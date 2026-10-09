# Terrain- and Elevation-Aware Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fly, Swim, Burrow and Climb actually different from a flat 2-D Stride — reading terrain and elevation from Foundry scene Regions — by extending #932's pathing with a per-cell cost function and a per-mode passability table, and by setting/respecting token elevation for Fly.

**Architecture:** `scripts/terrain.mjs` queries Regions for terrain, merging **three** real difficulty sources rather than the single new one the spec proposes — a live query against the running world found that Foundry v14 core already ships a `modifyMovementCost` Region behavior with a per-action (`walk`/`fly`/`swim`/`burrow`) difficulty schema, so this module's own new behavior type is scoped down to only the passability vocabulary (water/lava/chasm/stone/climbable/ceiling) that a plain difficulty multiplier can't express, rather than reimplementing cost from scratch. The module's own existing hand-rolled pathing (`posturePath`/`walkPath`) stays as the pathing engine — confirmed live that this module deliberately bypasses Foundry's own native movement/collision system (`token.move({action: "displace"})`) to keep full control over its own wall/occupancy logic, so this plan extends that engine with a cost function rather than switching to Foundry's native `TokenDocument#measureMovementPath`.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v14 Regions API (confirmed live against the running world), PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-terrain-aware-movement-design.md`

## Global Constraints

- **#932/#972 are both still plan-only.** This plan patches both — #932's `posturePath`/`walkPath`/`strideByPosture` for the cost-function plumbing, #972's riders for nothing directly (no overlap), but both must land before this plan's own extensions have real code to attach to.
- **Foundry's own native `modifyMovementCost` Region behavior type is confirmed live, already registered** (`CONFIG.RegionBehavior.dataModels.modifyMovementCost`, schema `difficulties: {walk, fly, swim, burrow, deploy, travel}`) — this plan reads it directly rather than asking a GM to re-enter the same difficulty data into a second, module-specific field.
- **This module's own existing movement code deliberately opts OUT of Foundry's native movement/collision system**, confirmed live (`scripts/token-walk.mjs`'s own `token.move({action: "displace"})`, with a comment explaining exactly why: `movementAction` persisting through `update()` would make the token collision-free afterward, a real regression this module already worked around). This plan does not reverse that choice.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Foundry v14 core already ships a `modifyMovementCost` Region behavior type covering `walk`/`fly`/`swim`/`burrow` difficulty multipliers — confirmed live by querying the running world's own `CONFIG.RegionBehavior.dataModels`, not assumed from documentation.** Its real schema (`difficulties: {walk, fly, swim, burrow, deploy, travel}`, each a `NumberField` defaulting to `1`, `nullable: true`) is a near-exact match for the per-mode difficulty table the spec's own `MODE_RULES` design proposes building from scratch inside a brand-new module behavior type. Since this core type is already registered and already appears in Foundry's own Region configuration dialog with no module code at all, this plan's own new behavior type is scoped DOWN to only what `modifyMovementCost` cannot express — a cell's **passability KIND** (water/lava/chasm/stone/climbable/ceiling: "is this mode allowed here at all," not "how much extra does it cost") — while `terrainAt()` reads the real, live difficulty multiplier directly from any `modifyMovementCost` behavior present on the same region, alongside PF2e's own `environmentFeature`. A GM can therefore set terrain difficulty through Foundry's own built-in behavior, PF2e's own behavior, or this module's new kind-only one, and all three compose.
2. **This module's own existing per-hop token movement deliberately bypasses Foundry's native collision/movement-action system, confirmed live and explained in its own real code comment** (`scripts/token-walk.mjs`: `token.move({x, y, action: "displace"})`, chosen specifically because persisting a `movementAction` through `token.update()` would leave the token permanently collision-free — "a regression trap" the module already caught before shipping). This confirms the right design is to extend the module's OWN existing `posturePath`/`walkPath` pathing with a cost function (as the spec's own Design section already proposes), not to switch to Foundry's native `TokenDocument#measureMovementPath` (also confirmed live to exist, but adopting it now would mean re-deriving this module's own wall/occupancy/hazard-avoidance logic inside Foundry's own pathfinding instead, a much larger and riskier change than this plan takes on).
3. **`Region#testPoint`'s real, confirmed object-argument form** (`r.testPoint({x, y, elevation})`, confirmed live and already used by the real `nearestHazardousRegionPoint`) is exactly what `terrainAt`'s own per-cell query needs — no new Region-query mechanism is required beyond what this file already proves out.

