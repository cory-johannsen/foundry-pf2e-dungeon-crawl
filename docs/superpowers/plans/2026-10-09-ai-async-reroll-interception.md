# Asynchronous Reroll Interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reroll/two-roll reactions (Cat's Luck, Shift Fate, Distracting Frolic) apply to a SYSTEM-OWNED roll (a player's own check) without the player ever seeing the pre-reaction result — the gap #963's synchronous `preCreateChatMessage` hook can't close, since a reroll needs a second async roll to complete before any message is created.

**Architecture:** Extends #1034's own `installCheckRollWrapper` (not a third system-method-wrap instance) with a second, independent hook option: a `rerollDecider(check, context)` that, when it decides a reroll applies, calls the REAL, original `Check.roll` TWICE with `createMessage: false` (confirmed real option `Check.roll` itself reads) — once plain, once with `isReroll: true` (confirmed real field `Check.roll` itself reads) — picks the better/worse result with #960's own real `better`/`worse` helpers, and posts exactly ONE final chat message by calling `Roll#toMessage` (Foundry's own real API) on the winning roll. The player's browser never renders an intermediate card.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** No dedicated spec file exists for #1035 — scoped by `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md`'s (#963's) own deferred-items framing and the issue body.

## Global Constraints

- **Depends on #1034's own `installCheckRollWrapper` landing first** — this plan extends that exact function's options rather than wrapping `Check.roll` a second, independent time (which would risk double-wrapping or an undefined call order between two separate wrappers).
- **`Check.roll`'s own return value when `createMessage: false` is passed is assumed to be the evaluated `Roll` instance** (consistent with Foundry's own convention of separating "evaluate" from "post"), but was not independently confirmed live this session — flagged explicitly for confirmation at implementation time (Investigation finding 2), with the surrounding logic fully written around that assumption rather than left vague.
- **#960's own `better`/`worse` helpers** (`scripts/npc-reactions-saves.mjs`, still plan-only per that plan) are reused by name for the module-owned semantics' consistency; this plan's own system-owned path reimplements the same two one-line comparisons locally if #960 hasn't merged yet, rather than blocking on it, and notes the duplication plainly.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`context.isReroll` is a real, confirmed field `Check.roll` itself reads** (confirmed by reading the real, installed PF2e system source during #1034's own research) — this plan passes it on the second roll so the system's own reroll-flavor text (if any) applies correctly, rather than two indistinguishable plain rolls.
2. **`createMessage: false` is the real, confirmed option gating `Check.roll`'s own final `toMessage` call** — `roll.toMessage({...}, {create: context.createMessage})`. Calling `Check.roll` with `createMessage: false` is therefore the correct way to get an evaluated roll with no card posted; what is NOT independently confirmed is the exact shape of `Check.roll`'s own RETURN value in that case (the evaluated `CheckRoll` itself, or a wrapper object around it) — flagged for live confirmation (Global Constraints).
3. **The real, confirmed GM-confirm-card async-hold pattern** (`postReactionConfirmCard`/`answerReactionConfirm`, `dungeon-combat.mjs`, confirmed real this session) solves a DIFFERENT problem (deferring a consequence after the player already sees their own roll) and is NOT reused here — #1035's own requirement (the player never sees the pre-reaction result) is strictly harder and needs the double-roll-before-any-message approach instead, stated explicitly so a future reader doesn't mistake the GM-confirm pattern for a fit.

## Review Focus

- The player must see exactly ONE chat message for a reroll-eligible check, never two (one suppressed, one shown) and never zero (Task 2's test).
- A check that does NOT qualify for a reroll reaction must behave byte-for-byte as it does today — one roll, one message, `createMessage` defaulting to whatever the caller already passed (Task 1's test).
- The SECOND roll must carry `isReroll: true` so the system's own reroll bookkeeping (if any) stays correct — never a second plain roll indistinguishable from the first (Task 2's test).
- If the reroll decision logic itself throws, the wrapper must fall back to a single normal roll (call through to the original exactly once, with the caller's own original `createMessage`), never leave the player with no roll at all (Task 2's test).
- `better`/`worse`'s own selection must be deterministic given two fixed `total`s — no silent coin-flip on a tie (favor the first roll on an exact tie, stated explicitly) (Task 2's test).

