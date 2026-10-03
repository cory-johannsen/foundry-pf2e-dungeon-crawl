# Player Max Difficulty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player pick a max difficulty tier (Trivial/Low/Moderate/Severe/Extreme) in the Start Dungeon dialog that caps combat, traps, skill-challenge DCs and puzzle DCs for the whole run.

**Architecture:** The tier is stored once on run state (`difficulty`, default `severe`). A pure `applyDifficultyCap(depthBias, tier)` turns the existing depth ramp into an *effective bias* that drives combat (level band + XP ceiling) and traps. Skill challenges and puzzles get a flat DC adjustment from a tier table.

**Tech Stack:** Foundry VTT v14 module, plain ES modules, vitest (`npx vitest run`).

**Spec:** `docs/superpowers/specs/2026-10-02-max-difficulty-design.md` (issue #412)

## Global Constraints

- Tiers, in order: `trivial`, `low`, `moderate`, `severe`, `extreme`. Default `severe`; any missing/unknown value normalizes to `severe` (old saved runs have no `difficulty`).
- Bias caps: Trivial −1, Low 0, Moderate 1, Severe 2, Extreme 2; Extreme additionally lifts any room whose ramp bias is 2 (goal room included) to 3. Result is `min(depthBias, cap)`; Severe is the identity on the 0..2 ramp.
- DC adjustments: Trivial −5, Low −2, Moderate −1, Severe 0, Extreme +2 (every room).
- Skill-challenge VP target / attempt budget (`vpTargetForDepth`, `attemptBudgetForDepth`), treasure rooms, and the standalone encounter macro (`depthBias` null → Severe) keep the raw ramp. Do NOT cap `depthBias` at those call sites.
- A `null` `partyLevel` in `initPuzzleState` keeps each hintCheck's own flat `dc` unadjusted.
- Every merge to `main` bumps `module.json` `version` (this is a feature: minor bump, e.g. 0.55.13 → 0.56.0; read the current value at execution time and never reuse one). Run the `update-architecture-docs` skill in the same pass because this adds the import edge `dungeon-runner.mjs → dungeon-deck.mjs`.
- PR body says `Refs #412`, not `Fixes`/`Closes` (the issue stays open until verified live). Merge with explicit `--subject`/`--body`.

## Review Focus

- Run state saved before this change (no `difficulty` field) must behave as Severe everywhere (Task 1, Task 4).
- A bad/unknown tier string arriving through the relayed `startRun` args must fall back to Severe, not crash or produce `undefined` bias (Task 1, Task 4).
- Extreme on the shortest run (roomCount 2): the goal room (ramp bias 2) must still lift to 3 (Task 1).
- Trivial's effective bias is −1 for *every* room including the goal room; combat must still always get at least one creature (first slot is always accepted) and traps must accept a negative offset (Task 1, Task 2).
- Puzzle with `partyLevel: null` plus a non-zero `dcAdjustment` keeps the hintCheck's own flat DC (Task 3).

---

### Task 1: Tier helpers in `dungeon-deck.mjs`

**Files:**
- Modify: `scripts/dungeon-deck.mjs` (add after `depthBiasFor`, ~line 101)
- Test: `tests/dungeon-deck.test.mjs`

**Interfaces:**
- Produces: `DIFFICULTY_TIERS` (string[]), `DEFAULT_DIFFICULTY` (`"severe"`), `normalizeDifficulty(value) -> tier string`, `applyDifficultyCap(depthBias:number, tier) -> number`.

- [x] **Step 1: Write the failing tests** — append to `tests/dungeon-deck.test.mjs`, and add `DIFFICULTY_TIERS, normalizeDifficulty, applyDifficultyCap` to its existing import list from `../scripts/dungeon-deck.mjs`:

```js
describe('difficulty tiers (#412)', () => {
  it('lists the five tiers in order', () => {
    expect(DIFFICULTY_TIERS).toEqual(['trivial', 'low', 'moderate', 'severe', 'extreme']);
  });

  it('normalizes missing or unknown values to severe', () => {
    expect(normalizeDifficulty(undefined)).toBe('severe');
    expect(normalizeDifficulty(null)).toBe('severe');
    expect(normalizeDifficulty('nightmare')).toBe('severe');
    expect(normalizeDifficulty('low')).toBe('low');
  });

  it('severe is the identity on the 0..2 ramp', () => {
    for (const b of [0, 1, 2]) expect(applyDifficultyCap(b, 'severe')).toBe(b);
  });

  it('a missing or unknown tier behaves as severe', () => {
    for (const b of [0, 1, 2]) {
      expect(applyDifficultyCap(b, undefined)).toBe(b);
      expect(applyDifficultyCap(b, 'bogus')).toBe(b);
    }
  });

  it('low clamps every room to 0, moderate to at most 1', () => {
    for (const b of [0, 1, 2]) expect(applyDifficultyCap(b, 'low')).toBe(0);
    expect([0, 1, 2].map((b) => applyDifficultyCap(b, 'moderate'))).toEqual([0, 1, 1]);
  });

  it('trivial is -1 for every room, goal room included', () => {
    for (const b of [0, 1, 2]) expect(applyDifficultyCap(b, 'trivial')).toBe(-1);
  });

  it('extreme matches severe except rooms at ramp bias 2, which lift to 3', () => {
    expect([0, 1, 2].map((b) => applyDifficultyCap(b, 'extreme'))).toEqual([0, 1, 3]);
  });

  it('extreme still lifts the goal room of the shortest dungeon', () => {
    const bias = depthBiasFor({ rank: 1, maxRank: 1, isGoal: true });
    expect(applyDifficultyCap(bias, 'extreme')).toBe(3);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dungeon-deck.test.mjs`
Expected: FAIL (`applyDifficultyCap` / `normalizeDifficulty` is not a function).

- [x] **Step 3: Implement** — insert in `scripts/dungeon-deck.mjs` right after `depthBiasFor`:

```js
// #412: the player's max-difficulty choice from the Start Dungeon dialog.
export const DIFFICULTY_TIERS = ["trivial", "low", "moderate", "severe", "extreme"];
export const DEFAULT_DIFFICULTY = "severe"; // today's behavior

/** Any missing/unknown value (old saved run, bad relayed arg) -> Severe. */
export function normalizeDifficulty(value) {
  return DIFFICULTY_TIERS.includes(value) ? value : DEFAULT_DIFFICULTY;
}

// Highest depth bias a tier allows. Extreme's ordinary cap equals Severe's;
// its extra lift for the deepest rooms is handled in applyDifficultyCap.
const DIFFICULTY_BIAS_CAP = { trivial: -1, low: 0, moderate: 1, severe: 2, extreme: 2 };

/**
 * #412: the effective depth bias for a room once the player's tier is
 * applied on top of the depth ramp -- `min(depthBias, tier cap)`, so the tier
 * only ever lowers what the ramp produced. The one exception is Extreme,
 * which lifts a room already at the ramp's max (bias 2, goal room included)
 * to 3, one past the normal ceiling.
 */
export function applyDifficultyCap(depthBias, tier) {
  const t = normalizeDifficulty(tier);
  if (t === "extreme" && depthBias >= MAX_DEPTH_BIAS) return MAX_DEPTH_BIAS + 1;
  return Math.min(depthBias, DIFFICULTY_BIAS_CAP[t]);
}
```

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "#412: difficulty tier helpers (applyDifficultyCap)"
```

---

### Task 2: Extend `xpCeilingTierForDepth` to the full range

**Files:**
- Modify: `scripts/encounter-roster.mjs:86-98` (function + its doc comment)
- Test: `tests/encounter-roster.test.mjs` (existing test at ~line 553 pins `3 -> "severe"`; it changes)

**Interfaces:**
- Consumes: nothing from Task 1 (takes a plain numeric bias).
- Produces: `xpCeilingTierForDepth(bias)`: `null/undefined -> "severe"`, `<0 -> "trivial"`, `0 -> "low"`, `1 -> "moderate"`, `2 -> "severe"`, `>=3 -> "extreme"`.

- [x] **Step 1: Update/add tests** in `tests/encounter-roster.test.mjs`. Replace the `it("maps depth bias to a ceiling tier", ...)` body with:

```js
  it("maps depth bias to a ceiling tier", () => {
    expect(xpCeilingTierForDepth(-1)).toBe("trivial");
    expect(xpCeilingTierForDepth(0)).toBe("low");
    expect(xpCeilingTierForDepth(1)).toBe("moderate");
    expect(xpCeilingTierForDepth(2)).toBe("severe");
    expect(xpCeilingTierForDepth(3)).toBe("extreme");
    expect(xpCeilingTierForDepth(null)).toBe("severe");
    expect(xpCeilingTierForDepth(undefined)).toBe("severe");
  });
```

and add inside the same `describe("depth-scaled XP ceiling (#293)", ...)` block, next to "bias 0 admits fewer slots...":

```js
  it("depthBias -1 (Trivial) keeps one creature and names Trivial (#412)", async () => {
    const roster = await run({ partySize: 4, depthBias: -1 });
    expect(roster.foes.length).toBeGreaterThanOrEqual(1);
    expect(roster.approxXp).toBe(40);
    expect(roster.warnings[0]).toMatch(/capped at Trivial/);
  });

  it("depthBias 3 (Extreme) admits more than the Severe ceiling (#412)", async () => {
    const roster = await run({ partySize: 4, depthBias: 3 });
    expect(roster.approxXp).toBe(160);
  });
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/encounter-roster.test.mjs`
Expected: FAIL (`-1` gives `"low"`, `3` gives `"severe"`).

- [x] **Step 3: Implement** — replace `xpCeilingTierForDepth` and its comment:

```js
/**
 * The XP ceiling tier for a dungeon room's (effective) depth bias (#293,
 * extended by #412): below 0 caps at Trivial, 0 at Low, 1 at Moderate, 2 at
 * Severe, and 3 or more at Extreme (only reachable via the player's Extreme
 * max-difficulty lift, dungeon-deck.mjs's applyDifficultyCap). A missing
 * depth (`null`/`undefined`, e.g. the standalone macro) keeps the historical
 * Severe cap.
 */
export function xpCeilingTierForDepth(bias) {
  if (bias == null) return "severe";
  if (bias < 0) return "trivial";
  if (bias === 0) return "low";
  if (bias === 1) return "moderate";
  if (bias === 2) return "severe";
  return "extreme";
}
```

Also update the `depthBias` paragraph in `resolveEncounterRoster`'s doc comment (~line 187-188): replace "`0 -> Low, 1 -> Moderate, >= 2 -> Severe`" with "`-1 -> Trivial, 0 -> Low, 1 -> Moderate, 2 -> Severe, 3 -> Extreme`".

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/encounter-roster.test.mjs`
Expected: PASS (all existing cap tests still pass: biases 0, 1, 2 unchanged).

- [x] **Step 5: Commit**

```bash
git add scripts/encounter-roster.mjs tests/encounter-roster.test.mjs
git commit -m "#412: xpCeilingTierForDepth covers Trivial and Extreme"
```

---

### Task 3: DC adjustment for skill challenges and puzzles

**Files:**
- Modify: `scripts/skill-challenge-mechanics.mjs` (add table + `dcAdjustmentForTier`; change `dcForAttempt`)
- Modify: `scripts/puzzle-mechanics.mjs:89-108` (`initPuzzleState`)
- Modify: `scripts/dungeon-runner.mjs:786-818` (`ensurePuzzleState`)
- Modify: `scripts/ui/dungeon-app.mjs` (`#onAttemptSkillChallenge` DC call, ~line 1377)
- Modify: `scripts/dungeon-scene.mjs` (`ensurePuzzleState` call, ~line 1620) — only the `dcAdjustment` argument; the bias wiring is Task 5
- Test: `tests/skill-challenge-mechanics.test.mjs`, `tests/puzzle-mechanics.test.mjs`

**Interfaces:**
- Produces: `DC_ADJUSTMENT_BY_TIER`, `dcAdjustmentForTier(tier) -> number` (unknown/missing -> 0); `dcForAttempt({ partyLevel, difficulty })`; `initPuzzleState({..., dcAdjustment = 0})`; `ensurePuzzleState(sceneId, roomId, {..., dcAdjustment = 0})`.

- [x] **Step 1: Write failing tests.**

In `tests/skill-challenge-mechanics.test.mjs`, add `dcAdjustmentForTier` to the import list and append:

```js
describe("difficulty DC adjustment (#412)", () => {
  it("maps each tier to its adjustment", () => {
    expect(
      ["trivial", "low", "moderate", "severe", "extreme"].map(dcAdjustmentForTier),
    ).toEqual([-5, -2, -1, 0, 2]);
  });

  it("unknown or missing tier adjusts by 0 (Severe)", () => {
    expect(dcAdjustmentForTier(undefined)).toBe(0);
    expect(dcAdjustmentForTier("bogus")).toBe(0);
  });

  it("dcForAttempt adds the run's adjustment to the Simple DC", () => {
    expect(dcForAttempt({ partyLevel: 5, difficulty: "trivial" })).toBe(15);
    expect(dcForAttempt({ partyLevel: 5, difficulty: "extreme" })).toBe(22);
    expect(dcForAttempt({ partyLevel: 5 })).toBe(20);
  });
});
```

In `tests/puzzle-mechanics.test.mjs`, inside `describe("initPuzzleState", ...)` append:

```js
  it("adds dcAdjustment to the party-level-scaled DC (#412)", () => {
    const state = initPuzzleState({
      hintChecks: HINT_CHECKS,
      partyLevel: 5,
      dcAdjustment: -5,
    });
    expect(state.stages.every((s) => s.dc === 15)).toBe(true);
  });

  it("leaves each hintCheck's own flat dc alone when partyLevel is null, even with an adjustment (#412)", () => {
    const state = initPuzzleState({
      hintChecks: HINT_CHECKS,
      partyLevel: null,
      dcAdjustment: 2,
    });
    expect(state.stages.map((s) => s.dc)).toEqual(HINT_CHECKS.map((c) => c.dc));
  });
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/skill-challenge-mechanics.test.mjs tests/puzzle-mechanics.test.mjs`
Expected: FAIL (`dcAdjustmentForTier` is not a function; puzzle DC unadjusted).

- [x] **Step 3: Implement.**

In `scripts/skill-challenge-mechanics.mjs`, replace `dcForAttempt` with:

```js
// #412: GM Core's difficulty adjustments (very easy -5, easy -2, hard +2);
// Moderate -1 is an interpolation (the book has no -1 step). Applied to
// every skill-challenge/puzzle DC in the run, since those DCs don't ramp
// with depth.
export const DC_ADJUSTMENT_BY_TIER = {
  trivial: -5,
  low: -2,
  moderate: -1,
  severe: 0,
  extreme: 2,
};

/** The flat DC adjustment for a run's difficulty tier; unknown/missing -> 0. */
export function dcAdjustmentForTier(tier) {
  return DC_ADJUSTMENT_BY_TIER[tier] ?? 0;
}

/**
 * The DC for any attempt in a skill challenge at `partyLevel` — the room's
 * Simple DC plus the run's difficulty adjustment (#412). Only a challenge's
 * own specialty skills can be attempted (#553), so the skill never matters.
 */
export function dcForAttempt({ partyLevel, difficulty }) {
  return simpleDcForLevel(partyLevel) + dcAdjustmentForTier(difficulty);
}
```

In `scripts/puzzle-mechanics.mjs`: add `dcAdjustment = 0,` to `initPuzzleState`'s destructured parameters (after `summary = null,`) and change the `scaledDc` line to:

```js
  const scaledDc =
    partyLevel != null ? simpleDcForLevel(partyLevel) + dcAdjustment : null;
```

In `scripts/dungeon-runner.mjs` `ensurePuzzleState`: add `dcAdjustment = 0,` to its destructured options and pass `dcAdjustment,` into the `initPuzzleState({ ... })` call.

In `scripts/ui/dungeon-app.mjs` `#onAttemptSkillChallenge`, change the DC call to:

```js
    const dc = dcForAttempt({
      partyLevel: await makeFoundryApi().partyLevel(),
      difficulty: state.difficulty,
    });
```

In `scripts/dungeon-scene.mjs`, the `ensurePuzzleState(scene.id, room.id, {...})` call: add `dcAdjustment: dcAdjustmentForTier(state.difficulty),` and extend the existing `import { selectSkillChallengeTemplate } from "./skill-challenge-mechanics.mjs";` (line ~79) to `import { selectSkillChallengeTemplate, dcAdjustmentForTier } from "./skill-challenge-mechanics.mjs";`.

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/skill-challenge-mechanics.test.mjs tests/puzzle-mechanics.test.mjs tests/dungeon-runner.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts tests
git commit -m "#412: DC adjustment by difficulty for skill challenges and puzzles"
```

---

### Task 4: Persist `difficulty` and thread it through Start

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (`createRun`: params, state field, new import)
- Modify: `scripts/ui/dungeon-app.mjs` (`startDungeonRun` params + `createRun` call; `#onStart` form read + both paths)
- Modify: `templates/dungeon-tracker.hbs` (Start Dungeon form, after the `roomCount` label, ~line 368)
- Modify: `lang/en.json`
- Test: `tests/dungeon-runner.test.mjs`

`dungeon-remote.mjs`'s `startRun` spreads `...args` into `startDungeonRun`, so `difficulty` already flows through the relay once `#onStart` sends it; no edit there.

**Interfaces:**
- Consumes: `normalizeDifficulty` from `scripts/dungeon-deck.mjs` (Task 1).
- Produces: `createRun({..., difficulty})` stores `state.difficulty` (normalized); `startDungeonRun({..., difficulty})`.

- [ ] **Step 1: Write failing tests** — append to `tests/dungeon-runner.test.mjs`:

```js
describe("createRun difficulty (#412)", () => {
  it("defaults to severe", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5 },
      { settingsRef },
    );
    expect(state.difficulty).toBe("severe");
  });

  it("stores a valid tier", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5, difficulty: "trivial" },
      { settingsRef },
    );
    expect(state.difficulty).toBe("trivial");
  });

  it("normalizes an unknown tier to severe", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5, difficulty: "nightmare" },
      { settingsRef },
    );
    expect(state.difficulty).toBe("severe");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL (`state.difficulty` is `undefined`).

- [ ] **Step 3: Implement.**

`scripts/dungeon-runner.mjs`: add `import { normalizeDifficulty } from "./dungeon-deck.mjs";` with the other imports; add `difficulty = null,` to `createRun`'s first-argument destructuring (after `hostUserId = null,`); and in the `state` literal, after `excludeTraits,` add:

```js
    // #412: the player's max-difficulty tier, fixed for the whole run.
    // Normalized so a bad relayed value (or an old caller) reads as Severe.
    difficulty: normalizeDifficulty(difficulty),
```

`scripts/ui/dungeon-app.mjs`: in `startDungeonRun`'s destructured parameters add `difficulty,`, and pass `difficulty,` in the `createRun({ ... })` call. In `#onStart`, after the `excludeTraits` read add:

```js
    const difficulty =
      form?.querySelector('[name="difficulty"]')?.value ?? "severe";
```

and add `difficulty,` to both the `startDungeonRun({...})` args and the `requestDungeonAction("startRun", {...})` args.

`templates/dungeon-tracker.hbs`: after the `roomCount` `</label>` and before `{{{traitsFieldHtml}}}`, insert:

```hbs
      <label>
        {{localize "PF2EDC.Dungeon.DifficultyLabel"}}
        <select name="difficulty">
          <option value="trivial">{{localize "PF2EDC.Dungeon.Difficulty.Trivial"}}</option>
          <option value="low">{{localize "PF2EDC.Dungeon.Difficulty.Low"}}</option>
          <option value="moderate">{{localize "PF2EDC.Dungeon.Difficulty.Moderate"}}</option>
          <option value="severe" selected>{{localize "PF2EDC.Dungeon.Difficulty.Severe"}}</option>
          <option value="extreme">{{localize "PF2EDC.Dungeon.Difficulty.Extreme"}}</option>
        </select>
      </label>
```

`lang/en.json`: after the `PF2EDC.Dungeon.RoomCountLabel` line add (keep JSON valid — mind the trailing commas):

```json
  "PF2EDC.Dungeon.DifficultyLabel": "Maximum difficulty",
  "PF2EDC.Dungeon.Difficulty.Trivial": "Trivial",
  "PF2EDC.Dungeon.Difficulty.Low": "Low",
  "PF2EDC.Dungeon.Difficulty.Moderate": "Moderate",
  "PF2EDC.Dungeon.Difficulty.Severe": "Severe (default)",
  "PF2EDC.Dungeon.Difficulty.Extreme": "Extreme (deep rooms and the goal)",
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs && node -e "JSON.parse(require('fs').readFileSync('lang/en.json'))"`
Expected: PASS, no JSON error.

- [ ] **Step 5: Commit**

```bash
git add scripts templates lang tests
git commit -m "#412: persist difficulty on run state; Start Dungeon selector"
```

---

### Task 5: Apply the cap to combat and traps at room build

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (import; new exported `effectiveRoomBias`; combat and trap call sites ~lines 1547-1553 and 1614)
- Test: `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `applyDifficultyCap` (Task 1), `depthBiasFor` (existing), `state.difficulty` (Task 4).
- Produces: `effectiveRoomBias({ rank, maxRank, isGoal, difficulty }) -> number` exported from `dungeon-scene.mjs`.

- [ ] **Step 1: Write failing tests** — add `effectiveRoomBias` to the existing `../scripts/dungeon-scene.mjs` import in `tests/dungeon-scene.test.mjs` and append:

```js
describe('effectiveRoomBias (#412)', () => {
  const room = { rank: 3, maxRank: 6, isGoal: false }; // ramp bias 1
  const goal = { rank: 6, maxRank: 6, isGoal: true }; // ramp bias 2

  it('severe and a missing difficulty equal the raw depth ramp', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'severe' })).toBe(1);
    expect(effectiveRoomBias({ ...room })).toBe(1);
    expect(effectiveRoomBias({ ...goal, difficulty: undefined })).toBe(2);
  });

  it('low flattens the ramp, trivial goes below zero everywhere', () => {
    expect(effectiveRoomBias({ ...goal, difficulty: 'low' })).toBe(0);
    expect(effectiveRoomBias({ ...goal, difficulty: 'trivial' })).toBe(-1);
    expect(effectiveRoomBias({ ...room, difficulty: 'trivial' })).toBe(-1);
  });

  it('extreme lifts only the deepest rooms', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'extreme' })).toBe(1);
    expect(effectiveRoomBias({ ...goal, difficulty: 'extreme' })).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dungeon-scene.test.mjs`
Expected: FAIL (`effectiveRoomBias` is not a function).

- [ ] **Step 3: Implement** in `scripts/dungeon-scene.mjs`:

Change line ~75 to `import { depthBiasFor, applyDifficultyCap } from "./dungeon-deck.mjs";` and add (near the other exported helpers, above the function that builds a room):

```js
/** #412: a room's depth bias with the run's difficulty cap applied. Drives
 * combat's level band + XP ceiling and trap level offset. */
