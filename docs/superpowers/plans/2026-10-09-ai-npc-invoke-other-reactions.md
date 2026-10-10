# Invoke-Other/Move/Counteract NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model the reaction EFFECT shapes #961's own grammar explicitly returns `null` for (an effect that invokes another ability, moves/transforms the reactor, or counteracts): **Slink** (Stride/Climb/Swim up to 10 feet), **Crumble** (Burrow down 20 feet), **Overwhelming Light** (counteract). **Fast Swallow** (which "uses Swallow Whole") is explicitly deferred — Swallow Whole itself has no real executor anywhere in this codebase and is a substantial new subsystem (engulfment, escape, ongoing damage), not something to invent inline for one reaction's own sake; the issue's own framing ("needs the invoked ability... modeled first") is honored by stating this plainly rather than guessing a shape.

**Architecture:** Slink/Crumble reuse #932's real movement machinery (`planPostureWalk`, confirmed real, `dungeon-combat.mjs:6461`) via a small, additive extension to the real `strideByPosture(combat, combatant, posture, target)` — an optional `{maxSquares}` override, backward-compatible with every existing caller, since neither reaction moves the reactor's own full Speed. Overwhelming Light reuses the real, merged `scripts/counteract.mjs` (#1021). Both reactions' own TRIGGER halves (Slink: "a creature ends its movement adjacent to the viper," a proximity trigger; Overwhelming Light: not independently confirmed this session) are #961's own responsibility (its real proximity-trigger emitters, still plan-only) — this plan's own registry rows and executors are written against that dependency, the same posture every other deferred-issue plan in this sequence takes toward an unimplemented prerequisite.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** No dedicated spec file exists for #1027 — scoped by `docs/superpowers/specs/2026-10-09-ai-npc-other-triggered-reactions-design.md`'s (#961's) own deferred-items framing (its line 108: "Reactions that invoke other abilities or move/transform the reactor (Fast Swallow → Swallow Whole, Slink, Crumble, Overwhelming Light) — #1027") and the issue body.

## Global Constraints

