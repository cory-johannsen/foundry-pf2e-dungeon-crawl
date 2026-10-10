# Advanced Encounter Builder (Multiple Opposing Forces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the GM compose a stand-alone encounter from several opposing forces, each with its own creature filters, budget share and hostility mode (hostile to players / hostile to all, with force-level retaliation).

**Architecture:** Two new pure modules (`force-budget.mjs`, `force-hostility.mjs`) hold the budget split and the central `areHostile(combat, a, b)` relation over force ids. `dungeon-combat.mjs`'s disposition comparisons (opponents, allies, sneaker observers, side status) are routed through that relation; tokens carry `flags.pf2e-dungeon-crawl.forceId` and the combat carries a `forces` flag table. `generateEncounter` loops the existing swappable generator once per force (new filter params + `xpCapOverride`), and the existing dialog gains a repeatable force section. Tokens keep native hostile disposition, so the legacy single-force path is unchanged.

**Tech Stack:** Foundry VTT v13 module, plain ES modules (`.mjs`), Vitest (`npm test`).

**Spec:** `docs/superpowers/specs/2026-10-10-advanced-encounter-builder-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json` `version` (currently `0.94.11`; this is a feature → **minor** bump, re-read `origin/main`'s value at merge time and never reuse a number).
- Run the `update-architecture-docs` skill in the same pass (this plan adds `scripts/force-budget.mjs`, `scripts/force-hostility.mjs`, `scripts/encounter-forces-dialog.mjs` and new imports).
- PF2e rules are the source of truth: budgets come only from `xpBudget(tier, partySize)` / `xpFor` in `scripts/encounter-roster.mjs`; no house rules.
- Dungeon-room population (`skipThemeDialog`) keeps a single implicit force and must behave exactly as before.
- Work in a worktree off `origin/main`; `npm ci` (never symlink `node_modules`); copy `.env` before live testing.
- Combat flag key is `flags.pf2e-dungeon-crawl.forces`; token flag is `flags.pf2e-dungeon-crawl.forceId` (`MODULE_ID = "pf2e-dungeon-crawl"`).
- PR merges with an explicit `--subject/--body` (issue needs live playtest → label `verification`, see CLAUDE.md "Issue status").
- Out of scope (filed): presets #1223, named creatures #1222, mid-combat hostility change #1224, per-creature grudges #1225, per-force tiers #1226.

## Review Focus

- A force whose filters match nothing (e.g. level range above any creature, family typo) → empty roster with a message naming the force; other forces still spawn; all empty → abort, no combat started.
- Shares that don't sum to 100, a share of 0, or NaN/negative → dialog blocks Generate; `splitBudget` never returns a negative/NaN cap (odd partySize, rounding).
- Combat flag `forces` missing/malformed, or a token with no `forceId`/unknown force id → falls back to legacy disposition behavior (unknown force id ⇒ hostile to players).
- A player (party) attacking a `players`-mode force must not create a retaliation edge, and a force never becomes hostile to itself or its own members.
- A custom registered generator that ignores the new filter params → builder warns that the filter was unsupported rather than silently ignoring.
- Combat end: undead (`all`) and goblins (`players`) still alive while the party is down → defeat; goblins dead + undead dead → victory; a mixed fight where goblins killed the undead awards XP for both.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/force-budget.mjs` (new) | Pure: `splitBudget`, `validateShares`. |
| `scripts/force-hostility.mjs` (new) | Pure: `PARTY_FORCE`, `DEFAULT_FORCE`, `forceIdOf`, `areHostileForces`, `areHostile`, `withRetaliation`, `recordAttack`. |
| `scripts/encounter-roster.mjs` | `resolveEncounterRoster`/`pickCreature` gain `levelOffsetMin/Max`, `family`, `rarity`, `xpCapOverride`; returns `appliedFilters`. |
| `scripts/foundry-api.mjs` | `findCreatures` gains `family`, `rarity`; `spawnCreatures` gains `originOffsetCells`, `tint`, `nameSuffix`. |
| `scripts/dungeon-combat.mjs` | Route opponents/allies/observers/side status through `areHostile`; `startCombat` accepts a `forces` table; retaliation hook + calls. |
| `scripts/encounter-forces-dialog.mjs` (new) | Pure `defaultForce`, `forceSectionHtml`, `readForcesFromForm`; `chooseEncounterForces` DialogV2 wrapper. |
| `scripts/encounter-generator.mjs` | Multi-force orchestration in `generateEncounter`/`spawnEncounterTokens`. |
| `scripts/module.mjs` | Register `createChatMessage` retaliation hook. |
| `templates/encounter-chat.hbs`, `lang/en.json` | Force header + new strings. |
| `tests/*.test.mjs` | One test file per task (named below). |

---

### Task 1: Budget split (`force-budget.mjs`)

**Files:**
- Create: `scripts/force-budget.mjs`
- Test: `tests/force-budget.test.mjs`

**Interfaces:**
- Produces: `splitBudget(totalXp: number, shares: number[]) → number[]` (per-force XP caps, `floor(total*share/100)`, each ≥ 0 and finite); `validateShares(shares: number[]) → { ok: boolean, total: number }` (ok iff every share is a finite number > 0 and the sum is exactly 100).

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import { splitBudget, validateShares } from "../scripts/force-budget.mjs";
import { xpBudget } from "../scripts/encounter-roster.mjs";

describe("splitBudget", () => {
  it("a single 100% force gets the whole budget (legacy parity)", () => {
    expect(splitBudget(xpBudget("moderate", 4), [100])).toEqual([80]);
  });
  it("splits by percentage, flooring", () => {
    expect(splitBudget(80, [50, 50])).toEqual([40, 40]);
    expect(splitBudget(100, [33, 33, 34])).toEqual([33, 33, 34]);
    expect(splitBudget(xpBudget("low", 5), [50, 50])).toEqual([37, 37]); // 75 → 37,37
  });
  it("never returns negative or NaN", () => {
    expect(splitBudget(-5, [100])).toEqual([0]);
    expect(splitBudget(80, [NaN, 100])).toEqual([0, 80]);
  });
});

describe("validateShares", () => {
  it("accepts shares summing to 100", () => {
    expect(validateShares([60, 40])).toEqual({ ok: true, total: 100 });
  });
  it("rejects wrong sum, zero, negative and NaN shares", () => {
    expect(validateShares([60, 30]).ok).toBe(false);
    expect(validateShares([100, 0]).ok).toBe(false);
    expect(validateShares([120, -20]).ok).toBe(false);
    expect(validateShares([NaN, 100]).ok).toBe(false);
    expect(validateShares([]).ok).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify it fails** — `npx vitest run tests/force-budget.test.mjs` → FAIL (module not found).

- [x] **Step 3: Implement**

```js
/**
 * #1083: pure helpers for dividing one overall PF2e XP budget (xpBudget in
 * encounter-roster.mjs) across an encounter's opposing forces.
 */
const finite = (n) => (Number.isFinite(n) ? n : 0);

export function splitBudget(totalXp, shares) {
  const total = Math.max(0, finite(totalXp));
  return shares.map((s) => Math.max(0, Math.floor((total * Math.max(0, finite(s))) / 100)));
}

export function validateShares(shares) {
  const total = shares.reduce((sum, s) => sum + finite(s), 0);
  const ok =
    shares.length > 0 &&
    shares.every((s) => Number.isFinite(s) && s > 0) &&
    total === 100;
  return { ok, total };
}
```

- [x] **Step 4: Run to verify it passes** — same command → PASS.
- [x] **Step 5: Commit** — `git add scripts/force-budget.mjs tests/force-budget.test.mjs && git commit -m "#1083: force budget split helpers"`

---

### Task 2: Central hostility relation (`force-hostility.mjs`)

**Files:**
- Create: `scripts/force-hostility.mjs`
- Test: `tests/force-hostility.test.mjs`

**Interfaces:**
- Produces:
  - `PARTY_FORCE = "party"`, `DEFAULT_FORCE = "default"`.
  - `forceIdOf(combatant) → string`: token flag `flags["pf2e-dungeon-crawl"].forceId` if set; else `PARTY_FORCE` when `combatant.token?.disposition !== -1`; else `DEFAULT_FORCE`. Reads `combatant.token?.getFlag?.(MODULE_ID,"forceId") ?? combatant.token?.flags?.[MODULE_ID]?.forceId`.
  - `readForces(combat) → { [forceId]: { hostility: "players"|"all", hostileTo: string[] } } | null` (from `combat.getFlag?.(MODULE_ID,"forces")`, `null` if missing/not an object).
  - `areHostileForces(forces, fa, fb) → boolean` (pure): same force ⇒ false; either side `party`: the other is hostile (a force missing from table ⇒ treated as `players`) ⇒ true unless the other is also party; both non-party: true iff either has `hostility:"all"` or either lists the other in `hostileTo`; missing table ⇒ legacy: `fa !== fb` ⇒ hostile only if one is party and the other is not.
  - `areHostile(combat, a, b) → boolean` (combatants; `a.id === b.id` ⇒ false).
  - `withRetaliation(forces, attackerForce, victimForce) → forces` (pure, returns new table): no-op if table null, same force, victim is `party`, or victim force unknown; else adds `attackerForce` to victim's `hostileTo`, and (symmetric) adds `victimForce` to attacker force's `hostileTo` when the attacker force exists and has `hostility:"players"` (attacker `party` has no entry — skipped).
  - `async recordAttack(combat, attacker, victim)`: computes `withRetaliation`, and `combat.setFlag(MODULE_ID,"forces",next)` only if it changed; swallows+`console.error`s failures (never blocks).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from "vitest";
import {
  areHostile, areHostileForces, withRetaliation, recordAttack, forceIdOf,
} from "../scripts/force-hostility.mjs";

const M = "pf2e-dungeon-crawl";
const mk = (id, disposition, forceId) => ({
  id,
  token: { disposition, flags: forceId ? { [M]: { forceId } } : {} },
});
const forces = () => ({
  f1: { hostility: "all", hostileTo: [] },
  f2: { hostility: "players", hostileTo: [] },
  f3: { hostility: "players", hostileTo: [] },
});
const combatWith = (table) => ({ getFlag: (m, k) => (k === "forces" ? table : undefined), setFlag: vi.fn() });

describe("forceIdOf", () => {
  it("uses the token flag, else party/default by disposition", () => {
    expect(forceIdOf(mk("a", -1, "f2"))).toBe("f2");
    expect(forceIdOf(mk("a", 1))).toBe("party");
    expect(forceIdOf(mk("a", 0))).toBe("party");
    expect(forceIdOf(mk("a", -1))).toBe("default");
  });
});

describe("areHostileForces", () => {
  it("party is hostile to every force; never to itself", () => {
    expect(areHostileForces(forces(), "party", "f1")).toBe(true);
    expect(areHostileForces(forces(), "f2", "party")).toBe(true);
    expect(areHostileForces(forces(), "party", "party")).toBe(false);
  });
  it("same force never hostile", () => {
    expect(areHostileForces(forces(), "f1", "f1")).toBe(false);
  });
  it("'all' is hostile to other forces both ways; players-vs-players indifferent", () => {
    expect(areHostileForces(forces(), "f1", "f2")).toBe(true);
    expect(areHostileForces(forces(), "f2", "f1")).toBe(true);
    expect(areHostileForces(forces(), "f2", "f3")).toBe(false);
  });
  it("retaliation edge makes players forces hostile", () => {
    const t = forces();
    t.f2.hostileTo = ["f3"];
    expect(areHostileForces(t, "f2", "f3")).toBe(true);
    expect(areHostileForces(t, "f3", "f2")).toBe(true);
  });
  it("unknown force id is treated as hostile to players", () => {
    expect(areHostileForces(forces(), "ghost", "party")).toBe(true);
  });
  it("null table = legacy (party vs hostile only)", () => {
    expect(areHostileForces(null, "party", "default")).toBe(true);
    expect(areHostileForces(null, "default", "default")).toBe(false);
  });
});

describe("areHostile (combatants)", () => {
  it("uses force ids from tokens and the combat table", () => {
    const c = combatWith(forces());
    expect(areHostile(c, mk("u", -1, "f1"), mk("g", -1, "f2"))).toBe(true);
    expect(areHostile(c, mk("g1", -1, "f2"), mk("g2", -1, "f2"))).toBe(false);
    expect(areHostile(c, mk("p", 1), mk("g", -1, "f2"))).toBe(true);
    expect(areHostile(c, mk("p", 1), mk("p", 1))).toBe(false);
  });
  it("legacy combat without a table matches old disposition rule", () => {
    const c = combatWith(undefined);
    expect(areHostile(c, mk("p", 1), mk("m", -1))).toBe(true);
    expect(areHostile(c, mk("m1", -1), mk("m2", -1))).toBe(false);
  });
});

describe("withRetaliation / recordAttack", () => {
  it("goblins (players) attacked by undead: goblins become hostile to undead force", () => {
    const next = withRetaliation(forces(), "f1", "f2");
    expect(next.f2.hostileTo).toContain("f1");
  });
  it("symmetric when the attacker force is players-mode", () => {
    const next = withRetaliation(forces(), "f3", "f2");
    expect(next.f3.hostileTo).toContain("f2");
    expect(next.f2.hostileTo).toContain("f3");
  });
  it("party attacking never records an edge; victim party and same-force are no-ops", () => {
    const t = forces();
    expect(withRetaliation(t, "party", "f2")).toEqual(t);
    expect(withRetaliation(t, "f2", "party")).toEqual(t);
    expect(withRetaliation(t, "f2", "f2")).toEqual(t);
    expect(withRetaliation(null, "f1", "f2")).toBeNull();
  });
  it("does not mutate its input", () => {
    const t = forces();
    withRetaliation(t, "f1", "f2");
    expect(t.f2.hostileTo).toEqual([]);
  });
  it("recordAttack writes the flag only when the table changed, and swallows errors", async () => {
    const c = combatWith(forces());
    await recordAttack(c, mk("u", -1, "f1"), mk("g", -1, "f2"));
    expect(c.setFlag).toHaveBeenCalledTimes(1);
    const c2 = combatWith(forces());
    await recordAttack(c2, mk("p", 1), mk("g", -1, "f2"));
    expect(c2.setFlag).not.toHaveBeenCalled();
    const c3 = combatWith(forces());
    c3.setFlag.mockRejectedValue(new Error("boom"));
    await expect(recordAttack(c3, mk("u", -1, "f1"), mk("g", -1, "f2"))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/force-hostility.test.mjs` → FAIL.

- [ ] **Step 3: Implement**

```js
/**
 * #1083: the central "who is hostile to whom" relation for encounters with
 * several opposing forces. Pure except recordAttack's flag write.
 * Combatants carry a forceId token flag; the combat carries a `forces` table
 * { [forceId]: { hostility: "players" | "all", hostileTo: [forceId] } }.
 * No table (every legacy / dungeon-room combat) = the old disposition rule.
 */
const MODULE_ID = "pf2e-dungeon-crawl";
export const PARTY_FORCE = "party";
export const DEFAULT_FORCE = "default";

export function forceIdOf(combatant) {
  const token = combatant?.token;
  const flagged =
    token?.getFlag?.(MODULE_ID, "forceId") ?? token?.flags?.[MODULE_ID]?.forceId;
  if (flagged) return flagged;
  return token?.disposition === -1 ? DEFAULT_FORCE : PARTY_FORCE;
}

export function readForces(combat) {
  const table = combat?.getFlag?.(MODULE_ID, "forces");
  return table && typeof table === "object" ? table : null;
}

export function areHostileForces(forces, fa, fb) {
  if (fa === fb) return false;
  if (fa === PARTY_FORCE || fb === PARTY_FORCE) return true; // the other is a non-party force
  if (!forces) return false; // legacy: two non-party sides never fight each other
  const a = forces[fa] ?? { hostility: "players", hostileTo: [] };
  const b = forces[fb] ?? { hostility: "players", hostileTo: [] };
  return (
    a.hostility === "all" ||
    b.hostility === "all" ||
    (a.hostileTo ?? []).includes(fb) ||
    (b.hostileTo ?? []).includes(fa)
  );
}

export function areHostile(combat, a, b) {
  if (!a || !b || a.id === b.id) return false;
  return areHostileForces(readForces(combat), forceIdOf(a), forceIdOf(b));
}

export function withRetaliation(forces, attackerForce, victimForce) {
  if (!forces || attackerForce === victimForce || victimForce === PARTY_FORCE) return forces;
  if (!forces[victimForce]) return forces;
  const next = structuredClone(forces);
  const add = (id, other) => {
    const list = next[id].hostileTo ?? (next[id].hostileTo = []);
    if (!list.includes(other)) list.push(other);
  };
  add(victimForce, attackerForce);
  if (next[attackerForce]?.hostility === "players") add(attackerForce, victimForce);
  return next;
}

export async function recordAttack(combat, attacker, victim) {
  try {
    const forces = readForces(combat);
    const next = withRetaliation(forces, forceIdOf(attacker), forceIdOf(victim));
    if (next === forces || JSON.stringify(next) === JSON.stringify(forces)) return;
    await combat.setFlag(MODULE_ID, "forces", next);
  } catch (err) {
    console.error(`${MODULE_ID} | #1083: recording retaliation failed:`, err?.message ?? err);
  }
}
```

Note: `withRetaliation` returns the *same object* when it no-ops, so `next === forces` short-circuits before the JSON compare; the `toEqual` assertions in the test hold either way.

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add scripts/force-hostility.mjs tests/force-hostility.test.mjs && git commit -m "#1083: central force hostility relation"`

