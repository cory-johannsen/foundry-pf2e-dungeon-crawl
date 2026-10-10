# Advanced AI Characters: Widening Feat Reactions With #961's Grammar

**Issue:** #1031 — widen character feat reactions using #961's trigger grammar and shapes, deferred from #962.

**Builds on:** #962 / `docs/superpowers/specs/2026-10-09-ai-character-feat-reactions-design.md` (curated core table: Shield Block, Reactive Strike, Nimble Dodge, Retributive Strike, Flash of Grandeur), #961 / `docs/superpowers/specs/2026-10-09-ai-npc-other-triggered-reactions-design.md` (closed trigger grammar `scripts/npc-reaction-triggers.mjs`, effect shapes, override table `scripts/npc-reaction-overrides.mjs`, golden-file ratchet), #931 (registry), #963 (interception), #947 / `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md` (class set), #998 and #999 (allowlist pattern), #992 (closed-world requirements).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#962 gives AI-controlled party characters a curated table of five reactions. About **577** reaction feats and actions exist for characters across class, archetype, ancestry, skill and general. This spec applies #961's machinery — the **closed trigger grammar**, the **reused effect shapes**, the **reviewed override table** and the **golden-file coverage ratchet** — to character reaction feats, with **character-side eligibility** (the character's own items, proficiency and equipment) and a staged class set: the nine #947 classes, ancestry reactions, a reviewed set of common archetype reactions, and general/skill reactions.

## Investigation findings

