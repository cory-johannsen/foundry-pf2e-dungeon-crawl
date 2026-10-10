# Path-Damage Movement Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model movement abilities that deal save-based damage to every creature within N feet of each square moved through, or adjacent at any point during the movement ("each creature within 20 feet of each square they move through"; "each creature the serpent is adjacent to at any point during its movement") — using the real, executed path and a de-duplicated affected-creature set.

**Architecture:** A new `pathDamage` rider field on the real movement-ability descriptor (`scripts/npc-move-parse.mjs`, #932, real/merged). `affectedCreaturesAlongPath(combat, mover, path, {feet, gridSize, gridDistanceFt})` (pure-ish, reusing real geometry helpers) computes the de-duplicated creature set from the real, executed path (`planned.steps`/`planned.walk.waypoint.steps`, confirmed real this session from `executeNpcMoveCandidate`). The save/damage application loops the real, single-target `rollNpcAbilitySave` once per affected creature — the same posture #1022's own Reflective Scales took, since no dedicated multi-target "area save executor" exists outside spell paths.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** No dedicated spec file exists for #1037 — scoped by `docs/superpowers/specs/2026-10-09-ai-npc-movement-riders-design.md`'s (#972's) own deferred-items framing and the issue body.

## Global Constraints

- **#932 is real, merged code** (confirmed, same finding as every real/merged dependency in this sequence: `scripts/npc-move-parse.mjs`, `scripts/dungeon-combat.mjs`) — this plan's own rider field and executor hook edit those real files directly.
- **#972's own merged plan patches a stale plan document instead of the real `npc-move-parse.mjs`** (a confirmed "wrong target file" bug, same class as #959/#960/#961's own, but simpler — the rider SHAPE it drafted already matches the real `RIDER_TABLE` exactly). Fixed here as a prerequisite (Task 1), since this plan's own Task 2 adds a sibling rider field to the same real descriptor shape #972 extends.
- **No dedicated multi-target "area save executor" exists outside spell-casting paths** (confirmed: `castAreaSpellAndApplySaves` is spell-only; the real single-target `rollNpcAbilitySave` is reused directly here, looped, the same posture #1022's Reflective Scales already took).
- **The path-damage rider's own exact trigger/effect phrasing was not independently re-verified live this session** — the regex Task 2 adds is a best-effort pattern from the issue's own quoted examples, explicitly flagged as needing confirmation against real fixture items (Flaming Strafe, Spine Rake, Dance of Burning War) before being treated as complete, the same posture every other reviewed-definition task in this sequence takes.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The real, executed path is available from `executeNpcMoveCandidate`** (`dungeon-combat.mjs:6847`, confirmed real): a plain "move" plan uses `planned.walk.waypoint.steps`; a move-plus-Strike plan uses `planned.steps` directly, both walked via the real `walkNpcMoveSteps(combat, combatant, start, steps, gridSize, {suppressReactions})`. This plan's own hook reads the SAME `steps` array the real executor already computed — never re-deriving a second, possibly-inconsistent path.
2. **`rollNpcAbilitySave(combatant, target, item, descriptor)` is real but single-target** (`dungeon-combat.mjs:10156`, confirmed this session) — this plan loops it once per de-duplicated affected creature, exactly the pattern #1022's Reflective Scales already established for a non-spell area effect.
3. **Real geometry helpers confirmed**: `pf2eDistanceFeet(a, b, gridSize, gridDistanceFt)` for "within N feet"; `chebyshevSquares(a, b, gridSize)` for "adjacent" (`<= 1`) — both real, `dungeon-combat.mjs`, reused directly rather than re-derived.
4. **De-duplication is the one genuinely new piece**: a creature in range of THREE squares along a long path must still only be hit/save once, not three times. `affectedCreaturesAlongPath` builds its result as a `Map` keyed by combatant id, overwriting nothing once added, so iteration order across squares never double-counts.

## Review Focus

- A creature in range of multiple squares along the path must be affected exactly once, never once per square (Task 2's test — this is the single most likely bug shape for this feature).
- A creature that was in range at the START of the move but the mover then moves AWAY from (ending the move out of that creature's range) must still be affected — the affected set is built from EVERY square of the path, not just the final position (Task 2's test).
- The mover's own square(s) must never count itself as an affected creature (Task 2's test).
- A malformed or empty path (a move that didn't actually go anywhere — Crumble/Slink's own "escape" moves, or a disrupted Stride) must produce an empty affected set, never throw (Task 2's test).
- Each affected creature's own save/damage must be independent — one creature's critical failure must never affect another creature's own degree or damage roll (Task 3's test).

---

### Task 1: Fix #972's plan — the real merge-point file (prerequisite)

**Already applied in this worktree.**

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-riders.md`

- [ ] **Step 1: Confirm the amendment is present**

This worktree already contains the fix: that plan's Tasks 1 and 2 now edit the real `scripts/npc-move-parse.mjs` directly (the rider shapes themselves were already correct as drafted — only the target file was a stale plan document). Confirm via `git log` on this branch; re-apply from that plan file's own Tasks 1/2 if missing.

- [ ] **Step 2: Commit (if not already committed on this branch)**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-riders.md
git commit -m "docs(#972): fix the rider merge-point target to the real npc-move-parse.mjs (prerequisite for #1037)"
```

---

### Task 2: `pathDamage` rider and the affected-creature computation

**Files:**
- Modify: `scripts/npc-move-parse.mjs`
- Test: `tests/npc-move-parse.test.mjs` (extend)

**Interfaces:**
- Produces: a `pathDamage: {feet: number | "adjacent", save, dc, formula, type} | null` field on the movement-ability `plan` descriptor; `affectedCreaturesAlongPath(combat, mover, path, {feet, gridSize, gridDistanceFt})` → `Combatant[]` (pure given real geometry inputs).

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-move-parse.test.mjs (extend — add alongside the real file's
// own existing RIDER_TABLE tests)
import { affectedCreaturesAlongPath } from '../scripts/npc-move-parse.mjs';

function combatant(id, x, y) {
  return { id, token: { x, y, width: 1, height: 1 } };
}

describe('affectedCreaturesAlongPath (#1037)', () => {
  const combat = { combatants: [] };
  const gridSize = 100, gridDistanceFt = 5;

  it('affects a creature within range of any one square along the path, exactly once', () => {
    const mover = combatant('mover', 0, 0);
    const bystander = combatant('b1', 400, 0); // 20 ft from the path's 4th square
    const path = [{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 }, { gx: 4, gy: 0 }];
    const result = affectedCreaturesAlongPath({ combatants: [mover, bystander] }, mover, path, { feet: 20, gridSize, gridDistanceFt });
    expect(result.map((c) => c.id)).toEqual(['b1']);
  });

  it('affects a creature only once even when in range of several squares', () => {
    const mover = combatant('mover', 0, 0);
    const bystander = combatant('b1', 200, 0);
    const path = [{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 }, { gx: 4, gy: 0 }];
    const result = affectedCreaturesAlongPath({ combatants: [mover, bystander] }, mover, path, { feet: 20, gridSize, gridDistanceFt });
    expect(result).toHaveLength(1);
  });

  it('never includes the mover itself', () => {
    const mover = combatant('mover', 0, 0);
    const path = [{ gx: 0, gy: 0 }];
    const result = affectedCreaturesAlongPath({ combatants: [mover] }, mover, path, { feet: 20, gridSize, gridDistanceFt });
    expect(result).toHaveLength(0);
  });

  it('an "adjacent" feet value uses chebyshev <= 1 square, not a feet radius', () => {
    const mover = combatant('mover', 0, 0);
    const adjacentOne = combatant('a1', 100, 0); // 1 square away
    const twoSquaresAway = combatant('a2', 200, 0);
    const path = [{ gx: 0, gy: 0 }];
    const result = affectedCreaturesAlongPath({ combatants: [mover, adjacentOne, twoSquaresAway] }, mover, path, { feet: 'adjacent', gridSize, gridDistanceFt });
    expect(result.map((c) => c.id)).toEqual(['a1']);
  });

  it('returns [] for an empty or malformed path, never throwing', () => {
    const mover = combatant('mover', 0, 0);
    expect(() => affectedCreaturesAlongPath({ combatants: [mover] }, mover, [], { feet: 20, gridSize, gridDistanceFt })).not.toThrow();
    expect(affectedCreaturesAlongPath({ combatants: [mover] }, mover, null, { feet: 20, gridSize, gridDistanceFt })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-move-parse.test.mjs`
Expected: FAIL with "affectedCreaturesAlongPath is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/npc-move-parse.mjs -- append

/** #1037: a new rider field, alongside the existing charge/mapRule/
 * pushOnHit/pounceHidden fields #972 added -- added here to the SAME real
 * plan descriptor shape, not a parallel one.
 *   pathDamage: { feet: number | "adjacent", save, dc, formula, type } | null
 * Best-effort regex from the issue's own quoted examples; confirm against
 * real fixture items (Flaming Strafe, Spine Rake, Dance of Burning War)
 * before treating this rider as complete (Global Constraints). */
const PATH_DAMAGE_FEET_RE = /\beach creature within (\d+) feet of each square (?:it|the [a-z' -]+) moves? through\b.*?must (?:attempt|succeed at) an? @Check\[(\w+)\|dc:(\d+)\][^.]*?(?:take|takes) ([\w\s+d]+?) (\w+) damage/i;
const PATH_DAMAGE_ADJACENT_RE = /\beach creature (?:the|this) [a-z' -]+ is adjacent to at any point during its movement\b.*?must (?:attempt|succeed at) an? @Check\[(\w+)\|dc:(\d+)\][^.]*?(?:take|takes) ([\w\s+d]+?) (\w+) damage/i;

export function parsePathDamage(sentence) {
  const feetMatch = PATH_DAMAGE_FEET_RE.exec(sentence);
  if (feetMatch) {
    return { feet: Number(feetMatch[1]), save: feetMatch[2].toLowerCase(), dc: Number(feetMatch[3]), formula: feetMatch[4].trim(), type: feetMatch[5] };
  }
  const adjacentMatch = PATH_DAMAGE_ADJACENT_RE.exec(sentence);
  if (adjacentMatch) {
    return { feet: "adjacent", save: adjacentMatch[1].toLowerCase(), dc: Number(adjacentMatch[2]), formula: adjacentMatch[3].trim(), type: adjacentMatch[4] };
  }
  return null;
}

/** #1037: the de-duplicated affected-creature set for a path-damage
 * movement ability -- built from EVERY square of the real, executed
 * path (`path`, the same `steps`/`waypoint.steps` array
 * `executeNpcMoveCandidate` already computed), never the final position
 * alone. A `Map` keyed by combatant id guarantees each creature appears
 * at most once regardless of how many squares put it in range. */
export function affectedCreaturesAlongPath(combat, mover, path, { feet, gridSize, gridDistanceFt }) {
  const affected = new Map();
  for (const cell of path ?? []) {
    const cellPos = { x: cell.gx * gridSize, y: cell.gy * gridSize, width: 1, height: 1 };
    for (const candidate of combat.combatants) {
      if (candidate.id === mover.id || !candidate.token || affected.has(candidate.id)) continue;
      const inRange =
        feet === "adjacent"
          ? chebyshevSquares(cellPos, candidate.token, gridSize) <= 1
          : pf2eDistanceFeet(cellPos, candidate.token, gridSize, gridDistanceFt) <= feet;
      if (inRange) affected.set(candidate.id, candidate);
    }
  }
  return [...affected.values()];
}
```

Note: `chebyshevSquares`/`pf2eDistanceFeet` are real, exported from `scripts/dungeon-combat.mjs` — import them into `npc-move-parse.mjs`, or confirm at implementation time whether that creates a circular import with `dungeon-combat.mjs`'s own import of `parseMovementAbility` from this file (if so, move `affectedCreaturesAlongPath` into `dungeon-combat.mjs` itself instead, alongside the geometry helpers it already owns — flagged as a real possibility, not assumed clean).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-parse.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/npc-move-parse.mjs tests/npc-move-parse.test.mjs
git commit -m "feat(#1037): pathDamage rider and the de-duplicated affected-creature computation"
```

---

### Task 3: Wire into `executeNpcMoveCandidate`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-execute.test.mjs` (extend, or create if no existing file covers `executeNpcMoveCandidate`)

**Interfaces:**
- Produces: `applyPathDamage(combat, combatant, plan, path)`, called from `executeNpcMoveCandidate` after the move's own `walkNpcMoveSteps` completes.

- [ ] **Step 1: Write the failing test**

```js
// tests/npc-move-execute.test.mjs (extend or create)
import { describe, it, expect, vi } from 'vitest';
import { applyPathDamage } from '../scripts/dungeon-combat.mjs';

describe('applyPathDamage (#1037)', () => {
  it('rolls a save and applies damage independently for each affected creature', async () => {
    const roll1 = vi.fn().mockResolvedValue(undefined);
    const roll2 = vi.fn().mockResolvedValue(undefined);
    globalThis.game = { messages: { contents: [{ flags: { pf2e: { context: { outcome: 'failure' } } } }] } };
    const mover = { id: 'mover', token: { x: 0, y: 0, width: 1, height: 1 } };
    const c1 = { id: 'c1', token: { x: 100, y: 0, width: 1, height: 1 }, actor: { saves: { reflex: { roll: roll1 } } } };
    const c2 = { id: 'c2', token: { x: 100, y: 100, width: 1, height: 1 }, actor: { saves: { reflex: { roll: roll2 } } } };
    const combat = { combatants: [mover, c1, c2], scene: { grid: { size: 100, distance: 5 } } };
    const plan = { pathDamage: { feet: 'adjacent', save: 'reflex', dc: 20, formula: '2d6', type: 'fire' } };
    const path = [{ gx: 0, gy: 0 }];
    await applyPathDamage(combat, mover, plan, path);
    expect(roll1).toHaveBeenCalled();
    expect(roll2).toHaveBeenCalled();
  });

  it('does nothing when the plan carries no pathDamage rider', async () => {
    const result = await applyPathDamage({ combatants: [] }, { id: 'm1', token: {} }, {}, []);
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/npc-move-execute.test.mjs`
Expected: FAIL with "applyPathDamage is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new, near executeNpcMoveCandidate
/** #1037: applies a pathDamage rider's save/damage to every creature
 * affected along the real, executed path -- one real rollNpcAbilitySave
 * per creature (no dedicated multi-target area-save executor exists
 * outside spell-casting paths; this is the same posture #1022's
 * Reflective Scales already took). Independent per creature: one
 * creature's outcome never affects another's. */
export async function applyPathDamage(combat, mover, plan, path) {
  if (!plan?.pathDamage) return;
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const affected = affectedCreaturesAlongPath(combat, mover, path, { feet: plan.pathDamage.feet, gridSize, gridDistanceFt });
  for (const target of affected) {
    const saveStat = target.actor?.saves?.[plan.pathDamage.save];
    if (!saveStat) continue;
    await saveStat.roll({ dc: { value: plan.pathDamage.dc }, createMessage: true });
    const outcome = game.messages?.contents?.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const roll = await new Roll(plan.pathDamage.formula).roll();
    const scaled = outcome === "criticalSuccess" ? 0 : outcome === "success" ? Math.floor(roll.total / 2) : outcome === "criticalFailure" ? roll.total * 2 : roll.total;
    if (scaled > 0) await target.actor.applyDamage?.(scaled, { type: plan.pathDamage.type });
  }
}
```

Call `await applyPathDamage(combat, combatant, plan, planned.steps ?? planned.walk?.waypoint?.steps ?? [])` from `executeNpcMoveCandidate`, after its own `walkNpcMoveSteps` call(s) complete (both the plain-move and move-plus-Strike branches) — confirm the exact field name for the executed path at implementation time (`planned.steps` for the move-plus-Strike branch, `planned.walk.waypoint.steps` for the plain-move branch, per Investigation finding 1).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-execute.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-move-execute.test.mjs
git commit -m "feat(#1037): wire pathDamage into executeNpcMoveCandidate"
```

---

### Task 4: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/npc-move-parse.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add fixture-match tests**

Confirm Flaming Strafe/Spine Rake/Dance of Burning War's real compendium text against `parsePathDamage` (Global Constraints — not independently verified this session); add one fixture test per real item name, following this file's own established fixture-test convention.

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
git commit -m "test(#1037): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** The `pathDamage` rider and affected-set computation (Task 2) and its wiring into the real executor (Task 3) are covered. The #972 prerequisite fix (Task 1) is documented, not silently assumed.

**2. Placeholder scan:** No "TBD"/"TODO". The one genuinely unconfirmed piece (the path-damage rider's own exact regex, and the executed-path field name at both of `executeNpcMoveCandidate`'s own branches) is flagged plainly in Global Constraints/Investigation finding 1 and Task 3's own wiring note, with fully working code built around the stated assumption.

**3. Type consistency:** `affectedCreaturesAlongPath`'s `Combatant[]` return is consumed identically by its own tests and `applyPathDamage` (Task 3).

**4. Review Focus:** All five bullets (de-duplication across squares, affected-at-any-point-not-just-final-position, mover self-exclusion, malformed-path safety, per-creature independence) are each pinned to a named test in Tasks 2 and 3.

**Corrections found while writing this plan:** #972's own merged plan patches a stale plan document instead of the real `scripts/npc-move-parse.mjs` — the rider shapes it drafted (`{re, apply}`) already match the real `RIDER_TABLE` exactly, so this was a pure "wrong target file" bug, fixed as this plan's prerequisite Task 1, the same defect class (though a simpler instance of it) found four times before in this reaction/ability-feature sequence.
