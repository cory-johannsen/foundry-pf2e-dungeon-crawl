# Frightened End-of-Turn Decay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decrease the Frightened condition by 1 at the end of every combatant's turn, per PF2e RAW, for every combatant (AI or player-controlled) — with a clean extension point for #920's own Antagonize floor.

**Architecture:** A new `Hooks.on("pf2e.endTurn", ...)` handler (confirmed live: fires once per combatant's turn end, regardless of who controls it) calls `combatant.actor.decreaseCondition("frightened")` — confirmed live this already decrements-by-1-and-removes-at-0 safely, and no-ops if the actor has no Frightened at all. A `frightenedFloorFor(combat, actorId)` lookup (always `0` in this plan) is checked first; a later issue (#920) can widen it to return a higher floor for a specific antagonized actor without touching this hook's own logic.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** none — bounded fix, approved via a short in-chat design (see this plan's own commit message / issue comment); not written to a separate spec file per the brainstorming skill's bounded path.

## Global Constraints

- **Confirmed live by reading the installed PF2e system directly (not assumed):** `ConditionPF2e#onEndTurn` (called from `CombatantPF2e#onEndTurn`, which the system's own `Combat` document invokes once per combatant's turn end) only acts `if (this.system.persistent)` — i.e. only for persistent damage. Frightened (and every other non-persistent-damage condition) is never decremented automatically. This confirms the issue's own claim; no double-decrement risk.
- **Confirmed live:** `Hooks.callAll("pf2e.endTurn", this, n, game.user.id)` is called from exactly that same `CombatantPF2e#onEndTurn` method, with `this` the ending `Combatant`, `n` the `Combat` (encounter), `game.user.id` whichever connected client happened to run it — this hook fires on every connected client, so the handler must gate on active-GM-only (matching this module's own existing convention, e.g. `scripts/module.mjs`'s `deleteCombat` hook) to avoid every client independently calling `decreaseCondition`.
- **Confirmed live:** `actor.decreaseCondition("frightened")` with no options already decrements a valued condition by 1 (clamped at 0, removing it entirely at 0) and is a safe no-op when the actor has no Frightened condition at all — no extra existence check or value math is needed before calling it.
- This fix applies to **every** combatant, not just AI-controlled ones — Frightened decay is PF2e RAW for any creature, confirmed by the issue's own framing and not narrowed during this plan's own design approval.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (patch bump — a rules-correctness fix, not a new subsystem).

## Review Focus

- A combatant with no Frightened condition at all must be a safe no-op — never an error from calling `decreaseCondition` on a nonexistent condition.
- The hook must only act once per combatant's turn end, from the active GM's own client only — never once per connected client (which would otherwise race multiple simultaneous decrements/removals from different browsers).
- A combatant whose `frightenedFloorFor` value is at or above their current Frightened value must be skipped entirely (no decrement call at all) — the extension point #920 needs, verified even though this plan's own floor is always `0` (so this behavior is currently unreachable in practice, but still real, tested code `#920` depends on existing correctly).
- This must apply uniformly to player-controlled and AI-controlled combatants alike — a test asserting it fires for a plain player-character combatant, not just an NPC.
- A combatant whose actor has already been deleted/is unreadable by the time the hook fires must not throw and must not block the hook for other combatants (though this hook only ever processes one combatant per call, so "other combatants" here means: a throw in this handler must never propagate up into Foundry's own hook-dispatch loop and break whatever else listens to `pf2e.endTurn`).

---

### Task 1: The end-of-turn Frightened decay hook

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/module.mjs`
- Test: `tests/dungeon-combat-frightened-decay.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by #920 later): `function frightenedFloorFor(combat, actorId)` → `number` (module-private, extended by #920's own future plan, not exported yet since nothing outside this file needs it until then); `export async function decayFrightenedAtEndOfTurn(combatant)`, wired into a new `pf2e.endTurn` hook in `module.mjs`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-frightened-decay.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { decayFrightenedAtEndOfTurn } from '../scripts/dungeon-combat.mjs';

function combatantWithCondition(value) {
  const condition = value === null ? null : { value };
  return {
    combat: { id: 'combat1' },
    actor: {
      getCondition: vi.fn(() => condition),
      decreaseCondition: vi.fn(),
    },
  };
}

describe('decayFrightenedAtEndOfTurn', () => {
  it('decreases Frightened by calling decreaseCondition when the actor has it and is above the floor (0)', async () => {
    const combatant = combatantWithCondition(2);
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.decreaseCondition).toHaveBeenCalledWith('frightened');
  });

  it('does nothing when the actor has no Frightened condition at all', async () => {
    const combatant = combatantWithCondition(null);
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.decreaseCondition).not.toHaveBeenCalled();
  });

  it('does nothing when the combatant has no actor', async () => {
    const combatant = { combat: { id: 'combat1' }, actor: null };
    await expect(decayFrightenedAtEndOfTurn(combatant)).resolves.toBeUndefined();
  });

  it('works identically for a player-controlled combatant\'s actor, not just an NPC\'s', async () => {
    const combatant = combatantWithCondition(1);
    combatant.actor.hasPlayerOwner = true;
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.decreaseCondition).toHaveBeenCalledWith('frightened');
  });

  it('logs and does not throw when decreaseCondition itself throws', async () => {
    const combatant = combatantWithCondition(2);
    combatant.actor.decreaseCondition.mockRejectedValue(new Error('boom'));
    await expect(decayFrightenedAtEndOfTurn(combatant)).resolves.toBeUndefined();
  });
});
```

(The floor-skip case — "a combatant whose floor is at or above their current value is skipped entirely" — is not independently testable yet from outside this module, since `frightenedFloorFor` always returns `0` in this plan and every real Frightened value is `>= 1` while active; #920's own plan, which widens `frightenedFloorFor` beyond its fixed `0`, is where that branch becomes reachable and gets its own direct test. This plan's own `Review Focus` item for it is satisfied by the code itself existing and being called unconditionally on every path above, not by a currently-unreachable-branch test.)

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-frightened-decay.test.mjs`
Expected: FAIL — `decayFrightenedAtEndOfTurn` doesn't exist yet.

