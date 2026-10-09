# Advanced AI Actors: Custom Save-Ability Outcomes

**Issue:** #987 — bespoke save-ability outcomes (waste an action, action restrictions, next-roll modifiers, degree-dependent durations), deferred from #935.

**Builds on:** #935 / `docs/superpowers/specs/2026-10-08-ai-npc-save-outcome-coverage-design.md` (the per-degree outcome model, `applyTimedPenalty`, the reviewed override table `NPC_ABILITY_OVERRIDES`, the golden-file ratchet), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` (descriptor, `auto` vs `reportOnly`, `applyTimedCondition`, immunity window), #914 (agent-effect tagging and combat-end cleanup), and #984 / `docs/superpowers/specs/2026-10-09-ai-npc-prose-abilities-design.md` (the declarative-table-of-primitives pattern).

**Status:** Approved for planning. Decided autonomously in a batch run: every scope choice below took the recommended option, and each option not taken is filed as a follow-up issue (see "Explicitly out of scope").

## Summary

#935 widens the grammars so most save abilities run automatically, but leaves **bespoke outcomes** `reportOnly`: a degree block that is none of "no effect / as another degree / a condition / a simple numeric penalty". In a GM-less run nobody applies a whispered outcome, so these abilities are inert. This spec adds a small closed set of **outcome effect primitives** that the #935 override table can use inside a degree's outcome, plus the runtime that makes each one real. It is deliberately *override-table-only*: no new grammar guesses at prose; each ability is hand-reviewed, as #935 and #984 do.

