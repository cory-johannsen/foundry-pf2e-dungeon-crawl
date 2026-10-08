# Advanced AI Actors: Widening Self-Effect Feat/Action Eligibility

**Issue:** #914 — widen self-effect feat/action eligibility beyond stances + Rage.

**Builds on:** #910 / `docs/superpowers/specs/2026-10-08-ai-actor-feat-actions-design.md` (the feat vocabulary builder `buildFeatVocabulary` and the `feat` execution branch) and, through it, #909's `/v1/combat-candidates` pipeline. This spec replaces #910's "stances + Rage" self-effect allowlist with a **derived, data-driven eligibility filter**; it adds no new endpoint or subsystem.

**Status:** Approved. Drafted from investigation of this repo, the installed PF2e system and the live compendium; the six open questions were answered by the owner on 2026-10-08 and are folded in below (see "Resolved questions").

## Summary

#910 offers an AI combatant only stances and Rage as self-effect actions, via an explicit allowlist. This issue generalizes that to **every one-action or free feat/action carrying a PF2e `system.selfEffect`**, but only after a deterministic filter inspects the *linked effect item* and rejects the ones the module cannot apply safely without a human (unresolved choices, granted items, marked-target effects, effects with no mechanics, multi-hour effects). Eligibility is therefore computed from data, not curated per feat; a small slug **denylist** removes the few that pass the filter but are tactically meaningless. The vocabulary entry also gains a deterministic `effectSummary` so the #909 reasoning model can tell a damage buff from a resistance buff without reading prose.

## Motivation

Stances and Rage are the best-known self-buffs, but a large share of martial, ancestry and caster-hybrid kits are one-action "gain a buff" feats (Raise a Shield, Draconic Resilience, Invoke Offense, Stone Body, Trance of Celerity, Armored Courage, ...). AI characters that never use them leave a lot of their own power unused. Per CLAUDE.md "Game rules", this must use PF2e's own effect items and rule elements, not module-invented approximations.

## Investigation findings

Confirmed against the live compendia (`pf2e.feats-srd`, `pf2e.actionspf2e`) and their linked effect packs (`pf2e.feat-effects`, `pf2e.other-effects`, `pf2e.spell-effects`, `pf2e.equipment-effects`), and the installed PF2e system.