---

### Task 3: Per-force creature filters in the roster + creature listing

**Files:**
- Modify: `scripts/encounter-roster.mjs` (`pickCreature` ~142-181, `resolveEncounterRoster` ~228-, return value)
- Modify: `scripts/foundry-api.mjs` (`findCreatures` ~215-300)
- Test: `tests/encounter-roster-force-filters.test.mjs` (follow the mocking style of `tests/encounter-roster.test.mjs`; read it first)

**Interfaces:**
- Consumes: `xpBudget`, `xpFor` (existing).
- Produces: `resolveEncounterRoster({ ..., levelOffsetMin = null, levelOffsetMax = null, family = null, rarity = null, xpCapOverride = null })`. Semantics:
  - `levelOffsetMin/Max`: the picked creature's level must lie in `[partyLevel+min, partyLevel+max]` (null = unbounded). Intersects the slot's own level window; applied in **every** fallback `look`.
  - `family`/`rarity` are passed through to `api.findCreatures({ family, rarity })` in every `look`; `rarity` is an exact match (`"common"|"uncommon"|"rare"|"unique"`); `family` is a case-insensitive equality match against the creature's family value.
  - `xpCapOverride` (number): replaces `xpCap` (still `null` → no cap only when both it and `partySize` are null). `xpCapOverride === 0` yields an empty roster **without** the "empty roster takes -4" fallback (a zero-share force gets nothing; also guards the lower clamp: `fitOffset` returns `null` for cap 0).
  - The returned roster gains `appliedFilters: string[]` — the subset of `["levelRange","family","rarity","xpCapOverride"]` this resolver honored (always all four). A custom generator that omits `appliedFilters` is treated as supporting none (Task 7 warns).
