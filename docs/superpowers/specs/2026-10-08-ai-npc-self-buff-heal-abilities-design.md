# Advanced AI Actors: NPC Self-Buff and Heal Abilities

**Issue:** #934 — NPC self-buff and heal abilities.

**Builds on:** #910 / `docs/superpowers/specs/2026-10-08-ai-actor-feat-actions-design.md` (self-effect execution: usage message, frequency, effect creation with origin context), #914 / `docs/superpowers/specs/2026-10-08-ai-actor-self-effect-widening-design.md` (derived eligibility filter, `effectSummary`, vocabulary cap, agent-effect tagging and combat-end cleanup), #909's `/v1/combat-candidates` pipeline, #915's conventions (pure parsers, all-or-nothing, coverage audit), and #925's result descriptor.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

An AI-controlled monster never uses its own non-damaging utility abilities: raising a shield wall, donning a protective shell, regaining Hit Points from a feast. #910 and #914 cover feat and class self-effects on character-style actors; #915 covers save-based NPC abilities. This spec covers the self-targeted remainder that is **machine-readable**: NPC action items whose behavior is carried by structured data — a PF2e `selfEffect`, a linked effect item in the text, or a healing enricher.

Three families are offered through a new `npcSelf` vocabulary entry: (1) **NPC self-effect actions**, (2) **linked-effect buffs**, and (3) **self-heals**. Everything benefits **only the acting monster** in this slice. Requirements are checked against a closed set of predicates; abilities with any other requirement, or with any unmodeled text, are not offered (all-or-nothing). The rest of the population — allies, corpses, summons, prose-only zones and transformations — is deferred to filed follow-ups.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3; 1,433 NPCs).