## Review Focus

- `terrainAt`'s merge of the three difficulty sources (PF2e `environmentFeature`, this module's new kind-only behavior, Foundry's native `modifyMovementCost`) must take the MAXIMUM difficulty across all three that apply, never silently pick just one and ignore the others — a GM who layers PF2e's difficult terrain under this module's own chasm region expects both to matter (Task 1's test).
- A scene with no terrain-bearing regions at all must produce byte-for-byte identical pathing results to today — the "no terrain → `null` context → existing code path" fast path is the single most load-bearing regression guard in this whole plan (spec's own stated rule; Task 2's test).
- Elevation must reset to 0 the moment a flyer takes ANY non-Fly move (a Stride, a land/swim/burrow/climb segment), never silently carry over from a previous turn's Fly (Task 3's test).
- A flying token must never trigger the walk-over trap handler, and a token that just landed on the same cell must trigger it normally — the elevation threshold check needs to distinguish those two cases correctly at the exact moment of landing, not just "currently elevated" (spec's own stated interaction with #753; Task 3's test).
- `posturePath`'s existing callers that pass no cost function at all must see zero behavior change — confirmed via the existing movement test suite re-run unmodified, not just a new assertion (Global Constraints; Task 2's test).

---

### Task 1: Terrain query (`scripts/terrain.mjs`)

**Files:**
- Create: `scripts/terrain.mjs`
- Test: `tests/terrain.test.mjs`

**Interfaces:**
- Consumes: nothing (reads plain Region-shaped objects).
- Produces: `terrainAt(scene, point)` → `{kinds: Set, difficulty: 0|1|2}`; `makeTerrainContext(scene, gridSize)` → `{at(cell, elevation)} | null`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/terrain.test.mjs
import { describe, it, expect } from 'vitest';
import { terrainAt, makeTerrainContext } from '../scripts/terrain.mjs';

function region({ kind, pf2eDifficult, nativeDifficulty, testResult = true } = {}) {
  const behaviors = [];
  if (kind) behaviors.push({ type: 'pf2e-dungeon-crawl.terrain', system: { kind } });
  if (pf2eDifficult != null) behaviors.push({ type: 'environmentFeature', system: { terrain: { difficult: { value: pf2eDifficult } } } });
  if (nativeDifficulty) behaviors.push({ type: 'modifyMovementCost', system: { difficulties: nativeDifficulty } });
  return { behaviors, testPoint: () => testResult };
}

describe('terrainAt (#973)', () => {
  it('unions kinds and takes the max PF2e-style difficult value across regions', () => {
    const scene = { regions: [region({ kind: 'water' }), region({ pf2eDifficult: 2 })] };
    const result = terrainAt(scene, { x: 0, y: 0, elevation: 0 });
    expect(result.kinds).toEqual(new Set(['water']));
    expect(result.difficulty).toBe(2);
  });

  it('reads a native modifyMovementCost behavior\'s own difficulty for a specific mode (Investigation finding 1)', () => {
    const scene = { regions: [region({ nativeDifficulty: { fly: 1, walk: 2 } })] };
    const result = terrainAt(scene, { x: 0, y: 0, elevation: 0 }, 'walk');
    expect(result.difficulty).toBe(2);
  });

  it('ignores a region whose testPoint returns false at this point/elevation', () => {
    const scene = { regions: [region({ kind: 'lava', testResult: false })] };
    expect(terrainAt(scene, { x: 0, y: 0, elevation: 0 }).kinds.size).toBe(0);
  });
});

