# Defensive Advance Player Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a human player uses the Defensive Advance feat, raise their shield automatically and, when their first movement ends with the targeted enemy in melee reach, make a melee Strike against it, so the PF2E Automated Action Tracker charges 2 actions in total (#1278).

**Architecture:** The tracker only absorbs the follow-ups at no extra cost in the order Raise a Shield → Stride → Strike, and players Stride first. A new `createChatMessage` handler on the author's own client raises the shield first and arms client-local pending state; a `moveToken` handler consumes it on the first completed movement and rolls the Strike through the player's normal PF2e pipeline (so the tracker, `handleManualStrikeDamage` and the reaction hooks all behave as for a manual Strike). Pure decisions live in `defensive-advance-logic.mjs` (no imports); Foundry I/O lives in `defensive-advance.mjs` with injectable deps.

**Tech Stack:** Foundry VTT v13 module, ES modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-defensive-advance-player-automation-design.md`

## Global Constraints

- Defensive Advance costs **2 actions total**, including the movement; nothing here may add a charge. (spec Summary)
- The tracker module id is `pf2e-auto-action-tracker`; its per-combatant log is `combatant.flags["pf2e-auto-action-tracker"].log`. Never write to it, never patch the tracker. (spec Resolved decisions 1)
- Strike the **targeted actor only**, no fallback to another adjacent enemy; read the target when the movement completes. (spec Resolved decisions 3, 4)
- `game.pf2e.actions.raiseAShield` is a **toggle**: never call it when the shield is already raised. (spec "Raise the shield")
- Human players only: skip `agentControlled` combatants. (spec Resolved decisions 5)
- A hook handler must never throw: catch, `console.error` with the `pf2e-dungeon-crawl | #1278:` prefix, and let the player finish by hand. (spec Failure behaviour)
- Do NOT use `rollAndApplyStrike` (it applies damage itself; `handleManualStrikeDamage` would apply it a second time). (spec Investigation findings)
- Every merge to `main` bumps `module.json` `version`; never reuse a number (`git fetch origin main` and read `origin/main:module.json` first). Run the `update-architecture-docs` skill in the same pass. (CLAUDE.md)
- Work in a git worktree off `origin/main`, copy `.env` in for live testing, use `npm ci`, never symlink `node_modules`. (CLAUDE.md)

## Review Focus

- The player targets nothing, or several tokens, when the movement ends: a notice, no Strike, and the pending state is spent. (Task 3)
- The shield is already raised when the feat card appears: it must NOT be lowered. (Task 2)
- The GM (or another user) drags the player's token while a Defensive Advance is pending: ignored, pending state kept for the player's own move. (Task 3)
- The targeted creature is an ally, the mover itself, or already defeated: no Strike. (Tasks 1, 3)
- The turn ends (or the combat is deleted) without the player moving: a later move must not Strike. (Task 4)
- The tracker log is missing or unreadable when the MAP is needed: roll at no penalty and tell the player. (Tasks 1, 3)

---

## File Structure

- Create `scripts/defensive-advance-logic.mjs`: pure functions, **zero imports**, so tests need no Foundry or `dungeon-combat.mjs`.
- Create `scripts/defensive-advance.mjs`: Foundry I/O handlers + hook registration; imports the logic file, `dungeon-combat.mjs` helpers and `force-hostility.mjs`.
- Modify `scripts/dungeon-combat.mjs`: export two existing helpers (`isModuleCombat`, `isMeleeStrikeAction`); no behaviour change.
- Modify `scripts/module.mjs`: one import + one `registerDefensiveAdvanceHooks()` call.
- Modify `lang/en.json`: five notice strings.
- Modify `docs/architecture.md`, `module.json`.
- Create `tests/defensive-advance-logic.test.mjs`, `tests/defensive-advance.test.mjs`.

---

### Task 1: Pure decision logic

**Files:**
- Create: `scripts/defensive-advance-logic.mjs`
- Test: `tests/defensive-advance-logic.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (all named exports of `scripts/defensive-advance-logic.mjs`):
  - `DEFENSIVE_ADVANCE_SLUG = "defensive-advance"`, `TRACKER_NAMESPACE = "pf2e-auto-action-tracker"`
  - `isDefensiveAdvanceMessage(message) → boolean`
  - `createPendingStore() → Map`, `armPending(store, entry)`, `peekPending(store, tokenId) → entry|null`, `consumePending(store, tokenId) → entry|null`, `clearPendingWhere(store, predicate) → number`; an entry is `{ tokenId, combatId, combatantId, round, featMessageId }`
  - `resolveTargetToken(userTargets) → { ok: true, token } | { ok: false, reason: "none" | "many" }`
  - `validateTarget({ targetCombatant, moverCombatant, hostile }) → { ok: true } | { ok: false, reason: "not-in-combat" | "self" | "defeated" | "not-hostile" }`
  - `pickMeleeStrike(actions, distanceSquares, { reachOf, isMelee }) → action|null`
  - `countMapAttacks(log) → number`, `mapVariantIndex(log) → 0|1|2`
  - `logHasMessage(log, msgId) → boolean`, `activityHasMoveChild(log, featMsgId) → boolean`
  - `degreeToOutcome(degree) → "criticalSuccess" | "success" | null`

- [x] **Step 1: Write the failing tests**

Create `tests/defensive-advance-logic.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import {
  isDefensiveAdvanceMessage, createPendingStore, armPending, peekPending, consumePending,
  clearPendingWhere, resolveTargetToken, validateTarget, pickMeleeStrike, countMapAttacks,
  mapVariantIndex, logHasMessage, activityHasMoveChild, degreeToOutcome,
} from "../scripts/defensive-advance-logic.mjs";

const featCard = (over = {}) => ({
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:defensive-advance"] } } },
  ...over,
});

describe("isDefensiveAdvanceMessage", () => {
  it("accepts the feat card", () => expect(isDefensiveAdvanceMessage(featCard())).toBe(true));
  it("rejects another feat's card", () => {
    const m = featCard();
    m.flags.pf2e.origin.rollOptions = ["origin:item:slug:devoted-guardian"];
    expect(isDefensiveAdvanceMessage(m)).toBe(false);
  });
  it("rejects a roll made by the feat (has a context)", () => {
    const m = featCard();
    m.flags.pf2e.context = { type: "attack-roll" };
    expect(isDefensiveAdvanceMessage(m)).toBe(false);
  });
  it("rejects a non-feat origin and junk input", () => {
    const m = featCard();
    m.flags.pf2e.origin.type = "action";
    expect(isDefensiveAdvanceMessage(m)).toBe(false);
    expect(isDefensiveAdvanceMessage(null)).toBe(false);
    expect(isDefensiveAdvanceMessage({})).toBe(false);
  });
});

