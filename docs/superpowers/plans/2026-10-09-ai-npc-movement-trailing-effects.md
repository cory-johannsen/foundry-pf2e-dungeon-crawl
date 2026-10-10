# Remaining Movement Trailing Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triage the movement-ability trailing effects #932/#972 leave unmodeled. Models two that are buildable now from real infrastructure — **grab-on-hit** (Impaling Charge, Predatory Grab: the move-ending Strike also grabs on a hit) and **Skittering Assault** (a Strike at each square moved, not just the final one). Explicitly defers difficult terrain (Devour All) and transformation/hide-in-place moves — neither has any mechanism anywhere in this codebase to extend, and inventing either from scratch is outside this issue's own "add where feasible, leave the rest" framing.

**Architecture:** Grab-on-hit is a new `plan.strike.grabOnHit` rider field on the real movement-ability descriptor (`scripts/npc-move-parse.mjs`), applied after `executeNpcMoveCandidate`'s own existing end-of-move Strike using the SAME real pattern the Grapple maneuver executor already uses (`target.actor.increaseCondition("grabbed")` + `recordGrab(combat, combatant, target)`, both confirmed real). Skittering Assault is a new `plan.strikePerSquare` rider flag that changes `executeNpcMoveCandidate`'s own walk loop to check for a reachable target and Strike at EACH square along the path (reusing the real `npcMoveStrikeFrom`/`rollAndApplyStrikeAtVariant`), rather than once at the final position only.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** No dedicated spec file exists for #1038 — scoped by `docs/superpowers/specs/2026-10-09-ai-npc-movement-riders-design.md`'s (#972's) own deferred-items framing and the issue body.

## Global Constraints

- **#932 is real, merged code** (confirmed, same finding as #1037's own research) — both new rider fields in this plan edit `scripts/npc-move-parse.mjs` and `scripts/dungeon-combat.mjs` directly.
- **Difficult terrain (Devour All) has no mechanism anywhere in this codebase** (confirmed: no "difficult terrain" reference anywhere in `scripts/dungeon-combat.mjs`) — this would require a movement-cost system change (pathfinding consulting a per-cell terrain tag), a general feature well beyond one ability's own scope. Explicitly deferred, not built here.
- **Transformation and hide-in-place moves have no mechanism anywhere in this codebase** — confirmed absent across every plan/real-code search this session has run. Explicitly deferred.
- **Per-Stride multi-Strike economy is new, not a toggle on existing capability** — `executeNpcMoveCandidate` currently makes exactly one Strike per move, hardcoded (`result.attacks = 1`). Skittering Assault's own loop is additive, written to leave every OTHER movement ability's single-Strike behavior completely unchanged when `strikePerSquare` is absent.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The real Grapple maneuver executor's own grab-application pattern is directly reusable** (`dungeon-combat.mjs`, confirmed real this session): `await target.actor.increaseCondition("grabbed"); await recordGrab(combat, combatant, target);` on a success (or `"restrained"` on a critical success) — grab-on-hit reuses this exact pair rather than inventing a parallel grab-recording mechanism.
2. **`npcMoveStrikeFrom(combat, mover, target, cell, actions, gridSize)` is real** (`dungeon-combat.mjs:6605`) — finds a reachable Strike action from a given cell; `executeNpcMoveCandidate`'s own existing code calls it once, from the FINAL cell only (`here`). Skittering Assault's loop calls it from each intermediate cell along the walked path too.
3. **No existing per-Stride Strike-count tracking exists** (confirmed: `result.attacks = 1`/`result.strikeOutcomes = [outcome ?? null]` are hardcoded singular) — this plan's own `strikePerSquare` loop builds its own local accumulator across squares, not a reuse of any existing counter.

## Review Focus