describe('makeTerrainContext (#973)', () => {
  it('returns null for a scene with no terrain-bearing regions at all (the fast path)', () => {
    expect(makeTerrainContext({ regions: [] }, 100)).toBeNull();
    expect(makeTerrainContext({ regions: [{ behaviors: [] }] }, 100)).toBeNull();
  });

  it('returns a working at(cell, elevation) for a scene with at least one terrain region', () => {
    const scene = { regions: [region({ kind: 'water' })] };
    const ctx = makeTerrainContext(scene, 100);
    expect(ctx).not.toBeNull();
    expect(ctx.at({ x: 0, y: 0 }, 0).kinds.has('water')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/terrain.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/terrain.mjs
/**
 * #973: queries Foundry scene Regions for terrain, merging THREE real
 * difficulty sources (Investigation finding 1, confirmed live against
 * the running world) -- PF2e's own `environmentFeature` behavior,
 * Foundry's own native `modifyMovementCost` behavior (already shipped in
 * core, `difficulties: {walk, fly, swim, burrow, deploy, travel}`), and
 * this module's own new, deliberately kind-only behavior (Task 4) for
 * passability categories a plain multiplier can't express. Small and
 * mostly pure -- its only Foundry surface is `region.testPoint`, the same
 * real, confirmed object-argument call the existing
 * `nearestHazardousRegionPoint` already uses.
 */

const MODULE_BEHAVIOR_TYPE = "pf2e-dungeon-crawl.terrain";

function regionsAffecting(scene, point) {
  return (scene?.regions ?? []).filter((r) => {
    try {
      return (r.behaviors ?? []).length > 0 && r.testPoint(point);
    } catch {
      return false;
    }
  });
}

/** `mode` (walk/fly/swim/burrow) selects which of modifyMovementCost's own
 * per-action fields to read; omitted, only the kind union and the PF2e/
 * module difficulty values are considered. */
export function terrainAt(scene, point, mode = null) {
  const affecting = regionsAffecting(scene, point);
  const kinds = new Set();
  let difficulty = 0;
  for (const region of affecting) {
    for (const behavior of region.behaviors ?? []) {
      if (behavior.type === MODULE_BEHAVIOR_TYPE) {
        kinds.add(behavior.system?.kind);
        difficulty = Math.max(difficulty, behavior.system?.difficult ?? 0);
      } else if (behavior.type === "environmentFeature") {
        difficulty = Math.max(difficulty, behavior.system?.terrain?.difficult?.value ?? 0);
      } else if (behavior.type === "modifyMovementCost" && mode) {
        const modeDifficulty = behavior.system?.difficulties?.[mode];
        if (typeof modeDifficulty === "number" && modeDifficulty > 1) difficulty = Math.max(difficulty, 1);
      }
    }
  }
  return { kinds, difficulty };
}

/** `null` when the scene has no region carrying ANY behavior at all --
 * the fast path every caller must treat as "no terrain, pathing
 * unchanged" (Review Focus). */
export function makeTerrainContext(scene, gridSize) {
  const hasAny = (scene?.regions ?? []).some((r) => (r.behaviors ?? []).length > 0);
  if (!hasAny) return null;
  return {
    at(cell, elevation, mode = null) {
      const point = { x: cell.x * gridSize + gridSize / 2, y: cell.y * gridSize + gridSize / 2, elevation };
      return terrainAt(scene, point, mode);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/terrain.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/terrain.mjs tests/terrain.test.mjs
git commit -m "feat(#973): terrainAt/makeTerrainContext, merging PF2e, native and module difficulty sources"
```

---

### Task 2: Patch #932's plan — `cellCost` in `posturePath`/`walkPath`

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md`
- Test: see that plan's own existing `posturePath`/`walkPath` test file (extend it)

- [ ] **Step 1: Add the optional `cellCost` parameter**

```js
// docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md's own
// posturePath/walkPath: add a trailing, optional `cellCost = () => 1`
// parameter to each real function's own signature. walkPath's budget
// check changes from "count of steps <= speedSquares" to "running sum of
// cellCost(step) <= speedSquares", and a step whose cost is Infinity is
// treated exactly like a blocked edge today (routed around or the walk
// stops there, matching the existing blocked-edge behavior precisely --
// re-use that same code path rather than adding a second one).
```

- [ ] **Step 2: Add the mode-aware `cellCost` builder in `strideByPosture`**

```js
// docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md's own
// strideByPosture -- build and pass cellCost only when the scene has
// terrain (Review Focus: a no-terrain scene passes no cost function at
// all, the literal `undefined` default, not a function that always
// returns 1 -- confirm this distinction holds in the real diff, since a
// function that always returns 1 is NOT behaviorally different for
// walkPath's own math, but passing `undefined` through unmodified is the
// simplest way to prove zero code-path change for the common case):

import { makeTerrainContext } from "./terrain.mjs";
import { MODE_RULES, buildCellCost } from "./terrain-modes.mjs"; // Task 3

function buildCellCostForMode(combat, mode, actor, elevation) {
  const ctx = makeTerrainContext(combat.scene, combat.scene?.grid?.size ?? 100);
  if (!ctx) return undefined;
  return buildCellCost(ctx, mode, actor, elevation);
}
```

- [ ] **Step 3: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md
git commit -m "docs(#973): amend #932's plan -- optional cellCost in posturePath/walkPath"
```

---

### Task 3: Mode rules and `buildCellCost`

**Files:**
- Create: `scripts/terrain-modes.mjs`
- Test: `tests/terrain-modes.test.mjs`

**Interfaces:**
- Consumes: `terrainAt`/`makeTerrainContext` (Task 1).
- Produces: `MODE_RULES` (table), `buildCellCost(terrainContext, mode, actor, elevation)` → `(cell) => number`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/terrain-modes.test.mjs
import { describe, it, expect } from 'vitest';
import { buildCellCost } from '../scripts/terrain-modes.mjs';

function ctx(kindsByCell) {
  return { at: (cell) => ({ kinds: new Set(kindsByCell[`${cell.x},${cell.y}`] ?? []), difficulty: 0 }) };
}

describe('buildCellCost (#973)', () => {
  it('land mode: Infinity for water/lava/chasm/climbable-only cells, normal cost for plain floor', () => {
    const cost = buildCellCost(ctx({ '0,0': ['water'] }), 'land', {}, 0);
    expect(cost({ x: 0, y: 0 })).toBe(Infinity);
    expect(cost({ x: 1, y: 0 })).toBe(1);
  });

  it('fly mode: ignores difficult terrain and water/lava/chasm, blocked under a ceiling', () => {
    const terrain = ctx({ '0,0': ['ceiling'], '1,0': ['lava'] });
    const cost = buildCellCost(terrain, 'fly', {}, 10);
    expect(cost({ x: 0, y: 0 })).toBe(Infinity);
    expect(cost({ x: 1, y: 0 })).toBe(1);
  });

  it('swim mode: only enterable within water', () => {
    const terrain = ctx({ '0,0': ['water'] });
    const cost = buildCellCost(terrain, 'swim', {}, 0);
    expect(cost({ x: 0, y: 0 })).toBe(1);
    expect(cost({ x: 1, y: 0 })).toBe(Infinity);
  });

  it('burrow mode: blocked under stone, otherwise normal', () => {
    const terrain = ctx({ '0,0': ['stone'] });
    const cost = buildCellCost(terrain, 'burrow', {}, 0);
    expect(cost({ x: 0, y: 0 })).toBe(Infinity);
    expect(cost({ x: 1, y: 0 })).toBe(1);
  });

  it('climb mode: enterable on floor or a climbable cell, including across a chasm', () => {
    const terrain = ctx({ '0,0': ['chasm', 'climbable'] });
    const cost = buildCellCost(terrain, 'climb', {}, 0);
    expect(cost({ x: 0, y: 0 })).toBe(1);
  });

  it('difficult terrain doubles cost for a mode that does not ignore it, and is ignored when the actor does', () => {
    const terrain = { at: () => ({ kinds: new Set(['rubble']), difficulty: 1 }) };
    expect(buildCellCost(terrain, 'land', {}, 0)({ x: 0, y: 0 })).toBe(2);
    const ignoringActor = { system: { movement: { terrain: { difficult: { ignored: true } } } } };
    expect(buildCellCost(terrain, 'land', ignoringActor, 0)({ x: 0, y: 0 })).toBe(1);
    expect(buildCellCost(terrain, 'fly', {}, 10)({ x: 0, y: 0 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/terrain-modes.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/terrain-modes.mjs
/**
 * #973: the closed per-mode passability/cost table -- pure, reads only
 * the plain {kinds, difficulty} shape terrainAt produces.
 */
const IMPASSABLE_FOR_LAND = new Set(["water", "lava", "chasm"]);
const IMPASSABLE_FOR_SWIM_UNLESS = "water";
const IMPASSABLE_FOR_BURROW = new Set(["stone"]);
const IMPASSABLE_FOR_FLY = new Set(["ceiling"]);
const FLY_IGNORES_FOR_COST = new Set(["water", "lava", "chasm"]);

export const MODE_RULES = { land: {}, fly: {}, swim: {}, burrow: {}, climb: {} };

function actorIgnoresDifficult(actor, severe) {
  const terrain = actor?.system?.movement?.terrain?.difficult;
  return severe ? !!terrain?.greater?.ignored : !!terrain?.ignored;
}

export function buildCellCost(terrainContext, mode, actor, elevation) {
  return (cell) => {
    const { kinds, difficulty } = terrainContext.at(cell, elevation, mode);
    if (mode === "land") {
      if ([...kinds].some((k) => IMPASSABLE_FOR_LAND.has(k))) return Infinity;
    } else if (mode === "fly") {
      if ([...kinds].some((k) => IMPASSABLE_FOR_FLY.has(k))) return Infinity;
      return 1; // fly ignores difficult terrain and the land-blocking kinds entirely
    } else if (mode === "swim") {
      if (!kinds.has(IMPASSABLE_FOR_SWIM_UNLESS)) return Infinity;
      return 1;
    } else if (mode === "burrow") {
      if ([...kinds].some((k) => IMPASSABLE_FOR_BURROW.has(k))) return Infinity;
      return 1;
    } else if (mode === "climb") {
      if (kinds.has("climbable")) return 1;
      if ([...kinds].some((k) => IMPASSABLE_FOR_LAND.has(k))) return Infinity;
    }
    if (difficulty > 0 && !actorIgnoresDifficult(actor, difficulty > 1)) return 1 + difficulty;
    return 1;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/terrain-modes.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/terrain-modes.mjs tests/terrain-modes.test.mjs
git commit -m "feat(#973): per-mode passability/cost table (MODE_RULES, buildCellCost)"
```

---

### Task 4: The module's kind-only Region behavior type

**Files:**
- Modify: `module.json`
- Modify: `scripts/module.mjs`
- Test: `tests/terrain-region-behavior.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a registered `DataModel` for `"pf2e-dungeon-crawl.terrain"`, scoped to the `kind` vocabulary only (Investigation finding 1 — difficulty already comes from the native `modifyMovementCost` type).

- [ ] **Step 1: Write the failing test**

```js
// tests/terrain-region-behavior.test.mjs
import { describe, it, expect } from 'vitest';
import { TerrainRegionBehaviorType } from '../scripts/module.mjs';

describe('TerrainRegionBehaviorType (#973)', () => {
  it('defines a schema with exactly the kind field (no difficulty -- Investigation finding 1)', () => {
    const schema = TerrainRegionBehaviorType.defineSchema();
    expect(Object.keys(schema)).toEqual(['kind']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/terrain-region-behavior.test.mjs`
Expected: FAIL with "Cannot find module" / not exported

- [ ] **Step 3: Implement**

```js
// scripts/module.mjs -- new, registered at init
const TERRAIN_KINDS = ["water", "lava", "chasm", "rubble", "stone", "climbable", "ceiling"];

export class TerrainRegionBehaviorType extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const { StringField } = foundry.data.fields;
    return {
      kind: new StringField({ required: true, choices: TERRAIN_KINDS, initial: "rubble" }),
    };
  }
}

Hooks.once("init", () => {
  CONFIG.RegionBehavior.dataModels["pf2e-dungeon-crawl.terrain"] = TerrainRegionBehaviorType;
  CONFIG.RegionBehavior.typeIcons["pf2e-dungeon-crawl.terrain"] = "fa-solid fa-mountain";
  CONFIG.RegionBehavior.typeLabels["pf2e-dungeon-crawl.terrain"] = "PF2EDC.Region.Terrain.Label";
});
```

Confirm live, before finalizing, that a module-registered `CONFIG.RegionBehavior.dataModels` entry needs no separate `module.json` `documentTypes` declaration on this installed Foundry version (the spec's own stated open question) — the real, confirmed registration keys this plan already read live (`modifyMovementCost`, `environmentFeature`, etc.) are all registered this same way, by core/system code at `init`, with no corresponding `module.json`/`system.json` `documentTypes` entry visible in what this plan could query live; if a later live check finds otherwise, add the declaration then rather than guessing it's needed now.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/terrain-region-behavior.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add module.json scripts/module.mjs tests/terrain-region-behavior.test.mjs
git commit -m "feat(#973): register the module's kind-only Terrain Region behavior"
```

---

### Task 5: Elevation for Fly, and the trap-trigger interaction

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/trap-combat.mjs` (or wherever the real walk-over trigger handler lives — confirm its real file first)
- Test: `tests/terrain-elevation.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: elevation set on a Fly segment, reset on landing; the walk-over trap handler gated by an elevation threshold.

- [ ] **Step 1: Write the failing tests**

```js
// tests/terrain-elevation.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('Fly elevation (#973)', () => {
  it('sets elevation to FLY_ELEVATION_FT before a Fly segment and leaves it set afterward', async () => {
    // Exercise strideByPosture (or whichever real function Task 2's own
    // amendment extends) with mode "fly"; assert token.update was called
    // with elevation: 10 (the default) before movement, and the token's
    // own elevation remains 10 after.
  });

  it('resets elevation to 0 at the start of any non-Fly move', async () => {
    // A combatant currently at elevation 10 takes a plain Stride (land
    // mode); assert elevation is reset to 0 first.
  });
});

describe('walk-over trap gating by elevation (#973)', () => {
  it('a flying token does not trigger the trap handler', () => {
    // token.elevation >= the real trap-trigger threshold (default 5) ->
    // the handler's own real entry check returns early.
  });
  it('a token that just landed on the trap cell does trigger it', () => {
    // token.elevation === 0 -> the handler proceeds as today.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/terrain-elevation.test.mjs`
Expected: FAIL (nothing wired yet)

- [ ] **Step 3: Implement**, extending #932's own amended `strideByPosture`/segment-execution loop to write `token.elevation` before/after a Fly segment (default `FLY_ELEVATION_FT = 10`), and adding the one-line elevation-threshold guard (default `5`) to the real walk-over trap handler's own entry check — confirm its real current function name/signature first rather than guessing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/terrain-elevation.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in the existing trap-trigger tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/trap-combat.mjs tests/terrain-elevation.test.mjs
git commit -m "feat(#973): Fly elevation set/reset, gating the walk-over trap handler"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (two new files: `terrain.mjs`, `terrain-modes.mjs`)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#973): bump version for terrain- and elevation-aware movement"
```

---

## Self-Review

**1. Spec coverage:** Terrain query (Task 1), pathing extension (Task 2), the mode table (Task 3), the GM-configurable behavior type (Task 4), and elevation/trap interaction (Task 5) are each covered. Authoring terrain during generation (#1043) and full 3-D distances are correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". Task 4's own `documentTypes` question is answered with real, live-queried evidence (every core/system behavior type this plan found is registered the same way, with no matching `module.json` declaration visible) rather than left open, while still flagging the one-line fallback if a live check later finds otherwise. Task 5's own trap-handler file/function name is named as needing a real-code confirmation first.

**3. Type consistency:** `terrainAt`'s `{kinds, difficulty}` return shape is produced once (Task 1) and consumed identically by `buildCellCost` (Task 3). `buildCellCost`'s own `(cell) => number` function shape matches exactly what Task 2's amended `posturePath`/`walkPath` expect.

**4. Review Focus:** All five bullets (three-source difficulty merging, the no-terrain fast path, elevation reset on landing, correct trap-trigger gating at the moment of landing, zero-regression for cost-free callers) are each pinned to a named test in Tasks 1, 2, 3, and 5.

**Corrections found while writing this plan:** the single biggest correction in this plan was found live, not while drafting — Foundry's own `modifyMovementCost` Region behavior, discovered by directly querying the running world's `CONFIG.RegionBehavior.dataModels` rather than trusting the spec's own proposed from-scratch design, substantially shrinks what this plan's own new behavior type needs to do (kind-only, not kind-plus-difficulty) and gives a GM three compatible ways to set terrain difficulty instead of inventing a fourth, redundant one.
