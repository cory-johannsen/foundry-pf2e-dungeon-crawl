# Player max difficulty in the Start Dungeon dialog (#412)

## Goal

Let the player cap how hard a whole dungeon run can get, chosen once in the
Start Dungeon dialog and applied to every room generated during the run.

## Decisions (made with Cory, 2026-10-02)

- **Five GM Core tiers**: Trivial, Low, Moderate, Severe, Extreme.
- **Default Severe** — today's behavior, so existing runs, old saved runs, and
  anything that does not pass a tier are unchanged.
- **Clamp semantics.** The player's tier sits *on top of* the #293 depth ramp
  (`depthBiasFor`, 0..2). It lowers what the ramp produces; it never raises
  early rooms. The one exception is Extreme, which lifts only the deepest
  rooms (below).
- The alternative, a **whole-ramp shift** (Extreme raises every room, Low and
  Trivial lower every room), was considered and deferred: #636.

## Non-goals

- Treasure rooms (`lootGpForTreasureRoom`) and any other consumer of
  `depthBiasFor` besides the three below keep the raw ramp.
- Skill-challenge VP target and attempt budget (`vpTargetForDepth`,
  `attemptBudgetForDepth`) keep the raw ramp. Only the DC changes for skill
  challenges, per the agreed mapping.
- No change to the standalone encounter macro (`depthBias` null stays Severe).
- No in-run difficulty display or mid-run change.

## Design

### 1. Data

- Run state gains `difficulty`: one of `trivial | low | moderate | severe |
  extreme`. Set by `createRun` (`scripts/dungeon-runner.mjs`); any missing or
  unknown value normalizes to `severe`, so runs persisted before this change
  read as Severe with no migration.
- New exports in `scripts/dungeon-deck.mjs` next to `depthBiasFor`:
  - `DIFFICULTY_TIERS` — the ordered tier list, and `normalizeDifficulty(v)`.
  - `applyDifficultyCap(depthBias, tier)` — pure. Returns the *effective bias*:
    - cap per tier: Trivial −1, Low 0, Moderate 1, Severe 2, Extreme 2;
    - result is `min(depthBias, cap)`;
    - Extreme only: a room whose ramp bias is 2 (the goal room always is)
      returns 3.
    - Severe is the identity on the 0..2 ramp.
- New `DC_ADJUSTMENT_BY_TIER` in `scripts/skill-challenge-mechanics.mjs`:
  Trivial −5, Low −2, Moderate −1, Severe 0, Extreme +2. These come from GM
  Core's difficulty adjustments (very easy −5, easy −2, hard +2); Moderate −1
  is an interpolation, since the book has no −1 step. Extreme applies to every
  room because skill-challenge and puzzle DCs do not ramp with depth.
  Exposed through `dcAdjustmentForTier(tier)`.
- `xpCeilingTierForDepth` (`scripts/encounter-roster.mjs`) extends to the full
  range: bias < 0 → Trivial, 0 → Low, 1 → Moderate, 2 → Severe, ≥ 3 →
  Extreme. `null`/`undefined` stays Severe. No existing caller passes a
  negative or ≥ 3 bias, so current behavior is unchanged.

### 2. Wiring

- **Form**: `templates/dungeon-tracker.hbs` Start Dungeon form gets a
  `<select name="difficulty">` with the five tiers, Severe selected, labels
  localized in `lang/en.json`.
- **Start**: `#onStart()` (`scripts/ui/dungeon-app.mjs`) reads it and passes
  `difficulty` to `startDungeonRun` (GM path) and to the relayed `startRun`
  action (`scripts/dungeon-remote.mjs`, non-GM host). `startDungeonRun` passes
  it to `createRun`.
- **Combat** (`scripts/dungeon-scene.mjs`, room build): compute the effective
  bias `applyDifficultyCap(depthBiasFor(...), state.difficulty)` and pass it as
  both `levelOffsetBias` and `depthBias` to `populateSlotEncounter`, so the
  creature level band and the XP ceiling (`xpCeilingTierForDepth` →
  `xpBudget`) agree. The existing cap-aware pick in `resolveEncounterRoster`
  already lowers picks under a smaller budget.
- **Traps**: the trap call site passes the effective bias as `levelOffsetBias`
  to `populateSlotTrap` → `selectTrap`. No change inside `trap-library.mjs`.
- **Skill challenges**: `dcForAttempt` (`skill-challenge-mechanics.mjs`)
  becomes `simpleDcForLevel(partyLevel) + dcAdjustmentForTier(difficulty)`.
  `#onAttemptSkillChallenge` passes the run's `state.difficulty`. The
  `ensureSkillChallenge` call site is untouched (non-goal above).
- **Puzzles**: `initPuzzleState` (`scripts/puzzle-mechanics.mjs`) takes a
  `dcAdjustment` (default 0) added to `scaledDc`; `ensurePuzzleState` and its
  call site pass `dcAdjustmentForTier(state.difficulty)`. A `null`
  `partyLevel` keeps each hintCheck's own flat `dc` unadjusted, as today.

### 3. Errors and edge cases

- Unknown/missing difficulty (old run, bad relayed arg) → Severe.
- Effective bias below 0 reaches `selectTrap`'s level window and the combat
  level band; both already accept any numeric offset.
- Extreme on a one-room-deep ramp: only rooms at ramp bias 2 lift, so a short
  dungeon still gets an Extreme goal room.

## Testing

- `applyDifficultyCap`: every tier across ramp biases 0, 1, 2; Severe identity;
  Extreme lifts only bias-2 rooms; Trivial/Low clamp early and late rooms.
- `xpCeilingTierForDepth`: full range plus `null`.
- `dcAdjustmentForTier` / `dcForAttempt` (every tier, unknown tier) and
  `initPuzzleState` with `dcAdjustment` (including `partyLevel: null`).
- `createRun` persists the tier and defaults/normalizes it; `startDungeonRun`
  and the relayed `startRun` pass it through.
- Roster: a Trivial/Low/Extreme run produces the expected XP ceilings.
- Live check on a real Foundry world: start a Trivial or Low run, inspect
  generated rooms and DCs.

## Release

Minor `module.json` bump (new feature). The architecture doc is refreshed only
if the change adds or rewires a `scripts/` import; none is expected, since all
helpers live in modules that are already imported where they are used.