describe("pending store", () => {
  const entry = (over = {}) => ({ tokenId: "t1", combatId: "k1", combatantId: "c1", round: 1, featMessageId: "m1", ...over });
  it("arms, peeks without consuming, then consumes once", () => {
    const s = createPendingStore();
    armPending(s, entry());
    expect(peekPending(s, "t1")).toEqual(entry());
    expect(peekPending(s, "t1")).toEqual(entry());
    expect(consumePending(s, "t1")).toEqual(entry());
    expect(consumePending(s, "t1")).toBeNull();
    expect(peekPending(s, "t1")).toBeNull();
  });
  it("a second arm for the same token replaces the first", () => {
    const s = createPendingStore();
    armPending(s, entry({ featMessageId: "old" }));
    armPending(s, entry({ featMessageId: "new" }));
    expect(peekPending(s, "t1").featMessageId).toBe("new");
    expect(s.size).toBe(1);
  });
  it("clearPendingWhere removes matching entries only and reports the count", () => {
    const s = createPendingStore();
    armPending(s, entry({ tokenId: "a", combatId: "k1" }));
    armPending(s, entry({ tokenId: "b", combatId: "k1" }));
    armPending(s, entry({ tokenId: "c", combatId: "k2" }));
    expect(clearPendingWhere(s, (e) => e.combatId === "k1")).toBe(2);
    expect([...s.keys()]).toEqual(["c"]);
  });
});

describe("resolveTargetToken", () => {
  it("none", () => expect(resolveTargetToken(new Set())).toEqual({ ok: false, reason: "none" }));
  it("many", () => expect(resolveTargetToken(new Set([{}, {}]))).toEqual({ ok: false, reason: "many" }));
  it("exactly one", () => {
    const tok = { id: "x" };
    expect(resolveTargetToken(new Set([tok]))).toEqual({ ok: true, token: tok });
  });
  it("tolerates null/undefined", () => {
    expect(resolveTargetToken(undefined)).toEqual({ ok: false, reason: "none" });
    expect(resolveTargetToken(null)).toEqual({ ok: false, reason: "none" });
  });
});

describe("validateTarget", () => {
  const mover = { id: "c1" };
  it("accepts a living hostile other combatant", () =>
    expect(validateTarget({ targetCombatant: { id: "c2", isDefeated: false }, moverCombatant: mover, hostile: true })).toEqual({ ok: true }));
  it("rejects a target that is not in the combat", () =>
    expect(validateTarget({ targetCombatant: undefined, moverCombatant: mover, hostile: false })).toEqual({ ok: false, reason: "not-in-combat" }));
  it("rejects the mover itself", () =>
    expect(validateTarget({ targetCombatant: { id: "c1" }, moverCombatant: mover, hostile: false })).toEqual({ ok: false, reason: "self" }));
  it("rejects a defeated target", () =>
    expect(validateTarget({ targetCombatant: { id: "c2", isDefeated: true }, moverCombatant: mover, hostile: true })).toEqual({ ok: false, reason: "defeated" }));
  it("rejects an ally", () =>
    expect(validateTarget({ targetCombatant: { id: "c2", isDefeated: false }, moverCombatant: mover, hostile: false })).toEqual({ ok: false, reason: "not-hostile" }));
});

describe("pickMeleeStrike", () => {
  const strike = (name, mod, over = {}) => ({ type: "strike", ready: true, totalModifier: mod, name, ...over });
  const opts = { reachOf: (a) => a.reach ?? 1, isMelee: (a) => !a.ranged };
  it("picks the highest modifier among melee strikes in reach", () => {
    const actions = [strike("fist", 5), strike("sword", 9), strike("bow", 12, { ranged: true })];
    expect(pickMeleeStrike(actions, 1, opts).name).toBe("sword");
  });
  it("skips strikes that are not ready or not strikes", () => {
    const actions = [strike("sheathed", 20, { ready: false }), { type: "action", totalModifier: 30 }, strike("fist", 5)];
    expect(pickMeleeStrike(actions, 1, opts).name).toBe("fist");
  });
  it("honours a longer reach and excludes a target out of reach", () => {
    const actions = [strike("fist", 5), strike("glaive", 3, { reach: 2 })];
    expect(pickMeleeStrike(actions, 2, opts).name).toBe("glaive");
    expect(pickMeleeStrike(actions, 3, opts)).toBeNull();
  });
  it("returns null with no usable strike or bad input", () => {
    expect(pickMeleeStrike([strike("bow", 9, { ranged: true })], 1, opts)).toBeNull();
    expect(pickMeleeStrike(undefined, 1, opts)).toBeNull();
  });
});

describe("MAP from the tracker log", () => {
  const atk = (over = {}) => ({ msgId: "a", isMapRelevant: true, type: "action", ...over });
  it("counts no prior attacks as variant 0", () => {
    expect(countMapAttacks([])).toBe(0);
    expect(mapVariantIndex([])).toBe(0);
  });
  it("counts map-relevant top-level entries, ignoring reactions and deferMAP", () => {
    expect(countMapAttacks([atk(), atk({ type: "reaction" }), atk({ actionModifiers: ["deferMAP"] }), { msgId: "s", isMapRelevant: false }])).toBe(1);
  });
  it("counts an activity's children, including the doubled mapIncrease2", () => {
    const activity = { msgId: "f", isMapRelevant: false, ComplexActionState: { orderedActivityChildActions: [atk({ actionModifiers: ["mapIncrease2"] })] } };
    expect(countMapAttacks([activity])).toBe(2);
  });
  it("clamps the variant index to 2", () => {
    expect(mapVariantIndex([atk(), atk(), atk(), atk()])).toBe(2);
    expect(mapVariantIndex([atk()])).toBe(1);
  });
});

describe("tracker log predicates", () => {
  it("logHasMessage", () => {
    expect(logHasMessage([{ msgId: "m1" }], "m1")).toBe(true);
    expect(logHasMessage([{ msgId: "m1" }], "m2")).toBe(false);
    expect(logHasMessage(undefined, "m1")).toBe(false);
  });
  const activity = (leaves) => [{ msgId: "f", ComplexActionState: { leaves } }];
  it("activityHasMoveChild is true only once the move leaf has a claimed child", () => {
    expect(activityHasMoveChild(activity({ a: { type: "action", childActions: [{}] }, b: { type: "move", childActions: [] } }), "f")).toBe(false);
    expect(activityHasMoveChild(activity({ b: { type: "move", childActions: [{ msgId: "x" }] } }), "f")).toBe(true);
  });
  it("activityHasMoveChild is false for a missing entry or activity", () => {
    expect(activityHasMoveChild([], "f")).toBe(false);
    expect(activityHasMoveChild([{ msgId: "f" }], "f")).toBe(false);
    expect(activityHasMoveChild(undefined, "f")).toBe(false);
  });
});

