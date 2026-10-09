# Advanced AI Actors: NPC Strike-Plus Abilities

**Issue:** #933 — NPC strike-plus abilities (Rend, Gnaw, Consume Flesh, Constrict, ...).

**Builds on:** the existing strike primitives and rider code in `scripts/dungeon-combat.mjs` (`rollAndApplyStrikeAtVariant`, `castMultiStrikeBundleAndApply`, `matchMultiStrikeActionSlug`) and `scripts/dungeon-strike-riders.mjs` (the Grab rider), #909's `/v1/combat-candidates` pipeline, #915's parser conventions (pure, all-or-nothing, coverage audit) and its degree-of-success outcome parser, #925's result-descriptor convention, and #932's `npcMove` vocabulary pattern.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

An AI-controlled monster today strikes, uses multi-strike bundles of the Draconic Frenzy form ("two claw Strikes and one tail Strike in any order"), triggers post-Strike riders (Grab, Knockdown) as part of a Strike, and uses breath weapons. Dozens of other standard monster abilities are Strikes with a twist and are never offered: Wrestle and Death Roll (a Strike against a creature it has Grabbed), Constrict (damage to a grabbed creature), Lunging Bite (extended reach), Broad Swipe and Wide Swing (one attack against two foes), Mangling Rend (two Strikes with a bonus if both hit), Hurl Net (a Strike whose hit applies conditions).