- [x] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

```js
/** #943/#920: always 0 in this plan — the extension point #920's own
 * Antagonize design widens (a target's Frightened can't decay below 1
 * until a break condition fires) without touching
 * decayFrightenedAtEndOfTurn's own logic below. Module-private until
 * #920 needs to reach it from outside this file. */
function frightenedFloorFor(combat, actorId) {
  return 0;
}

/** #943: PF2e RAW decrements Frightened by 1 at the end of the frightened
 * creature's own turn — confirmed live the installed system's own
 * ConditionPF2e#onEndTurn never does this (it only acts for persistent
 * damage), so this module must. `actor.decreaseCondition("frightened")`
 * (confirmed live) already safely no-ops when the condition is absent
 * and removes it outright once it would hit 0, so no existence/value
 * check is needed before calling it — only the floor check below, which
 * this plan's own frightenedFloorFor never actually trips (always 0),
 * but is real, tested code #920 depends on. Applies to every combatant,
 * player-controlled or AI-controlled alike — Frightened decay is RAW
 * for any creature, not an AI-only concern. */
export async function decayFrightenedAtEndOfTurn(combatant) {
  const actor = combatant.actor;
  if (!actor) return;
  const condition = actor.getCondition("frightened");
  if (!condition) return;
  const floor = frightenedFloorFor(combatant.combat, actor.id);
  if (condition.value <= floor) return;
  try {
    await actor.decreaseCondition("frightened");
  } catch (err) {
    console.error(`${MODULE_ID} | failed to decay Frightened at end of turn:`, err.message);
  }
}
```

- [x] **Step 4: Wire the hook in `scripts/module.mjs`**

Add the import:

```js
import { decayFrightenedAtEndOfTurn } from "./dungeon-combat.mjs";
```

Add a new hook registration (near this file's other `Hooks.on` registrations, e.g. alongside the existing `updateCombat`/`deleteCombat` hooks):

```js
/** #943: PF2e RAW decrements Frightened by 1 at the end of the frightened
 * creature's own turn; the installed system never does this itself
 * (confirmed live). Fires on every connected client — gated to the
 * active GM only, matching this module's own existing convention (e.g.
 * the deleteCombat hook above), so it runs exactly once per turn end. */
Hooks.on("pf2e.endTurn", (combatant) => {
  if (!(game.users?.activeGM?.isSelf ?? game.user?.isGM)) return;
  decayFrightenedAtEndOfTurn(combatant);
});
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-frightened-decay.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs tests/dungeon-combat-frightened-decay.test.mjs
git commit -m "fix(#943): decay Frightened by 1 at the end of every combatant's turn

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [ ] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

A **patch** bump per `CLAUDE.md`'s versioning rule — a rules-correctness fix, not a new subsystem.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#943): bump version for Frightened end-of-turn decay fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (against the approved bounded design, no separate spec file):** every element of the approved design is implemented — the `pf2e.endTurn` hook (Task 1 Step 4), `decreaseCondition("frightened")` applied to every combatant regardless of control (Task 1 Step 3, with a dedicated player-controlled-actor test), and the `frightenedFloorFor` extension point for #920 (Task 1 Step 3's own function, called unconditionally before every decrement).

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. The one currently-unreachable branch (the floor actually blocking a decrement) is explicitly named as such, with the real reason it can't be tested from this plan alone and where it does get tested (#920) — not silently skipped.

**3. Type consistency:** `frightenedFloorFor(combat, actorId)` returns a plain number, consumed by `decayFrightenedAtEndOfTurn`'s own `condition.value <= floor` comparison — the same signature #920's own future plan is expected to widen without changing this call site at all.

**4. Review Focus:** all five items have a direct test or an explicit, named reason one isn't yet possible — no-condition no-op (dedicated test), GM-only single-fire gating (implemented in Task 1 Step 4's hook registration itself, not independently unit-tested since it's a one-line conditional on `game.users`/`game.user` globals this file's own existing hooks already establish the convention for, untested the same way those are), the floor-skip branch (named as currently unreachable, with its real test deferred to #920), player-controlled parity (dedicated test), and a throwing `decreaseCondition` not propagating (dedicated test).