- **Population (one-action or free, with a `selfEffect`):** **241** items — 168 class feats, 31 ancestry feats, 2 skill feats, 39 basic/specialty actions (24 offensive, 7 defensive, 8 interaction), 1 uncategorized. **84** of them carry the `stance` trait (already in #910's scope). Every one of the 241 `selfEffect.uuid` values resolves to a real effect item (0 missing).
- **Usage metadata:** 62 of the 241 have a `system.frequency` (e.g. `1/PT1H`, `1/day`, `3/day`, `1/round`); the rest are unlimited-use.
- **The effect item, not the feat, decides what is safe to apply.** The effects' rule-element keys (counts over the 241): `FlatModifier` 98, `ChoiceSet` 50, `DamageDice` 23, `TempHP` 21, `ItemAlteration` 21, `Resistance` 24, `RollOption` 24, `ActiveEffectLike` 19, `GrantItem` 18, `AdjustStrike` 17, `TokenMark` 13, `Aura` 11, `Note` 13, `BaseSpeed` 9, `Sense` 6, plus a long tail (`Strike`, `CreatureSize`, `FastHealing`, `RollTwice`, ...). 19 effects have **no rules at all** (a marker item only).
- **Effect durations:** rounds 74, minutes 57, until end of encounter 73, unlimited 31, hours 3, days 3.
- **Automatic exclusion reasons (counts, overlapping):** unresolved `ChoiceSet` 50; `GrantItem` 18; marked-target / `@target`-dependent rules 21; no rules (nothing to apply) 19; hours/days duration 6.
- **After those exclusions, 139 items remain** (51 stances and 87 other feats/actions, plus Rage). So the generic filter reaches ~88 non-stance self-buffs beyond #910's slice with no per-feat code. Of the 139, 8 have `unlimited` duration (see Decision 6).
- **Why ChoiceSet and GrantItem are excluded, not resolved.** Creating an effect that contains an unresolved `ChoiceSet` makes the system open a dialog for the choice, which would block an unattended run — the same defect reported in #897 for treasure items. `GrantItem` creates additional items with their own lifecycle; the module does not yet track or clean them up for an AI actor. Both are deferred, not rejected forever.
- **Applying an effect is already specified.** #910 documents that the system applies a self-effect from a chat-card button handler (`pf2e.mjs` ~55482: load `fromUuid(selfEffect.uuid)`, merge with an origin context, create it on the actor) and that this logic is reproduced in the module. This spec reuses that executor unchanged.
- **Sample of what becomes eligible** (non-stance, passes the filter): Raise a Shield, Draconic Resilience, Invoke Offense, Stoney Deflection, Trance of Celerity, Armored Courage, Weapon Infusion, Stone Body, Bone Spikes, Guardian's Embrace, Reckless Abandon, Divine Invulnerability, Kishin Rage, Howling Aspect, Ursine Avenger Form.

## Decisions (Proposed)

1. **Replace #910's allowlist with a derived filter; keep #910's per-turn gates.** All of #910's gates (cost vs. remaining actions, frequency, not already in effect, excluded traits, stance replacement) still apply. This spec only changes *which items are considered self-effect candidates*: any one-action/free item with a resolvable `selfEffect` that passes the effect-item checks below.
2. **Effect-item eligibility checks (deterministic, in `buildFeatVocabulary`).** Load the effect source from the compendium index (cached per UUID) and exclude when: (a) rules contain a `ChoiceSet`; (b) rules contain `GrantItem`; (c) rules contain `TokenMark`, a `target:` roll-option predicate or an `@target` reference; (d) there are no rules; (e) duration unit is `hours` or `days`. A load/parse failure excludes the item, never defaults it to eligible.
3. **A slug denylist for the survivors.** A short, reviewed list of slugs that pass the filter but are never worth an AI turn (purely cosmetic, utility-only, or situational outside the module's context). Initial contents are produced during planning from the 139-item survivor list (see Open questions); the denylist is data in `scripts/self-effect-denylist.mjs`.
4. **`effectSummary` for the model.** Each vocabulary entry carries a short, deterministic summary derived from the effect's rule keys and selectors (for example `"+attack, +damage dice, 1 round"`, `"resistance, temp HP, 1 minute"`, `"+speed"`), plus the feat's frequency. The model chooses among entries by purpose; it never reads raw rules. A pure function `summarizeEffect(effectSource)` builds it, with a fixed key→label table and a safe fallback label for unknown keys.
5. **Vocabulary size cap.** At most 12 self-effect entries per turn are sent (highest tactical relevance first: those with attack/damage/AC/speed modifiers before resistances before the rest), bounding prompt size for characters with many options. A character normally has far fewer eligible items than the cap.
6. **Unlimited-duration effects are cleaned up at combat end.** The 8 surviving `unlimited` effects (and any future ones) would otherwise persist after the encounter. Effects the AI creates are tagged `flags.pf2e-dungeon-crawl.agentSelfEffect = true`; combat resolution removes tagged effects whose duration is `unlimited` (round/minute/encounter-duration effects expire through the system's own duration handling).
7. **No reasoning-model contract change.** The `feat` vocabulary entry from #910 gains optional `effectSummary`, `durationLabel` and `frequencyLabel` fields; picks are still validated by literal membership on `(type, itemId)`.

## Eligibility filter (what changes in `buildFeatVocabulary`)

For each item in `actor.itemTypes.feat` and `actor.itemTypes.action` (as in #910), after #910's action-type, cost, frequency, already-active and excluded-trait gates:

1. Item has `system.selfEffect.uuid`; resolve to an effect source (index lookup, cached). Unresolvable → exclude.
2. Apply the five effect-item checks (Decision 2). Any hit → exclude.
3. Slug in the denylist → exclude.
4. Stance trait: unchanged from #910 (replace any active stance; at most one stance).
5. Build the entry: `{ type: "feat", kind: "selfEffect", itemId, slug, name, cost, effectSummary, durationLabel, frequencyLabel?, replacesStance? }`.
6. Sort by relevance and truncate to the cap (Decision 5).

Composite-kind entries (#910's four feats) are untouched.

## Execution

Unchanged from #910's self-effect path, with one addition: the created effect is tagged `flags.pf2e-dungeon-crawl.agentSelfEffect = true` (Decision 6), and `resolveCombat`'s existing cleanup removes tagged `unlimited`-duration effects when combat ends. The GM whisper names the feat and the effect summary.

## Error handling

- Effect-pack lookup fails or a `selfEffect.uuid` does not resolve → that item is excluded; the turn continues with the remaining vocabulary.
- Unknown rule-element keys in `summarizeEffect` → generic fallback label, never an exception.
- Cleanup at combat end that fails to remove a tagged effect is logged and reported to the GM; it never blocks combat resolution.

## Testing

- **Data-driven audit test.** A fixture snapshot of the 241 candidate index rows plus their effect rule/duration data classifies every row; assertions: no included row has `ChoiceSet`/`GrantItem`/`TokenMark`/target-dependent rules/no rules/hours-or-days duration, and the included count equals the expected number for the snapshot (the test fails loudly if the compendium changes the population, prompting a conscious re-review).
- `summarizeEffect`: each key family, unknown key fallback, empty rules.
- Cap and ordering: more than 12 eligible → the 12 most relevant, deterministic.
- Denylist: a denylisted slug is excluded even if it passes the filter.
- Executor/cleanup: tagged effect created with the tag; combat-end cleanup removes tagged `unlimited` effects and leaves untagged and timed effects alone.
- Live verification on a world with a character carrying several eligible feats (e.g. Raise a Shield, a Draconic Resilience-style buff): the entry is offered, used, applied, and expires or is cleaned up correctly.

## Explicitly out of scope

- Effects with a `ChoiceSet` (revisit once #897's randomized choice mechanism exists) and `GrantItem` effects.
- Marked-target effects (Hunt Prey-style, Duelist's Challenge, Harsh Judgement) — they need the AI to also choose a target; a separate follow-up.
- Items with 2 or more actions or reaction-type self-effects.
- Hours/days-duration effects and any effect that outlives an encounter by design.
- Composite (Strike/Stride) feats — owned by #910's table.
- NPC/monster abilities — #915.

## Resolved questions

1. **Denylist:** built by review. At planning time the planner produces the survivor table (feat, category, effect summary) and the owner marks which to deny; the denylist ships as reviewed data (Decision 3).
2. **ChoiceSet effects (50 items):** excluded for now; revisit once #897's randomized choice pre-answer exists, then share it.
3. **Marked-target effects (21 items):** out of scope; filed as 927.
4. **Vocabulary cap:** 12 (Decision 5).
5. **Unlimited-duration self-effects:** removed at combat end (Decision 6).
6. **Sequencing:** plan now against #910's and #909's specs; execution waits for both.

## Follow-ups

- #927: marked-target self-effect feats need AI target selection.