This spec adds them as a new `npcStrike` vocabulary entry built from a small set of **named shapes**, each with a pure parser and an executor that reuses the existing Strike primitives. An ability is offered only when its text matches a shape **completely**; anything with an effect the shapes do not model is not offered (all-or-nothing). One piece of new state is required: the module must remember **which creature an actor currently has grabbed**, because most of the abilities have that as a precondition.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **What exists.** `rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, variantIndex)` rolls a Strike and applies its damage (variant index = the multiple-attack-penalty step); `castMultiStrikeBundleAndApply` runs a named bundle as consecutive Strikes with the variant index escalating across the whole bundle; `matchMultiStrikeActionSlug` resolves a named limb to a ready strike; the Grab rider (`resolveGrabRider`, `dungeon-strike-riders.mjs`) rolls Athletics against Fortitude DC and applies Grabbed through `target.actor.increaseCondition("grabbed")`. `buildMultiStrikeCandidates` already offers bundles whose text is only "makes N <limb> Strikes … in any order".
- **What is missing.** Nothing records *who grabbed whom*: `increaseCondition("grabbed")` creates the condition with no origin, and no module flag follows it. Abilities such as Wrestle, Gnaw, Death Roll, Rending Mandibles, Suck Blood and Constrict all require "a creature it has/is Grabbing".
- **Glossary-form actions are not standalone.** Grab (215 uses), Improved Grab (66), Knockdown (46), Rend (27), Push (21), Throw Rock (19) appear as action items whose text is just an `@Localize` glossary reference; they are Strike riders already handled by `dungeon-strike-riders.mjs` (`strike.item.system.attackEffects`), not candidates.
- **Scale and shape of the real abilities** (excluding movement, #932, and Change Shape): about 316 "other", 162 multi-strike, 77 Strike + save, 53 Strike + on-hit effect and 17 grab-follow-ups across the five source books; `Draconic Frenzy` alone is 81 of the multi-strike group and is already covered by the existing bundle code.
- **Representative texts (read from the data).**
  - *Wrestle* (Tiger, 1 action): "makes a claw Strike against a creature it is Grabbing. If the attack hits, that creature is knocked Prone."
  - *Death Roll* (Crocodile, 1 action): Requirements: has a creature Grabbed. "makes a jaws Strike with a +2 circumstance bonus to the attack roll against the grabbed creature. If it hits, it also knocks the creature Prone ..." (further text read at planning).
  - *Gnaw* (Owlbear, 1 action): Requirements: has a creature Grabbed with its talons. "beak Strike. If the Strike hits, the target must attempt a Will save" with degree-of-success outcomes.
  - *Constrict* (Globster, 1 action): `@Damage[(1d8+6)[bludgeoning]]`, `@Check[fortitude|dc:22|basic]` plus the glossary — basic-save damage to a grabbed creature.
  - *Lunging Bite* (Mirage Dragon, 2 actions): "jaws Strike with an extended reach of 20 feet."
  - *Broad Swipe* (Skeletal Hulk, 2 actions): "two Strikes with its claw against two adjacent foes, both within its reach. Both attacks count toward the multiple attack penalty, but the penalty doesn't increase until after both attacks."
  - *Wide Swing* (Frost Giant, 1 action): "a single greataxe Strike and compares the attack roll result to the ACs of up to two foes within reach. This counts as two attacks for the multiple attack penalty."
  - *Mangling Rend* (Megaprimatus, 2 actions): "two fist Strikes against the same target. If both hit, the attack deals an additional `@Damage[2d6[bludgeoning]]`, the target is Off-Guard, and takes a –20-foot status penalty to all Speeds until the end of its next turn" (the penalty is a linked effect item).
  - *Hurl Net* (Tripkee Scout, 1 action): requires a net in two hands; ranged Strike with a fixed `[[/r 1d20+9]]` attack modifier against a Medium or smaller creature within 20 feet; on a hit Off-Guard and a –10-foot Speed penalty; critical effect also stated.
  - Excluded for unmodeled effects: *Rending Mandibles* and *Armor-Rending Bite* (armor broken / damage bypasses Hardness, #979), *Wind Strike* (a second, emanation-wide save), *Suck Blood* (Quickened with an action restriction), *Dispelling Strike* (casts a spell), *Thrash* (per-limb limits across many targets).
- **Degree-of-success outcomes already have a parser** in the #915 design (condition links, durations, "unaffected", immunity), reusable for Gnaw's save outcomes.
- **Multiple attack penalty rules in the text matter.** Several abilities state how they count toward MAP (both attacks count but the penalty rises only afterward; counts as two attacks). The existing executors expose the variant index, so these rules are expressible by controlling the index and by how many steps `mapIncrement` advances.

## Resolved decisions

1. **All four families are in the first slice:** grab follow-ups, multi-target and extended-reach Strikes, multi-Strike variants beyond Draconic Frenzy, and Strike plus an on-hit effect or save.
2. **Recognition: named shapes**, each with a parser and an executor.
3. **Unmodeled effects → not offered.** All-or-nothing, as in #932 and #915; a half-modeled ability is never run, which matters because GM-less runs have no one to apply leftovers.
4. **Grab state is tracked by the module** (a prerequisite, designed below).

## Design

### Grab-state tracking

A flag on the **grabber's** actor: `flags.pf2e-dungeon-crawl.grabbing = { targetActorUuid, targetTokenId, sinceWorldTime }` (a single entry, since one creature at a time is the supported case).

- **Set** wherever the module applies Grabbed on purpose: the Grab rider on a successful grab (and its improved variants) and #909's Grapple executor (Grapple/Restrained, same record). Existing call sites that only call `increaseCondition("grabbed")` are routed through one helper `recordGrab(grabber, target)`.
- **Cleared** when the target's Grabbed/Restrained condition is removed (an `deleteItem` hook on condition items), when either creature is defeated or removed, when the grabber moves away from the target by its own movement (RAW), and when the combat ends.
- **Read** by the grabbed-follow-up shape's eligibility: the flag exists, the target still has the condition, and the target is in reach.

### Shapes (`scripts/npc-strike-shapes.mjs`, pure parsers)

`parseStrikePlusAbility(item)` normalizes the description (strip HTML, resolve `@UUID` condition/effect links to their names, keep `@Damage`/`@Check` enrichers as tokens, split off `Frequency`/`Requirements`/`Trigger` blocks) and returns `null` or `{ shape, cost, frequency, params }`. Each shape lists the **recognition cue** (what must match) and its **parameters**:

1. **`strikeAgainstGrabbed`** — requirement or sentence says the actor has/is Grabbing a creature; effect: `makes a <limb> Strike against … (the grabbed creature | a creature it is Grabbing)`. Params: `limb`, `attackBonus` (e.g. +2 circumstance), `onHit`: a list drawn from {`prone`, a condition with duration, a degree-of-success save block parsed with #915's parser (Gnaw)}. Anything else on the hit (armor broken, gain condition) → not offered.
2. **`constrictLike`** — `@Damage` + `@Check[...|basic]` against a grabbed creature, no Strike. Params: `damage`, `save`, `dc`. (Basic-save damage via the existing apply path.)
3. **`extendedReachStrike`** — "<limb> Strike with an extended reach of N feet". Params: `limb`, `reachFeet`.
4. **`twoTargetStrikes`** — "makes two Strikes with <limb> against two adjacent foes within reach" or "a Strike against a creature, then one against another creature adjacent to the original". Params: `limb`, `count: 2`, `mapRule: "both-count-then-increase"`.
5. **`singleRollMultiAC`** — "a single <weapon> Strike and compares the attack roll result to the ACs of up to N foes within reach; counts as N attacks". Params: `limb`, `targets: N`.
6. **`bundleWithBothHitRider`** — "makes N <limb> Strikes against the same target. If both/all hit, … additional @Damage …, the target is <condition(s)>, … (linked effect)". Params: `limb`, `count`, `bothHit: { extraDamage, conditions[], effects[] }`. (The existing Draconic-Frenzy bundles remain with the current code.)
7. **`strikeWithOnHit`** — a single Strike with a fixed attack modifier or limb whose hit/critical hit applies stated damage and conditions with durations or linked effects, within a stated range (Hurl Net: ranged, 20 ft, size cap). Params: `limbOrFixedModifier`, `rangeFeet?`, `sizeCap?`, `onHit`, `onCrit`.

A shape's parser accepts the ability only if **every** sentence is consumed by the shape's grammar; unconsumed sentences make the whole ability `null`. The set of shapes and their exact grammars are finalized against the fixture at planning time; this list is the contract for what is *in* the first slice.

### Vocabulary (`buildNpcStrikeVocabulary`, `scripts/agent-candidates.mjs`)

Called from `getPendingAgentTurn` for AI-controlled NPCs beside the other vocabulary builders. For each parsed ability: skip if cost > actions remaining, `frequency.value` is 0, or recharge says unavailable; the named `limb` must resolve to a ready strike (`matchMultiStrikeActionSlug`). Then per shape:

- `strikeAgainstGrabbed` / `constrictLike`: one entry for the grabbed target (grab flag valid, condition present, in reach).
- `extendedReachStrike`: one entry per opponent within `reachFeet` with line of sight.
- `twoTargetStrikes` / `singleRollMultiAC`: one entry per pair/group of distinct opponents within reach of the actor (`singleRollMultiAC` offered for up to N), choosing the combinations with the most enemies and fewest allies.
- `bundleWithBothHitRider`: one entry per opponent in reach.
- `strikeWithOnHit`: one entry per opponent within range and size cap.

Entry: `{ type: "npcStrike", itemId, slug, name, shape, cost, targetIds[], summary }` with a deterministic `summary` ("Death Roll: jaws Strike on grabbed Goblin (+2), knocks prone on hit"). The per-turn cap on non-strike entries applies; ranking by expected enemies affected.

### Reasoning call and validation

As in #909/#915/#932: vocabulary `type: "npcStrike"` with `itemId`/`targetIds` as free strings; picks validated by literal membership on `(type, itemId, targetIds)`; survivors become candidates `{ id: "npcStrike:<itemId>:<targetIds.join(',')>", ... }` appended before the existing `/v1/combat-decision` call.

### Execution (`applyAgentDecision`, new `case "npcStrike"`)

Common steps: spend the cost through `turnState`; decrement `system.frequency.value` and record recharge as other abilities do; post the usage message (`item.toMessage()`); then per shape:

- **`strikeAgainstGrabbed`:** `rollAndApplyStrikeAtVariant` with the limb at the current MAP variant, applying `attackBonus` as an explicit roll modifier; on a hit apply `onHit` (Prone via `increaseCondition`, timed conditions via #915's timed-condition helper, a save block through #915's save/degree executor); bump `mapIncrement` once.
- **`constrictLike`:** roll the target's save against the DC (system roll, as #915) and apply basic-save damage through `applyDamage` using the standard degree multipliers.
- **`extendedReachStrike`:** as a normal Strike, with the distance gate already enforced by the vocabulary (the system's Strike roll does not itself enforce reach).
- **`twoTargetStrikes`:** two Strikes at the same variant index (one per target); `mapIncrement` advances by 2 only after both.
- **`singleRollMultiAC`:** one attack roll against the first target; the other targets' outcomes are computed from the same roll total against their AC and the system's degree-of-success rules (natural 20/1 adjustment included); damage rolled once and applied to each target that was hit; `mapIncrement` advances by N.
- **`bundleWithBothHitRider`:** `castMultiStrikeBundleAndApply` for the Strikes, then if every Strike hit apply the `bothHit` rider (extra damage, conditions, linked effect created on the target).
- **`strikeWithOnHit`:** one Strike (fixed modifier or limb), on a hit/critical hit apply the stated damage, conditions with durations and linked effects.

Strike results, damage and condition application each go through the existing helpers, so strike riders (Grab, Knockdown), critical specialization and cover handling behave as for ordinary Strikes. Results are reported through #925's result descriptor.

## Error handling

- A parse failure is `null` (not offered); parsing never throws into the turn.
- A grab flag that is stale at execution time (condition gone, target gone or out of reach) aborts the ability before spending the action and refreshes the flag; the action is not wasted.
- If a Strike in a multi-Strike ability cannot be rolled (target defeated mid-bundle), the remaining steps are skipped and the partial result is reported.
- A failing rider application (condition, effect creation) is logged and reported; earlier damage stays applied.
- Missing limb/ready-strike data excludes the ability from the vocabulary.

## Testing

- **Shape parsers (pure), fixtures from the real texts above:** Wrestle, Death Roll, Gnaw (with save degrees), Constrict, Lunging Bite, Broad Swipe, Wide Swing, Mangling Rend, Hurl Net; excluded cases (Rending Mandibles, Armor-Rending Bite, Wind Strike, Suck Blood, Dispelling Strike, Thrash) must return `null`; Change Shape and glossary-only actions return `null`.
- **Coverage audit:** a snapshot test over the fixture asserting counts per shape and not-offered, so changes are visible and #978/#979 progress is measurable.
- **Grab state:** recorded by the Grab rider and the Grapple executor; cleared on condition removal, defeat, grabber movement and combat end; the follow-up shapes honor it.
- **Vocabulary builder:** cost/frequency/recharge gates, limb resolution, reach/range/size gates, pair selection, grabbed-target gating, cap and ranking.
- **Executors (mocked Foundry):** correct variant indices and `mapIncrement` movement for each MAP rule; the single-roll multi-AC degree computation (including natural 20/1); both-hit rider applies only when all Strikes hit; Prone/conditions/effects created with correct durations; stale grab flag aborts without spending the action.
- **Regression:** existing multi-strike bundle, Grab rider and Strike tests keep passing.
- **Live verification:** a crocodile (grab then Death Roll), a giant with Wide Swing, a monster with a both-hit bundle rider, a net thrower.

## Explicitly out of scope

- More shapes (per-limb multi-target Thrash, area on-hit effects, self-buff and spell riders) — #978.
- Equipment-damaging abilities (armor/shield damage, bypassing Hardness) — #979.
- Glossary-form riders (already handled by the strike-rider code) and movement abilities (#932).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact grammars per shape (finalized against the fixture), the cleanup hook for the grab flag when the grabber moves, the `singleRollMultiAC` damage-roll reuse, and the per-turn entry cap.