- `api.findCreatures` gains `family` and `rarity` options; the index `fields` list gains `"system.traits.rarity"` and the family field (see Step 1 probe), and returned entries gain `rarity` and `family`.

- [ ] **Step 1: Probe where PF2e stores creature family** (planning left this open)

Run (needs `PF2E_SYSTEM_PACKS_DIR` from `.env`/README):
`ls "$PF2E_SYSTEM_PACKS_DIR"/pathfinder-monster-core/_source 2>/dev/null | head -3`, then `grep -o '"family"[^,]*' -r "$PF2E_SYSTEM_PACKS_DIR"/pathfinder-monster-core/_source | head -5` and `grep -rl 'details.family\|"family"' ... | head`. Record the exact JSON path in this plan's `FAMILY_FIELD` constant below. **If no NPC carries a family field in the data**, STOP and ask the owner: the spec's family filter then needs a different source (e.g. name-prefix match), which is a scope decision, not a coding detail. If found (expected: `system.details.family`... verify, do not assume), proceed using the verified path in place of `system.details.family` everywhere below.

- [ ] **Step 2: Write the failing tests**

Using a fake `api.findCreatures` that records its args and returns a pool filtered by the args (copy the helper pattern from `tests/encounter-roster.test.mjs`), assert:

```js
it("passes family/rarity through every fallback look", async () => {
  const calls = [];
  const api = { findCreatures: async (q) => { calls.push(q); return []; } };
  await resolveEncounterRoster({ resolved: oneFoeSlot, api, partyLevel: 3, partySize: 4,
    family: "Goblin", rarity: "common", xpCapOverride: 40 });
  expect(calls.length).toBeGreaterThan(1);
  for (const q of calls) { expect(q.family).toBe("Goblin"); expect(q.rarity).toBe("common"); }
});
it("clamps the level window to the party-relative range", async () => {
  const calls = [];
  const api = { findCreatures: async (q) => { calls.push(q); return []; } };
  await resolveEncounterRoster({ resolved: oneFoeSlot, api, partyLevel: 5, partySize: 4,
    levelOffsetMin: -1, levelOffsetMax: 1, xpCapOverride: 80 });
  for (const q of calls) { expect(q.minLevel).toBeGreaterThanOrEqual(4); expect(q.maxLevel).toBeLessThanOrEqual(6); }
});
it("xpCapOverride replaces the depth-bias cap", async () => { /* 2 foe slots at offset 0 (40 xp each), override 40 → exactly one foe */ });
it("xpCapOverride 0 yields an empty roster (no -4 fallback)", async () => { /* roster.foes.length === 0 */ });
it("appliedFilters lists all four supported filters", async () => { /* expect(roster.appliedFilters).toEqual([...]) */ });
it("no new params = identical result to today (regression)", async () => { /* same fixtures as an existing test */ });
```