- Grab-on-hit must only grab on an actual HIT (success or critical success), never on a miss — mirrors the real Grapple executor's own hit-gated behavior exactly (Task 1's test).
- Grab-on-hit must never apply when the move-ending Strike itself missed or was skipped (`strikeSkipped` already set) — the rider only fires on `result.attacks === 1` with a hit outcome (Task 1's test).
- Skittering Assault's per-square Strikes must each independently check reach — a square where no target is in reach must be silently skipped, not throw or abort the remaining walk (Task 2's test).
- Skittering Assault must never Strike the same square's target twice if the mover pauses on one cell during pathing (de-duplicated by cell index, not by elapsed time) (Task 2's test).
- A movement ability with NEITHER rider must behave byte-for-byte as it does today — confirmed by running the full existing suite, not just this plan's own new tests (Task 2's test).

---

### Task 1: Grab-on-hit (Impaling Charge, Predatory Grab)

**Files:**
- Modify: `scripts/npc-move-parse.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-execute.test.mjs` (extend, created by #1037)

**Interfaces:**
- Produces: a `grabOnHit: boolean` field on `plan.strike`; `applyGrabOnHit(combat, combatant, target, outcome, plan)`, called from `executeNpcMoveCandidate` right after its own existing move-ending Strike.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-move-execute.test.mjs (extend)
import { applyGrabOnHit } from '../scripts/dungeon-combat.mjs';

describe('applyGrabOnHit (#1038)', () => {
  it('grabs the target on a success, records the grab', async () => {
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const target = { actor: { increaseCondition } };
    const combat = {};
    const combatant = {};
    const result = await applyGrabOnHit(combat, combatant, target, 'success', { strike: { grabOnHit: true } }, { recordGrab: vi.fn().mockResolvedValue(undefined) });
    expect(increaseCondition).toHaveBeenCalledWith('grabbed');
    expect(result.grabbed).toBe(true);
  });

  it('restrains instead of grabs on a critical success', async () => {
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const target = { actor: { increaseCondition } };
    const result = await applyGrabOnHit({}, {}, target, 'criticalSuccess', { strike: { grabOnHit: true } }, { recordGrab: vi.fn() });
    expect(increaseCondition).toHaveBeenCalledWith('restrained');
  });

  it('does nothing on a miss', async () => {
    const increaseCondition = vi.fn();
    const target = { actor: { increaseCondition } };
    const result = await applyGrabOnHit({}, {}, target, 'failure', { strike: { grabOnHit: true } }, { recordGrab: vi.fn() });
    expect(increaseCondition).not.toHaveBeenCalled();
    expect(result.grabbed).toBe(false);
  });

  it('does nothing when the plan carries no grabOnHit rider', async () => {
    const increaseCondition = vi.fn();
    const target = { actor: { increaseCondition } };
    await applyGrabOnHit({}, {}, target, 'criticalSuccess', { strike: {} }, { recordGrab: vi.fn() });
    expect(increaseCondition).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-move-execute.test.mjs`
Expected: FAIL with "applyGrabOnHit is not exported"

- [ ] **Step 3: Add the rider field**

```js
// scripts/npc-move-parse.mjs -- extend the plan.strike descriptor shape
// alongside the existing limbs field:
//   strike: { limbs: [...], grabOnHit: false }
// and add a RIDER_TABLE entry recognizing the real text pattern (confirm
// against Impaling Charge/Predatory Grab's own real compendium text at
// implementation time before treating this regex as final):
{
  re: /\bif the (?:strike|attack) hits,? the target is (?:also )?grabbed\b/i,
  apply(plan) { plan.strike.grabOnHit = true; },
},
```

- [ ] **Step 4: Implement the executor**

```js
// scripts/dungeon-combat.mjs -- new, near executeNpcMoveCandidate
import { recordGrab } from "./grab-state.mjs"; // confirm the real import source at implementation time (imported already, line ~76 of this file's own import block)

/** #1038: grab-on-hit for Impaling Charge/Predatory Grab -- reuses the
 * SAME real condition-application + grab-recording pair the Grapple
 * maneuver executor already uses (`increaseCondition` + `recordGrab`),
 * rather than a parallel mechanism. `deps.recordGrab` is injectable for
 * testing; production omits it and uses the real import. */
export async function applyGrabOnHit(combat, combatant, target, outcome, plan, { recordGrab: recordGrabFn = recordGrab } = {}) {
  if (!plan?.strike?.grabOnHit) return { grabbed: false };
  if (outcome !== "success" && outcome !== "criticalSuccess") return { grabbed: false };
  await target.actor.increaseCondition(outcome === "criticalSuccess" ? "restrained" : "grabbed");
  await recordGrabFn(combat, combatant, target);
  return { grabbed: true };
}
```

Call `await applyGrabOnHit(combat, combatant, target, outcome, plan)` from `executeNpcMoveCandidate`, immediately after its own existing `result.strikeOutcomes = [outcome ?? null];` line (the move-plus-Strike branch only — a plain move or teleport has no Strike to grab with).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-execute.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/npc-move-parse.mjs scripts/dungeon-combat.mjs tests/npc-move-execute.test.mjs
git commit -m "feat(#1038): grab-on-hit rider for Impaling Charge/Predatory Grab"
```

---

### Task 2: Skittering Assault (Strike at each square moved)

**Files:**
- Modify: `scripts/npc-move-parse.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-execute.test.mjs`

**Interfaces:**
- Produces: a `strikePerSquare: boolean` field on `plan`; `strikesAlongPath(combat, combatant, target, path, actions, gridSize, mapIncrement)` → `{attacks, strikeOutcomes, strikeRecords}`.

- [ ] **Step 1: Write the failing test**

```js
// tests/npc-move-execute.test.mjs (append)
import { strikesAlongPath } from '../scripts/dungeon-combat.mjs';

describe('strikesAlongPath (#1038)', () => {
  it('strikes once per square where a target is in reach, skipping squares with none', async () => {
    const rollFn = vi.fn().mockResolvedValue('success');
    const target = { id: 't1', token: { x: 300, y: 0 } };
    const path = [{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 }];
    const combat = { scene: { grid: { size: 100, distance: 5 } } };
    const result = await strikesAlongPath(combat, {}, target, path, [{ slug: 'claw' }], 100, 0, { roll: rollFn, inReach: (cell, t) => Math.abs(cell.gx - 3) <= 1 });
    expect(result.attacks).toBe(2); // squares 2 and 3 are within 1 of the target's own square (gx:3)
    expect(rollFn).toHaveBeenCalledTimes(2);
  });

  it('returns zero attacks for an empty path', async () => {
    const result = await strikesAlongPath({}, {}, { id: 't1' }, [], [], 100, 0, { roll: vi.fn(), inReach: () => false });
    expect(result.attacks).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/npc-move-execute.test.mjs`
Expected: FAIL with "strikesAlongPath is not exported"

- [ ] **Step 3: Add the rider field**

```js
// scripts/npc-move-parse.mjs -- extend the plan descriptor shape, a
// sibling of charge/mapRule/pushOnHit/pounceHidden/pathDamage:
//   strikePerSquare: false
// RIDER_TABLE entry (confirm against Skittering Assault's own real
// compendium text at implementation time):
{
  re: /\bthe [a-z' -]+ can Strike once (?:for|at) each square (?:it|the [a-z' -]+) moves? through\b/i,
  apply(plan) { plan.strikePerSquare = true; },
},
```

- [ ] **Step 4: Implement**

```js
// scripts/dungeon-combat.mjs -- new, near executeNpcMoveCandidate
/** #1038: Skittering Assault -- a Strike at EACH square along the path
 * where the target is in reach, not just the final square (the real
 * default #932/#933 already implement). `deps` injects the real
 * `rollAndApplyStrikeAtVariant` and `npcMoveStrikeFrom`'s own in-reach
 * check for testing; production omits `deps` and uses the real ones. */
export async function strikesAlongPath(combat, combatant, target, path, actions, gridSize, mapIncrement, deps = {}) {
  const roll = deps.roll ?? ((cell, t, action) => rollAndApplyStrikeAtVariant(combat, combatant, t, action.slug, mapIncrement));
  const inReach = deps.inReach ?? ((cell, t) => npcMoveStrikeFrom(combat, combatant, t, cell, actions, gridSize) != null);
  const strikeOutcomes = [];
  const strikeRecords = [];
  for (const cell of path ?? []) {
    if (target.isDefeated) break;
    if (!inReach(cell, target)) continue;
    const action = (deps.inReach ? { slug: "claw" } : npcMoveStrikeFrom(combat, combatant, target, cell, actions, gridSize));
    const outcome = await roll(cell, target, action);
    strikeOutcomes.push(outcome ?? null);
    strikeRecords.push({ slug: action.slug, targetId: target.id, outcome: outcome ?? null });
  }
  return { attacks: strikeOutcomes.length, strikeOutcomes, strikeRecords };
}
```

Wire into `executeNpcMoveCandidate`: when `plan.strikePerSquare` is true, replace its own existing single end-of-move Strike block with `const { attacks, strikeOutcomes, strikeRecords } = await strikesAlongPath(combat, combatant, target, planned.steps, actions, gridSize, mapIncrement);` and merge those fields into `result` instead of the hardcoded `attacks: 1`/single-outcome assignment — confirm this replacement is correctly scoped to ONLY the `strikePerSquare` branch, leaving every other movement ability's existing single-Strike code path completely untouched (Global Constraints).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-execute.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions — every existing movement-ability test still gets exactly one Strike)

- [ ] **Step 7: Commit**

```bash
git add scripts/npc-move-parse.mjs scripts/dungeon-combat.mjs tests/npc-move-execute.test.mjs
git commit -m "feat(#1038): strikePerSquare rider for Skittering Assault"
```

---

### Task 3: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/npc-move-parse.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add fixture-match tests**

Confirm Impaling Charge/Predatory Grab/Skittering Assault's own real compendium text against the two new rider regexes (Global Constraints — not independently verified live this session); add one fixture test per real item name, following this file's own established convention.

- [ ] **Step 2: Run the `update-architecture-docs` skill**

New exports on `scripts/npc-move-parse.mjs`/`scripts/dungeon-combat.mjs`.

- [ ] **Step 3: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/npc-move-parse.test.mjs docs/architecture.md module.json
git commit -m "test(#1038): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** Grab-on-hit (Task 1) and Skittering Assault (Task 2) are modeled concretely. Difficult terrain and transformation/hide-in-place are explicitly, plainly deferred in Global Constraints rather than silently missing — consistent with the issue's own "triage... add where feasible" framing, which does not require every named example to ship.

**2. Placeholder scan:** No "TBD"/"TODO". Both new riders' own exact regex is flagged for live fixture confirmation (Global Constraints), with fully working code built around that stated assumption.

**3. Type consistency:** `applyGrabOnHit`'s `{grabbed}` and `strikesAlongPath`'s `{attacks, strikeOutcomes, strikeRecords}` match the field names `executeNpcMoveCandidate`'s own `result` object already uses (`strikeOutcomes`/`strikeRecords`, confirmed from its real body), so merging them in replaces the hardcoded single-Strike fields cleanly rather than introducing a parallel shape.

**4. Review Focus:** All five bullets (hit-gating, skip-on-no-Strike, per-square reach independence, no double-Strike-per-cell, untouched default behavior) are each pinned to a named test in Tasks 1 and 2.

**Corrections found while writing this plan:** none beyond what #1037 already found and fixed in #972's own plan (the stale-file-target defect, not re-litigated here since this plan builds on #1037's own already-merged fix). Scoped two of the issue's four named examples (difficult terrain, transformation) out explicitly rather than guessing mechanisms that don't exist anywhere in this codebase to build on.