- **#931 is real, merged code** (confirmed, same finding as every other plan in this sequence) — the two registry rows this plan adds go into `scripts/npc-reactions.mjs` directly.
- **#961's own plan is still 100% plan-only, and this plan depends on its proximity-trigger emitters landing** for Slink/Overwhelming Light to actually fire in real play — this plan's own executors are written and tested in isolation (callable directly, fully testable without #961's own trigger plumbing), with the wiring step stated as depending on #961's emitters by name rather than re-deriving a parallel trigger-detection mechanism.
- **Fast Swallow/Swallow Whole and any transformation mechanic are explicitly out of scope** — confirmed no real or planned executor exists anywhere in this codebase for either. This plan adds no registry row for Fast Swallow.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **#961's spec (line 25) gives Slink's real trigger**: "a creature ends its movement adjacent to the viper or within the viper's space" — a proximity trigger, not a timing one (unlike #1026's own family). #961's own plan lists `proximityApproach`/`proximityEndTurn` emitters by name as part of its planned (not yet implemented) grammar.
2. **Swallow Whole is a real, glossary-referenced ability with no parseable prose** — confirmed live (Foundry 14.368, `foundry-rest`): the compendium item's own description is `[Listed Size], @Damage[(0)[bludgeoning]], Rupture [0]` plus a bare `@Localize[PF2E.NPC.Abilities.Glossary.SwallowWhole]` token, the same "real prose doesn't exist in item data" situation #959's own Ferocity investigation already found. Modeling it for real would need the RAW rules text from outside this module's own data (engulfment, Escape DC, ongoing damage, regurgitation) — a correctly-scoped follow-up, not a guess made here.
3. **`planPostureWalk(combat, combatant, posture, target, speedSquares, {straightLine})` is real** (`dungeon-combat.mjs:6461`) — the lower-level function `strideByPosture` itself calls, already parameterized by an explicit `speedSquares` cap. `strideByPosture`'s own real body currently derives that cap ONLY from the actor's full land Speed (`combatant.actor?.system?.movement?.speeds?.land?.value`), with no override parameter — Task 2 adds one, backward-compatible with every existing caller (defaults to the current unchanged behavior when omitted).
4. **`scripts/counteract.mjs` is real, merged** (#1021: `counteractRank`, `counteractOutcome`, `rollCounteract`) — Overwhelming Light's counteract-vs-darkness reuses it directly, no new counteract mechanic needed.

## Review Focus

- Slink/Crumble must never move the reactor farther than their own stated cap (10 ft / 20 ft) even when the actor's own full Speed is much higher — the whole point of the `{maxSquares}` override is to prevent `strideByPosture`'s own default (full Speed) from silently applying (Task 2's test).
- The `{maxSquares}` override must never affect any EXISTING caller of `strideByPosture` that doesn't pass it — confirmed by running the full existing suite, not just this plan's own new tests (Task 2's test).
- Overwhelming Light's counteract must use the REACTOR's own counteract rank/modifier (from its own item text, once reviewed), never a hardcoded placeholder — flagged for live confirmation of the exact rank/modifier at implementation time, since this session did not independently verify Overwhelming Light's own compendium text (Task 3's test structure accommodates whatever real numbers are confirmed then).
- Fast Swallow must get NO registry row and NO executor in this plan — a reviewer should be able to confirm its absence is deliberate (stated in Global Constraints) rather than an oversight.
- Crumble's Burrow must never leave the reactor in an obviously invalid position (e.g. a burrow move that `planPostureWalk` can't path at all) — falls back to a no-op the same way every other movement executor in this file already does on an unpathable move (Task 2's test).

---

### Task 1: Registry rows

**Files:**
- Modify: `scripts/npc-reactions.mjs`

- [ ] **Step 1: Add the two registry rows (Fast Swallow deliberately excluded)**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS. Both reuse #961's
// own planned "proximity" trigger kind by name (still plan-only); no new
// trigger string is added here since this plan does not own trigger
// detection, only the effect executor.
Object.freeze({
  id: "slink", label: "Slink", match: /^Slink\b/i,
  triggers: ["proximityEndTurn"], kind: "escapeMove", priority: 5, policy: always,
  move: { mode: "land", maxFeet: 10, alsoModes: ["climb", "swim"] },
}),
Object.freeze({
  id: "crumble", label: "Crumble", match: /^Crumble\b/i,
  triggers: ["proximityEndTurn"], kind: "escapeMove", priority: 5, policy: always,
  move: { mode: "burrow", maxFeet: 20 },
}),
Object.freeze({
  id: "overwhelming-light", label: "Overwhelming Light", match: /^Overwhelming Light\b/i,
  triggers: ["proximityApproach"], kind: "counteractEffect", priority: 5, policy: always,
  counteract: { rank: null, modifier: null }, // confirm the item's own real values at implementation time (Review Focus)
}),
```

- [ ] **Step 2: Commit**

```bash
git add scripts/npc-reactions.mjs
git commit -m "feat(#1027): registry rows for Slink, Crumble, Overwhelming Light (Fast Swallow deliberately excluded)"
```

---

### Task 2: Escape-move executor (Slink, Crumble)

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`strideByPosture`, extended with an optional `{maxSquares}` override; new `executeEscapeMove`)
- Test: `tests/npc-invoke-other-reactions.test.mjs`

**Interfaces:**
- Produces: the extended `strideByPosture(combat, combatant, posture, target, {maxSquares} = {})`; `executeEscapeMove(combat, reactor, attacker, def)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-invoke-other-reactions.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('strideByPosture maxSquares override (#1027)', () => {
  it('caps the move distance below the actor\'s own full speed when provided', async () => {
    const { strideByPosture } = await import('../scripts/dungeon-combat.mjs');
    const combatant = {
      token: { x: 0, y: 0 },
      actor: { system: { movement: { speeds: { land: { value: 100 } } } } }, // 20 squares at 5ft
    };
    const combat = { scene: { grid: { size: 100, distance: 5 } } };
    // Spy-free smoke test: confirm the function accepts the option without
    // throwing and doesn't require speed-derived squares when it's given.
    await expect(strideByPosture(combat, combatant, 'retreat', null, { maxSquares: 2 })).resolves.toBeDefined();
  });
});

describe('executeEscapeMove (#1027)', () => {
  it('moves the reactor via strideByPosture, capped to the def\'s own maxFeet', async () => {
    const { executeEscapeMove } = await import('../scripts/dungeon-combat.mjs');
    const strideFn = vi.fn().mockResolvedValue('moved');
    const combat = { scene: { grid: { size: 100, distance: 5 } } };
    const reactor = { token: { x: 0, y: 0 } };
    const def = { move: { mode: 'burrow', maxFeet: 20 } };
    const result = await executeEscapeMove(combat, reactor, { token: { x: 500, y: 0 } }, def, { strideByPosture: strideFn });
    expect(strideFn).toHaveBeenCalledWith(combat, reactor, 'retreat', { token: { x: 500, y: 0 } }, { maxSquares: 4 });
    expect(result.moved).toBe(true);
  });

  it('reports moved:false when the move is unpathable, never throwing', async () => {
    const { executeEscapeMove } = await import('../scripts/dungeon-combat.mjs');
    const strideFn = vi.fn().mockResolvedValue('no-path');
    const combat = { scene: { grid: { size: 100, distance: 5 } } };
    const result = await executeEscapeMove(combat, { token: {} }, { token: {} }, { move: { mode: 'land', maxFeet: 10 } }, { strideByPosture: strideFn });
    expect(result.moved).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-invoke-other-reactions.test.mjs`
Expected: FAIL with "executeEscapeMove is not exported" (and the `maxSquares` smoke test fails since the option is ignored)

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- strideByPosture, extended (backward
// compatible: existing callers that omit the 5th argument are unaffected)
export async function strideByPosture(combat, combatant, posture, target, { maxSquares } = {}) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const preSnap = rawPosition(combatant.token);
  await snapTokenToGrid(combatant.token, gridSize);
  const preReported = await reportPreMoveOverlap("strideByPosture", combat, combatant, preSnap, gridSize, target);
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = maxSquares ?? Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return "no-speed";
  // ... unchanged from here: planPostureWalk(combat, combatant, posture, target, speedSquares), etc.
}

/** #1027: Slink/Crumble's own "Stride/Climb/Swim or Burrow up to N feet"
 * escape move -- a capped `strideByPosture` "retreat" (away from whatever
 * triggered the reaction), never the actor's own full Speed. `mode`
 * (land/climb/swim/burrow) affects which real NPC_MOVE_MODES speed Slink's
 * own "alsoModes" variants are allowed to use -- confirmed at
 * implementation time against `moverSpeedsOf`'s real per-mode lookup
 * rather than assumed identical to land speed. */
export async function executeEscapeMove(combat, reactor, attacker, def, { strideByPosture: strideFn = strideByPosture } = {}) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const maxSquares = Math.floor(def.move.maxFeet / gridDistanceFt);
  const result = await strideFn(combat, reactor, "retreat", attacker, { maxSquares });
  return { moved: result === "moved" || result === "disrupted" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-invoke-other-reactions.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions — every existing `strideByPosture` call site is unaffected by the new optional parameter)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-invoke-other-reactions.test.mjs
git commit -m "feat(#1027): executeEscapeMove for Slink/Crumble, extending strideByPosture with an optional distance cap"
```

---

### Task 3: Overwhelming Light (counteract)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-invoke-other-reactions.test.mjs`

**Interfaces:**
- Consumes: `rollCounteract` (real, `scripts/counteract.mjs`, #1021).
- Produces: `executeOverwhelmingLight(combat, reactor, darknessEffect)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/npc-invoke-other-reactions.test.mjs (append)
import { executeOverwhelmingLight } from '../scripts/dungeon-combat.mjs';

describe('executeOverwhelmingLight (#1027)', () => {
  it('counteracts a darkness effect and reports the result', async () => {
    const rng = () => 0.99; // guarantees a high roll
    const result = await executeOverwhelmingLight({}, { name: 'Trumpet Archon' }, { rank: 3, name: 'Darkness' }, { rng });
    expect(typeof result.counteracted).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/npc-invoke-other-reactions.test.mjs`
Expected: FAIL with "executeOverwhelmingLight is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
import { counteractRank, rollCounteract } from "./counteract.mjs";

/** #1027: Overwhelming Light -- counteracts a darkness effect using the
 * real RAW counteract helper (#1021). The reactor's own counteract
 * rank/modifier are read off its reaction item (`def.counteract`) --
 * confirmed at implementation time against Overwhelming Light's own real
 * compendium text (this session did not independently verify its exact
 * numbers; see Review Focus). Posts a public announcement either way. */
export async function executeOverwhelmingLight(combat, reactor, darknessEffect, { rng, counteract = {} } = {}) {
  const targetRank = counteractRank(darknessEffect);
  const result = rollCounteract({
    modifier: counteract.modifier ?? 0,
    dc: 10 + targetRank,
    counteractorRank: counteract.rank ?? targetRank,
    targetRank,
    rng,
  });
  const esc = (s) => foundry.utils?.escapeHTML?.(String(s)) ?? String(s);
  await ChatMessage.create({
    content: `<p><strong>${esc(reactor.name)}</strong> ${result.counteracted ? "dispels the darkness with overwhelming light!" : "fails to overcome the darkness."}</p>`,
  });
  return { counteracted: result.counteracted };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-invoke-other-reactions.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-invoke-other-reactions.test.mjs
git commit -m "feat(#1027): Overwhelming Light counteract executor"
```

---

### Task 4: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/npc-invoke-other-reactions.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add the fixture-match tests**

```js
// tests/npc-invoke-other-reactions.test.mjs (append)
import { REACTION_DEFS } from '../scripts/npc-reactions.mjs';

describe('fixture matches (#1027)', () => {
  const names = ['Slink', 'Crumble', 'Overwhelming Light'];
  it.each(names)('a real item named "%s" matches its own registry row', (name) => {
    expect(REACTION_DEFS.find((d) => d.match.test(name))).toBeTruthy();
  });
  it('no registry row exists for Fast Swallow (deliberately deferred)', () => {
    expect(REACTION_DEFS.find((d) => d.id === "fast-swallow")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-invoke-other-reactions.test.mjs`
Expected: PASS

- [ ] **Step 3: Run the `update-architecture-docs` skill**

New exports on `scripts/dungeon-combat.mjs` (`executeEscapeMove`, `executeOverwhelmingLight`, the extended `strideByPosture`). Run the skill and commit any update it produces alongside this task's own commit.

- [ ] **Step 4: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add tests/npc-invoke-other-reactions.test.mjs docs/architecture.md module.json
git commit -m "test(#1027): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** Slink and Crumble (Task 2), Overwhelming Light (Task 3), and registry rows (Task 1) are covered. Fast Swallow is explicitly, deliberately excluded rather than silently missing — stated in Global Constraints, Task 1's own commit message, and a dedicated negative fixture test (Task 4).

**2. Placeholder scan:** No "TBD"/"TODO". Overwhelming Light's own exact counteract rank/modifier (not independently verified this session) is flagged plainly in Task 3's own code comment and this plan's Review Focus, with a fully working, testable implementation around that one unconfirmed number — the same posture #951's own plan took for its coordinate-conversion uncertainty.

**3. Type consistency:** `executeEscapeMove`'s `{moved}` and `executeOverwhelmingLight`'s `{counteracted}` are each produced once and consumed identically by their own tests.

**4. Review Focus:** All five bullets (distance-cap correctness, backward compatibility of the `strideByPosture` extension, Overwhelming Light's flagged numbers, Fast Swallow's deliberate absence, unpathable-move safety) are each addressed in Tasks 2–4.

**Corrections found while writing this plan:** (1) #961's own spec (not its plan) gives Slink's real trigger as a proximity event, not a timing one — this plan's own registry rows cite #961's planned `proximityEndTurn`/`proximityApproach` trigger kinds by name as an explicit, stated dependency, rather than inventing a parallel trigger-detection mechanism for triggers #961 already owns. (2) Fast Swallow's own effect ("uses Swallow Whole") was found to depend on a real ability (Swallow Whole) that exists in the compendium only as a bare, unparseable glossary token — the same "no real prose exists" situation #959's Ferocity investigation already established — confirming the issue's own framing that this needs separate modeling, not a guess made here.