First slice of primitives (four): **`wasteActions`**, **`onlyActions`**, **`rollTwice`** (fortune/misfortune on the target's next roll or rolls) and **degree-keyed durations**. Damage-type overrides, resistance/weakness changes, forced movement, suffocation and curse-removal semantics are filed separately.

## Investigation findings

Read from the local PF2e source data (Bestiary 1-3, Monster Core 1-2) and the installed system (`/srv/foundry/data/Data/systems/pf2e/pf2e.mjs`).

- **The slice.** 914 active NPC actions in those five books have an inline save check and no `@Damage`. Of these, 165 are block-form (at least two Success/Failure blocks) and 749 are not.
- **Bespoke outcomes in block-form abilities** (keyword classification of the 165; counts are distinct names, an ability can fall in several buckets):
  - action-loss / action-forcing wording: **11** (Do a Jig!, Drown, Captivating Dance, Captivating Lure, Pose a Riddle, Haunting Melody, Compel Condemned, Beckoning Call, Pollen Touch, Spray Pollen, Captivating Pollen);
  - duration decided by the degree: **6** (Brand of the Impenitent, All Becomes Flame, Spectral Corruption, Bittersweet Dreams, Whispers of Discord, Godslayer);
  - curses: **7** (Pluck Dream, Shameful Loathing, Touch of Ages, Vanth's Curse, Steal Voice, All Becomes Flame, Cynic's Curse); most of these are a condition plus "until the curse is removed" and are only unparseable because of the duration phrase;
  - next-roll modifiers: **1** in block form (Mask of Fate) and **6** more among non-block abilities (Wrathful Misfortune, Manipulate Luck, ...);
  - suffocation / breath-holding: **6**; resistance/weakness edits: **4**.
- **Representative texts.**
  - *Do a Jig!* (Gnome Bard): Failure "must waste 1 action on its next turn dancing"; Critical Failure "waste 2 actions".
  - *Drown* (Sarglagon): Failure "The only action it can take is to attempt a Fortitude save against Drown ... a single action"; Critical Failure falls and suffocates.
  - *Mask of Fate* (Divine Warden of Pharasma): Success "-1 status penalty to the next saving throw it attempts within the next minute against a divine effect from a divine warden of Pharasma or worshipper of Pharasma"; Failure "rolls twice and takes the worse result" for that next save; Critical Failure applies to all applicable saves.
  - *Wrathful Misfortune* (Guecubu): Clumsy 2 plus "on their next roll [of initiative] they must roll twice and use the worse result".
  - *Manipulate Luck* (Huldra): on a failure the *caster chooses* good luck (roll twice, keep higher, one d20 in the next minute) or bad luck (roll twice, keep lower, next d20).
  - *Brand of the Impenitent* (Balisse): the effect (-1 status to AC and saves, resistances reduced by 2, weakness 2 to holy) is fixed; only the **duration** differs by degree (1 round / 1 day / unlimited).
  - *All Becomes Flame* (Cinder Dragon, Ravener): curse for 1 round / 1 hour / 1 day, "damage dealt becomes fire damage", suppressible as an action.
- **The PF2e system already has the rule elements for fortune/misfortune.** `RollTwice` (`pf2e.mjs`, `RollTwiceRuleElement`) takes `selector[]`, `keep: "lower"|"higher"`, an optional `predicate` and `removeAfterRoll`; `afterRoll` deletes the effect (or ignores its rules) after a roll that used the keep-dice. This covers "next saving throw" and "next d20" without module code. `selector` values are the system's domains (`saving-throw`, `will`, `initiative`, `all` for any d20). `DamageAlteration` can override damage type (used by the follow-up).
- **There is no system primitive for "waste an action" or "only action".** PF2e models "lose actions" with the Stunned, Slowed and Quickened conditions, which differ in rules text (Stunned also removes reactions and is a different condition). Wasting an action is a distinct effect and must not be re-labelled as Stunned: "don't invent house rules."
- **The AI turn loop owns an action budget.** `agent-candidates.mjs` seeds `actionsRemaining: MAX_ACTIONS_PER_TURN` per turn state and every candidate builder checks `cost <= actionsRemaining`. A module effect can therefore reduce an AI-driven combatant's budget at turn start with no new rules engine. Human-driven turns have no budget; the module only observes them (`updateCombat` hook in `module.mjs`).
- **Existing building blocks:** the per-degree outcome list, `applyTimedCondition`/`applyTimedPenalty` effect-item synthesis, `abilityImmunity`, agent-effect tagging and combat-end cleanup (#914), and the fixture-backed override table with the ratchet (#935).

## Resolved decisions

1. **Override-table only; no new prose grammar** (decided autonomously (batch run) — recommended option). Bespoke prose is too varied to parse safely; reviewed per-ability entries keep #935's "never guess" rule. A broader grammar for the repeated shapes is #1091.
2. **First slice: `wasteActions`, `onlyActions`, `rollTwice`, degree-keyed duration** (decided autonomously (batch run) — recommended option). These cover the issue's named examples (Do a Jig!, Drown failure, Mask of Fate, duration-only abilities) and Manipulate Luck / Wrathful Misfortune. Other mechanics are follow-ups.
3. **Implement fortune/misfortune with the system's `RollTwice` rule element** inside a synthesized effect item (decided autonomously (batch run) — recommended option), rather than hooking the module's own rolls. It applies to human and AI rolls alike and the system handles removal.
4. **"Waste/only action" is enforced for AI-driven combatants by the module's turn loop; for human-driven combatants it is a visible chat/turn notice, not a lock** (decided autonomously (batch run) — recommended option). The module does not take control of a player's actions. Locking a human turn is a follow-up.
5. **No home-ruled severity:** wasted actions are exactly N actions on the target's *next* turn; "Stunned" is never substituted.
6. **A choice made by the caster at resolution time (Manipulate Luck's good/bad luck) is modeled as a descriptor `choice` resolved by the existing AI decision step, defaulting to the beneficial-to-caster option (bad luck on the enemy)** (decided autonomously (batch run) — recommended option).

## Design

### Outcome extension (builds on #935's `degrees[x]`)

A degree outcome gains `effects[]` (new) beside `conditions[]` and `penalties[]`. Each entry is a closed-union object. All four kinds are only creatable from the override table; the grammars never emit them.

```js
{ kind: "wasteActions",  count: 1|2|3, on: "nextTurn", note: "dancing" }
{ kind: "onlyActions",   allowed: ["saveAgainstSelf"], saveType: "fortitude",
                         dcSource: "ability", until: "succeedsSave" | "endOfNextTurn" }
{ kind: "rollTwice",     keep: "lower"|"higher", selector: ["saving-throw"],
                         predicate: ["origin:trait:divine"] /* optional */,
                         scope: "next" | "all", durationSeconds: 60 }
```

And `durationSeconds` on a degree may be `"unlimited"` (kept as an effect with no expiry, removed at combat end like all #914 agent effects; see out-of-scope for curse removal).

`mode: "auto"` requires every degree, including its `effects`, to be a recognized kind. An unknown `kind` in an override fails the table-integrity test; at runtime it makes the ability `reportOnly`.

### New module: `scripts/npc-custom-outcomes.mjs`

Pure builders plus one thin GM-client executor. Each builder returns the effect-item data; the executor creates it with the same helper #935 uses (`applyTimedPenalty` family; one shared "create tagged effect item" function).

- **`buildRollTwiceEffect(origin, effect)`** returns an effect item named after the ability with `system.duration` from `durationSeconds` and one `RollTwice` rule element per selector (`keep`, `selector`, optional `predicate`, `removeAfterRoll: true` when `scope === "next"`, otherwise `false`). Origin-conditioned wording (Mask of Fate: "divine effect from a divine warden ... or worshipper of Pharasma") is expressed as a predicate on the roll's `origin:` options; if the override cannot express the restriction as a closed predicate, the entry is not eligible for `auto` (it stays `reportOnly`) rather than applying it unconditionally.
- **`buildWasteActionsEffect(origin, effect)`** returns an effect item with `flags["<module>"].wasteActions = { count, appliesTurn: <target's next turn> }`, `system.duration` of "until the end of the target's next turn", and the module's agent-effect tag. No rule element (the system has none for this).
- **`buildOnlyActionsEffect(origin, effect)`** returns an effect item carrying `flags["<module>"].onlyActions` (the allowed action set and the save DC captured at application time), expiring at the end of the target's next turn or when the save succeeds.

### Turn-start enforcement (AI-driven combatants)

A single `updateCombat` turn-start handler (the module already owns one in `module.mjs`; this adds a branch, not a new hook) reads the starting combatant's active module effect flags:

- `wasteActions.count = N`: the AI turn state starts with `actionsRemaining = max(0, MAX_ACTIONS_PER_TURN - N)`; the wasted actions are logged to the combat narration ("spends 1 action dancing"). The effect is removed once that turn begins (consumed, not on expiry).
- `onlyActions`: the candidate builders receive an `actionFilter`; the only candidate offered is `saveAgainstSelf` (a Fortitude save against the stored DC, 1 action). On a success the filter and the effect are removed and the rest of the turn proceeds normally; on a failure the turn ends (the save used the only action).
- Both read the combatant's *own* flags, so GM-less and GM-attended runs behave the same.

### Human-driven combatants

The same turn-start branch whispers/posts a chat card to the owning player ("Do a Jig!: you must waste 1 action dancing this turn") and a banner for `onlyActions`, and keeps the effect item visible on the token. It does **not** deduct or block anything (decision 4). The effect is consumed when the turn ends.

### Degree-keyed durations

Abilities whose effect is fixed but whose duration is by degree (Brand of the Impenitent, Spectral Corruption, Whispers of Discord, ...) are written in the override as the effect definition once plus `durationByDegree: { success, failure, criticalFailure }`. The applier uses #935's `applyTimedCondition`/`applyTimedPenalty` with the degree's duration; `"unlimited"` creates the effect with no expiry. Components that need mechanics outside the four primitives (Brand's resistance/weakness changes) make the whole ability `reportOnly` until their follow-up lands; the audit lists the exact missing primitive per ability.

### Override-table entries (first batch)

Entries are authored in `scripts/npc-ability-overrides.mjs`, each with a reviewer comment and a fixture assertion (#935 rules). The first batch is the abilities that need only the four primitives:

| Ability | Source | Primitives |
|---|---|---|
| Do a Jig! | Gnome Bard | wasteActions 1 / 2 |
| Drown (failure degree only; crit-failure suffocation is a follow-up, so the ability stays `reportOnly` until then) | Sarglagon | onlyActions |
| Mask of Fate | Divine Warden of Pharasma | penalty (next save, 1 minute) + rollTwice lower, scope next / all, predicate |
| Wrathful Misfortune | Guecubu | Clumsy 2 + rollTwice lower on `initiative`, scope next |
| Manipulate Luck | Huldra | rollTwice higher/lower, caster choice (decision 6) |
| Duration-only abilities with fully supported effects | per audit | conditions/penalties + durationByDegree |

The planner confirms the exact membership against the fixture; abilities needing an unimplemented primitive are not entered.

### Audit and ratchet

The #935 golden file gains `family: "custom"` and the audit emits, for each `reportOnly` ability, the **missing primitive** (`damageTypeOverride`, `forcedMove`, `suffocation`, `resistanceEdit`, `curseRemoval`, ...). `GOLDEN_AUTO_COUNT` rises with this change and may only be raised further.

### Cleanup and immunity

Effects are tagged as agent effects (#914) and removed at combat end; the #915 `abilityImmunity` window is unchanged and applies exactly as for other outcomes. Incapacitation handling stays with the system's check roll.

## Error handling

- Effect creation failures (`createEmbeddedDocuments` rejects, target gone) are logged and reported to the GM exactly like #935's timed-condition failures; other targets and the saves are unaffected.
- A malformed or unknown `effects[]` entry makes the ability `reportOnly` at runtime and fails the table-integrity test.
- Turn-start enforcement is best effort: a missing combatant, flag or malformed count is ignored (no wasted actions) and a warning is logged, never a stuck turn. `wasteActions.count` is clamped to the budget.
- `RollTwice` removal depends on the system's `afterRoll`; if the system's automation setting for removing effects is off, the effect still expires on duration and the PF2e chat card shows the roll-twice result.

## Testing

- **Builders (pure):** `buildRollTwiceEffect` rule-element shape for next vs all, selectors, predicate; `buildWasteActionsEffect` / `buildOnlyActionsEffect` flags and duration; unknown kind rejected.
- **Override table:** each first-batch entry resolves to a real fixture item and its text matches (stale-override test); the audit emits the missing primitive for every remaining `reportOnly`.
- **Turn-start enforcement:** AI budget reduced by N and consumed, clamped at 0; `onlyActions` yields exactly one candidate, success clears and resumes, failure ends the turn; human combatant gets the notice and nothing is deducted.
- **Degree-keyed duration:** each degree's duration, `"unlimited"`, immunity window.
- **Ratchet:** golden file updated, `autoCount` monotonic test passes, deliberate-regression test still fails on drop.
- **Regression:** #915/#935 parser, executor and audit tests unchanged.
- **Live verification (GM-less):** the Gnome Bard failing a PC's save and a PC-side check that Mask of Fate's roll-twice is applied by the system to the next Will save and removed afterward; an AI-driven target loses exactly one action after Do a Jig!.

## Explicitly out of scope

Filed as follow-ups (each depends on #987):

- Damage-type override curses (All Becomes Flame: "damage dealt becomes fire", suppress-as-an-action) — #1091.
- Resistance/weakness edits as an outcome (Brand of the Impenitent, Witchflame, Sap Mind, Fascination of Flame) — #1090.
- Forced-movement outcomes ("must move closer", Captivating Dance, Beckoning Call) — #1091.
- Suffocation and breath-holding outcomes (Drown critical failure, Steal Breath, Drowning Touch) — #1090.
- Curse duration "until the curse is removed" and its integration with remove-curse effects — #1091.
- Locking or enforcing wasted/restricted actions on human-driven turns — #1090.
- A reusable grammar for the repeated bespoke shapes, once the override table shows which recur — #1091.
- Bundled, random and no-outcome-text abilities remain #988; the Trample glossary form remains #986.

## Open questions

None. Planning-time details: the exact first-batch membership after fixture review, the stable flag namespace for module effect data, the predicate vocabulary for origin-restricted `RollTwice` (confirmed against installed-system roll-option names), and the shape of the `actionFilter` passed to the candidate builders.