---

### Task 1: Extend `installCheckRollWrapper` with a `rerollDecider` option

**Files:**
- Modify: `scripts/check-roll-intercept.mjs` (#1034)
- Test: `tests/check-roll-intercept.test.mjs`

**Interfaces:**
- Consumes: `installCheckRollWrapper` (#1034, extended in place — same exported function, new optional parameter, fully backward compatible).
- Produces: the extended `installCheckRollWrapper({checkClass, intercept, rerollDecider})`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/check-roll-intercept.test.mjs (append)
describe('installCheckRollWrapper with rerollDecider (#1035)', () => {
  it('behaves exactly as #1034\'s own wrapper when rerollDecider is omitted', async () => {
    const original = vi.fn().mockResolvedValue('rolled');
    const checkClass = { roll: original };
    installCheckRollWrapper({ checkClass });
    const result = await checkClass.roll({ slug: 'reflex' }, { dc: { value: 15 } });
    expect(original).toHaveBeenCalledTimes(1);
    expect(result).toBe('rolled');
  });

  it('rolls twice with createMessage:false and posts once when rerollDecider applies', async () => {
    const rollA = { total: 10, toMessage: vi.fn().mockResolvedValue(undefined) };
    const rollB = { total: 18, toMessage: vi.fn().mockResolvedValue(undefined) };
    const original = vi.fn().mockResolvedValueOnce(rollA).mockResolvedValueOnce(rollB);
    const checkClass = { roll: original };
    installCheckRollWrapper({
      checkClass,
      rerollDecider: () => ({ reroll: true, pick: (a, b) => (b.total >= a.total ? b : a) }),
    });
    const result = await checkClass.roll({ slug: 'reflex' }, { dc: { value: 15 }, createMessage: true });
    expect(original).toHaveBeenCalledTimes(2);
    expect(original.mock.calls[0][1]).toMatchObject({ createMessage: false });
    expect(original.mock.calls[1][1]).toMatchObject({ createMessage: false, isReroll: true });
    expect(rollB.toMessage).toHaveBeenCalledTimes(1);
    expect(rollA.toMessage).not.toHaveBeenCalled();
    expect(result).toBe(rollB);
  });

  it('falls back to a single normal roll when rerollDecider itself throws', async () => {
    const original = vi.fn().mockResolvedValue('rolled');
    const checkClass = { roll: original };
    installCheckRollWrapper({ checkClass, rerollDecider: () => { throw new Error('boom'); } });
    const result = await checkClass.roll({ slug: 'reflex' }, { createMessage: true });
    expect(original).toHaveBeenCalledTimes(1);
    expect(result).toBe('rolled');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: FAIL (the new option is ignored, double-roll assertions fail)

- [ ] **Step 3: Implement**

```js
// scripts/check-roll-intercept.mjs -- installCheckRollWrapper, extended
export function installCheckRollWrapper({
  checkClass = globalThis.game?.pf2e?.Check,
  intercept = () => null,
  rerollDecider = () => null,
} = {}) {
  if (typeof checkClass?.roll !== "function") return;
  if (checkClass.roll.__pf2edcWrapped) return;
  const original = checkClass.roll;
  async function wrapped(check, context, ...rest) {
    if (inIntercept) return original.call(checkClass, check, context, ...rest);
    try {
      inIntercept = true;
      let decision = null;
      try {
        decision = await rerollDecider(check, context);
      } catch (err) {
        console.error(`${MODULE_ID} | #1035: rerollDecider failed, falling back to a single roll:`, err?.message ?? err);
      }
      if (decision?.reroll) {
        // #1035: evaluate both rolls with no card posted, pick the winner,
        // post exactly one final message -- the player never sees the
        // suppressed roll. `Check.roll`'s own return value with
        // createMessage:false is assumed to be the evaluated Roll itself
        // (Global Constraints: unconfirmed live, flagged).
        const first = await original.call(checkClass, check, { ...context, createMessage: false }, ...rest);
        const second = await original.call(checkClass, check, { ...context, createMessage: false, isReroll: true }, ...rest);
        const winner = (decision.pick ?? ((a, b) => (b.total > a.total ? b : a)))(first, second);
        await winner.toMessage?.({}, { create: context.createMessage ?? true });
        return winner;
      }
      let adjustedContext = context;
      try {
        const result = await intercept(check, context);
        if (result) adjustedContext = { ...context, ...result };
      } catch (err) {
        console.error(`${MODULE_ID} | #1034: Check.roll interception failed:`, err?.message ?? err);
      }
      return original.call(checkClass, check, adjustedContext, ...rest);
    } finally {
      inIntercept = false;
    }
  }
  wrapped.__pf2edcWrapped = true;
  checkClass.roll = wrapped;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/check-roll-intercept.mjs tests/check-roll-intercept.test.mjs
git commit -m "feat(#1035): extend installCheckRollWrapper with an async rerollDecider"
```

---

### Task 2: Reroll eligibility for Cat's Luck, Shift Fate, Distracting Frolic (system-owned saves)

**Files:**
- Modify: `scripts/check-roll-intercept.mjs`
- Test: `tests/check-roll-intercept.test.mjs`

**Interfaces:**
- Produces: `rerollDeciderFor(combat)` → a `rerollDecider(check, context)` bound to that combat.

- [ ] **Step 1: Write the failing tests**

```js
// tests/check-roll-intercept.test.mjs (append)
import { rerollDeciderFor } from '../scripts/check-roll-intercept.mjs';

function combatant(id, { agentControlled = true, hasItem = null, disposition = 'hostile' } = {}) {
  return { id, isDefeated: false, token: { disposition }, actor: { items: hasItem ? [hasItem] : [] }, getFlag: (mod, key) => (key === 'agentControlled' ? agentControlled : undefined) };
}

describe('rerollDeciderFor (#1035)', () => {
  it('decides a reroll for Cat\'s Luck on the reactor\'s own failed Reflex save', async () => {
    const catsLuck = { name: "Cat's Luck", type: 'action', system: { actionType: { value: 'reaction' } } };
    const reactor = combatant('r1', { hasItem: catsLuck });
    const combat = { combatants: [reactor] };
    const decide = rerollDeciderFor(combat);
    const result = await decide({ slug: 'reflex' }, { dc: { value: 20 }, token: { combatant: reactor } });
    expect(result?.reroll).toBe(true);
  });

  it('returns null for a check with no eligible reroll reaction', async () => {
    const reactor = combatant('r1');
    const combat = { combatants: [reactor] };
    const decide = rerollDeciderFor(combat);
    const result = await decide({ slug: 'reflex' }, { token: { combatant: reactor } });
    expect(result).toBeNull();
  });

  it('on a tie, picks the FIRST roll (deterministic, no coin-flip)', async () => {
    const catsLuck = { name: "Cat's Luck", type: 'action', system: { actionType: { value: 'reaction' } } };
    const reactor = combatant('r1', { hasItem: catsLuck });
    const combat = { combatants: [reactor] };
    const decide = rerollDeciderFor(combat);
    const result = await decide({ slug: 'reflex' }, { token: { combatant: reactor } });
    const a = { total: 15 }, b = { total: 15 };
    expect(result.pick(a, b)).toBe(a);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: FAIL with "rerollDeciderFor is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/check-roll-intercept.mjs -- append
/** #1035: reroll eligibility for the system-owned (player-rolled) path --
 * Cat's Luck (own Reflex save), Shift Fate/Distracting Frolic (an
 * ally's/the reactor's own save, picked better or worse by allegiance).
 * `better`/`worse` are reimplemented locally (one line each) rather than
 * importing #960's own still-plan-only scripts/npc-reactions-saves.mjs,
 * to avoid blocking on an unmerged dependency; duplication noted here. */
function better(a, b) { return b.total >= a.total ? b : a; }
function worse(a, b) { return b.total <= a.total ? b : a; }

export function rerollDeciderFor(combat) {
  return (check, context) => {
    const saver = context?.token?.combatant;
    if (!saver) return null;
    for (const candidate of combat.combatants) {
      if (candidate.isDefeated || !candidate.getFlag?.("pf2e-dungeon-crawl", "agentControlled")) continue;
      const items = Array.from(candidate.actor?.items ?? []);
      const isSelf = candidate.id === saver.id;
      const isAlly = !isSelf && candidate.token?.disposition === saver.token?.disposition;
      if (isSelf && items.some((i) => i.name === "Cat's Luck") && check.slug === "reflex") {
        return { reroll: true, pick: better };
      }
      if ((isSelf || isAlly) && items.some((i) => i.name === "Shift Fate")) {
        return { reroll: true, pick: isAlly ? better : worse };
      }
      if (isAlly && items.some((i) => i.name === "Distracting Frolic")) {
        return { reroll: true, pick: better };
      }
    }
    return null;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/check-roll-intercept.mjs tests/check-roll-intercept.test.mjs
git commit -m "feat(#1035): reroll eligibility for Cat's Luck, Shift Fate, Distracting Frolic"
```

---

### Task 3: Wire into the real registration, version bump

**Files:**
- Modify: `scripts/module.mjs`
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Extend the `ready`-time registration**

```js
// scripts/module.mjs -- extend #1034's own Hooks.once("ready", ...) call
import { installCheckRollWrapper, acBonusInterceptFor, rerollDeciderFor } from "./check-roll-intercept.mjs";

Hooks.once("ready", () => {
  const systemVersion = game.system?.version;
  if (!VERIFIED_CHECK_ROLL_PF2E_VERSIONS.includes(systemVersion)) {
    console.warn(`pf2e-dungeon-crawl | #1034/#1035: PF2e system ${systemVersion} is not in the verified range; Check.roll interception disabled.`);
    return;
  }
  installCheckRollWrapper({
    intercept: (check, context) => {
      const targetId = context?.target?.token?.combatant?.id ?? null;
      return targetId && game.combat ? acBonusInterceptFor(game.combat, targetId)(check, context) : null;
    },
    rerollDecider: (check, context) => (game.combat ? rerollDeciderFor(game.combat)(check, context) : null),
  });
});
```

- [ ] **Step 2: Run the `update-architecture-docs` skill**

Extended exports on `scripts/check-roll-intercept.mjs`; extended `ready`-time registration.

- [ ] **Step 3: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add scripts/module.mjs docs/architecture.md module.json
git commit -m "feat(#1035): wire the reroll decider into the real ready-time registration; version bump"
```

---

## Self-Review

**1. Spec coverage:** The wrapper extension (Task 1), the three named reactions' eligibility (Task 2), and registration (Task 3) are each covered.

**2. Placeholder scan:** No "TBD"/"TODO". The one genuinely unconfirmed piece (`Check.roll`'s own return shape with `createMessage: false`) is stated plainly in Investigation finding 2 and Global Constraints, with fully working code built around the stated assumption.

**3. Type consistency:** `rerollDecider(check, context)`'s contract (`null` or `{reroll: true, pick(a, b)}`) is defined once in Task 1 and honored identically by Task 2's `rerollDeciderFor`.

**4. Review Focus:** All five bullets (exactly-one-message guarantee, unchanged behavior for non-eligible checks, `isReroll` tagging, reroll-decision-failure fallback, deterministic tie-breaking) are each pinned to a named test in Tasks 1 and 2.

**Corrections found while writing this plan:** confirmed this is NOT the same mechanism as #931's own real GM-confirm-card async-hold pattern (`postReactionConfirmCard`) — that pattern defers a CONSEQUENCE after the player already sees their own roll, while this issue's own stated requirement ("the player never sees the pre-reaction result") needs the roll's own FIRST message to never be created at all. Stated explicitly in Review Focus and the Architecture section so a future reader doesn't reach for the wrong existing precedent.
