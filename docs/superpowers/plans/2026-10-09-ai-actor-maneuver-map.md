# AI Actor Maneuver MAP Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch #909's own planned maneuver execution so Trip/Shove/Grapple/Disarm (not Demoralize) actually suffer and accumulate the multiple attack penalty, matching PF2e RAW.

**Architecture:** This is a bounded correction to #909's own not-yet-implemented `executeManeuverCandidate`/`applyCandidateToTurnState` — no new subsystem, no spec file (classified bounded per the brainstorming skill; approved in chat with the owner before writing this plan). A new `computeManeuverMapModifier` reuses the system's own `calculateMAPs` for the correct agile-vs-standard penalty value, passed to the maneuver macro via its existing `modifiers` option; `applyCandidateToTurnState`'s existing `mapIncrement` bump gains one more branch.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** none — bounded fix, approved via a short in-chat design (see this plan's own commit message / issue comment for the approved design summary); not written to a separate spec file per the brainstorming skill's bounded path.

## Global Constraints

- **Hard dependency: #909's own plan must be fully implemented and merged first.** Confirmed live as of this plan's writing: `scripts/dungeon-combat.mjs` has no `executeManeuverCandidate`/`runManeuverCheck` at all yet.
- **Confirmed live by reading the installed PF2e system directly:** `trip`/`shove`/`grapple`/`disarm` each forward a caller-supplied `modifiers` array to the underlying roll (`let n = e?.modifiers`, then `modifiers: n` in their own `checkContext` calls) but apply no multiple-attack-penalty modifier themselves; all four carry the `attack` trait. `demoralize` carries no `attack` trait and takes no `modifiers`-based MAP either way — it is correctly exempt, not an oversight.
- **Confirmed live:** `simpleRollActionCheck` (the shared helper behind all five maneuver macros) never forwards an `attackNumber` option to the underlying `Statistic#roll` call — there is no shortcut where simply passing an attack-number-like option makes the system compute MAP automatically for these specific macros, even though `Statistic#roll` itself supports `attackNumber` generically for other callers (e.g. Strikes).
- **Confirmed live, the real, exact, reusable function:** `calculateMAPs(item, {domains, options})` (globally available inside the PF2e system's own module scope, not on `game.pf2e` — see Task 1, Step 3 for how this plan calls it) returns `{label, map1, map2}` — `map1: -4, map2: -8` when `item` is of type `action`/`melee`/`weapon` and has the `agile` trait, else `map1: -5, map2: -10`; `{domains: [], options: new Set()}` is a safe, minimal call (the function's only other use of those two parameters is an optional custom-synthetics override lookup this plan doesn't need).
- **Confirmed live:** `game.pf2e.Modifier` is the real, public constructor for a roll modifier (`new game.pf2e.Modifier(label, value, type)`, the "legacy positional" constructor form; `type: "untyped"` matches PF2e's own MAP modifier).
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (patch bump — a routine correctness fix to an unimplemented plan, not a new subsystem; check the current value at the final task).

## Review Focus

- Demoralize must never receive a MAP modifier or bump `mapIncrement` — the one documented exemption this whole fix exists alongside, not instead of.
- The very first maneuver in a turn (`mapIncrement === 0`) must get no MAP modifier at all (a `-0` penalty is wrong; PF2e's own first-attack MAP is always 0) — `computeManeuverMapModifier` must return `null`, not a zero-value modifier.
- An actor with no matching-trait weapon (unarmed/free-hand maneuver) must still get the correct standard `-5`/`-10` penalty, not silently skip it just because there's no weapon item to check for `agile`.
- An actor with an agile-trait matching weapon must get `-4`/`-8`, confirmed via the real system function, not a hand-derived value that could drift from PF2e's own definition of "agile."
- `mapIncrement` must accumulate correctly across a mix of Strikes and maneuvers in the same turn (e.g. Strike, then Trip, then Strike again) — the existing Strike-bump logic and this new maneuver-bump logic must compose, not reset each other.

---

### Task 1: Compute and apply the maneuver MAP modifier

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/agent-candidates.mjs`
- Test: `tests/dungeon-combat-maneuver-map.test.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: `hasFreeHandOrManeuverWeapon`'s own existing held-weapon-filtering logic (per #909's plan, module-private in `dungeon-combat.mjs`) — extended with a sibling that also returns *which* weapon matched, not just whether one does.
- Produces: `executeManeuverCandidate` (per #909's plan) now applies the correct MAP modifier; `applyCandidateToTurnState` (per #909's plan, `agent-candidates.mjs`) now bumps `mapIncrement` for a non-Demoralize maneuver candidate.

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent-candidates.test.mjs` (inside the existing `describe('applyCandidateToTurnState', ...)` block, per #909's plan):

```js
  it('bumps mapIncrement by 1 for a non-demoralize maneuver candidate', () => {
    const next = applyCandidateToTurnState(
      { actionsRemaining: 3, mapIncrement: 0, maneuverPicks: null },
      { type: 'maneuver', slug: 'trip', cost: 1 },
    );
    expect(next.mapIncrement).toBe(1);
  });

  it('does not bump mapIncrement for a demoralize maneuver candidate', () => {
    const next = applyCandidateToTurnState(
      { actionsRemaining: 3, mapIncrement: 0, maneuverPicks: null },
      { type: 'maneuver', slug: 'demoralize', cost: 1 },
    );
    expect(next.mapIncrement).toBe(0);
  });

  it('accumulates mapIncrement across a mix of strikes and maneuvers in the same turn', () => {
    let state = { actionsRemaining: 3, mapIncrement: 0, maneuverPicks: null };
    state = applyCandidateToTurnState(state, { type: 'strike', cost: 1 });
    state = applyCandidateToTurnState(state, { type: 'maneuver', slug: 'trip', cost: 1 });
    expect(state.mapIncrement).toBe(2);
  });
```

Find and read an existing `applyAgentDecision` maneuver-execution test (per #911's plan, `tests/dungeon-combat-maneuver-execution.test.mjs`) to copy its exact `game`/combat/combatant/target stub shape, then create `tests/dungeon-combat-maneuver-map.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision maneuver MAP accounting', () => {
  it('passes no modifiers on the first maneuver this turn (mapIncrement 0)', async () => {
    // agentTurnState.mapIncrement === 0 for this combatant this turn.
    // const actionSpy = vi.fn(({ callback }) => callback({ outcome: 'success' }));
    // installGamePf2eStub({ trip: actionSpy });
    // await applyAgentDecision(combat, combatantId, 'maneuver:trip:opp1', 'r');
    // expect(actionSpy).toHaveBeenCalledWith(expect.objectContaining({ modifiers: undefined }));
  });

  it('passes a -5 modifier on the second maneuver this turn with no matching-trait weapon (unarmed/free-hand)', async () => {
    // agentTurnState.mapIncrement === 1; combatant.actor has no held
    // weapon carrying the 'trip' trait.
    // expect(actionSpy).toHaveBeenCalledWith(expect.objectContaining({
    //   modifiers: [expect.objectContaining({ modifier: -5 })],
    // }));
  });

  it('passes a -10 modifier on the third maneuver this turn', async () => {
    // agentTurnState.mapIncrement === 2 -- expect modifier -10.
  });

  it('passes a -4 modifier on the second maneuver when the actor wields a trip-trait weapon with the agile trait', async () => {
    // combatant.actor has a held weapon item whose traits include both
    // 'trip' and 'agile'. expect modifier -4.
  });

  it('never passes any MAP modifier for demoralize, regardless of mapIncrement', async () => {
    // agentTurnState.mapIncrement === 2; candidate.slug === 'demoralize'.
    // installGamePf2eStub({ demoralize: actionSpy }).
    // expect(actionSpy).toHaveBeenCalledWith(expect.objectContaining({ modifiers: undefined }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-candidates.test.mjs tests/dungeon-combat-maneuver-map.test.mjs`
Expected: FAIL — `applyCandidateToTurnState` doesn't bump for maneuvers yet; `executeManeuverCandidate` passes no modifiers at all yet.

- [ ] **Step 3: Update `applyCandidateToTurnState` in `scripts/agent-candidates.mjs`**

```js
export function applyCandidateToTurnState(turnState, candidate) {
  if (candidate.type === 'endTurn') return { ...turnState, actionsRemaining: 0 };
  let mapIncrement = turnState.mapIncrement;
  if (candidate.type === 'strike') mapIncrement += 1;
  else if (candidate.type === 'multiStrike') {
    mapIncrement += candidate.strikes.reduce((sum, s) => sum + s.count, 0);
  } else if (candidate.type === 'maneuver' && candidate.slug !== 'demoralize') {
    mapIncrement += 1;
  }
  return { actionsRemaining: turnState.actionsRemaining - candidate.cost, mapIncrement };
}
```

- [ ] **Step 4: Add `computeManeuverMapModifier` and wire it into execution in `scripts/dungeon-combat.mjs`**

Add near `hasFreeHandOrManeuverWeapon` (per #909's plan):

```js
/** #940: the actual held weapon carrying `slug` as one of its own traits
 * (the "trip-trait weapon" `hasFreeHandOrManeuverWeapon` already checks
 * for existence of, now needed by name so calculateMAPs can read its
 * own `agile` trait) — null for an unarmed/free-hand maneuver. */
function findManeuverWeapon(actor, slug) {
  const heldWeapons = (actor?.itemTypes?.weapon ?? []).filter(
    (w) => w.system?.equipped?.carryType === "held",
  );
  return heldWeapons.find((w) => (w.system?.traits?.value ?? []).includes(slug)) ?? null;
}

const MANEUVER_MAP_SLUGS = new Set(["trip", "shove", "grapple", "disarm"]);

/** #940: Trip/Shove/Grapple/Disarm all carry the `attack` trait and
 * suffer PF2e's own multiple attack penalty (confirmed live); the
 * system's own maneuver macros apply none of it unless the caller
 * supplies it, so this module must. Demoralize carries no `attack`
 * trait and is correctly exempt (returns null for it unconditionally).
 * Reuses the system's own `calculateMAPs` for the real agile-vs-standard
 * value rather than hand-deriving it; with no matching-trait weapon,
 * calculateMAPs has no item argument to call with, so this falls back
 * to the plain standard -5/-10 values directly instead (an unarmed
 * maneuver is never agile). Returns null on the very first maneuver of
 * the turn (mapIncrement 0) — PF2e's own first-attack MAP is always 0,
 * never a literal "-0" modifier. */
function computeManeuverMapModifier(actor, slug, mapIncrement) {
  if (!MANEUVER_MAP_SLUGS.has(slug) || mapIncrement <= 0) return null;
  const weapon = findManeuverWeapon(actor, slug);
  const { map1, map2 } = weapon
    ? calculateMAPs(weapon, { domains: [], options: new Set() })
    : { map1: -5, map2: -10 };
  const value = mapIncrement >= 2 ? map2 : map1;
  return new game.pf2e.Modifier("Multiple Attack Penalty", value, "untyped");
}
```

Update `runManeuverCheck` and `executeManeuverCandidate` (per #909/#911's plans):

```js
function runManeuverCheck(slug, combatant, target, skill, mapModifier) {
  return new Promise((resolve) => {
    game.pf2e.actions[slug]({
      actors: [combatant.actor],
      target: () => ({ actor: target.actor, token: target.token }),
      skill,
      modifiers: mapModifier ? [mapModifier] : undefined,
      callback: ({ outcome }) => resolve(outcome),
    });
  });
}

async function executeManeuverCandidate(combat, combatant, candidate) {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return;
  const turnState = getAgentTurnState(combat, combatant.id);
  const mapModifier = computeManeuverMapModifier(combatant.actor, candidate.slug, turnState.mapIncrement);
  const outcome = await runManeuverCheck(candidate.slug, combatant, target, candidate.skill, mapModifier);
  await applyManeuverOutcome(candidate.slug, combat, combatant, target, outcome, candidate.skill);
}
```

(Only the `runManeuverCheck` signature/body and the two new lines inside `executeManeuverCandidate` — `turnState`/`mapModifier`, and passing `mapModifier` into the `runManeuverCheck` call — change; `applyManeuverOutcome`'s own call is otherwise exactly as #909/#911's plans already have it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs tests/dungeon-combat-maneuver-map.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — in particular, re-check #909/#911's own existing maneuver-execution tests that assert the exact `game.pf2e.actions[slug]` call arguments via `toHaveBeenCalledWith` on an object *without* a `modifiers` key at all; those fixtures' own `mapIncrement` is implicitly 0 (a fresh turn), so this task's `modifiers: undefined` addition must not change their outcome, but confirm this directly rather than assuming it.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/agent-candidates.mjs tests/dungeon-combat-maneuver-map.test.mjs tests/agent-candidates.test.mjs
git commit -m "fix(#940): apply and accumulate the multiple attack penalty on maneuvers

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

A **patch** bump per `CLAUDE.md`'s versioning rule — a routine correctness fix, not a new subsystem.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#940): bump version for maneuver MAP accounting fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (against the approved bounded design, no separate spec file):** the approved design's every element is implemented — `calculateMAPs` reuse for the agile check (Step 4), explicit `modifiers` forwarding (Step 4), `mapIncrement` bump restricted to the four affected slugs (Step 3), Demoralize's exemption preserved throughout (both Step 3's `candidate.slug !== 'demoralize'` guard and Step 4's `MANEUVER_MAP_SLUGS` set excluding it).

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 1's test bodies stay commented/pseudocoded pending the real stub shape from an existing maneuver-execution test, named explicitly — the same deliberate, flagged exception every prior plan in this session's sequence has used for the same reason.

**3. Type consistency:** `computeManeuverMapModifier`'s return value (a `game.pf2e.Modifier` instance or `null`) matches exactly how `runManeuverCheck`'s own new `mapModifier` parameter is consumed (`modifiers: mapModifier ? [mapModifier] : undefined`). `findManeuverWeapon`'s return value (a weapon item or `null`) matches exactly how `computeManeuverMapModifier` branches on it.

**4. Review Focus:** all five items have a direct test — Demoralize's exemption (two dedicated tests, one at the `applyCandidateToTurnState` level and one at the execution level), the zero-mapIncrement no-modifier case (Task 1's first execution test), the no-weapon standard-penalty fallback (Task 1's second execution test), the agile-weapon `-4` value (Task 1's fourth execution test), and strike+maneuver accumulation (Task 1's dedicated `applyCandidateToTurnState` test).