describe("degreeToOutcome", () => {
  it("maps hits and crits, nothing else", () => {
    expect(degreeToOutcome(3)).toBe("criticalSuccess");
    expect(degreeToOutcome(2)).toBe("success");
    expect(degreeToOutcome(1)).toBeNull();
    expect(degreeToOutcome(0)).toBeNull();
    expect(degreeToOutcome(undefined)).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/defensive-advance-logic.test.mjs`
Expected: FAIL — cannot resolve `../scripts/defensive-advance-logic.mjs`.

- [x] **Step 3: Write the implementation**

Create `scripts/defensive-advance-logic.mjs`:

```js
/**
 * #1278: pure decision logic for the player Defensive Advance automation
 * (Raise Shield at feat use + auto-Strike when the first movement ends in
 * melee reach). No imports and no Foundry globals, so it unit-tests alone;
 * the Foundry I/O lives in defensive-advance.mjs.
 *
 * Tracker facts this relies on (pf2e-auto-action-tracker v0.19.1): its
 * per-combatant log entries carry `msgId`, `isMapRelevant`, `type`,
 * `actionModifiers`, and for an activity a `ComplexActionState` with
 * `leaves` ({type, childActions}) and `orderedActivityChildActions`.
 */
export const DEFENSIVE_ADVANCE_SLUG = "defensive-advance";
export const TRACKER_NAMESPACE = "pf2e-auto-action-tracker";

const REACH_EPSILON = 1e-6;

/** True for the Defensive Advance feat's own chat card (not a roll it made). */
export function isDefensiveAdvanceMessage(message) {
  const pf2e = message?.flags?.pf2e;
  if (!pf2e || pf2e.context) return false;
  if (pf2e.origin?.type !== "feat") return false;
  const options = pf2e.origin.rollOptions;
  return Array.isArray(options) && options.includes(`origin:item:slug:${DEFENSIVE_ADVANCE_SLUG}`);
}

// --- pending state (client-local; one entry per token) --------------------

export const createPendingStore = () => new Map();

export function armPending(store, entry) {
  store.set(entry.tokenId, { ...entry });
}

export function peekPending(store, tokenId) {
  return store.get(tokenId) ?? null;
}

export function consumePending(store, tokenId) {
  const entry = store.get(tokenId) ?? null;
  store.delete(tokenId);
  return entry;
}

export function clearPendingWhere(store, predicate) {
  let removed = 0;
  for (const [key, value] of store) {
    if (predicate(value)) {
      store.delete(key);
      removed++;
    }
  }
  return removed;
}

// --- target ----------------------------------------------------------------

/** Exactly one targeted token, or the reason there isn't. */
export function resolveTargetToken(userTargets) {
  const list = userTargets ? [...userTargets] : [];
  if (list.length === 0) return { ok: false, reason: "none" };
  if (list.length > 1) return { ok: false, reason: "many" };
  return { ok: true, token: list[0] };
}

export function validateTarget({ targetCombatant, moverCombatant, hostile }) {
  if (!targetCombatant) return { ok: false, reason: "not-in-combat" };
  if (targetCombatant.id === moverCombatant?.id) return { ok: false, reason: "self" };
  if (targetCombatant.isDefeated) return { ok: false, reason: "defeated" };
  if (!hostile) return { ok: false, reason: "not-hostile" };
  return { ok: true };
}

/** The ready melee Strike with the best modifier that reaches the target. */
export function pickMeleeStrike(actions, distanceSquares, { reachOf, isMelee }) {
  const usable = (actions ?? []).filter(
    (a) =>
      a?.type === "strike" &&
      a.ready !== false &&
      isMelee(a) &&
      distanceSquares <= reachOf(a) + REACH_EPSILON,
  );
  usable.sort((a, b) => (b.totalModifier ?? 0) - (a.totalModifier ?? 0));
  return usable[0] ?? null;
}

// --- multiple attack penalty (mirrors the tracker's getCurrentMapStateFromLog) --

export function countMapAttacks(log) {
  const flat = (log ?? []).flatMap((entry) => {
    const state = entry?.ComplexActionState;
    if (!state) return [entry];
    const children = (state.orderedActivityChildActions ?? []).flatMap((child) =>
      child?.actionModifiers?.includes("mapIncrease2") ? [child, child] : [child],
    );
    return [...(entry.isMapRelevant ? [entry] : []), ...children];
  });
  return flat.filter(
    (e) => e?.isMapRelevant === true && e.type !== "reaction" && !e.actionModifiers?.includes("deferMAP"),
  ).length;
}

/** Index into a Strike's `variants` (0 = no penalty, 1 = MAP 1, 2 = MAP 2). */
export function mapVariantIndex(log) {
  return Math.min(countMapAttacks(log), 2);
}

// --- tracker log predicates ---------------------------------------------------

export function logHasMessage(log, msgId) {
  return (log ?? []).some((e) => e?.msgId === msgId);
}

/** Whether the tracker has claimed a Stride/move for the feat's open activity. */
export function activityHasMoveChild(log, featMsgId) {
  const entry = (log ?? []).find((e) => e?.msgId === featMsgId);
  const leaves = entry?.ComplexActionState?.leaves;
  if (!leaves) return false;
  return Object.values(leaves).some((l) => l?.type === "move" && (l.childActions ?? []).length > 0);
}

/** PF2e check degree of success (0-3) to the outcome string Strike damage takes. */
export function degreeToOutcome(degree) {
  if (degree === 3) return "criticalSuccess";
  if (degree === 2) return "success";
  return null;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/defensive-advance-logic.test.mjs`
Expected: PASS (all describe blocks green).

- [x] **Step 5: Commit**

```bash
git add scripts/defensive-advance-logic.mjs tests/defensive-advance-logic.test.mjs
git commit -m "#1278: Defensive Advance pure decision logic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Feat-card handler (raise the shield, arm the Strike)

**Files:**
- Modify: `scripts/dungeon-combat.mjs:630` (export `isModuleCombat`), `scripts/dungeon-combat.mjs:4234` (export `isMeleeStrikeAction`)
- Create: `scripts/defensive-advance.mjs`
- Modify: `lang/en.json` (five keys)
- Test: `tests/defensive-advance.test.mjs`

**Interfaces:**
- Consumes (Task 1): `isDefensiveAdvanceMessage`, `createPendingStore`, `armPending`, `logHasMessage`, `TRACKER_NAMESPACE`.
- Consumes (existing): `isModuleCombat(combat)`, `isMeleeStrikeAction(action)` (newly exported), `chebyshevSquares(a, b, gridSize)`, `actionReachSquares(action, gridDistanceFt)` from `dungeon-combat.mjs`; `areHostile(combat, a, b)` from `force-hostility.mjs`.
- Produces (named exports of `scripts/defensive-advance.mjs`):
  - `pendingDefensiveAdvance` — the module-level pending store (a `Map`)
  - `waitForTrackerLog(combatant, predicate, { attempts = 20, intervalMs = 100, sleepFn }) → Promise<boolean>`
  - `onDefensiveAdviceCard(message, deps = {}) → Promise<void>` (deps keys: `game`, `log`, `notify(key)`, `raiseAShield`, `sleepFn`, `isModuleCombat`)
  - `defaultDeps()` (internal but exported for tests; see code)

- [ ] **Step 1: Export the two existing helpers**

In `scripts/dungeon-combat.mjs` change `function isModuleCombat(c) {` to `export function isModuleCombat(c) {`, and `function isMeleeStrikeAction(action) {` to `export function isMeleeStrikeAction(action) {`. No other change.

Run: `npx vitest run tests/dungeon-combat*.test.mjs`
Expected: PASS (exports are additive).

- [ ] **Step 2: Add the lang strings**

In `lang/en.json`, after the `"PF2EDC.Dungeon.Combat.ReactionDisruptedMoveGm"` line, add:

```json
  "PF2EDC.Dungeon.Combat.DefensiveAdvance.NoShield": "Defensive Advance: you have no shield to raise.",
  "PF2EDC.Dungeon.Combat.DefensiveAdvance.ShieldAlreadyRaised": "Defensive Advance: your shield is already raised.",
  "PF2EDC.Dungeon.Combat.DefensiveAdvance.TargetOne": "Defensive Advance: target exactly one enemy to Strike automatically.",
  "PF2EDC.Dungeon.Combat.DefensiveAdvance.TargetInvalid": "Defensive Advance: the targeted creature is not an enemy you can Strike.",
  "PF2EDC.Dungeon.Combat.DefensiveAdvance.MapUnknown": "Defensive Advance: could not read your multiple attack penalty from the action tracker; rolling the Strike with no penalty.",
```

Run: `node -e "JSON.parse(require('fs').readFileSync('lang/en.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Write the failing tests**

Create `tests/defensive-advance.test.mjs`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  onDefensiveAdviceCard, pendingDefensiveAdvance, waitForTrackerLog,
} from "../scripts/defensive-advance.mjs";
import { TRACKER_NAMESPACE } from "../scripts/defensive-advance-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function world({ shield = { isRaised: false }, trackerLog = [{ msgId: "m1" }], agent = false, current = true, defeated = false } = {}) {
  const mover = {
    id: "c1", tokenId: "t1", isDefeated: defeated,
    getFlag: (scope, key) => (scope === MODULE_ID && key === "agentControlled" ? agent : undefined),
    flags: { [TRACKER_NAMESPACE]: { log: trackerLog } },
    actor: { heldShield: shield },
  };
  const combat = {
    id: "k1", round: 2, started: true, scene: { id: "s1" },
    combatant: current ? mover : { id: "other" },
    combatants: { find: (fn) => [mover].find(fn), get: (id) => [mover].find((c) => c.id === id) },
  };
  const game = { user: { id: "u1", targets: new Set() }, combats: { contents: [combat], get: () => combat } };
  return { mover, combat, game };
}
const card = (over = {}) => ({
  id: "m1", author: { id: "u1" }, speaker: { scene: "s1", token: "t1" },
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:defensive-advance"] } } },
  ...over,
});
const mkDeps = (w, over = {}) => ({
  game: w.game, log: { error: vi.fn(), warn: vi.fn() }, notify: vi.fn(),
  raiseAShield: vi.fn(async () => {}), sleepFn: vi.fn(async () => {}), isModuleCombat: () => true, ...over,
});

beforeEach(() => pendingDefensiveAdvance.clear());

describe("onDefensiveAdviceCard", () => {
  it("raises the shield and arms the pending Strike", async () => {
    const w = world(); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
    expect(deps.raiseAShield).toHaveBeenCalledWith({ actors: [w.mover.actor] });
    expect(pendingDefensiveAdvance.get("t1")).toEqual({
      tokenId: "t1", combatId: "k1", combatantId: "c1", round: 2, featMessageId: "m1",
    });
  });

  it("never lowers an already-raised shield (raiseAShield is a toggle) but still arms", async () => {
    const w = world({ shield: { isRaised: true } }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.ShieldAlreadyRaised");
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });

  it("with no shield, notifies, does not raise, and still arms", async () => {
    const w = world({ shield: null }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.NoShield");
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });

  it("waits for the tracker to log the feat card before raising", async () => {
    const w = world({ trackerLog: [] });
    let calls = 0;
    const deps = mkDeps(w, {
      sleepFn: vi.fn(async () => { if (++calls === 3) w.mover.flags[TRACKER_NAMESPACE].log = [{ msgId: "m1" }]; }),
    });
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.sleepFn).toHaveBeenCalledTimes(3);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
  });

  it("raises anyway after the wait times out", async () => {
    const w = world({ trackerLog: [] }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another feat", { flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:devoted-guardian"] } } } }, {}],
    ["another user's card", { author: { id: "u2" } }, {}],
    ["an AI-controlled combatant", {}, { agent: true }],
    ["not the combatant's turn", {}, { current: false }],
    ["a defeated combatant", {}, { defeated: true }],
  ])("does nothing for %s", async (_name, msgOver, worldOver) => {
    const w = world(worldOver); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(msgOver), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("does nothing outside a module combat", async () => {
    const w = world(); const deps = mkDeps(w, { isModuleCombat: () => false });
    await onDefensiveAdviceCard(card(), deps);
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("never throws: a failing raise is logged and the Strike still stays armed", async () => {
    const w = world(); const deps = mkDeps(w, { raiseAShield: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(onDefensiveAdviceCard(card(), deps)).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalled();
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });
});

describe("waitForTrackerLog", () => {
  it("resolves true immediately when the predicate already holds", async () => {
    const c = { flags: { [TRACKER_NAMESPACE]: { log: [{ msgId: "m1" }] } } };
    const sleepFn = vi.fn(async () => {});
    expect(await waitForTrackerLog(c, (l) => l.length === 1, { sleepFn })).toBe(true);
    expect(sleepFn).not.toHaveBeenCalled();
  });
  it("resolves false after the attempts are used up, treating a missing log as empty", async () => {
    const c = { flags: {} };
    const sleepFn = vi.fn(async () => {});
    expect(await waitForTrackerLog(c, (l) => l.length > 0, { attempts: 4, sleepFn })).toBe(false);
    expect(sleepFn).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/defensive-advance.test.mjs`
Expected: FAIL — cannot resolve `../scripts/defensive-advance.mjs`.

- [ ] **Step 5: Write the implementation**

Create `scripts/defensive-advance.mjs`:

```js
/**
 * #1278: a human player's Defensive Advance (Champion flourish, 2 actions:
 * "You Raise your Shield and Stride. If you end your movement within melee
 * reach of at least one enemy, you can make a melee Strike against that
 * enemy").
 *
 * The PF2E Automated Action Tracker (pf2e-auto-action-tracker) models the
 * feat as one 2-action activity but only absorbs its parts at no extra cost
 * in the order Raise a Shield -> Stride -> Strike, and players Stride first,
 * which breaks the activity and charges every later action again. This
 * module (1) raises the shield the moment the feat card appears and (2)
 * Strikes the targeted enemy when the first completed movement ends in melee
 * reach, both on the acting player's own client, through the normal PF2e
 * pipeline, so the tracker, handleManualStrikeDamage and the reaction hooks
 * treat the Strike exactly like a manual one.
 */
import {
  isModuleCombat, isMeleeStrikeAction, chebyshevSquares, actionReachSquares,
} from "./dungeon-combat.mjs";
import { areHostile } from "./force-hostility.mjs";
import {
  TRACKER_NAMESPACE, isDefensiveAdvanceMessage, createPendingStore, armPending,
  logHasMessage,
} from "./defensive-advance-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const LANG = "PF2EDC.Dungeon.Combat.DefensiveAdvance";
const TAG = `${MODULE_ID} | #1278:`;

/** Client-local pending Strikes, keyed by token id (see armPending). */
export const pendingDefensiveAdvance = createPendingStore();

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultDeps() {
  return {
    game: globalThis.game,
    log: console,
    notify: (key) => globalThis.ui?.notifications?.warn(globalThis.game.i18n.localize(key)),
    raiseAShield: (args) => globalThis.game.pf2e.actions.raiseAShield(args),
    sleepFn: defaultSleep,
    isModuleCombat,
    isMeleeStrikeAction,
    chebyshevSquares,
    actionReachSquares,
    areHostile,
  };
}

const trackerLogOf = (combatant) => combatant?.flags?.[TRACKER_NAMESPACE]?.log;

/**
 * Poll the combatant's tracker log until `predicate(log)` holds, up to
 * `attempts` sleeps. The tracker records actions through an async GM socket
 * call, so an action we trigger can be evaluated before the entry it depends
 * on exists. Resolves false on timeout (callers proceed anyway).
 */
export async function waitForTrackerLog(combatant, predicate, { attempts = 20, intervalMs = 100, sleepFn = defaultSleep } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (predicate(trackerLogOf(combatant) ?? [])) return true;
    await sleepFn(intervalMs);
  }
  return predicate(trackerLogOf(combatant) ?? []);
}

/**
 * createChatMessage: the author's own client reacts to their Defensive
 * Advance feat card. Raises the shield (never lowering a raised one) and
 * arms the pending Strike. Never throws.
 */
export async function onDefensiveAdviceCard(message, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  try {
    if (!isDefensiveAdvanceMessage(message)) return;
    if (message.author?.id !== d.game.user?.id) return;
    const sceneId = message.speaker?.scene;
    const combat = d.game.combats?.contents?.find(
      (c) => c.scene?.id === sceneId && d.isModuleCombat(c) && (c.started ?? c.round > 0),
    );
    if (!combat) return;
    const mover = combat.combatants.find((c) => c.tokenId === message.speaker?.token);
    if (!mover || mover.isDefeated) return;
    if (mover.getFlag(MODULE_ID, "agentControlled")) return;
    if (combat.combatant?.id !== mover.id) return;

    await waitForTrackerLog(mover, (log) => logHasMessage(log, message.id), { sleepFn: d.sleepFn });

    armPending(pendingDefensiveAdvance, {
      tokenId: mover.tokenId, combatId: combat.id, combatantId: mover.id,
      round: combat.round, featMessageId: message.id,
    });

    const shield = mover.actor?.heldShield;
    if (!shield) return d.notify(`${LANG}.NoShield`);
    // raiseAShield is a toggle: with the effect present it LOWERS the shield.
    if (shield.isRaised) return d.notify(`${LANG}.ShieldAlreadyRaised`);
    await d.raiseAShield({ actors: [mover.actor] });
  } catch (err) {
    d.log.error?.(`${TAG} Defensive Advance feat handler failed:`, err?.message ?? err);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/defensive-advance.test.mjs tests/defensive-advance-logic.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/defensive-advance.mjs scripts/dungeon-combat.mjs lang/en.json tests/defensive-advance.test.mjs
git commit -m "#1278: Defensive Advance feat-card handler (raise shield, arm Strike)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Movement handler (auto-Strike)

**Files:**
- Modify: `scripts/defensive-advance.mjs`
- Test: `tests/defensive-advance.test.mjs`

**Interfaces:**
- Consumes (Task 1): `peekPending`, `consumePending`, `resolveTargetToken`, `validateTarget`, `pickMeleeStrike`, `mapVariantIndex`, `activityHasMoveChild`, `degreeToOutcome`. (Task 2): `pendingDefensiveAdvance`, `waitForTrackerLog`, `defaultDeps`, `trackerLogOf`.
- Produces: `onDefensiveAdviceMove(tokenDoc, movement, deps = {}, hookArgs = []) → Promise<void>`; `withDialogsSuppressed(game, fn) → Promise<*>` (exported for tests).

- [ ] **Step 1: Write the failing tests**

Append to `tests/defensive-advance.test.mjs` (the two `import` lines below are additional imports; ESM allows importing from the same module twice):

```js
import { onDefensiveAdviceMove } from "../scripts/defensive-advance.mjs";
import { armPending } from "../scripts/defensive-advance-logic.mjs";

function moveWorld({ targets = "one", targetOver = {}, strikeOver = {}, trackerLog, hostile = true, hookRound = 2 } = {}) {
  const strike = {
    type: "strike", ready: true, totalModifier: 9, name: "Morningstar",
    variants: [{ roll: vi.fn(async () => ({ degreeOfSuccess: 2 })) }, { roll: vi.fn(async () => ({ degreeOfSuccess: 2 })) }, { roll: vi.fn(async () => ({ degreeOfSuccess: 2 })) }],
    damage: vi.fn(async () => ({})), ...strikeOver,
  };
  const featLog = [{
    msgId: "m1", ComplexActionState: { leaves: { s: { type: "move", childActions: [{ msgId: "x" }] } }, orderedActivityChildActions: [] },
  }];
  const w = world({ trackerLog: trackerLog ?? featLog });
  w.mover.actor = { heldShield: { isRaised: true }, system: { actions: [strike] } };
  const targetDoc = { id: "t2", x: 200, y: 0, width: 1, height: 1 };
  const targetCombatant = { id: "c2", tokenId: "t2", isDefeated: false, token: targetDoc, ...targetOver };
  w.combat.round = hookRound;
  w.combat.scene.grid = { size: 100, distance: 5 };
  w.combat.combatants = {
    find: (fn) => [w.mover, targetCombatant].find(fn),
    get: (id) => [w.mover, targetCombatant].find((c) => c.id === id),
  };
  w.game.user.targets = targets === "one" ? new Set([{ document: targetDoc }]) : targets === "none" ? new Set() : new Set([{ document: targetDoc }, { document: { id: "t3" } }]);
  w.game.combats.get = () => w.combat;
  w.game.messages = { contents: [] };
  const tokenDoc = { id: "t1", x: 100, y: 0, width: 1, height: 1 };
  const deps = mkDeps(w, {
    chebyshevSquares: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100,
    actionReachSquares: () => 1,
    isMeleeStrikeAction: () => true,
    areHostile: () => hostile,
    withDialogsSuppressed: async (_game, fn) => fn(),
  });
  return { ...w, strike, tokenDoc, deps, targetCombatant };
}
const move = (over = {}) => ({ method: "dragging", origin: { x: 0, y: 0 }, passed: { waypoints: [{ x: 100, y: 0 }] }, ...over });
const arm = (over = {}) =>
  armPending(pendingDefensiveAdvance, { tokenId: "t1", combatId: "k1", combatantId: "c1", round: 2, featMessageId: "m1", ...over });

describe("onDefensiveAdviceMove", () => {
  it("Strikes the targeted enemy in reach (attack then damage on a hit) and spends the pending state", async () => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
    const rollArgs = w.strike.variants[0].roll.mock.calls[0][0];
    expect(rollArgs.target).toEqual({ document: w.targetCombatant.token });
    expect(rollArgs.createMessage).toBe(true);
    expect(rollArgs.skipDialog).toBe(true);
    expect(w.strike.damage).toHaveBeenCalledWith({ target: { document: w.targetCombatant.token }, outcome: "success", createMessage: true });
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("rolls damage as a critical on a critical hit and none on a miss", async () => {
    const crit = moveWorld(); arm();
    crit.strike.variants[0].roll = vi.fn(async () => ({ degreeOfSuccess: 3 }));
    await onDefensiveAdviceMove(crit.tokenDoc, move(), crit.deps);
    expect(crit.strike.damage.mock.calls[0][0].outcome).toBe("criticalSuccess");

    pendingDefensiveAdvance.clear();
    const miss = moveWorld(); arm();
    miss.strike.variants[0].roll = vi.fn(async () => ({ degreeOfSuccess: 1 }));
    await onDefensiveAdviceMove(miss.tokenDoc, move(), miss.deps);
    expect(miss.strike.damage).not.toHaveBeenCalled();
  });

  it("uses the MAP variant from the tracker log", async () => {
    const log = [
      { msgId: "a1", isMapRelevant: true, type: "action" },
      { msgId: "m1", ComplexActionState: { leaves: { s: { type: "move", childActions: [{}] } }, orderedActivityChildActions: [] } },
    ];
    const w = moveWorld({ trackerLog: log }); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
  });

  it("falls back to no penalty and tells the player when the tracker log is unreadable", async () => {
    const w = moveWorld(); arm();
    delete w.mover.flags[TRACKER_NAMESPACE];
    await onDefensiveAdviceMove(w.tokenDoc, move(), { ...w.deps, sleepFn: vi.fn(async () => {}) });
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(w.deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.MapUnknown");
  });

  it("waits for the tracker to log the Stride before rolling", async () => {
    const w = moveWorld({ trackerLog: [{ msgId: "m1", ComplexActionState: { leaves: { s: { type: "move", childActions: [] } } } }] }); arm();
    let n = 0;
    const deps = { ...w.deps, sleepFn: vi.fn(async () => {
      if (++n === 2) w.mover.flags[TRACKER_NAMESPACE].log[0].ComplexActionState.leaves.s.childActions = [{}];
    }) };
    await onDefensiveAdviceMove(w.tokenDoc, move(), deps);
    expect(deps.sleepFn).toHaveBeenCalledTimes(2);
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it.each([["none", "TargetOne"], ["many", "TargetOne"]])("with %s targeted: notifies, no Strike, pending spent", async (targets, key) => {
    const w = moveWorld({ targets }); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.deps.notify).toHaveBeenCalledWith(`PF2EDC.Dungeon.Combat.DefensiveAdvance.${key}`);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it.each([
    ["an ally", { hostile: false }],
    ["a defeated creature", { targetOver: { isDefeated: true } }],
  ])("does not Strike %s", async (_n, over) => {
    const w = moveWorld(over); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.TargetInvalid");
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
  });

  it("does not Strike a target out of reach, silently, and spends the pending state", async () => {
    const w = moveWorld({ targetOver: { token: { id: "t2", x: 500, y: 0, width: 1, height: 1 } } }); arm();
    w.game.user.targets = new Set([{ document: w.targetCombatant.token }]);
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(w.deps.notify).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("ignores another user's drag and keeps the pending state for the player's own move", async () => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps, [{ id: "gm", isGM: true }]);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(1);
  });

  it("accepts the player's own user in the hook arguments", async () => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps, [{}, { id: "u1", isGM: false }]);
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a displace waypoint", move({ passed: { waypoints: [{ x: 100, y: 0, action: "displace" }] } })],
    ["a non-drag method", move({ method: "api" })],
    ["no waypoints", move({ passed: { waypoints: [] } })],
  ])("ignores %s", async (_n, mv) => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, mv, w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(1);
  });

  it("does nothing for a token with no pending Defensive Advance", async () => {
    const w = moveWorld();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
  });

  it("drops stale pending state from an earlier round or a different turn", async () => {
    const w = moveWorld({ hookRound: 3 }); arm({ round: 2 });
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("never throws: a failing roll is logged", async () => {
    const w = moveWorld(); arm();
    w.strike.variants[0].roll = vi.fn(async () => { throw new Error("boom"); });
    await expect(onDefensiveAdviceMove(w.tokenDoc, move(), w.deps)).resolves.toBeUndefined();
    expect(w.deps.log.error).toHaveBeenCalled();
  });
});

describe("withDialogsSuppressed", () => {
  it("turns the roll dialogs off for the call and restores the previous values", async () => {
    const { withDialogsSuppressed } = await import("../scripts/defensive-advance.mjs");
    const update = vi.fn(async () => {});
    const game = { user: { flags: { pf2e: { settings: { showCheckDialogs: true, showDamageDialogs: true } } }, update } };
    const result = await withDialogsSuppressed(game, async () => "done");
    expect(result).toBe("done");
    expect(update).toHaveBeenNthCalledWith(1, { "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    expect(update).toHaveBeenNthCalledWith(2, { "flags.pf2e.settings.showCheckDialogs": true, "flags.pf2e.settings.showDamageDialogs": true });
  });
  it("restores even when the callback throws", async () => {
    const { withDialogsSuppressed } = await import("../scripts/defensive-advance.mjs");
    const update = vi.fn(async () => {});
    const game = { user: { flags: { pf2e: { settings: { showCheckDialogs: true, showDamageDialogs: false } } }, update } };
    await expect(withDialogsSuppressed(game, async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(update).toHaveBeenLastCalledWith({ "flags.pf2e.settings.showCheckDialogs": true, "flags.pf2e.settings.showDamageDialogs": false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/defensive-advance.test.mjs`
Expected: FAIL — `onDefensiveAdviceMove` / `withDialogsSuppressed` are not exported.

- [ ] **Step 3: Write the implementation**

In `scripts/defensive-advance.mjs`, extend the logic import to:

```js
import {
  TRACKER_NAMESPACE, isDefensiveAdvanceMessage, createPendingStore, armPending,
  peekPending, consumePending, resolveTargetToken, validateTarget, pickMeleeStrike,
  mapVariantIndex, logHasMessage, activityHasMoveChild, degreeToOutcome,
} from "./defensive-advance-logic.mjs";
```

Add `withDialogsSuppressed: (g, fn) => withDialogsSuppressed(g, fn),` to the object returned by `defaultDeps()` (function declarations hoist, so ordering is fine), then append:

```js
/**
 * Runs `fn` with this user's PF2e check/damage roll dialogs off, restoring
 * the previous values afterwards (the same per-user flag toggle
 * rollAndApplyStrike uses; a player may update their own user flags).
 */
export async function withDialogsSuppressed(game, fn) {
  const settings = game.user.flags?.pf2e?.settings ?? {};
  const prevCheck = settings.showCheckDialogs;
  const prevDamage = settings.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    return await fn();
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevCheck,
      "flags.pf2e.settings.showDamageDialogs": prevDamage,
    });
  }
}

/**
 * moveToken: the first completed movement of a token with a pending
 * Defensive Advance ends the Stride. If the one targeted enemy is then in
 * melee reach, roll a melee Strike at it exactly as the player would
 * (attack, then damage on a hit); handleManualStrikeDamage applies the
 * damage. `hookArgs` are the moveToken arguments after (tokenDoc, movement);
 * if one is a User other than the local user, the move is not ours and the
 * pending state is left alone. Never throws.
 */
export async function onDefensiveAdviceMove(tokenDoc, movement, deps = {}, hookArgs = []) {
  const d = { ...defaultDeps(), ...deps };
  try {
    if (!peekPending(pendingDefensiveAdvance, tokenDoc?.id)) return;
    const actingUser = hookArgs.find((a) => a && typeof a === "object" && "isGM" in a);
    if (actingUser && actingUser.id !== d.game.user?.id) return;
    if (!["dragging", "keyboard"].includes(movement?.method)) return;
    const waypoints = movement.passed?.waypoints ?? [];
    if (!waypoints.length) return;
    if (waypoints.some((w) => w?.action === "displace" || w?.action === "blink")) return;

    const pending = consumePending(pendingDefensiveAdvance, tokenDoc.id);
    const combat = d.game.combats?.get(pending.combatId);
    if (!combat || combat.round !== pending.round || combat.combatant?.id !== pending.combatantId) return;
    const mover = combat.combatants.get(pending.combatantId);
    if (!mover || mover.isDefeated) return;

    const targeted = resolveTargetToken(d.game.user?.targets);
    if (!targeted.ok) return d.notify(`${LANG}.TargetOne`);
    const targetDoc = targeted.token.document ?? targeted.token;
    const target = combat.combatants.find((c) => c.tokenId === targetDoc.id);
    const verdict = validateTarget({
      targetCombatant: target,
      moverCombatant: mover,
      hostile: !!target && d.areHostile(combat, mover, target),
    });
    if (!verdict.ok) return d.notify(`${LANG}.TargetInvalid`);

    const gridSize = combat.scene?.grid?.size ?? 100;
    const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
    const distance = d.chebyshevSquares(tokenDoc, target.token, gridSize);
    const strike = pickMeleeStrike(mover.actor?.system?.actions, distance, {
      reachOf: (a) => d.actionReachSquares(a, gridDistanceFt),
      isMelee: d.isMeleeStrikeAction,
    });
    if (!strike) return; // out of reach is normal after a short Stride; the Strike is optional

    // The tracker logs the Stride through an async GM socket call; let it land
    // first so the Strike is absorbed as the activity's third child.
    await waitForTrackerLog(mover, (log) => activityHasMoveChild(log, pending.featMessageId), { sleepFn: d.sleepFn });

    const log = trackerLogOf(mover);
    let variantIndex = 0;
    if (Array.isArray(log)) variantIndex = mapVariantIndex(log);
    else d.notify(`${LANG}.MapUnknown`);
    const variant = strike.variants[Math.min(variantIndex, strike.variants.length - 1)];

    const targetRef = { document: target.token };
    await d.withDialogsSuppressed(d.game, async () => {
      const roll = await variant.roll({ target: targetRef, createMessage: true, skipDialog: true });
      const outcome = degreeToOutcome(roll?.degreeOfSuccess ?? roll?.options?.degreeOfSuccess);
      if (outcome) await strike.damage({ target: targetRef, outcome, createMessage: true });
    });
  } catch (err) {
    d.log.error?.(`${TAG} Defensive Advance Strike failed:`, err?.message ?? err);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/defensive-advance.test.mjs tests/defensive-advance-logic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/defensive-advance.mjs tests/defensive-advance.test.mjs
git commit -m "#1278: Defensive Advance auto-Strike on movement completion

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Lifecycle, hook registration, docs, version

**Files:**
- Modify: `scripts/defensive-advance.mjs`
- Modify: `scripts/module.mjs` (import near line 73 with the other local imports; one call near line 836, after `Hooks.on("createChatMessage", handleManualStrikeDamage);`)
- Modify: `docs/architecture.md`, `module.json`
- Test: `tests/defensive-advance.test.mjs`

**Interfaces:**
- Consumes (Tasks 1-3): `clearPendingWhere`, `pendingDefensiveAdvance`, `onDefensiveAdviceCard`, `onDefensiveAdviceMove`.
- Produces: `clearDefensiveAdvanceForCombat(combat) → number`; `onDefensiveAdviceCombatUpdate(combat, changes) → number`; `registerDefensiveAdvanceHooks(hooks = globalThis.Hooks) → void`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/defensive-advance.test.mjs` (add one more `import { clearDefensiveAdvanceForCombat, onDefensiveAdviceCombatUpdate, registerDefensiveAdvanceHooks } from "../scripts/defensive-advance.mjs";` line):

```js
describe("lifecycle clearing", () => {
  it("a turn or round change clears that combat's pending state only", () => {
    arm({ tokenId: "a", combatId: "k1" }); arm({ tokenId: "b", combatId: "k2" });
    expect(onDefensiveAdviceCombatUpdate({ id: "k1" }, { turn: 3 })).toBe(1);
    expect([...pendingDefensiveAdvance.keys()]).toEqual(["b"]);
  });
  it("a round change clears too; an unrelated update does not", () => {
    arm({ tokenId: "a", combatId: "k1" });
    expect(onDefensiveAdviceCombatUpdate({ id: "k1" }, { scene: "x" })).toBe(0);
    expect(onDefensiveAdviceCombatUpdate({ id: "k1" }, { round: 4 })).toBe(1);
  });
  it("deleting a combat clears its pending state", () => {
    arm({ tokenId: "a", combatId: "k1" });
    expect(clearDefensiveAdvanceForCombat({ id: "k1" })).toBe(1);
    expect(pendingDefensiveAdvance.size).toBe(0);
  });
});

describe("registerDefensiveAdvanceHooks", () => {
  it("registers the four hooks; the card hook does not pass hook options in as deps", async () => {
    const handlers = {};
    registerDefensiveAdvanceHooks({ on: (name, fn) => { handlers[name] = fn; } });
    expect(Object.keys(handlers).sort()).toEqual(["createChatMessage", "deleteCombat", "moveToken", "updateCombat"]);
    // createChatMessage passes (message, options, userId): options must not be read as deps.
    await expect(handlers.createChatMessage({ flags: {} }, { game: "NOT-A-GAME" }, "u1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/defensive-advance.test.mjs`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Write the implementation**

Add `clearPendingWhere` to the logic import in `scripts/defensive-advance.mjs`, then append:

```js
/** Drop every pending Strike belonging to `combat` (turn over / combat gone). */
export function clearDefensiveAdvanceForCombat(combat) {
  return clearPendingWhere(pendingDefensiveAdvance, (e) => e.combatId === combat?.id);
}

/** updateCombat: any turn or round change ends an unspent Defensive Advance. */
export function onDefensiveAdviceCombatUpdate(combat, changes) {
  if (!changes || !("turn" in changes || "round" in changes)) return 0;
  return clearDefensiveAdvanceForCombat(combat);
}

/** Registers the four hooks. Wrapped so Foundry's extra hook arguments never become `deps`. */
export function registerDefensiveAdvanceHooks(hooks = globalThis.Hooks) {
  hooks.on("createChatMessage", (message) => onDefensiveAdviceCard(message));
  hooks.on("moveToken", (tokenDoc, movement, ...rest) => onDefensiveAdviceMove(tokenDoc, movement, {}, rest));
  hooks.on("updateCombat", (combat, changes) => onDefensiveAdviceCombatUpdate(combat, changes));
  hooks.on("deleteCombat", (combat) => clearDefensiveAdvanceForCombat(combat));
}
```

In `scripts/module.mjs` add, after the `combatant-write-relay.mjs` import:

```js
import { registerDefensiveAdvanceHooks } from "./defensive-advance.mjs";
```

and after the `Hooks.on("createChatMessage", handleManualStrikeDamage);` line:

```js
/** #1278: a player's Defensive Advance raises their shield and auto-Strikes
 * the targeted enemy when the first movement ends in melee reach. */
registerDefensiveAdvanceHooks();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/defensive-advance.test.mjs tests/defensive-advance-logic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS with no new failures. Any pre-existing failure must be reported, not hidden.

- [ ] **Step 6: Architecture docs and version**

Run the `update-architecture-docs` skill (new files `defensive-advance-logic.mjs`, `defensive-advance.mjs`; `module.mjs` and `defensive-advance.mjs` gained imports). Add a short paragraph beside the `combatant-write-relay.mjs` one describing the Defensive Advance automation (#1278).

Then `git fetch origin main`, read `origin/main:module.json`'s `version`, and set `module.json` to the **next unused patch** version (never reuse one).

- [ ] **Step 7: Commit**

```bash
git add scripts/defensive-advance.mjs scripts/module.mjs docs/architecture.md module.json tests/defensive-advance.test.mjs
git commit -m "#1278: Defensive Advance lifecycle clearing and hook wiring

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Open the PR and merge, keeping the issue open**

The issue needs a live playtest, so merge with an explicit subject/body (no closing keyword):

```bash
git push -u origin HEAD
gh pr create --title "#1278: Defensive Advance player automation" --body "Implements docs/superpowers/plans/2026-11-09-defensive-advance-player-automation.md. Refs #1278 (stays open for live verification).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --subject "#1278: Defensive Advance player automation (#<PR number>)" --body "Issue stays open pending live verification."
```

Then on #1278: add `verification`, remove `in progress` and `claimed`.

---

### Task 5: Live verification (owner-attended)

**Files:** none (verification only).

**Interfaces:** Consumes the merged build installed in the live world (confirm the world's module version equals `module.json` first; a stale install is the usual cause of "macros/hooks dead after deploy" — check `game.modules.get("pf2e-dungeon-crawl").version` and the "Installed module" log time before debugging).

- [ ] **Step 1: Set up.** Start a module combat in which Herman Brightshield's player has the turn, with one hostile in melee-reach distance after a short Stride and one hostile far away. Confirm the tracker shows 3 free pips for Herman.
- [ ] **Step 2: In reach.** Target the near hostile, click Defensive Advance, drag the token adjacent to it. Expected: the shield raises on the feat click (before the drag), after the drag a Morningstar attack (and damage on a hit) appears with no roll dialog, the tracker's pip count shows **2 spent**, no "Sequence Broken" or "exceeded available slots" whisper, damage is applied exactly once.
- [ ] **Step 3: MAP.** Next turn, Strike once first, then Defensive Advance; the automatic Strike uses the −5 variant.
- [ ] **Step 4: Out of reach, wrong target, no target.** Stride short of the target (nothing rolls, 2 spent); target an ally (notice, nothing rolls); target nothing (notice, nothing rolls).
- [ ] **Step 5: Already raised.** Raise the shield first, then use the feat: the shield stays raised, a notice appears, the Stride and Strike still work.
- [ ] **Step 6: moveToken on the player's client.** If Step 2 never auto-Strikes, run `Hooks.on("moveToken", (...a) => console.log("moveToken", a))` in the player's browser console and drag a token. If nothing logs there, switch the handler to `updateToken` plus a position comparison (spec "Verified at the start of the plan", item 1) and add a regression test.
- [ ] **Step 7: Record the result on #1278** (terse: pass/fail per step). Close the issue only if all steps pass; on failure remove `verification` and re-claim.
