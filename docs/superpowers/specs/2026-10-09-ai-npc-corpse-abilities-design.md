# Advanced AI Actors: Corpse-Based NPC Abilities (Consume a Corpse)

**Issue:** #982 — corpse-based NPC abilities (Consume Flesh, Collect Brain, Soul Lock, ...) via corpse tracking, deferred from #934.

**Builds on:** #934 / `docs/superpowers/specs/2026-10-08-ai-npc-self-buff-heal-abilities-design.md` (the `npcSelf` vocabulary entry, the self-heal executor, the closed requirement-predicate set, which excluded corpse requirements), #935 / `docs/superpowers/specs/2026-10-08-ai-npc-save-outcome-coverage-design.md` (timed effects built from simple clauses), #959 / `docs/superpowers/specs/2026-10-09-ai-npc-death-reactions-design.md` (the defeat seam and the `updateActor`/combatant fallback), the game clock from #785, and the loot code from #172/#902 (`resolveCombat`'s loot conversion, empty-loot cleanup, `sweepCompletedDungeonScene`/`teardownDungeonRun`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Several monsters heal or strengthen themselves by **feeding on a corpse**: the ghoul's Consume Flesh and the ghonhatine's Feed require "the corpse of a creature that died within the last hour" adjacent to the monster, and each corpse can be used only once. #934 excluded them because the module keeps **no record of corpses**: it does not know when a creature died, where, or whether anything has already fed on it.

This spec adds that record and the first family that needs it. A **corpse record** is written on the token when a monster is defeated (death time on the game clock, position, creature data, a consumed-by set); it survives the loot conversion and room changes until the scene is torn down. A new **`corpse` family** of #934's `npcSelf` entries lets an AI monster consume an adjacent eligible corpse to heal or gain a timed buff, with the once-per-corpse rule enforced. Only **defeated monsters** leave corpses in this slice; multi-step abilities, corpse-targeting abilities, dying-creature abilities and party-character corpses are filed as follow-ups.

## Investigation findings

Confirmed against the repo, the local PF2e source data (Monster Core 1–2, Bestiary 1–3) and the earlier specs.

