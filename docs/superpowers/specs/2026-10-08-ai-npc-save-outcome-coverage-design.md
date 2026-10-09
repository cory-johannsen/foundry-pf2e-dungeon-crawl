# Advanced AI Actors: Widening NPC Save-Ability Outcome Parsing

**Issue:** #935 — expand NPC save-ability outcome parsing coverage beyond the structured subset.

**Builds on:** #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` (the `parseSaveAbility` descriptor, the `auto` vs `reportOnly` modes, the degree-block parser, timed-condition application, the immunity window and the coverage audit). This spec widens that parser; it adds no new vocabulary type, endpoint or executor shape.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

#915 offers every save-based, no-damage NPC ability whose save it can recognize, but runs it **fully automatically** only when its text parses into per-degree outcomes: separate Critical Success / Success / Failure / Critical Failure blocks whose outcomes are linked conditions with durations. Anything else is **roll-and-report** (saves are rolled and the monster's own outcome text is whispered to the GM). In a GM-less run nobody applies a whispered outcome, so every ability that stays roll-and-report is effectively inert in those runs. This spec raises the share that runs automatically.

It does so with three additions to the parser, plus one new outcome kind: (1) a **broader degree-block grammar**, (2) an **inline-outcome grammar** for single-sentence outcomes, (3) a **reviewed per-ability override table** for the highest-use abilities the grammars miss, and (4) a **simple penalty outcome** (a numeric status/circumstance penalty to a named statistic for a duration), applied by synthesizing a small effect item. Coverage is protected by a **ratchet**: a committed golden-file audit of every parsed ability, and a test that fails if the automatic count ever drops.

## Investigation findings

Confirmed against the local PF2e source data (Monster Core 1–2, Bestiary 1–3) and the #915 spec.

