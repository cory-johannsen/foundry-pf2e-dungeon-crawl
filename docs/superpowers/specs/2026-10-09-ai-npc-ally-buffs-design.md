# Advanced AI Actors: Ally-Targeting NPC Buffs

**Issue:** #981 — ally-targeting NPC buffs and heals (single willing ally, allies in an emanation), deferred from #934. This spec covers the buff half; the heal half is #1056 and #1057.

**Builds on:** #934 / `docs/superpowers/specs/2026-10-08-ai-npc-self-buff-heal-abilities-design.md` (the `npcSelf` vocabulary entry, self-effect and linked-effect application, the closed requirement-predicate set, the heal executor), #914 / `docs/superpowers/specs/2026-10-08-ai-actor-self-effect-widening-design.md` (the derived effect-item filter, `effectSummary`, cap and agent-effect tagging with combat-end cleanup), #922 / `docs/superpowers/specs/2026-10-08-ai-actor-targeted-feat-actions-design.md` (one vocabulary entry per legal target), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` (template parsing, area membership) and the area-placement code area spells already use (`readyAreaSpells`, `placements`, ally-aware affected sets in `scripts/dungeon-combat.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#934 lets an AI monster use its own **self-targeted** buffs. Other monster abilities benefit **allies**: Battle Cry rallies every orc in a 30-foot emanation, Take Them Down! empowers allied hryngars of equal or lower level, Profane Gift empowers one willing humanoid. They are never offered today.

This spec adds two families to #934's `npcSelf` vocabulary entry: **ally area buffs** (an emanation or burst of allies, with a closed subject filter) and **single willing-ally buffs**. Both apply a **linked PF2e effect item** to each affected ally. Foundry enumerates the legal targets and placements deterministically, the #909 model chooses among them, and execution creates the effect on each ally. As in #934, an ability is offered only if everything in its text is modeled (all-or-nothing). Heals (single, group and check-based) are #1056 and #1057.

## Investigation findings

Confirmed against the repo, the local PF2e source data (Monster Core 1–2, Bestiary 1–3) and the earlier specs.

- **The population.** Among active NPC actions that name allies and are not Strikes, saves or movement, the structured ones are small: roughly **6 area buffs with a linked effect** (Battle Cry — "gives themself and all orc allies within a 30-foot emanation a status bonus …", Take Them Down!), **about 6 single-target buffs with a linked effect** (Profane Gift: "gives a willing humanoid a profane gift. That creature gains a +1 status bonus …"; Invigorating Passion; Brand of the Impenitent), plus a large prose-only remainder (Bark Orders, Share the Wealth, Telekinetic Storm and similar) that is not machine-readable. Heals (Dero Medicine, Collect Brain, Drink Blood, Healing Arrow) are the follow-ups.
- **Group buffs are partly handled already.** An action whose `system.selfEffect` effect carries a PF2e **`Aura` rule element** (about 11 of the 241 one-action feat/action self-effects) spreads its benefit to allies through the system itself once the actor has the effect, so #934's self-effect path already delivers it. The abilities in this spec are the ones whose text names allies and links an effect item **without** that automation, so the module must apply the effect to each ally.
- **Subject filters in the text are a small, closed set:** an ancestry or trait ("all orc allies", "allied hryngars"), a level bound ("of equal or lower level"), "themself and" (include the actor), and "willing". Others ("who hear and understand this order", "within their confessor's aura") need state the module does not model.
- **How allies are known.** Token disposition splits sides (`combatantOpponents` uses `token.disposition !== mySide`); allies are same-disposition, non-defeated combatants. `readyAreaSpells`/`placements` already compute, per candidate template placement, which combatants are affected and distinguish allies from opponents (area spells avoid friendly fire).
- **Applying an effect to another actor is the same mechanism as to self.** #910/#934 create the effect item from the compendium source with an origin context (`actor`, `token`, `item` UUIDs and `getOriginData().rollOptions`); for an ally the target actor is that ally and the effect is created on the ally. The module's AI executors run on the GM client, which can create embedded items on any actor.
- **The #914 effect filter applies unchanged** to the linked effect (no unresolved `ChoiceSet`, no `GrantItem`, no marked-target or no-rule effects, no multi-hour durations), as does the agent tag and combat-end cleanup for unlimited durations.
- **Per-target vocabulary precedent.** #922 emits one entry per legal target creature with a deterministic `summary`; area spells emit one entry per best placement.

## Resolved decisions