Write each body fully, reusing the file's existing `oneFoeSlot`-style fixtures (create them from the shape `dealEncounter` produces: `{ foes: [{ levelOffset: 0, countsAs: 1 }] }`). Add a `foundry-api` test only if a `findCreatures` test file already exists; otherwise cover `findCreatures` filtering through a pure extracted predicate `creatureMatchesFilters(entry, { family, rarity })` exported from `foundry-api.mjs`'s neighbor — **put it in `scripts/encounter-roster.mjs`** and unit-test it there (case-insensitive family equality, exact rarity, `null` = no constraint).

- [ ] **Step 3: Run to verify they fail** — `npx vitest run tests/encounter-roster-force-filters.test.mjs`.

- [ ] **Step 4: Implement**
  1. `encounter-roster.mjs`: add and export `creatureMatchesFilters`; add the new params to `pickCreature` (compute `minLevel = Math.max(minLevel, partyLevel+levelOffsetMin)`, `maxLevel = Math.min(maxLevel, partyLevel+levelOffsetMax)` when non-null) and pass `family`/`rarity` in `look`; thread the params through `resolveEncounterRoster`'s two `pickCreature` call sites (`pick` and `pickWithinCap`). Set `const xpCap = xpCapOverride ?? (partySize != null ? xpBudget(capTier, partySize) : null)`; in `fitOffset` return `null` immediately when `xpCap === 0`; in `pickWithinCap` the "empty roster takes -4 / nominal pick" fallbacks must not run when `xpCap === 0`. Add `appliedFilters` to the returned object.
  2. `foundry-api.mjs findCreatures`: add `family = null, rarity = null` options, request `system.traits.rarity` and the verified family field in `fields`, filter with `creatureMatchesFilters`, include `rarity`/`family` in `found.push`.