- **Population.** The compendium holds about 577 feat/action items with `actionType: reaction` usable by characters (the issue's count). They span class (the bulk), archetype, ancestry, skill and general. Many repeat the same triggers as monster reactions: "you are targeted by", "an ally within N feet is hit", "you take damage", "a creature moves/attacks", "you succeed/fail a saving throw" — exactly the phrasings #961's grammar already parses.
- **Character-side differences from NPC reactions.** Eligibility depends on what the character has equipped or raised (a wielded shield, a free hand, a weapon with a trait), on class resources (Focus Points, Rage, stance, panache, Hero Points), on proficiency/ranks the feat already enforces by being on the sheet, and on feat-specific frequency. Effects often cite the character's own statistics (class DC, level, an attribute modifier).
- **What #961 provides.** A closed list of trigger phrasings producing a trigger kind plus parameters; effect shapes (a Strike with a named limb, a Strike with an on-hit effect, a save with outcomes, a simple defensive effect); a reviewed override table; and a coverage ratchet that fails when a reaction's classification regresses.
- **What #962 provides.** The character-side gates (the combatant is `agentControlled`, human characters unaffected), the core hand-written definitions, and Champion's Resistance application.

## Resolved decisions

1. **Class set:** the nine #947 classes, ancestry reactions, common archetype reactions, and general/skill reactions — all four groups.
2. **Recognition:** #961 grammar + shapes + override table + golden-file ratchet, extended with character-side eligibility (not a hand-written table only).
3. **All-or-nothing**, as everywhere: a reaction with an unparsed trigger, an unmodeled effect or a requirement outside the closed predicate set is not offered.
4. **Archetype reactions use a reviewed allowlist** (as #998) rather than wholesale parsing, because their prerequisites and state are heterogeneous.

## Design

### Recognition (`scripts/character-reaction-feats.mjs`, pure)

`parseCharacterReaction(item, actor)` returns `null` or `{ trigger, effect, requirements[], frequency, cost, source }`:

1. Gate the item: type `feat` or `action`, action type `reaction`, owned by the actor, and (class feats) a class trait in `CHARACTER_REACTION_CLASS_SET` — the nine #947 classes — or (ancestry/general/skill) the item's category is in the enabled groups, or (archetype) the slug is in `ARCHETYPE_REACTION_ALLOWLIST`.
2. Normalize the description as #961 does (strip HTML, keep `@Damage`/`@Check`/`@Template`/`@UUID` tokens, split `Trigger`/`Requirements`/`Frequency`/`Effect`).
3. Parse the trigger with `parseReactionTrigger` (#961); the grammar is **reused unchanged** (any new phrasing found is added to it, shared with NPCs).
4. Parse the effect with #961's shapes. Character-specific references resolve through a small **statistic resolver**: "your class DC", "your level", "your spell DC", `@actor.level`, and the attribute modifier the text names, read from the actor.
5. Parse **requirements** with the closed predicate set (#934/#946/#992) extended for reactions: `shieldRaised`, `handFree`, `wielding:<trait>`, `inStance:<slug>`, `focusPoints>=n`, `hasEffect:<slug>`, `notFlatFooted`... Anything else → not offered.

The **override table** (`scripts/character-reaction-overrides.mjs`) mirrors #961's: a reviewed per-feat descriptor for high-use reactions the grammar misses (for example Leshy Superstition, Call on Ancient Blood, Ward Caster's Unarmed Defense-style feats), each with a fixture assertion against the item text.

### Eligibility (character-side)

`reactionEligible(actor, combatant, def, trigger)` extends #931's gates with character checks: the reaction item is on the actor and enabled, the reaction hasn't been used this round, frequency/Focus Point/Hero Point cost is payable, requirements hold, and the trigger concerns this character or an ally it can protect. For human-controlled characters nothing changes (only `agentControlled` combatants react).

### Decision policy

Reactions go through #931's hybrid decision exactly as for NPCs: a deterministic policy where the benefit is clear (an AC bonus that changes a hit, damage reduction, a free Strike against a provoking move); the reasoning pipeline only when several definitions compete for the single reaction. Costs (Focus Points, Hero Points) are treated as part of eligibility: the policy never spends a Hero Point for a reaction.

### Interception and execution

Triggers resolve through the same seams as other reactions: #963's hooks for AC/save/damage phases, #959's damage seam, #961's movement/attack triggers. Effects execute through #961's shapes (Strike, save with outcomes, timed condition, defensive bonus). Resource costs are spent at commit (GM client) idempotently by `commitId`.

### Coverage audit and ratchet

`tools/audit-character-reactions.mjs` runs the parser over every reaction feat/action and emits a golden file of `{ item, group, trigger kind | notOffered, effect shape | notOffered, reason }`; a monotonic ratchet test (as #935/#961) fails when the offered count falls or a previously offered item becomes not offered, and the file is regenerated deliberately. The ratchet starts at the audited count for the four enabled groups.

### Settings and rollout

A world setting (default on) enables each group (`class`, `ancestry`, `archetype`, `general-skill`) so a GM can switch off a misbehaving group without code changes. The setting only gates vocabulary; the kill switch for interception (#963) remains separate.

## Error handling

- Parse or statistic-resolution failure: the reaction is not offered (all-or-nothing); a warning is logged once per item.
- Missing resource at commit (a race): the commit is rejected, a GM note is posted, and the adjustment already applied follows #963's fallback.
- An item that changes between audit and play is detected by the fixture hash of the override entry.

## Testing

- **Parser:** representative feats per group (ancestry, class, general/skill, allowlisted archetype); trigger grammar reuse; statistic resolver; requirement predicates.
- **Eligibility:** equipment/stance/resource gating; human characters unaffected; frequency and Focus Point costs.
- **Overrides:** each entry's fixture assertion.
- **Golden file:** coverage ratchet over the enabled groups.
- **Execution:** one reaction per shape (Strike, save, defensive bonus, condition) on a mocked combat.
- **Live verification:** an AI ranger/fighter reacts with a class reaction from the widened set; an ancestry reaction (Leshy Superstition) fires on a spell save.

## Explicitly out of scope

- Reactions needing an enemy's choice or ally rescue (#1030) and counteract-style reactions (#1021 for NPCs; character-side counteract reactions need their own pass).
- Wholesale archetype parsing (rejected).
- Reactions that need state the module does not track (the #992/#997 approach: add state first).

## Open questions

None. Planning-time details: the exact initial offered count for the ratchet, the first override entries, and the allowlist contents for archetype reactions.