- **The slice.** 369 active (1–3 action or free) NPC actions have an inline saving-throw check (`@Check[fortitude|reflex|will|…]`) and no `@Damage` enricher.
- **Block-form abilities: 113.** These have at least two `<strong>Critical Success|Success|Failure|Critical Failure</strong>` blocks. #915's strict parser (degree blocks **and** linked conditions) automates about 74. A broader per-block classification finds **78** whose every block is one of: *no effect* (107 blocks across the group), *"as failure/success/critical failure"* (52), a *linked condition* (70) or a *condition named in plain text* (39), with a duration in 127 blocks. The other **35** contain a block that is none of those: bespoke outcomes such as "the target must waste 1 action on its next turn dancing" (Do a Jig!), "the target is cursed for 1 round …" (All Becomes Flame), "the only action it can take is to attempt a Fortitude save" (Drown), "takes a –1 status penalty to the next saving throw it attempts within the next …" (Mask of Fate), "the duration is 1 round" (Brand of the Impenitent). So the broader block grammar alone is a **small** gain over #915's 74 (about +4); the gain has to come from the non-block form.
- **Non-block abilities: 256.** Classified by shape: **100** single-sentence *inline outcomes* ("a creature that fails the save is X for N", "becomes Frightened 1 unless they succeed at a Will save", "… critically fails … is X"); **57** "must attempt a save" abilities that bundle other effects (terrain, movement, a random d4 effect); **45** the `Trample` glossary form (basic Reflex save with glossary-defined damage, a damage family rather than a no-damage ability); **45** with no stated outcome text at all (the outcome is elsewhere, or the ability is a bare check); plus a handful of success-only wordings ("unaffected on a success").
- **Representative inline texts.** *Terrifying Croak* (Boggard): "Any non-boggard within a 30-foot emanation becomes Frightened 1 unless they succeed at a Will save (DC …)", used by several boggard variants. *Frightful Moan*, *Frightening Display*-style abilities express outcomes in blocks; *Focus Gaze* (Medusa) uses the structured `@Check[fortitude|dc:25|options:inflicts:…]` option on a single-target gaze.
- **Existing building blocks from #915:** the descriptor shape (`save`, `dc`, `shape`, `traits`, `cost`, `frequency`, `degrees`, `mode`), the all-or-nothing rule per ability, timed-condition application (`applyTimedCondition`, an effect item carrying the condition and a duration), the `abilityImmunity` timestamp store on the game clock, the incapacitation handling supplied by the system's check roll, and the report-only fallback. The data-driven coverage audit test is introduced there; this spec makes it a ratchet.
- **PF2e has no standard "next-roll" or "waste an action" primitive** that a rule element expresses simply; those outcomes need bespoke mechanics (#987).

## Resolved decisions

1. **Three widenings are in this issue:** the broader degree-block grammar, the inline-outcome grammar, and a reviewed per-ability override table. The Trample glossary form is #986.
2. **Simple penalty effects are synthesized; everything else stays roll-and-report.** One extra outcome kind — a numeric status/circumstance penalty to a named statistic for a duration — is created as a small effect item. Bespoke outcomes (waste an action, curses, single-use "next roll" modifiers, action restrictions) are #987.
3. **Acceptance bar: a ratchet, not a target percentage.** A committed golden-file audit of every parsed ability (reviewable in PR diffs) and a test that fails if the automatic count drops.
4. **The remaining unparseable abilities** (bundled-effect, random-effect and no-outcome-text abilities) are #988.

## Design

### Where the work lives

All parsing stays pure and in the #915 parser module (`scripts/npc-ability-parse.mjs`), with two additions: the override table in `scripts/npc-ability-overrides.mjs` (data) and the penalty effect builder in the timed-effect helper #915 introduced. No executor, vocabulary or endpoint changes are needed because the descriptor shape already carries per-degree outcome lists; this spec adds one outcome kind to them.

### The outcome model (extends #915's `degrees`)

Each degree of a descriptor holds `{ none, asFailure, conditions[], penalties[], durationSeconds, immuneSeconds }`, where **`penalties`** is new: `[{ type: "status"|"circumstance"|"item", value: -N, selectors: [...], durationSeconds }]`. `mode` is `"auto"` only if every degree parses completely; otherwise `"reportOnly"` (unchanged from #915).

### 1. Broader degree-block grammar

Replaces #915's strict "block + condition link" requirement with per-block classification. A block parses if it is composed only of:

- **No effect:** "unaffected", "no effect", "the creature is unaffected" (with or without "and is temporarily immune to <ability> for <duration>").
- **As another degree:** "as failure", "as a failure but …", "as success", "as critical failure" — the referenced degree's outcome, plus an optional *parseable* suffix (a changed duration such as "for 1 hour"); a suffix that is not parseable makes the block unparseable.
- **A condition**, either linked (`@UUID[Compendium.pf2e.conditionitems.Item.<id|slug>]{Name N}`) **or** named in plain text from a closed list of PF2e condition names (valued and non-valued: dazzled, frightened N, stunned N, slowed N, sickened N, blinded, deafened, paralyzed, petrified, prone, grabbed, off-guard, stupefied N, confused, fascinated, fleeing, clumsy N, enfeebled N, drained N, immobilized, ...), each with an optional value and an optional duration.
- **A simple penalty** (below).

Durations: "for N round(s)/minute(s)/hour(s)/day(s)" (with "a", "one", "two", … as number words), "until the end of its next turn", "until the start of your next turn", "for 1 round" (6 s). Immunity: "temporarily immune … for N hours/days/minutes".

### 2. Inline-outcome grammar

For abilities without degree blocks, recognize a **single outcome sentence** attached to the save, in a closed set of patterns:

- `<subject> that fails the save is|becomes <condition> [for <duration>]` and `… critically fails … is|becomes <condition2>` (a failure and optionally a separate critical-failure outcome);
- `<subject> becomes <condition> unless they succeed at a <save> save` (failure → the condition; success and critical success → no effect);
- `Each creature in the area must succeed at a <save> save or <become|be> <condition>` and the `succeed at … or are <condition> for <duration>` variants.

The subject set is closed (creature(s), target, each creature in the area, "non-<ancestry>" restrictions — the restriction is carried as a target filter and an ancestry the parser cannot resolve makes the ability unparseable). The save, DC, template/range and traits come from the same enrichers as #915; only the *outcome* parsing is new. Requirements/Trigger blocks that the descriptor cannot check make the ability `null` as in #915.

### 3. Simple penalty outcomes

New outcome kind recognized in either grammar: `takes|takes a|suffers a –N (status|circumstance|item) penalty to <statistics> [for <duration>]`. Statistic selectors map from a closed table: all saving throws, a named save, attack rolls, AC, Perception, skill checks (all or a named skill), all Speeds, "all checks and DCs". "The next X" and "until you …"-style single-use or conditional wordings are **not** recognized (#987). Execution: `applyTimedPenalty(target, { type, value, selectors, durationSeconds, originItem })` creates one effect item named after the ability on the target with a matching `system.duration` and one `FlatModifier` rule element per selector (type, negative value), tagged with the origin; the system's own duration handling expires it. The exact effect-item shape is confirmed against the installed system at planning time (the same verification point as #915's timed-condition mechanism, so the two share one helper).

### 4. The reviewed override table

`NPC_ABILITY_OVERRIDES` is data keyed by an ability's source identity (compendium item name plus its `system.slug`, with the creature where several creatures share an identically named ability): for abilities the grammars miss or misread, a complete hand-written descriptor (`save`, `dc`, `shape`, per-degree outcomes). Rules:

- An override **replaces** the grammar result for that ability and is the only way a hand-written outcome gets in.
- Every override carries a short reviewer comment and is covered by a fixture assertion that the override's descriptor matches what the item's text says (so a compendium change that makes the text diverge fails a test).
- The initial table is built from the highest-use abilities the grammars leave as `reportOnly`, ranked by the number of creatures carrying them in the fixture (Terrifying Croak and similar repeated abilities first), reviewed by the owner in the PR.

### 5. The ratchet

- The audit (introduced by #915) is extended to emit a **golden file** (`tests/fixtures/npc-save-ability-audit.json`): one row per slice ability with `{ creature, ability, mode, family: "blocks"|"inline"|"override"|"reportOnly", summary }`, where `summary` is the deterministic one-line description of the parsed outcomes. The file is committed, so every parser change shows up as a reviewable diff of which abilities changed mode or meaning.
- A test compares the live audit to the golden file and a second test asserts `autoCount >= GOLDEN_AUTO_COUNT`, a number stored beside the golden file that may only be raised by a change that also updates the golden file. A drop in coverage, or an ability silently changing meaning, fails CI.
- The audit also reports the count of unparseable-by-reason for #987/#988 triage.

### Interaction with #915's execution

`mode: "auto"` abilities now include inline and penalty-based ones; the #915 executor needs two additions only: apply `penalties` through `applyTimedPenalty`, and read the new `family` field for the GM report ("outcome parsed from inline text"). Roll-and-report abilities are unchanged.

## Error handling

- Parsing never throws; an unrecognized block or sentence makes the whole ability `reportOnly` (unchanged all-or-nothing rule).
- An override whose referenced item cannot be found or whose fixture assertion fails is ignored at runtime (the grammar result applies) and fails the test suite so it is fixed.
- A condition name outside the closed list, an unresolvable ancestry filter, or an unsupported statistic selector makes the ability `reportOnly`, never a guess.
- `applyTimedPenalty` failures are logged and reported to the GM (as #915's timed-condition failures); the save result and other targets are unaffected.

## Testing

- **Block grammar:** each block kind (no effect with/without immunity, as-other with parseable and unparseable suffix, linked condition, text-named condition with value and duration, penalty), number words in durations, "until the end of its next turn", and a block with an unknown outcome → `reportOnly`.
- **Inline grammar:** each sentence pattern with real texts (Terrifying Croak, a "fails … critically fails" pair, the "or become" variant), the ancestry filter, patterns that must not match (success-only phrasing without a defined failure, bundled effects).
- **Penalty outcomes:** selector mapping, duration handling, "next roll" wordings rejected, executor builds the correct effect item and the system expires it (mocked), failure path.
- **Overrides:** table integrity (every entry resolves to a real fixture item and matches its text), override precedence over the grammar, stale override ignored.
- **Ratchet:** the golden-file comparison, the monotonic count test, and a deliberate-regression test proving a coverage drop fails.
- **Regression:** #915's existing parser, executor and audit tests continue to pass; abilities that were `auto` stay `auto` with identical outcomes.
- **Live verification:** a monster with an inline-outcome ability (Terrifying Croak) and one with a penalty outcome in a real fight, in a GM-less run: conditions/penalties apply with the right durations and expire.

## Explicitly out of scope

- The Trample glossary form — #986.
- Bespoke outcomes: waste-an-action, curses, single-use next-roll modifiers, action restrictions, forced movement — #987.
- Bundled-effect, random-effect and no-outcome-text abilities — #988.
- Damaging save abilities (the breath-weapon family) and every other ability family.
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact grammar finalized against the fixture, the initial override list, the effect-item shape for penalty outcomes, and where the golden file and ratchet constant live.