- [ ] **Step 5: Run the new file + `npx vitest run tests/encounter-roster.test.mjs tests/encounter-generator.test.mjs`** → all PASS.
- [ ] **Step 6: Commit** — `git commit -am "#1083: per-force level range, family, rarity and budget override in roster resolution"` (add new test file).

---

### Task 4: Route combat logic through `areHostile`; combat gets a forces table

**Files:**
- Modify: `scripts/dungeon-combat.mjs` — `rollStealthInitiativeAndDetect` observer set (~330-340), `combatSideStatus` (~644), `combatantOpponents` (~1303), `combatantAllies` (~1359), `startCombat` (~219-244) and `startCombatForEncounterId` (~588)
- Test: `tests/dungeon-combat-forces.test.mjs`; existing `tests/dungeon-combat-side-status.test.mjs` must keep passing unmodified.

**Interfaces:**
- Consumes: `areHostile`, `forceIdOf`, `PARTY_FORCE` from Task 2.
- Produces: `startCombatForEncounterId(scene, encounterId, { forces = null } = {})` (when `forces` is given the new Combat gets `combat.setFlag(MODULE_ID, "forces", forces)` **before** `rollStealthInitiativeAndDetect`); `combatSideStatus(combat)` keeps its `{ hostilesDefeated, partyDefeated }` shape.