- **What the AI does today for NPC non-attack actions:** nothing. The candidate set is strikes, multi-strike bundles, breath weapons, spells, maneuvers (#909) and moves; no NPC action item that is not a Strike, spell or breath weapon is ever offered.
- **Population.** Among active (1–3 action or free) NPC actions that have no inline save or damage enricher, no Strike and no movement text, about **850** remain. **433** of them are glossary-only stubs (Grab 215, Improved Grab 66, Knockdown ~44, Rend ~28, Throw Rock ~20, Push, ...), which are Strike riders handled by the strike-rider code and are not candidates. The remainder, roughly 417, splits as: ~266 "other" prose (area terrain, zones, transformations), ~57 prose self/ally buffs, ~29 condition-on-others, ~25 heals, ~21 summons/creations, ~12 interact/equip, ~7 basic-action wrappers.
- **Structured subsets** (the only part this spec models): **15** NPC action items carry a real PF2e `system.selfEffect` (e.g. Form a Phalanx, Reef Armor, Thesis Shield, Crystalline Dust Form, Invoke Rune, Revealing Hypothesis); **~80** link an effect item in their description (`@UUID[Compendium.pf2e.bestiary-effects|spell-effects|other-effects|feat-effects…]`), a minority of which are pure self-buffs (e.g. Revert Form, Reef Armor); **53** contain a healing enricher (`@Damage[…[healing]]`), of which only 4 are area or ally-oriented and the rest are self-heals or self-or-adjacent-ally heals (Consume Flesh, Feed on Fear, Dero Medicine, Collect Brain).
- **Requirements are common and varied.** Examples: "wearing a cytillesh toolkit and has a hand free" (Dero Medicine), "adjacent to the corpse of a creature that died within the last hour" (Consume Flesh), "an enemy within 15 feet is under a fear effect or dying" (Feed on Fear), "is in an assumed form" (Revert Form), "in its natural form" (Broadcast Stance), "is Prone" (Spring Up). Corpse-based requirements need corpse tracking the module does not have (#982).
- **The machinery to reuse already exists in the specs:** #910 posts the usage message with `item.toMessage()`, decrements `system.frequency`, loads `fromUuid(selfEffect.uuid)`, merges an origin context and creates the effect on the actor; #914 adds the derived eligibility filter (no unresolved `ChoiceSet`, no `GrantItem`, no marked-target or no-rule effects, no multi-hour durations), the `effectSummary` for the model, the per-turn cap, and tagging with `flags.pf2e-dungeon-crawl.agentSelfEffect` so unlimited-duration effects are removed at combat end.
- **Healing application.** `Actor#applyDamage` (PF2e) accepts a damage roll or number; healing is applied through the same call with a negative amount, and the module already uses `actor.applyDamage` for AI and trap damage (`dungeon-critical-deck.mjs`, `dungeon-combat.mjs`, `trap-combat.mjs`). The exact call shape for healing (signed total vs a healing-typed `DamageRoll`) is confirmed at planning time.
- **Effect lookups by name.** Linked bestiary effects are referenced by UUID including name-form UUIDs (e.g. `Item.Effect: Tail Lash`); resolving them is a compendium lookup by id or name.

## Resolved decisions

1. **First slice: three families** — NPC self-effect actions, linked-effect buffs, and healing. The rest are deferred: allies (#981), corpse-based abilities (#982), summons (#983), prose-only zones/terrain/transformations (#984).
2. **Self-only first.** Every ability in this slice benefits only the acting monster; ally selection and group buffs are #981.
3. **Requirements: a closed set of checkable predicates.** Abilities with any other requirement clause are not offered.
4. **All-or-nothing**, consistent with #915/#932/#933: an ability is offered only when everything in it is modeled.

## Design

### Recognition (`scripts/npc-self-parse.mjs`, pure)

`parseSelfAbility(item)` returns `null` or `{ family, cost, frequency, rechargeFormula, requirements[], params }`. Normalization: strip HTML, resolve `@UUID` links to their names while keeping effect/condition UUIDs, keep `@Damage`/`@Check`/`@Template` enrichers as tokens, split off `Frequency`/`Requirements`/`Trigger` blocks. Items with an unresolved `@Check` save or a `@Damage` of a non-healing type (those belong to #915 and the breath-weapon code), a Strike or movement phrase, a `@Template` other than a self-centered one, or a `reaction`/`passive` action type are `null`.

**Families:**

1. **`selfEffectAction`** — `system.selfEffect.uuid` is set. Params: `effectUuid`. Eligibility reuses #914's derived effect-item filter and denylist, applied to NPC action items.
2. **`linkedEffectSelf`** — no `selfEffect`; the description's subject is the actor ("The X gains …", "gaining …", "Until the start of its next turn, it gains …", "The X resumes its true form. Until …, it gains …") with **exactly one** linked effect item and no other unmodeled sentence. Params: `effectUuid` (resolved to a real effect item). The same effect-item filter as #914 applies to the linked effect.
3. **`selfHeal`** — a healing enricher `@Damage[<formula>[healing]]` and a self subject ("regains", "heals themself", "you heal"). Params: `formula`. Abilities whose healing text also names an ally ("themself or an adjacent ally") are `null` in this slice (#981).

**Requirement predicates (closed set).** Parsed from the `Requirements` block; every requirement sentence must map to one of:

- `handFree` — "has a hand free";
- `wielding:<name>` / `wearing:<name>` — an equipped item whose name matches;
- `enemyWithin:<feet>[,<condition>]` — an opposing combatant within N feet, optionally having a named condition (e.g. "frightened", "dying");
- `inForm:<assumed|natural>` — only where the module can read the actor's polymorph/form state;
- `hasCondition:<slug>` / `notHasCondition:<slug>` on the actor itself.

A requirement outside this set (a corpse, a specific creature state the module does not read, ...) makes the ability `null`.

### Vocabulary (`buildNpcSelfVocabulary`, `scripts/agent-candidates.mjs`)

Called from `getPendingAgentTurn` for AI-controlled NPCs next to the other vocabulary builders. For each parsed ability: skip if cost > actions remaining, `frequency.value` is 0, the recharge store says unavailable, or the effect is already active on the actor (same origin item, as #914); evaluate each requirement predicate against the combatant and the current opponents (all must hold); for `selfHeal`, offer only if the actor is below full Hit Points. Entry:

```js
{ type: "npcSelf", family, itemId, slug, name, cost, summary, effectSummary?, hpFraction? }
```

`summary` is deterministic. `effectSummary` for effect families comes from #914's `summarizeEffect` (rule keys → short labels + duration); `selfHeal` summaries state the formula ("heals 2d6 HP") and the actor's current `hpFraction` so the model can weigh urgency. The #914 per-turn cap applies, ranked by relevance (heals when hurt first, then attack/AC/speed effects).

### Reasoning call and validation

As in #909/#915/#932/#933: the vocabulary gains `type: "npcSelf"` with `itemId` as a free string; picks are validated by literal membership on `(type, itemId)`; survivors become candidates `{ id: "npcSelf:<itemId>", ... }` appended before the existing `/v1/combat-decision` call.

### Execution (`applyAgentDecision`, new `case "npcSelf"`)

Common steps: spend the cost through `turnState`; decrement `system.frequency.value` and record recharge as other abilities do; post the usage message (`item.toMessage()`); report via #925's result descriptor.

- **`selfEffectAction` / `linkedEffectSelf`:** #910's self-effect path — resolve the effect source from `effectUuid`, merge the origin context (actor, token, item UUIDs, `getOriginData().rollOptions`), create the effect on the actor, tag it `flags.pf2e-dungeon-crawl.agentSelfEffect = true` so #914's combat-end cleanup removes unlimited-duration effects, and enforce stance-style mutual exclusion only where the effect carries the `stance` trait (same rule as #910).
- **`selfHeal`:** roll the formula (`new Roll(formula).evaluate()`), apply healing to the actor via `actor.applyDamage` with the healing total (signed amount), clamp at max Hit Points as the system does, and report the amount actually healed.

## Error handling

- A parse failure is `null` (not offered); parsing never throws into the turn.
- An unresolvable effect UUID, an effect failing the #914 filter, or an unreadable requirement predicate input excludes the ability, never defaults it to available.
- A throwing effect creation or heal application leaves the action unspent (cost deducted only after success) and is logged and reported to the GM.
- `/v1/combat-candidates` failure/unconfigured → no `npcSelf` entries that turn; the existing candidate set proceeds unchanged.

## Testing

- **Parsers (pure), real-text fixtures:** a `selfEffect` action (Form a Phalanx / Reef Armor), a linked-effect self buff (Revert Form), a self-heal with a predicate requirement (Feed on Fear), a self-or-ally heal (Dero Medicine → `null`), a corpse requirement (Consume Flesh → `null`), a prose-only zone (Belly Grease → `null`), glossary-only stubs (`null`), saves/damage (`null`).
- **Requirement predicates:** each predicate true/false cases; unknown requirement text → `null`; unreadable actor data → ability excluded.
- **Coverage audit:** a snapshot test over the NPC fixture asserting counts per family and not-offered, so changes are visible and the follow-ups' progress is measurable.
- **Vocabulary builder:** cost/frequency/recharge gates, already-in-effect exclusion, full-HP heal exclusion, predicate gating, cap and ranking, `effectSummary`/`hpFraction` content.
- **Executors (mocked Foundry):** effect creation with origin context and the cleanup tag; heal clamps at max HP and reports the actual amount; frequency/recharge recorded; failure paths leave the action unspent.
- **Combat-end cleanup (with #914):** unlimited-duration NPC effects tagged and removed at combat end; timed effects left to the system.
- **Live verification:** a monster with a self-effect action, one with a linked-effect buff and one with a self-heal in a real fight; confirm the effects appear, the heal lands, and requirements gate use.

## Explicitly out of scope

- Ally targeting and group buffs/heals — #981.
- Corpse-based abilities (needs corpse tracking) — #982.
- Summons and conjured creatures/objects — #983.
- Prose-only zones, terrain and transformations — #984.
- Reactions (#931), movement (#932), Strike-plus (#933) and save-based abilities (#915).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact healing call shape, how the module reads form state (`inForm`) if at all, and the per-turn entry cap shared with #914.
