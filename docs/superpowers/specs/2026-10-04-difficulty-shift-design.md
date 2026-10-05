# Difficulty as a whole-ramp shift (#636)

## Goal

Make the Start Dungeon difficulty tier move the *whole* depth ramp instead of
only capping it, and make **Moderate** the dialog's default.

## Background

#412 shipped the tier as a **clamp** on the #293 depth ramp
(`applyDifficultyCap`: caps −1/0/1/2/2, plus an Extreme lift of ramp-bias-2
rooms to 3). #636 recorded the alternative, a **shift**, as a follow-up "worth
doing only if clamp semantics read as too weak". Cory chose to **replace** the
clamp with the shift (not offer both) and set the dialog default to Moderate.

## Decisions (made with Cory, 2026-10-04)

- **Replace, not add.** One semantic: the tier shifts the ramp. There is no
  second "mode" control.
- **Shift rule.** Effective bias = `clamp(rampBias + tierOffset, −1, 3)`, with
  tier offsets Trivial −3, Low −2, Moderate −1, Severe 0, Extreme +1. The ramp
  bias (`depthBiasFor`) is 0 / 1 / 2 for early / middle / deep rooms; the goal
  room is always 2.
- **Why clamp to −1..3.** That is the range the combat XP ceiling
  (`xpCeilingTierForDepth`: <0 Trivial … ≥3 Extreme), the creature level band,
  the trap level window and the `fitOffset` +4 guard already support and test
  (#412). Anything lower would put creatures/traps at levels where candidates
  may not exist and would need its own verification. Trivial keeps meaning −1
  everywhere, exactly as shipped.
- **Moderate is the one default**, in the dialog (preselected) *and* in code: a
  missing or unknown tier reads as Moderate everywhere (accepted by Cory
  2026-10-04) — see "Defaults" below.

## Non-goals

- DC adjustments (−5/−2/−1/0/+2) are already flat shifts and are unchanged.
- Skill-challenge VP target / attempt budget, treasure rooms and the standalone
  encounter macro keep the raw ramp (unchanged from #412).
- No second control, no per-room-kind shift amounts, no in-run change.
- `xpCeilingTierForDepth`, `resolveEncounterRoster`, `selectTrap`, run-state
  plumbing and the relayed `startRun` path need no change: they already take a
  numeric bias / the tier string.

## Design

### Effective bias by tier

| Tier | offset | early / middle / deep room | previous (clamp) |
|---|---|---|---|
| Trivial | −3 | −1 / −1 / −1 | −1 / −1 / −1 |
| Low | −2 | −1 / −1 / 0 | 0 / 0 / 0 |
| Moderate | −1 | −1 / 0 / 1 | 0 / 1 / 1 |
| Severe | 0 | 0 / 1 / 2 | 0 / 1 / 2 |
| Extreme | +1 | 1 / 2 / 3 | 0 / 1 / 3 |

Consequences worth stating: Low and Moderate are softer in early rooms than the
clamp was; Extreme is harder in *every* room (the "harder-mode" behavior the
clamp deliberately avoided, which is what this change opts into); Severe and
Trivial are unchanged.

### Code changes

- `scripts/dungeon-deck.mjs`: replace `DIFFICULTY_BIAS_CAP` and
  `applyDifficultyCap` with `DIFFICULTY_BIAS_OFFSET`
  (`{ trivial: −3, low: −2, moderate: −1, severe: 0, extreme: 1 }`) and
  `applyDifficultyShift(depthBias, tier)` returning
  `Math.max(−1, Math.min(3, depthBias + DIFFICULTY_BIAS_OFFSET[normalized]))`.
  `DEFAULT_DIFFICULTY` changes from `"severe"` to `"moderate"` (and its comment
  from "today's behavior"); `normalizeDifficulty` is otherwise unchanged and is
  the single place a missing/unknown tier is resolved. Update the doc comments.
- `scripts/skill-challenge-mechanics.mjs`: `dcAdjustmentForTier` resolves its
  argument through `normalizeDifficulty` (it currently falls back to 0 on its
  own, which after this change would leave a missing tier at Severe for DCs but
  Moderate for rooms).
  The module already imports from `dungeon-deck.mjs`, so no new import edge.
- `scripts/dungeon-scene.mjs`: `effectiveRoomBias` calls `applyDifficultyShift`;
  update the import and its doc comment. The two call sites (combat, trap) do
  not change.
- `scripts/encounter-roster.mjs`: update the one comment that names
  `applyDifficultyCap`.
- `scripts/ui/dungeon-app.mjs` `#onStart`: the fallback when the form value is
  missing becomes `"moderate"` (matches the dialog default).
- `templates/dungeon-tracker.hbs`: the `selected` attribute moves from the
  Severe option to the Moderate option.
- `lang/en.json`: `DifficultyLabel` "Maximum difficulty" → "Difficulty";
  Moderate becomes "Moderate (default)"; Severe drops "(default)"; Extreme's
  text no longer says "deepest rooms and the goal" — it becomes
  "Extreme (every room one step harder, tougher checks)"; Trivial/Low/Moderate
  texts note they ease the whole dungeon (e.g. "Low (easier rooms, easier
  checks)").

### Defaults

One default, everywhere: **Moderate**.

- The dialog preselects Moderate, and `#onStart`'s fallback (form value
  missing) is `"moderate"`.
- `DEFAULT_DIFFICULTY` / `normalizeDifficulty` resolve a missing, null or unknown
  tier to Moderate: `createRun`'s absent argument, a bad relayed value, a run
  saved before #412, and any legacy caller of `effectiveRoomBias` or
  `dcAdjustmentForTier`.

Trade-off accepted: a missing/unknown tier is now one step *easier* than the raw
ramp (rooms) and −1 on DCs, where it used to mean "raw ramp". A garbage relayed
value therefore yields a Moderate run, not an unaltered one.

### Effect on existing runs

Rooms are built eagerly at run start, so a run already in progress keeps its
content. A run created before #412 has no saved tier and now reads as Moderate:
its already-built rooms are unaffected, its already-created puzzles keep their
baked DCs, and only skill-challenge DCs computed *at attempt time* shift by −1
(Moderate's adjustment) from then on. Runs created since #412 have an explicit
saved tier and keep it; the only change for them is the new shift meaning of
that tier for any content built after the upgrade (none, since building is
eager).

## Testing

- `applyDifficultyShift`: every tier × ramp biases 0/1/2 against the table
  above; Severe identity; missing/unknown tier behaves as **Moderate**; the
  result is always within −1..3 (sweep tiers × biases −2..5 to pin the clamp at
  both ends); Extreme on the shortest dungeon's goal room (bias 2) is 3.
- `normalizeDifficulty(undefined | null | 'bogus')` is `"moderate"`
  (`tests/dungeon-deck.test.mjs`, replacing the #412 "severe" assertions).
- `createRun` defaults the tier to `"moderate"` and normalizes an unknown tier
  to `"moderate"` (`tests/dungeon-runner.test.mjs`, replacing the #412
  "severe" assertions).
- `dcAdjustmentForTier(undefined | 'bogus')` is −1 and
  `dcForAttempt({ partyLevel: 5 })` is 19, not 20
  (`tests/skill-challenge-mechanics.test.mjs`, replacing the #412 "0"/20
  assertions); `initPuzzleState`'s existing `dcAdjustment` tests are unaffected
  (they pass the adjustment explicitly).
- `effectiveRoomBias` (`tests/dungeon-scene.test.mjs`): the existing #412 cases
  rewritten to the new table, including Moderate and Low goal rooms; a missing
  difficulty now equals Moderate, not the raw ramp.
- Dialog default: a small test that reads `templates/dungeon-tracker.hbs` as
  text and asserts the `difficulty` select has `selected` on the Moderate option
  and on no other option (the repo has no hbs rendering harness, so a text
  assertion is the cheapest reliable check), and that `lang/en.json` marks only
  Moderate as "(default)". `#onStart`'s `"moderate"` fallback is a one-token
  change covered by the live check.
- Existing roster/trap/`createRun` tests need no change.
- Live check: start a Low or Trivial run and a Moderate (default) run and
  inspect early-room creature levels and DCs against the table.

## Release

Minor `module.json` bump: this changes the meaning of every tier except Trivial
and Severe, changes the dialog default, and changes what a missing tier means. No import edges change; no
architecture-doc update expected.