Behavior to implement:
- `combatantOpponents(combat, c)`: `combat.combatants.filter(o => o.id !== c.id && !o.isDefeated && o.token && areHostile(combat, c, o))`.
- `combatantAllies(combat, c)`: `o.id !== c.id && !o.isDefeated && o.token && forceIdOf(o) === forceIdOf(c)` — **not** `!areHostile` (a neutral/other force is not an ally). Legacy parity: old rule was same disposition; the legacy `forceIdOf` yields `party` for dispositions ≠ -1, which now groups neutral(0) with friendly(+1). Neutral tokens are already counted in the party bucket by `combatSideStatus`, but `combatantAllies`/`Opponents` used raw disposition (0 ≠ 1 ⇒ opponents). To avoid changing legacy behavior, make `forceIdOf` unchanged but in the **legacy (no table) branch of both helpers keep the original disposition comparison** — i.e. guard: `if (!readForces(combat)) return <old expression>`.
- `combatSideStatus`: partition exactly as today (`token.disposition === -1` ⇒ hostile bucket, else party); additionally, when a forces table exists, `hostilesDefeated` stays "every hostile-bucket combatant is defeated". (Because the party is hostile to every force, this equals the spec's "no hostile pair left" rule; a regression test pins that equivalence.)
- Observer set in `rollStealthInitiativeAndDetect`: when a table exists, `hostiles = combatants.filter(c => !sneakerIds.has(c.id) && !partyIds.has(c.actor?.id) && sneakers.some(s => areHostile(combat, s, c)))`; otherwise keep the existing disposition expression.
- Do **not** change the `disposition:` copies in the move-payload builders (~4585/4613); they are debug data.

- [ ] **Step 1: Write failing tests** (`tests/dungeon-combat-forces.test.mjs`). `combatantOpponents`/`combatantAllies` are not exported; export them (`export function`) as part of this task, as other helpers in the file are. Cases, with a fake combat `{ combatants, getFlag }`:
  - Multi-force: party P, undead U (`all`), goblin G (`players`): `combatantOpponents(P)` = [U,G]; `(U)` = [P,G]; `(G)` = [P,U]. Add a second goblin G2: `combatantAllies(G)` = [G2], `combatantOpponents(G)` excludes G2.
  - After setting `forces.f2.hostileTo=["f3"]` for two `players` forces, they become opponents.
  - Legacy (no table): output identical to the old disposition rule for dispositions -1/0/+1 (copy the old expressions into the test as the oracle).
  - `combatSideStatus` with a table: goblins+undead all defeated, party up → `hostilesDefeated: true`; undead alive → false; all party down → `partyDefeated: true`.
  - `startCombatForEncounterId` passes `forces` through: stub `Combat.create` / `setFlag` as other `startCombat` tests do (grep `tests/` for `Combat.create` to reuse the harness) and assert `setFlag(MODULE_ID,"forces", table)` is called before `rollInitiative`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** as specified above; import from `./force-hostility.mjs`.
- [ ] **Step 4: Run** `npx vitest run tests/dungeon-combat-forces.test.mjs tests/dungeon-combat-side-status.test.mjs tests/dungeon-combat-downed-targets.test.mjs` then the whole suite `npm test` → PASS (this file is 11k lines and widely tested; any failure here is a regression to fix, not to skip).
- [ ] **Step 5: Commit** — `git commit -am "#1083: route combat opponents/allies/observers through force hostility"`.

---

### Task 5: Retaliation hooks

**Files:**
- Modify: `scripts/dungeon-combat.mjs` — new exported `handleAttackForRetaliation(message)`; calls in `rollAndApplyStrike` (~5317) and `rollAndApplyStrikeAtVariant` (~7688)
- Modify: `scripts/module.mjs` (~810-823) — `Hooks.on("createChatMessage", handleAttackForRetaliation)`
- Test: `tests/dungeon-combat-retaliation.test.mjs`

**Interfaces:**
- Consumes: `recordAttack`, `readForces` (Task 2).
- Produces: `handleAttackForRetaliation(message)`: active-GM-only; ignores messages whose `flags.pf2e.context.type` is not `"attack-roll"` or `"damage-roll"`; resolves attacker combatant from `message.speaker.token` and victim from `context.target.token` (`.split(".").pop()`, same as `handleAttackRollForReactions` ~3023-3040) in the module combat on that scene (`isModuleCombat`); returns early when the combat has no `forces` table; otherwise `await recordAttack(combat, attacker, victim)`.

- [ ] **Step 1: Write failing tests**: message fixtures shaped like the pf2e ones used in `tests/dungeon-combat-*reaction*.test.mjs` (grep for `attack-roll` fixtures and copy the harness). Cases: undead hits goblin ⇒ goblin force `hostileTo` gains `f1`; party hits goblin ⇒ no `setFlag`; message with no target ⇒ no-op; no forces table ⇒ no-op; non-GM client ⇒ no-op; a miss still counts (attack-roll with outcome `failure`).
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement.** In the two AI strike functions add `await recordAttack(combat, combatant, target)` right after the target is resolved (before rolling) — idempotent and cheap; guard so it only runs when `readForces(combat)` is non-null.
- [ ] **Step 4: Run** `npx vitest run tests/dungeon-combat-retaliation.test.mjs` then `npm test`.
- [ ] **Step 5: Commit** — `git commit -am "#1083: force-level retaliation on attack"`.

---

### Task 6: Force dialog helpers and UI (`encounter-forces-dialog.mjs`)

**Files:**
- Create: `scripts/encounter-forces-dialog.mjs`
- Modify: `lang/en.json` (new `PF2EDC.Encounter.Force*` keys, alphabetically placed like the neighbors)
- Test: `tests/encounter-forces-dialog.test.mjs`

**Interfaces:**
- Consumes: `traitFieldHtml`, `wireTraitPickerButtons`, `readTraitField` (`scripts/trait-picker.mjs`), `validateShares` (Task 1).
- Produces:
  - `defaultForce(index, overrides = {}) → Force` with `{ id: "f"+(index+1), name: "", hostility: "players", share: 100, filters: { traits: [], excludeTraits: [], levelOffsetMin: null, levelOffsetMax: null, family: "", rarity: "" }, placement: { mode: "nearParty" } }`.
  - `equalShares(n) → number[]` (sums to 100; remainder added to the first force, e.g. 3 → `[34,33,33]`).
  - `normalizeForce(raw, index) → Force` (coerces strings from the form: numeric offsets or `null` for `""`, `Number(share)`, trims `family`, unknown `hostility`→`"players"`, unknown `rarity`→`""`).
  - `forceSectionHtml(force, index, { traitsLabel, ... })` → HTML string with `data-force="<id>"` on a `<fieldset>`, inputs named `force-<id>-name|hostility|share|levelMin|levelMax|family|rarity|placement`, trait fields named `traits-<id>` / `excludeTraits-<id>`.
  - `readForcesFromForm(root) → Force[]` (reads every `fieldset[data-force]`; uses `readTraitField(root, "traits-<id>")`).
  - `async chooseEncounterForces({ api, scene }) → { difficulty, forces } | null` — the DialogV2 wrapper: difficulty select (existing keys), force 1 prefilled, **Add force** / **Remove** buttons that re-render the force list, a read-only budget line (`xpBudget(tier, partySize)` and each force's `splitBudget` allotment; recomputed on input), Generate disabled-with-message when `validateShares` fails. Placement select offers "Near party" plus one option per `scene.regions` entry (value `region:<id>`; resolved to a rect in Task 7).

- [ ] **Step 1: Write failing tests** for the pure parts: `defaultForce`/`equalShares([1,2,3])`, `normalizeForce` coercions, `forceSectionHtml` contains the expected `name=` attributes and the selected hostility/rarity (parse with `new DOMParser()` only if vitest env is jsdom — check `vitest.config.*`; otherwise assert on substrings), `readForcesFromForm` against a minimal fake root (`querySelectorAll`, `querySelector(name)` returning `{ value }`) — mirror how `tests/trait-picker*.test.mjs` fakes the DOM if it exists.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** the pure helpers + the `chooseEncounterForces` wrapper (not unit-tested; covered by live verification, Task 9). Reuse the existing dialog's markup, `PF2EDC.Encounter.*` keys and trait pickers; keep force 1's layout identical to today's dialog so a one-force encounter looks unchanged.
- [ ] **Step 4: Run** `npx vitest run tests/encounter-forces-dialog.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "#1083: encounter force dialog helpers and UI"`.

---

### Task 7: Multi-force generation and spawning

**Files:**
- Modify: `scripts/encounter-generator.mjs` (`chooseThemeAndSize` replaced by `chooseEncounterForces` for the stand-alone path; `generateEncounter`, `spawnEncounterTokens`, `postEncounterChatCard`)
- Modify: `scripts/foundry-api.mjs` `spawnCreatures` (new options)
- Modify: `templates/encounter-chat.hbs`, `lang/en.json`
- Test: `tests/encounter-generator-forces.test.mjs` (extend the harness in `tests/encounter-generator.test.mjs` — read it first and reuse its global stubs for `game`, `canvas`, `foundry`, `renderTemplate`)

**Interfaces:**
- Consumes: `splitBudget`/`validateShares` (T1), `startCombatForEncounterId(scene, id, { forces })` (T4), `chooseEncounterForces` (T6), `resolveEncounterRoster` new params + `appliedFilters` (T3).
- Produces:
  - Exported pure `buildForceTable(forces) → { [id]: { hostility, hostileTo: [] } }`.
  - Exported `FORCE_TINTS` (≥ 6 hex colors) and `forceTint(index)`.
  - `spawnCreatures(entries, { ..., originOffsetCells = null, tint = null, nameSuffix = null })`: `originOffsetCells {dx,dy}` shifts the non-area origin by that many grid cells before the free-spot search; `tint` sets `obj.texture.tint`; `nameSuffix` sets `obj.name = \`${obj.name} (${nameSuffix})\`` and stores the original in `extraFlags`-merged flag `originalName`.

Behavior in `generateEncounter`:
1. If `skipThemeDialog`: build exactly one implicit force from `prefillTraits`/`prefillExcludeTraits`, **no `forces` table, no `forceId` flag, no `xpCapOverride`** — the existing code path, byte-for-byte behavior preserved (this is the regression guard).
2. Else call `chooseEncounterForces`; cancel → return. Compute `total = xpBudget(difficulty, partySize)`, `caps = splitBudget(total, shares)`.
3. For each force `i`: `seed_i = \`${seed}-${force.id}\``; deal `dealEncounter(deckSlots, { seed: seed_i, partySize })`; `roster_i = await getGenerator().generateEncounterRoster({ resolved, api, partyLevel, traits, excludeTraits, levelOffsetMin, levelOffsetMax, family, rarity, xpCapOverride: caps[i], levelOffsetBias, requireTrait: locationTag, partySize, isBoss, depthBias: null })`. Requested-but-not-applied filters (a requested value that is non-empty and whose name is missing from `roster_i.appliedFilters ?? []`) append a warning `PF2EDC.Encounter.ForceFilterUnsupported`. A force with `roster_i.foes.length === 0` (and no friend/twins/lurker) gets `ui.notifications.warn(PF2EDC.Encounter.ForceEmpty {name})` and is dropped; if all are dropped → warn and `return` (no combat). Only force 1 may keep `friend/twins/lurker` (strip them from other forces' rosters).
4. One chat card per surviving force (`postEncounterChatCard(api, roster, force)`; template shows `force.name` header when given).
5. Spawn: for each surviving force `spawnEncounterTokens(api, roster, partyMembers, { ..., extraFlags: merge(flags, { [MODULE_ID]: { forceId, forceName } }), tint, nameSuffix: force.name || null, originOffsetCells, originArea })`, where nearParty forces get offsets `[{0,0},{4,0},{-4,0},{0,4},{0,-4},{4,4}][i % 6]` and a `region:<id>` placement resolves `scene.regions.get(id)` bounds to `originArea {x,y,width,height}` (unlike dungeon rooms this does **not** trigger the cover-items/`!originArea` combat-start branches — use a separate local `placementArea` variable, keep the function's `originArea` parameter semantics untouched).
6. Start combat once: `startCombatForEncounterId(scene, encounterId, { forces: buildForceTable(survivingForces) })`.

- [ ] **Step 1: Write failing tests** (mocked generator, `api.spawnCreatures` spy, `startCombatForEncounterId` mocked via `vi.mock("../scripts/dungeon-combat.mjs")`):
  - Two forces 50/50 on Moderate/4 PCs ⇒ generator called twice with `xpCapOverride` 40 and 40 and different `resolved` seeds; force filters passed through (`traits:["undead"]`, `family:"goblin"`…).
  - `spawnCreatures` is called with `extraFlags[MODULE_ID].forceId === "f1"/"f2"`, `disposition:-1` for both, distinct `originOffsetCells`, distinct `tint`.
  - Empty force ⇒ warning naming it, other force still spawns, table contains only survivors; all empty ⇒ no spawn, `startCombatForEncounterId` not called.
  - Generator returning no `appliedFilters` ⇒ unsupported warning.
  - `skipThemeDialog: true` ⇒ generator called once **without** `xpCapOverride`/`forceId` flag and `startCombatForEncounterId` not given `forces` (parity with the existing tests, which must still pass unmodified).
  - `buildForceTable`: `{ f1:{hostility:"all",hostileTo:[]}, f2:{hostility:"players",hostileTo:[]} }`.
  - friend/twin/lurker kept on force 1 only.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** per the behavior list; add lang keys `ForceEmpty`, `ForceFilterUnsupported`, `ForceCardHeader`.
- [ ] **Step 4: Run** `npx vitest run tests/encounter-generator-forces.test.mjs tests/encounter-generator.test.mjs tests/foundry-api-spawn-choice-set.test.mjs` then `npm test`.
- [ ] **Step 5: Commit** — `git commit -am "#1083: multi-force encounter generation and spawning"`.

---

### Task 8: Label/tint cleanup at combat end; XP regression

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`resolveCombat` ~790-1000: restore surviving tokens' name/tint before they are deleted/kept; or the `deleteCombat` hook in `scripts/module.mjs` ~827)
- Test: `tests/dungeon-combat-force-cleanup.test.mjs`; extend `tests/combat-rewards.test.mjs` and `tests/dungeon-combat-auto-defeat.test.mjs`

**Interfaces:**
- Consumes: token flags `originalName`, `forceId` (T7).
- Produces: exported `clearForceDecorations(combat)`: for each combatant token with a `forceId` flag, `token.update({ name: originalName ?? name, "texture.tint": null })` (skip tokens already deleted); active-GM only; errors logged, never thrown. Called from the existing `deleteCombat` hook (module.mjs) beside `clearDetection`.

- [ ] **Step 1: Failing tests**: cleanup restores name and clears tint only on forceId-flagged tokens; no-op for legacy tokens; swallowed update error.
- [ ] **Step 2: XP regression** (in `tests/dungeon-combat-auto-defeat.test.mjs` harness): a victory where the party is up and both an `all` force creature and a `players` force creature are defeated (the undead's `isDefeated` set by "someone else") awards `totalCombatXp` over **both** levels. Expect this test to PASS without a code change — `defeatedHostileCombatants` already counts every `disposition === -1` defeated creature regardless of killer. If it fails, fix `resolveCombat` (~810) instead of weakening the test.
- [ ] **Step 3: Run, implement cleanup, verify PASS**, `npm test`.
- [ ] **Step 4: Commit** — `git commit -am "#1083: clear force labels/tints at combat end; pin XP behavior"`.

---

### Task 9: Docs, version, live verification

**Files:**
- Modify: `module.json` (minor bump from the then-current `origin/main` value), `docs/architecture.md` via the `update-architecture-docs` skill, `README.md` (Generate Encounter section: forces, hostility modes, retaliation, PF2e flanking limitation from the spec), `docs/backlog.md` if it tracks this item.

- [ ] **Step 1:** Run `npm test` (full) → PASS.
- [ ] **Step 2:** Invoke the `update-architecture-docs` skill; commit its output.
- [ ] **Step 3:** Bump `module.json`; add the README section; commit.
- [ ] **Step 4: Live verification** (copy `.env` into the worktree; compare the live world's module version with the branch's `module.json` first, per memory notes). In a stand-alone scene with a 4-PC party, Moderate difficulty:
  1. Add force 1 = trait `undead`, **Hostile to all**, share 50; force 2 = trait `goblin` (or family Goblin), **Hostile to players**, share 50. Generate: two chat cards, per-force name labels and tints, no stacked spawn locations; combat starts once.
  2. Let the AI run: undead attack goblins *and* the party; goblins attack the party and do **not** attack the undead until an undead hits one — then they fight back (check `combat.getFlag("pf2e-dungeon-crawl","forces")` shows `f2.hostileTo` containing `f1`).
  3. A PC attacking the goblins never adds a retaliation edge. Kill all goblins and undead ⇒ combat ends "victory" once; XP awarded once for both forces' creatures. Leave one force alive and down the party ⇒ defeat.
  4. A force with an impossible filter (family "zzz") ⇒ warning naming it, the other force still spawns.
  5. Dungeon-run room fight and a one-force stand-alone encounter behave exactly as before; token names/tints restored after combat.
  6. Note in the PR: PF2e's flank indicator may count other-force creatures as allies (documented limitation).
- [ ] **Step 5:** Open the PR (no closing keyword; label `verification` after merge; remove `claimed`/`in progress`).

---

## Self-Review

**Spec coverage:** force model/dialog (T6), budget split + generation + empty/unsupported handling + per-force cards (T1, T3, T7), spawning/placement/labels/tints (T7, T8), hostility relation + retaliation + all call sites listed in the spec (T2, T4, T5; area-spell ally-awareness and the AI decision context use `combatantOpponents/Allies` — call sites at ~4453-4474, ~5578, ~10548-11054 go through those helpers, so T4 covers them), combat-end (T4 — shown equivalent to the old rule because the party is hostile to every force), XP (T8 regression; behavior already satisfies the spec), error handling fallbacks (T2/T4/T7), tests (each task), live verification (T9). Spec's open questions resolved: retaliation hooks into `createChatMessage` attack/damage-roll messages plus the two AI strike paths; region picker uses `scene.regions`; family source is probed in T3 Step 1 (owner decision gate if absent); tint via `texture.tint`.

**Placeholders:** none; the only conditional is T3 Step 1's explicit stop-and-ask gate.

**Type consistency:** `Force` shape (T6) → `buildForceTable`/`splitBudget`/`validateShares` (T7/T1); `forces` table shape `{hostility, hostileTo}` consistent in T2/T4/T5/T7; `forceId`/`forceName`/`originalName` flags consistent in T7/T8; `startCombatForEncounterId(scene, id, { forces })` consistent in T4/T7.
