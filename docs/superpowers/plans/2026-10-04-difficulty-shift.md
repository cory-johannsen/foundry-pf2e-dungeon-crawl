# Difficulty as a Whole-Ramp Shift (Moderate Default) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace #412's difficulty *clamp* with a whole-ramp *shift* (Extreme raises every room, Moderate/Low/Trivial lower rooms), and make Moderate the single default in the dialog and in code.

**Architecture:** One pure function swap in `dungeon-deck.mjs` (`applyDifficultyCap` → `applyDifficultyShift`, effective bias = `clamp(rampBias + tierOffset, −1, 3)`); everything downstream already consumes a numeric bias or the tier string, so only the default, one DC helper, the dialog markup/strings and tests change.

**Tech Stack:** Vanilla JS modules, Handlebars template, vitest (`npx vitest run`).

**Spec:** `docs/superpowers/specs/2026-10-04-difficulty-shift-design.md` (issue #636)

## Global Constraints

- Tiers (unchanged), in order: `trivial`, `low`, `moderate`, `severe`, `extreme`.
- Shift offsets: Trivial −3, Low −2, Moderate −1, Severe 0, Extreme +1. Effective bias = `Math.max(−1, Math.min(3, rampBias + offset))`; ramp bias is 0 / 1 / 2 for early / middle / deep rooms (goal room = 2). Resulting table (early / middle / deep): Trivial −1/−1/−1, Low −1/−1/0, Moderate −1/0/1, Severe 0/1/2, Extreme 1/2/3.
- **One default, Moderate, everywhere:** `DEFAULT_DIFFICULTY = "moderate"`; `normalizeDifficulty` resolves missing/null/unknown to Moderate; `createRun`, `effectiveRoomBias`, `dcAdjustmentForTier` all go through it; the dialog preselects Moderate and `#onStart`'s fallback is `"moderate"`.
- DC adjustments are unchanged: Trivial −5, Low −2, Moderate −1, Severe 0, Extreme +2.
- No change to: `xpCeilingTierForDepth` behavior, `resolveEncounterRoster`, `selectTrap`, run-state plumbing, the relayed `startRun` path (`dungeon-remote.mjs` spreads args), skill-challenge VP target/attempt budget, treasure rooms, the standalone encounter macro.
- No new import edges (`skill-challenge-mechanics.mjs` already imports from `dungeon-deck.mjs`).
- Every merge to `main` bumps `module.json` `version`; this change is a **minor** bump (it changes what tiers and the default mean). Read the current value on `origin/main` at execution time; never reuse a number.
- PR body says `Refs #636`, not `Fixes`/`Closes` (the issue stays open until verified live). Merge with explicit `--subject`/`--body`.

## Review Focus

- A missing, null or unknown tier must resolve to Moderate **consistently** for rooms, skill-challenge DCs and `createRun` — not Severe in one place and Moderate in another (the exact split `dcAdjustmentForTier`'s old `?? 0` would have caused) (Tasks 1, 2).
- The shift must clamp at **both** ends of −1..3 for inputs outside the 0..2 ramp (a negative or oversized bias must not reach combat/traps unclamped) (Task 1).
- Every tier already saved on a run (`trivial`…`extreme`) must still be accepted as-is after the semantics change — the tier list is unchanged and `normalizeDifficulty` must not rewrite a valid value (Task 1).
- Exactly one option in the dialog select is `selected`, and it is Moderate; "(default)" appears only on Moderate's label (Task 3).
- `#onStart`'s fallback token is the one behavior no unit test can run (no hbs/ApplicationV2 harness): it gets a source-text assertion, and the live check in Task 4 starts a run without touching the control (Task 3, Task 4).

---

### Task 1: Replace the clamp with the shift; Moderate becomes the code default

**Files:**
- Modify: `scripts/dungeon-deck.mjs` (the `#412` difficulty block right after `depthBiasFor`, ~lines 103-130)
- Modify: `scripts/dungeon-scene.mjs` (import ~line 75; `effectiveRoomBias` ~lines 1378-1381)
- Modify: `scripts/encounter-roster.mjs` (one comment, ~line 90)
- Test: `tests/dungeon-deck.test.mjs` (the `difficulty tiers (#412)` describe, ~lines 897-935, and its import list at ~line 30), `tests/dungeon-scene.test.mjs` (`effectiveRoomBias (#412)` describe, ~lines 523-543), `tests/dungeon-runner.test.mjs` (`createRun difficulty (#412)` describe, ~lines 2591-2618)

**Interfaces:**
- Produces: `DEFAULT_DIFFICULTY` (now `"moderate"`), `normalizeDifficulty(value)` (unchanged signature, now defaults to Moderate), `applyDifficultyShift(depthBias:number, tier) -> number in [-1, 3]` (replaces `applyDifficultyCap`), `effectiveRoomBias({ rank, maxRank, isGoal, difficulty })` (unchanged signature, new semantics).

- [x] **Step 1: Rewrite the tests to the new semantics (they must fail first)**

In `tests/dungeon-deck.test.mjs`: in the import list from `../scripts/dungeon-deck.mjs`, replace `applyDifficultyCap` with `applyDifficultyShift`. Replace the whole `describe('difficulty tiers (#412)', ...)` block with:

```js
describe('difficulty tiers (#412, #636)', () => {
  it('lists the five tiers in order', () => {
    expect(DIFFICULTY_TIERS).toEqual(['trivial', 'low', 'moderate', 'severe', 'extreme']);
  });

  it('normalizes missing or unknown values to moderate and keeps every valid tier as-is', () => {
    expect(normalizeDifficulty(undefined)).toBe('moderate');
    expect(normalizeDifficulty(null)).toBe('moderate');
    expect(normalizeDifficulty('nightmare')).toBe('moderate');
    for (const tier of DIFFICULTY_TIERS) expect(normalizeDifficulty(tier)).toBe(tier);
  });

  it('shifts the whole ramp by the tier offset (early / middle / deep room)', () => {
    const table = {
      trivial: [-1, -1, -1],
      low: [-1, -1, 0],
      moderate: [-1, 0, 1],
      severe: [0, 1, 2],
      extreme: [1, 2, 3],
    };
    for (const [tier, expected] of Object.entries(table)) {
      expect([0, 1, 2].map((b) => applyDifficultyShift(b, tier))).toEqual(expected);
    }
  });

  it('severe is the identity on the 0..2 ramp', () => {
    for (const b of [0, 1, 2]) expect(applyDifficultyShift(b, 'severe')).toBe(b);
  });

  it('a missing or unknown tier behaves as moderate', () => {
    for (const b of [0, 1, 2]) {
      expect(applyDifficultyShift(b, undefined)).toBe(applyDifficultyShift(b, 'moderate'));
      expect(applyDifficultyShift(b, 'bogus')).toBe(applyDifficultyShift(b, 'moderate'));
    }
  });

  it('always lands within -1..3, even for biases outside the 0..2 ramp', () => {
    for (const tier of DIFFICULTY_TIERS) {
      for (let b = -2; b <= 5; b += 1) {
        const r = applyDifficultyShift(b, tier);
        expect(r).toBeGreaterThanOrEqual(-1);
        expect(r).toBeLessThanOrEqual(3);
      }
    }
  });

  it('clamps at both ends', () => {
    expect(applyDifficultyShift(-5, 'trivial')).toBe(-1);
    expect(applyDifficultyShift(5, 'extreme')).toBe(3);
  });

  it('extreme still lifts the goal room of the shortest dungeon to 3', () => {
    const bias = depthBiasFor({ rank: 1, maxRank: 1, isGoal: true });
    expect(applyDifficultyShift(bias, 'extreme')).toBe(3);
  });
});
```

In `tests/dungeon-scene.test.mjs`, replace the whole `describe('effectiveRoomBias (#412)', ...)` block with:

```js
describe('effectiveRoomBias (#412, #636)', () => {
  const room = { rank: 3, maxRank: 6, isGoal: false }; // ramp bias 1
  const goal = { rank: 6, maxRank: 6, isGoal: true }; // ramp bias 2

  it('severe equals the raw depth ramp', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'severe' })).toBe(1);
    expect(effectiveRoomBias({ ...goal, difficulty: 'severe' })).toBe(2);
  });

  it('a missing difficulty reads as moderate, one step below the ramp', () => {
    expect(effectiveRoomBias({ ...room })).toBe(0);
    expect(effectiveRoomBias({ ...goal, difficulty: undefined })).toBe(1);
  });

  it('low and trivial shift the whole ramp down, never below -1', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'low' })).toBe(-1);
    expect(effectiveRoomBias({ ...goal, difficulty: 'low' })).toBe(0);
    expect(effectiveRoomBias({ ...room, difficulty: 'trivial' })).toBe(-1);
    expect(effectiveRoomBias({ ...goal, difficulty: 'trivial' })).toBe(-1);
  });

  it('extreme shifts every room up one, topping out at 3', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'extreme' })).toBe(2);
    expect(effectiveRoomBias({ ...goal, difficulty: 'extreme' })).toBe(3);
  });
});
```

In `tests/dungeon-runner.test.mjs`, in `describe("createRun difficulty (#412)", ...)`: rename the first test to `"defaults to moderate"` and change its assertion to `expect(state.difficulty).toBe("moderate");`; rename the third to `"normalizes an unknown tier to moderate"` and change its assertion to `expect(state.difficulty).toBe("moderate");`. Leave the "stores a valid tier" test as is.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs tests/dungeon-scene.test.mjs tests/dungeon-runner.test.mjs`
Expected: FAIL (`applyDifficultyShift` is not a function / not exported; `normalizeDifficulty(undefined)` still returns `'severe'`).

- [x] **Step 3: Implement**

In `scripts/dungeon-deck.mjs`, replace the block from the `// #412: the player's max-difficulty choice...` comment through the end of `applyDifficultyCap` (everything between `depthBiasFor` and the `// Placeholder heuristic, not a real treasure table` comment) with:

```js
// #412/#636: the player's difficulty choice from the Start Dungeon dialog.
export const DIFFICULTY_TIERS = ["trivial", "low", "moderate", "severe", "extreme"];
export const DEFAULT_DIFFICULTY = "moderate";

/** Any missing/unknown value (old saved run, bad relayed arg) -> Moderate. */
export function normalizeDifficulty(value) {
  return DIFFICULTY_TIERS.includes(value) ? value : DEFAULT_DIFFICULTY;
}

// #636: how far each tier shifts the WHOLE depth ramp. Severe is the identity.
const DIFFICULTY_BIAS_OFFSET = { trivial: -3, low: -2, moderate: -1, severe: 0, extreme: 1 };
// The effective bias stays inside the range the combat XP ceiling
// (xpCeilingTierForDepth), creature level band and trap level window already
// support and test: Trivial's -1 up to Extreme's 3 (one past the ramp's max).
const MIN_EFFECTIVE_BIAS = -1;
const MAX_EFFECTIVE_BIAS = MAX_DEPTH_BIAS + 1;

/**
 * #636 (replacing #412's clamp): the effective depth bias for a room once the
 * player's tier shifts the depth ramp -- `clamp(depthBias + tier offset,
 * -1, 3)`. Extreme raises every room one step, Moderate/Low/Trivial lower them
 * by one/two/three, Severe leaves the ramp alone. A missing or unknown tier
 * reads as Moderate (normalizeDifficulty).
 */
export function applyDifficultyShift(depthBias, tier) {
  const shifted = depthBias + DIFFICULTY_BIAS_OFFSET[normalizeDifficulty(tier)];
  return Math.max(MIN_EFFECTIVE_BIAS, Math.min(MAX_EFFECTIVE_BIAS, shifted));
}
```

In `scripts/dungeon-scene.mjs`: change the import to `import { depthBiasFor, applyDifficultyShift } from "./dungeon-deck.mjs";` and replace `effectiveRoomBias` and its doc comment with:

```js
/** #412/#636: a room's depth bias with the run's difficulty shift applied.
 * Drives combat's level band + XP ceiling and trap level offset. */
export function effectiveRoomBias({ rank, maxRank, isGoal, difficulty }) {
  return applyDifficultyShift(depthBiasFor({ rank, maxRank, isGoal }), difficulty);
}
```

In `scripts/encounter-roster.mjs`, in `xpCeilingTierForDepth`'s doc comment, change the single line ` * max-difficulty lift, dungeon-deck.mjs's applyDifficultyCap). A missing` to ` * difficulty shift, dungeon-deck.mjs's applyDifficultyShift). A missing` (leave every other comment line alone).

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs tests/dungeon-scene.test.mjs tests/dungeon-runner.test.mjs tests/encounter-roster.test.mjs`
Expected: PASS. Also run `grep -rn "applyDifficultyCap\|DIFFICULTY_BIAS_CAP" scripts tests` — expected: no matches.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs scripts/dungeon-scene.mjs scripts/encounter-roster.mjs tests/dungeon-deck.test.mjs tests/dungeon-scene.test.mjs tests/dungeon-runner.test.mjs
git commit -m "#636: difficulty shifts the whole ramp; Moderate is the code default"
```

---

### Task 2: `dcAdjustmentForTier` follows the same default

**Files:**
- Modify: `scripts/skill-challenge-mechanics.mjs` (import ~line 38; `dcAdjustmentForTier` ~lines 200-203)
- Test: `tests/skill-challenge-mechanics.test.mjs` (`difficulty DC adjustment (#412)` describe, ~lines 389-406)

**Interfaces:**
- Consumes: `normalizeDifficulty` from `scripts/dungeon-deck.mjs` (Task 1: missing/unknown → `"moderate"`).
- Produces: `dcAdjustmentForTier(tier)` — missing/unknown now → −1 (Moderate); `dcForAttempt({ partyLevel, difficulty })` unchanged signature.

- [x] **Step 1: Update the tests (they must fail first)**

In `tests/skill-challenge-mechanics.test.mjs`, in `describe("difficulty DC adjustment (#412)", ...)`: replace the test `"unknown or missing tier adjusts by 0 (Severe)"` with:

```js
  it("unknown or missing tier adjusts like Moderate (-1), matching the room default (#636)", () => {
    expect(dcAdjustmentForTier(undefined)).toBe(-1);
    expect(dcAdjustmentForTier(null)).toBe(-1);
    expect(dcAdjustmentForTier("bogus")).toBe(-1);
  });
```

and in the `"dcForAttempt adds the run's adjustment to the Simple DC"` test change the last assertion to `expect(dcForAttempt({ partyLevel: 5 })).toBe(19);` (Moderate's −1 on the level-5 Simple DC of 20).

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/skill-challenge-mechanics.test.mjs`
Expected: FAIL (`dcAdjustmentForTier(undefined)` returns 0; `dcForAttempt({partyLevel:5})` returns 20).

- [x] **Step 3: Implement**

In `scripts/skill-challenge-mechanics.mjs`: change `import { MAX_DEPTH_BIAS } from "./dungeon-deck.mjs";` to `import { MAX_DEPTH_BIAS, normalizeDifficulty } from "./dungeon-deck.mjs";` and replace `dcAdjustmentForTier` and its comment with:

```js
/** The flat DC adjustment for a run's difficulty tier; a missing/unknown tier
 * reads as Moderate (-1), the same default the room bias uses
 * (dungeon-deck.mjs normalizeDifficulty, #636). */
export function dcAdjustmentForTier(tier) {
  return DC_ADJUSTMENT_BY_TIER[normalizeDifficulty(tier)];
}
```

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/skill-challenge-mechanics.test.mjs tests/puzzle-mechanics.test.mjs`
Expected: PASS (puzzle tests pass `dcAdjustment` explicitly, so are unaffected).

- [x] **Step 5: Commit**

```bash
git add scripts/skill-challenge-mechanics.mjs tests/skill-challenge-mechanics.test.mjs
git commit -m "#636: skill-challenge DC adjustment defaults to Moderate like the rooms"
```

---

### Task 3: Dialog default, `#onStart` fallback and labels

**Files:**
- Modify: `templates/dungeon-tracker.hbs` (the `difficulty` select, ~lines 369-378)
- Modify: `scripts/ui/dungeon-app.mjs` (`#onStart`, ~line 1294)
- Modify: `lang/en.json` (the `Difficulty*` keys, ~lines 105-110)
- Create: `tests/difficulty-dialog-defaults.test.mjs`

**Interfaces:**
- Consumes: the five tier values and `"moderate"` default from Tasks 1-2.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing test**

Create `tests/difficulty-dialog-defaults.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #636: the repo has no hbs / ApplicationV2 rendering harness, so these read
// the template, strings and handler as text -- the cheapest reliable check
// that the dialog actually defaults to Moderate.
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const template = read("../templates/dungeon-tracker.hbs");
const lang = JSON.parse(read("../lang/en.json"));
const appSource = read("../scripts/ui/dungeon-app.mjs");

const TIERS = ["trivial", "low", "moderate", "severe", "extreme"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

describe("Start Dungeon difficulty dialog defaults (#636)", () => {
  const select = template.match(/<select name="difficulty">([\s\S]*?)<\/select>/)?.[1] ?? "";
  const options = [...select.matchAll(/<option value="(\w+)"( selected)?>/g)].map((m) => ({
    value: m[1],
    selected: Boolean(m[2]),
  }));

  it("offers all five tiers in order", () => {
    expect(options.map((o) => o.value)).toEqual(TIERS);
  });

  it("preselects Moderate and no other option", () => {
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual(["moderate"]);
  });

  it('marks only Moderate as "(default)" in the labels', () => {
    for (const tier of TIERS) {
      const label = lang[`PF2EDC.Dungeon.Difficulty.${cap(tier)}`];
      expect(typeof label).toBe("string");
      expect(label.includes("(default)")).toBe(tier === "moderate");
    }
  });

  it('labels the control "Difficulty", not "Maximum difficulty"', () => {
    expect(lang["PF2EDC.Dungeon.DifficultyLabel"]).toBe("Difficulty");
  });

  it('#onStart falls back to "moderate" when the form value is missing', () => {
    expect(appSource).toMatch(/\[name="difficulty"\]'\)\?\.value \?\? "moderate"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/difficulty-dialog-defaults.test.mjs`
Expected: FAIL (Severe is `selected`; Severe still says "(default)"; label still "Maximum difficulty"; fallback still `"severe"`).

- [ ] **Step 3: Implement**

In `templates/dungeon-tracker.hbs`, in the `<select name="difficulty">`, remove `selected` from the Severe option and add it to the Moderate option, so the options read:

```hbs
          <option value="trivial">{{localize "PF2EDC.Dungeon.Difficulty.Trivial"}}</option>
          <option value="low">{{localize "PF2EDC.Dungeon.Difficulty.Low"}}</option>
          <option value="moderate" selected>{{localize "PF2EDC.Dungeon.Difficulty.Moderate"}}</option>
          <option value="severe">{{localize "PF2EDC.Dungeon.Difficulty.Severe"}}</option>
          <option value="extreme">{{localize "PF2EDC.Dungeon.Difficulty.Extreme"}}</option>
```

In `scripts/ui/dungeon-app.mjs` `#onStart`, change the fallback to:

```js
    const difficulty =
      form?.querySelector('[name="difficulty"]')?.value ?? "moderate";
```

In `lang/en.json`, replace the six `Difficulty*` lines with (keep the surrounding keys and valid JSON):

```json
  "PF2EDC.Dungeon.DifficultyLabel": "Difficulty",
  "PF2EDC.Dungeon.Difficulty.Trivial": "Trivial (much easier rooms and checks)",
  "PF2EDC.Dungeon.Difficulty.Low": "Low (easier rooms and checks)",
  "PF2EDC.Dungeon.Difficulty.Moderate": "Moderate (default)",
  "PF2EDC.Dungeon.Difficulty.Severe": "Severe (the full depth ramp)",
  "PF2EDC.Dungeon.Difficulty.Extreme": "Extreme (every room one step harder, tougher checks)",
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/difficulty-dialog-defaults.test.mjs && node -e "JSON.parse(require('fs').readFileSync('lang/en.json'))"`
Expected: PASS, no JSON error.

- [ ] **Step 5: Commit**

```bash
git add templates/dungeon-tracker.hbs scripts/ui/dungeon-app.mjs lang/en.json tests/difficulty-dialog-defaults.test.mjs
git commit -m "#636: Moderate is the dialog default; relabel the difficulty control"
```

---

### Task 4: Release, full suite, PR and live check

**Files:**
- Modify: `module.json` (minor bump)

- [ ] **Step 1:** `git fetch && git show origin/main:module.json | grep '"version"'`, merge `origin/main` into the branch, then set `module.json` `version` to the next *minor* value (`x.Y+1.0`); never reuse a number.
- [ ] **Step 2:** No import edge changes (confirm: `git diff origin/main --stat -- scripts | cat` shows no new `import` lines between modules beyond the `normalizeDifficulty` addition to an existing `dungeon-deck.mjs` import), so no `update-architecture-docs` run is needed. If a new edge did appear, run that skill and commit.
- [ ] **Step 3:** Run the full suite with the complete log saved (~6 min; foreground with a long timeout or background): `npx vitest run > /tmp/full636.log 2>&1; grep -n FAIL /tmp/full636.log; tail -6 /tmp/full636.log`. Expected: all files pass. A lone `tests/dungeon-reseed-sweep.test.mjs` `maxMs < 5000` failure is a known load-induced flake: rerun that file alone once before judging.
- [ ] **Step 4:** Commit the bump, push, open the PR (`Refs #636`, end the body with the standard Claude Code attribution line), then `gh pr merge <n> --squash --subject "#636: difficulty shifts the whole ramp, Moderate default (#<n>)" --body "Refs #636"`.
- [ ] **Step 5:** Update #636: remove `in progress`, comment "PR #<n> merged (v<version>). Awaiting live verification." Do not close. Live check (needs Cory's go-ahead only if it writes to the world; reads are free): open the Start Dungeon dialog and confirm Moderate is preselected; start a run **without touching the control**, then read `difficulty` off the run state (`"moderate"`), the early-room creature levels, and a skill-challenge attempt's DC (level-1 party: 15 − 1 = **14**); optionally start a Low or Extreme run and compare early rooms against the table in this plan's Global Constraints.
