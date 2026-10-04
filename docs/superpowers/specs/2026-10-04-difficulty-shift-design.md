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
- **Dialog default is Moderate** (preselected). The *code* default for a missing
  or unknown tier stays **Severe** — see "Defaults" below.

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
  Update the doc comments. `DIFFICULTY_TIERS`, `DEFAULT_DIFFICULTY` and
  `normalizeDifficulty` are unchanged.
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

Two different defaults, deliberately:

- **Dialog / `#onStart` fallback: Moderate** — what a player gets by clicking
  Start without touching the control.
- **Code default (`DEFAULT_DIFFICULTY`, `normalizeDifficulty`, `createRun`'s
  missing arg): Severe** — the offset-0 identity. A run saved before #412 has no
  `difficulty` and was generated with the raw ramp; reading it as Severe keeps
  its DCs and any later-built content identical to what it always was, and a bad
  relayed value cannot silently make a run easier.

### Effect on existing runs

Rooms are built eagerly at run start, so a run in progress keeps its content.
Skill-challenge DCs are computed at attempt time from the saved tier and puzzle
DCs were baked at creation; neither depends on the cap/shift change (DC offsets
are unchanged). So changing the semantics has no mid-run effect on any run
already started.

## Testing

- `applyDifficultyShift`: every tier × ramp biases 0/1/2 against the table
  above; Severe identity; missing/unknown tier behaves as Severe; the result is
  always within −1..3 (sweep tiers × biases −2..5 to pin the clamp at both ends);
  Extreme on the shortest dungeon's goal room (bias 2) is 3.
- `effectiveRoomBias` (`tests/dungeon-scene.test.mjs`): the existing #412 cases
  rewritten to the new table, including Moderate and Low goal rooms.
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
and Severe, and changes the dialog default. No import edges change; no
architecture-doc update expected.