export function effectiveRoomBias({ rank, maxRank, isGoal, difficulty }) {
  return applyDifficultyCap(depthBiasFor({ rank, maxRank, isGoal }), difficulty);
}
```

In the `room.kind === "combat"` branch replace the `depthBias` computation with:

```js
      const depthBias = effectiveRoomBias({
        rank,
        maxRank: state.maxRank,
        isGoal: room.isGoal,
        difficulty: state.difficulty,
      });
```

(the two uses `levelOffsetBias: depthBias, depthBias,` stay). In the trap branch (`populateSlotTrap`), replace `levelOffsetBias: depthBiasFor({ rank, maxRank: state.maxRank, isGoal: room.isGoal }),` with:

```js
        levelOffsetBias: effectiveRoomBias({
          rank,
          maxRank: state.maxRank,
          isGoal: room.isGoal,
          difficulty: state.difficulty,
        }),
```

Leave the `ensureSkillChallenge` call's `depthBias: depthBiasFor(...)` exactly as is (Global Constraints).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dungeon-scene.test.mjs tests/encounter-roster.test.mjs tests/dungeon-deck.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene.test.mjs
git commit -m "#412: apply the difficulty cap to combat and trap rooms"
```

---

### Task 6: Docs, version, full suite, PR

**Files:**
- Modify: `module.json` (minor bump), `docs/architecture.md` (via the skill)