1. **First slice:** group buffs in an emanation or burst, and single willing-ally buffs. Self-or-ally heals including check-based heals are #1056; group heals are #1057.
2. **Selection: Foundry enumerates, the model chooses** (the #909 pipeline), ranked deterministically so the model sees the best few.
3. **Subject filters are a closed set;** anything else is not offered. All-or-nothing remains the rule.

## Design

### Recognition (extends `scripts/npc-self-parse.mjs`)

`parseSelfAbility(item)` (#934) gains two families. As before, the description is normalized (HTML stripped, `@UUID` links resolved to names with effect UUIDs kept, enrichers kept as tokens, `Frequency`/`Requirements` split off) and **every sentence must be consumed**:

1. **`allyEffectArea`** — the subject is the actor plus/or its allies and an area: "gives themself and all <filter> allies within a `@Template[emanation|burst|…|distance:N]` <effect>", "<filter> allies within N feet gain <effect>", with exactly **one** linked effect item (`@UUID[Compendium.pf2e.bestiary-effects|spell-effects|other-effects|feat-effects…]`). Params: `shape`, `distanceFeet`, `includeSelf`, `filter`, `effectUuid`.
2. **`allyEffectSingle`** — "gives a willing <noun> within N feet <effect>", "infuses a willing creature adjacent to them with …", with exactly one linked effect. Params: `rangeFeet` (adjacent = 5 ft), `targetFilter` (humanoid, undead, any creature), `effectUuid`.

**Filter grammar** (`filter`): `ancestryOrTrait:<slug>` ("orc", "hryngar"), `levelAtMost:self | <N>` ("of equal or lower level"), and an optional `excludeSelf` / `includeSelf`; "willing" is implicit for allies. Any other subject restriction makes the ability `null`.

Requirement clauses use #934's closed predicate set (hand free, wielding, an enemy within range, active-effect checks). The linked effect source must pass #914's filter and have a duration the system can expire (or unlimited, tagged for cleanup).

### Vocabulary (`buildNpcSelfVocabulary`, extended)

For each parsed ally ability, after #934's gates (cost vs actions, frequency, recharge, requirements):

- **Area:** compute candidate placements with the same helper area spells use. An emanation is centered on the actor (one placement); a burst's center candidates are positions within the ability's range that cover the most eligible allies. For each placement, the **affected set** is the combatants that are allies of the actor (same disposition, not defeated), pass the subject filter (ancestry/trait via the actor's traits, level bound), are within the shape, and **do not already have the effect** (same origin item). Skip a placement whose affected set is empty. Opponents are never in the set; unlike a damaging area, enemies in the shape cause no penalty.
- **Single:** one entry per legal ally target within range and line of effect that passes `targetFilter` and does not have the effect.
- Entries: `{ type: "npcSelf", family: "allyArea" | "allySingle", itemId, slug, name, cost, placement?, targetId?, affectedIds, summary, effectSummary }`. `summary` is deterministic ("Battle Cry: +1 status to 3 orc allies within 30 ft, 1 round"); `effectSummary` is #914's `summarizeEffect`.
- **Ranking and cap:** by number of allies affected, then by the allies' remaining threat (allies with actions still to take this round rank above those that already acted), subject to the shared #914 cap (12) across `npcSelf` entries.

### Reasoning call and validation

As in #934: `type: "npcSelf"` entries are validated by literal membership on `(type, itemId, targetId?, placement?)`; survivors become candidates `npcSelf:<itemId>[:<targetId>|:<placementId>]` appended before the existing `/v1/combat-decision` call.

### Execution (`applyAgentDecision`, `npcSelf` branch, new families)

1. Spend the cost through `turnState`; decrement `system.frequency.value`; record recharge; post the usage message (`item.toMessage()`).
2. Resolve the affected set again at execution time (allies can move or fall); drop any that no longer qualify; if the set is empty, abort before spending the action.
3. For each affected ally, create the linked effect on that ally with the origin context (the acting NPC as origin actor/token, the ability item, `getOriginData().rollOptions`) and the ally as target, then tag it `flags.pf2e-dungeon-crawl.agentSelfEffect = true` (#914's cleanup removes unlimited-duration effects at combat end). An ally that already has the effect is skipped.
4. Announce publicly (a single line naming the ability and the allies) and report through #925's result descriptor.

No stance exclusion or marked-target handling applies (those are excluded earlier by #914's filter).

## Error handling

- Parsing never throws; an unmatched sentence, an unsupported filter or more than one linked effect is `null` (not offered).
- An effect creation failure for one ally is logged and reported; the other allies still receive theirs, and the action is spent only if at least one effect was created.
- An unresolvable effect UUID, an effect failing #914's filter, or unreadable ally data excludes the ability or that ally; never defaulted in.
- A stale affected set at execution time is recomputed and filtered, not trusted.
- Reasoning-service failure → no ally-buff entries that turn; the existing candidate set proceeds.

## Testing

- **Parsers (pure), real-text fixtures:** Battle Cry (emanation, ancestry filter, includes self), Take Them Down! (level bound), Profane Gift and Invigorating Passion (single willing ally); abilities that must return `null` (an unsupported subject restriction, two linked effects, a prose-only buff, a heal, an enemy-targeting ability).
- **Filter grammar:** ancestry/trait matches and mismatches, `levelAtMost:self` and a numeric bound, `includeSelf`.
- **Vocabulary builder:** placement selection maximizing eligible allies, exclusion of allies who already have the effect, opponents never included, empty affected sets skipped, single-target range and filters, ranking and cap, requirements gating.
- **Executor (mocked Foundry):** the effect created on each affected ally with the right origin context and tag, skipped for allies that already have it, stale-set recomputation, partial failure handling, frequency and recharge recorded, action not spent when no effect was created.
- **Aura interplay:** an ability whose `selfEffect` carries an `Aura` is handled by #934's self-effect path and not duplicated here.
- **Coverage audit with ratchet (#935's pattern):** a golden file over the ally-buff fixture with `{ creature, ability, family | notOffered, reason }` and a monotonic count.
- **Regression:** #934's parsers and executors, #914's filter and cleanup, and area-spell placement tests keep passing.
- **Live verification:** an orc commander using Battle Cry on nearby orcs, a hryngar taskmaster using Take Them Down!, and a succubus using Profane Gift on an ally, with the effects visible on the allies' tokens and expiring or cleaned up correctly.

## Explicitly out of scope

- Heals that target the actor or an ally, including check-based heals (#1056), and group heals (#1057).
- Corpse-based abilities (#982), summons (#983) and prose-only zones/terrain/transformations (#984).
- Allies that must "hear and understand", confessor-aura or other state-dependent subject restrictions.
- Buffs that target player-side creatures, and enemy-targeting debuffs (#915 and the Strike and reaction series).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: how burst centers are enumerated for abilities with a range, how ancestry/trait is read from an ally actor, and where the per-ally effect application reuses #934's executor.