- **What happens to a dead monster today.** The module applies defeat through `applyDefeatIfReducedToZero` (`toggleDefeated()` on the combatant, plus the death sound), and PF2e also marks an NPC combatant defeated at 0 HP on its own when the system applies damage. The defeated token stays on the scene with its actor at 0 HP until `resolveCombat` ends the combat, which converts a hostile worth looting into a **lootable corpse**: it creates a PF2e `loot` actor from the dead actor's data and **repoints the existing token** at it (#172, because Foundry actor types are immutable); a hostile with nothing lootable is deleted instead. Empty, looted loot tokens are later cleaned up (#902), and any leftover is swept at Abandon/reset or run completion.
- **No death record exists.** Nothing stores a time or position of death, the creature's level, size or traits for later use, or a "consumed" marker. Positions are on the token; death time is not recorded anywhere.
- **The game clock exists** (#785): `game.time.worldTime` is real, persistent and advanced by the module for exploration and rests, so "died within the last hour/minute/day" can be evaluated against real elapsed game time.
- **Token flags survive the conversion.** Because the loot conversion repoints the **same token document** at a new actor, a flag stored on the **token** persists across the conversion, whereas a flag on the actor would be left on the discarded one.
- **The corpse abilities (read from the data).** 38 uses across 27 ability names have a corpse or "recently dead" clause. The structured, self-benefiting ones:
  - *Consume Flesh* (Ghoul, 5 uses, 1 action): Requirements — "adjacent to the corpse of a creature that died within the last hour". Effect — "devours a chunk of the corpse and regains `@Damage[2d6[healing]]` Hit Points. It can regain Hit Points from any given corpse only once."
  - *Feed* (Ghonhatine, 1 action): Requirements — the same adjacency and one-hour window. Effect — "devours a chunk of the corpse. For 1 minute, the ghonhatine gains fast healing 5 and a +2 status bonus to damage rolls. It can gain these benefits from any given corpse only once."
  - Not in this slice (follow-ups): *Collect Brain* (a creature within reach dead no more than a minute; a heal of 20 HP only after a later Interact action), *Necro Puppeteer*, *Ravenous Repast*, *Font of Death* (corpse-targeting with templates, checks or transformation), *Drain Soul* and *Trap Soul* (a Dying creature), *Body Thief*, *Inhabit Body*, *Abandon Body*, *Ride Corpse*, *Reap*, and the reactions that fire on a creature's death (Reawaken!, Soul Feast, #1019).
- **#934's machinery to reuse:** the self-heal executor (roll the formula, apply healing, clamp at max HP), the closed requirement-predicate grammar (extended here by one predicate), the per-turn entry cap, `effectSummary`, and #914's agent-effect tagging and combat-end cleanup. #935 supplies the effect-synthesis pattern for numeric bonuses and the timed-condition helper.

## Resolved decisions

1. **First slice: consume-a-corpse self heals and buffs** (Consume Flesh, Feed). Multi-step abilities (Collect Brain, #1062), corpse-targeting damage/save abilities (#1063) and dying-creature abilities (#1064) are follow-ups.
2. **Corpses come from defeated monsters only.** Dead party characters are never consumable in this slice (#1065).
3. **Corpse records live on the token** (death time on the game clock, position, creature data, consumed-by), surviving loot conversion and room changes until the scene is torn down.

## Design

### The corpse record

A flag on the **token document** of a defeated NPC: `flags.pf2e-dungeon-crawl.corpse`:

```json
{
  "diedAtWorldTime": 1840,
  "round": 3,
  "x": 1200, "y": 1500,
  "name": "Goblin Warrior",
  "level": 1,
  "size": "sm",
  "traits": ["goblin", "humanoid"],
  "creatureType": "humanoid",
  "consumedBy": ["Actor.abc123:consume-flesh"]
}
```

- **Written** (idempotently: never overwritten once present) at the module's defeat seam in `applyDefeatIfReducedToZero` for an NPC target, and by a fallback `updateCombatant` handler for defeats the system applied itself (the same pairing #959 uses). The record captures the actor's name, level, size and traits at the moment of death.
- **Position** is the token's current top-left corner (`x`, `y`); adjacency uses cell geometry (below).
- **Persists** across the loot conversion because the conversion repoints the same token document; a hostile with nothing lootable is deleted at combat end and so its corpse record disappears with it (consistent: nothing is left to eat). Empty looted loot tokens removed by #902 take their records with them. The record is swept with the scene at Abandon/reset or run completion by the existing sweeps — no new cleanup code.
- **Never written** for party characters, hazards, cover items, or tokens that were not defeated.

### Corpse queries (`scripts/corpses.mjs`, pure over token snapshots)

- `corpsesNear(tokens, from, { adjacent: true | withinFeet, maxAgeSeconds, now })` returns eligible corpse snapshots (each with its token id, record, and age `now - diedAtWorldTime`), using the module's existing cell geometry for adjacency (a corpse is adjacent when within one square, Chebyshev) and the grid distance for ranges.
- `isConsumedBy(record, eaterUuid, abilitySlug)` / `markConsumed(record, eaterUuid, abilitySlug)` implement the once-per-corpse rule ("It can regain Hit Points from any given corpse only once": per eater and ability).
- **Eligible creature types.** A corpse is food only if its recorded traits exclude a small reviewed set (`NON_FLESH_TRAITS`: construct, elemental, incorporeal, and similar), because "the corpse of a creature" cannot be fed on if it left no flesh. This table is data planning reviews; it is a documented default, and PF2e rules are followed where they are explicit.

### Recognition (extends `scripts/npc-self-parse.mjs`)

`parseSelfAbility(item)` (#934) gains the **`corpse` family**. All of #934's rules hold (normalize, every sentence consumed, closed requirement set), plus:

- **New requirement predicate** `corpseNear { adjacent: true | reachFeet, maxAgeSeconds }` parsed from "adjacent to the corpse of a creature that died within the last <N> <unit>(s)" (units: round, minute, hour, day).
- **Effect clauses** (closed): a heal `@Damage[<formula>[healing]]` ("regains <heal> Hit Points") — #934's `selfHeal` — or a **timed buff** of the forms "For <duration>, <the actor> gains fast healing <N> and a +<B> status|circumstance|item bonus to <selector>" parsed into `{ fastHealing?: N, bonuses: [{ type, value, selector }], durationSeconds }`.
- **Rider** `oncePerCorpse` from "It can <gain these benefits | regain Hit Points> from any given corpse only once." An ability without this sentence is treated as repeatable per eater, as the text says.

An ability with any other trailing sentence or requirement is not offered.

### Vocabulary (extends `buildNpcSelfVocabulary`)

For each parsed `corpse` ability, after #934's gates (cost vs actions, frequency, recharge, other requirements):

- Gather corpse tokens on the viewed scene with a corpse record and evaluate `corpsesNear` from the acting token with the ability's adjacency and age limit against `game.time.worldTime`.
- Drop corpses already consumed by this eater for this ability (when `oncePerCorpse`) and corpses whose traits fall in `NON_FLESH_TRAITS`.
- For a heal, offer only when the actor is below full HP; for a buff, only when the buff is not already active from this item.
- One entry per eligible corpse: `{ type: "npcSelf", family: "corpse", itemId, slug, name, cost, targetId /* corpse token id */, summary, effectSummary }` with a deterministic `summary` ("Consume Flesh: heal 2d6 from the goblin corpse (died 2 minutes ago)"); the #914 per-turn cap applies, ranked by freshness (youngest first).

### Reasoning call and validation

As in #934 and #922: picks are validated by literal membership on `(type, itemId, targetId)`; survivors become candidates `npcSelf:<itemId>:<corpseTokenId>` appended before the existing `/v1/combat-decision` call.

### Execution (`applyAgentDecision`, `npcSelf` branch, `corpse` family)

1. Re-resolve the corpse token at execution time and re-check adjacency, age and the consumed set (a corpse can have been consumed or deleted since the vocabulary was built); abort before spending the action if it no longer qualifies.
2. Spend the cost through `turnState`; decrement `system.frequency.value`; record recharge; post the usage message (`item.toMessage()`).
3. **Heal:** #934's self-heal path. **Buff:** create one effect item on the actor with a `FastHealing` rule element and one `FlatModifier` per parsed bonus, a matching `system.duration`, the ability as origin, tagged `flags.pf2e-dungeon-crawl.agentSelfEffect = true` (#914 cleanup for unlimited effects; timed ones expire through the system).
4. **Record consumption:** `markConsumed` on the corpse token's flag (an update of the token document).
5. Announce publicly ("<name> devours part of the <corpse name>") and report through #925's result descriptor (including the amount healed or the buff).

### Interactions

- **Looting.** Eating a corpse does not remove its loot; the loot actor and its items are untouched.
- **#902 cleanup.** When an emptied looted loot token is removed, its corpse record goes with it; a later ability can no longer find that corpse, which is the intended behavior.
- **#959 death reactions** run before the defeat seam writes the record, so a Ferocity that cancels a defeat never leaves a corpse record; a monster later defeated gets its record then.
- **Game-clock advance.** Exploration and rest time (#785) advance `worldTime`, so corpses from earlier encounters in the same scene age naturally and eventually fall outside "within the last hour".

## Error handling

- Corpse record writes are best-effort: a failure is logged and the corpse simply is not recorded (it cannot be eaten); defeat handling is never affected.
- A missing or malformed record means "not a corpse"; the ability is not offered for it.
- A failed `markConsumed` after a successful heal is logged and reported; the corpse may be eaten again (an acceptable, visible inconsistency).
- An unreadable `worldTime` or a record without `diedAtWorldTime` is treated as not eligible, never as fresh.
- A healing/effect creation failure leaves the action unspent and the corpse unconsumed.

## Testing

- **Pure queries:** `corpsesNear` for adjacency and range, age limits at the boundaries (just inside and outside "an hour"), consumed filtering per eater and ability, `NON_FLESH_TRAITS` exclusion, malformed records.
- **Recognition (pure), real-text fixtures:** Consume Flesh (heal, `oncePerCorpse`) and Feed (fast healing and a +2 status bonus to damage rolls for 1 minute); texts that must return `null` (Collect Brain's Interact step, Necro Puppeteer, Drain Soul, an unrecognized requirement or trailing sentence).
- **Record writing:** written at the defeat seam for NPC targets only, idempotent, not for characters or cover items, written by the fallback for system-applied defeats; survives a simulated loot conversion (token repointed); absent for tokens deleted at combat end.
- **Vocabulary builder:** corpse eligibility, freshness ranking, heal only when hurt, buff only when not already active, per-entry summaries, cap.
- **Executor (mocked Foundry):** stale-corpse abort without spending the action, heal and buff application, consumed set updated, frequency/recharge recorded, public announcement, failure paths.
- **Regression:** #934's parsers and executors, #172/#902 loot tests, defeat-seam and fallback tests, `sweepCompletedDungeonScene` tests keep passing.
- **Live verification:** a ghoul beside a freshly killed monster using Consume Flesh once (and being unable to eat it again), a ghonhatine's Feed buff expiring after a minute, and a corpse from an earlier fight in the same scene aging past the window.

## Explicitly out of scope

- Multi-step corpse abilities (Collect Brain) — #1062; corpse-targeting damage/save abilities (Necro Puppeteer, Ravenous Repast, Font of Death) — #1063; dying-creature abilities (Drain Soul, Trap Soul) — #1064; corpses of dead party characters — #1065.
- Reactions triggered by a creature's death (Reawaken!, Soul Feast, #1019).
- Possession/inhabiting abilities (Body Thief, Inhabit Body, Abandon Body, Ride Corpse), Reap, and prose-only corpse effects.
- Changing the loot conversion or cleanup behavior.
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the reviewed `NON_FLESH_TRAITS` table, the exact adjacency test shared with the movement helpers, and where the consumed set is best stored if a token flag update proves racy with loot conversion.