- [ ] **Step 1:** Read the current `version` in `module.json` on `origin/main` (`git fetch && git show origin/main:module.json | grep '"version"'`), then set the next *minor* value (`x.Y+1.0`); never reuse a number.
- [ ] **Step 2:** Run the `update-architecture-docs` skill (new edge `dungeon-runner.mjs → dungeon-deck.mjs`; check subsystem prose still holds) and commit the result.
- [ ] **Step 3:** Run the full suite, saving the log (takes ~5-10 min; run in the background):
  `npx vitest run > /tmp/full412.log 2>&1; grep -n FAIL /tmp/full412.log; tail -6 /tmp/full412.log`
  Expected: all files pass. A lone failure in `dungeon-reseed-sweep.test.mjs` (`maxMs < 5000`) is a known load-induced flake: rerun with nothing else running before judging it.
- [ ] **Step 4:** Commit, push, open the PR (`Refs #412`, end the body with the standard Claude Code attribution line), then `gh pr merge <n> --squash --subject "#412: player max difficulty in Start Dungeon (#<n>)" --body "Refs #412"`.
- [ ] **Step 5:** Update #412: remove `in progress`, comment "PR #<n> merged (v<version>). Awaiting live verification." Do not close. Live check: start a Trivial or Low run in a real Foundry world and inspect generated rooms, trap levels and skill-challenge/puzzle DCs against the tier table.
