# Advanced AI Actors: NPC Summon and Conjure Abilities

**Issue:** #983 — summon and conjure NPC abilities (Summon Steed, Spider Minions, Summon Aquatic Ally, Spirit Blades, Phantom Mount), deferred from #934.

**Builds on:** #934 / `docs/superpowers/specs/2026-10-08-ai-npc-self-buff-heal-abilities-design.md` (the `npcSelf` entry conventions, requirement predicates, frequency and recharge), #914 (agent-effect tagging and cleanup), #925 (result descriptor), the module's creature placement code (`spawnCreatures` in `scripts/foundry-api.mjs`) and its AI turn pipeline (`getPendingAgentTurn`, `applyAgentDecision`, `runAgentDecisionLoop`, `resolveCombat` in `scripts/dungeon-combat.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

About 21 NPC abilities summon or conjure something: a dullahan summons a war horse, a morrigna summons spiders, a triton casts Summon Animal, a bikkhasura summons spirit blades. The AI never uses them. They are also the first abilities that **add combatants during a fight**, which raises design questions the other ability specs avoided: where the creature appears, how it acts, how long it lasts, and what it is worth.

This spec adds a new `npcSummon` vocabulary entry and **three shapes**: **direct creature summons** (a named compendium creature, optionally with elite/weak adjustments and added traits), **summon-spell abilities** (casting Summon Animal/Fey/Fiend at a stated rank with a restriction), and **conjured objects** (items conjured from a reviewed item definition). Summoned creatures follow the **PF2e minion rules**: they act only when their summoner spends an action to command them, then take two actions on the summoner's turn. They are tracked with a **summon record**, expire by game-clock duration or by being slain or dismissed, are removed at combat end, and are worth **no XP or loot**. Spell-derived mounts (Phantom Mount) are #1069.

## Investigation findings

Confirmed against the repo, the installed PF2e system and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **The abilities.** 21 uses across 16 names have summon/conjure text. The genuine creature summons:
  - *Spider Minions* (Morrigna, 3 actions): "summons a `@UUID[…Actor.Giant Tarantula]` or `@UUID[…Actor.Spider Swarm]`. These spiders have the summoned trait and remain for 10 minutes or until reduced to 0 Hit Points … The morrigna does not need to Sustain the Spell to direct these summoned creatures, and can have any number of summoned spiders in existence at once."
  - *Summon Steed* (Dullahan, 2 actions): "summons a war horse with elite adjustments and the fiend and unholy traits. This steed remains until it is slain, the dullahan Dismisses this effect, or the dullahan Summons a Steed again."
  - *Summon Aquatic Ally* (Triton, 3 actions, once per day): "casting a 2nd-rank Summon Animal spell. The triton can summon only an aquatic creature, such as a dolphin, octopus, ray, sea snake, or electric eel. This creature remains until it is slain, the triton Dismisses it, or the triton summons another ally."
  - *Ritual Gate* (Lurker in Light): casts Summon Fey with a requirement tied to killing a creature; *Spirit Blades* (Bikkhasura, once per hour): "summons six blades made out of spiritual energy … appear in the bikkhasura's hands or float next to it until it directs one or spends an Interact action to grab it … dispelled with a counteract check"; *Phantom Mount* (Graveknight): Marvelous Mount heightened to half the graveknight's level with AC and saves 4 lower (#1069).
  - The rest of the matches are not summons (storms, boulders, debris, a curse, a vision).
- **PF2e's rules for summoned creatures (system trait text).** A creature called by a spell or effect gains the **summoned** trait; a summoned creature **can't summon other creatures, create things of value, or cast spells that require a cost**; it **has the minion trait**; if it tries to cast a spell of equal or higher rank than the spell that summoned it, its own spell fails and the summoning ends. The **minion** trait: "Your minion acts on your turn in combat, once per turn, when you spend an action to issue it commands … for a minion that's a spell or magic item effect, like a summoned minion, you Sustain the effect … If given no commands, minions use no actions except to defend themselves or to escape obvious harm."
- **Elite and weak adjustments are native.** An NPC's `system.attributes.adjustment` of `"elite"` or `"weak"` is applied by the system's own derived-data code (`isElite`/`isWeak`), so "elite adjustments" is a one-field change on the spawned actor.
- **Placement already exists.** `spawnCreatures(entries, { nearActorId, disposition, place: "beside", extraFlags, … })` creates a token for a compendium reference or a world actor next to a focus token, avoids occupied squares (and squares created earlier in the same call), sets the actor's alliance first because PF2e derives disposition from it, and accepts per-entry token art and size overrides and extra flags.
- **Combatants can be added mid-combat.** The combat is a Foundry `Combat` with embedded combatants created from tokens (`createEmbeddedDocuments("Combatant", …)` in `startCombat`); the module flags combatants it controls with `flags.pf2e-dungeon-crawl.agentControlled`.
- **The turn pipeline is combatant-shaped.** `getPendingAgentTurn(combat)` and `applyAgentDecision(combat, combatantId, candidateId)` work on the combat's current combatant; `initAgentTurnState` starts an AI turn at three actions; per-turn state is stored on the combat.
- **Rewards.** `resolveCombat` computes XP from the **defeated hostile combatants** and converts defeated hostiles to loot actors (#172); summoned creatures must not count toward either.
- **No structured data for objects.** Spirit Blades gives no item statistics in its text; there is no compendium link. Conjured objects therefore need a reviewed item definition.

## Resolved decisions

1. **Summoned creatures follow the PF2e minion rules** (recommended and chosen): a summoned creature acts only when its summoner spends an action to command it, then takes two actions on the summoner's turn; uncommanded it only defends itself.
2. **First slice: direct creature summons, summon-spell abilities, and conjured objects.** Spell-derived mounts (Phantom Mount) are #1069.
3. **PF2e rules are the source of truth for summoned creatures:** the summoned-trait restrictions apply to the summoned creature.

## Design

### The summon record and combat integration

Each summoned creature is a token (and a temporary world actor) with `flags.pf2e-dungeon-crawl.summon`:

```json
{
  "summonerCombatantId": "cb1", "summonerActorUuid": "Actor.abc",
  "itemId": "xyz", "kind": "creature" | "object",
  "createdAtWorldTime": 1840, "expiresAtWorldTime": 2440 | null,
  "persistsUntil": "slain-or-dismissed-or-replaced" | "duration"
}
```

The token is added to the combat as a combatant flagged `agentControlled` and `flags.pf2e-dungeon-crawl.minionOf = summonerCombatantId`, with an initiative just below its summoner so the tracker shows it adjacent. **The minion never takes its own turn**: when the combat reaches a minion combatant the module advances past it automatically. A minion's actions happen only inside a command (below).

### Minion commands

- **A `commandMinion` candidate** (cost 1 action, type `command`) is offered to a summoner that has at least one live minion that has not been commanded this turn, one entry per minion (or one for "all" when the text says the summoner directs all of them, as Spider Minions). Its summary is deterministic ("Command the war horse (2 actions)").
- **Executing it** initializes a **two-action turn state** for the minion's combatant and runs the existing agent decision loop for that combatant (`getPendingAgentTurn`/`applyAgentDecision`) until its actions are spent, with the minion's own candidate set. The summoner then continues its turn with one fewer action. A minion can be commanded at most once per turn.
- **Uncommanded minions** take no actions except a defensive reaction already modeled elsewhere; the module does nothing for them.
- **The summoned-trait restrictions** are enforced when building a minion's candidates: no `npcSummon` entries (it can't summon or create valuables), no spell candidates that require a cost, and no spell candidates of equal or higher rank than the summoning spell (which would end the summon).

### Recognition (`scripts/npc-summon-parse.mjs`, pure)

`parseSummonAbility(item)` returns `null` or `{ shape, cost, frequency, params }` after the usual normalization (strip HTML, keep `@UUID` creature/spell links with their UUIDs, split `Frequency`/`Requirements`); every sentence must be consumed, or the ability is not offered.

1. **`namedCreature`** — "summons a [`@UUID[Compendium…Actor.<name>]` | `<article> <creature name>`] [or `@UUID[…]`] [with elite|weak adjustments] [and the <trait> and <trait> traits]". Params: `choices: [{ pack, id } | { name }]`, `adjustment: "elite" | "weak" | null`, `addTraits[]`, `count` (default 1), `duration`: "remain for N minutes or until reduced to 0 Hit Points" → `{ seconds: N*60 }`; "remains until it is slain, <the summoner> Dismisses it, or <the summoner> Summons <again|another>" → `"untilSlainDismissedReplaced"` with `replacePrevious: true`; `maxAlive`: "any number" → `null`, otherwise 1.
2. **`summonSpell`** — "casts a <ordinal>-rank `@UUID[…Summon (Animal|Fey|Fiend)]` [spell]" with an optional restriction ("can summon only an aquatic creature") and the same duration grammar. Params: `spellSlug`, `rank`, `restriction` (a trait filter from a closed list such as `aquatic`), `duration`. The creature options come from a reviewed `SUMMON_SPELL_TABLE` (data: for each supported summon spell and rank, the creature trait(s) and the maximum creature level, taken from the spell's own heightened text) and a compendium index query.
3. **`conjuredObjects`** — "summons <N> <objects> …" accepted **only** when the ability is a key in a reviewed `CONJURED_ITEM_DEFINITIONS` table that supplies the item statistics the text lacks (Spirit Blades: a spirit-blade weapon, count 6, dispel DC 42, counteract rank 10); without a table entry the ability is not offered.

A reviewed override table (`NPC_SUMMON_OVERRIDES`, ability name plus source, reviewer comment, fixture assertion) supplies complete descriptors for summons the grammar misses. A golden-file coverage audit with a ratchet (the #935 pattern) covers every summon-text ability.

### Vocabulary (`buildNpcSummonVocabulary`)

For each parsed ability, after #934's gates (cost vs actions remaining, `frequency.value`, recharge, requirements):

- **`namedCreature`:** one entry per creature choice (resolved from the compendium index; an unresolvable choice drops that option); skipped when `maxAlive` is reached and the ability does not replace.
- **`summonSpell`:** one entry per legal creature (trait and level filter), capped at 6 and ranked by creature level then by expected tactical value (offense, reach), so the model chooses among the best few.
- **`conjuredObjects`:** one entry.
- A **`dismiss`** candidate (cost 0, type `command`) when the ability text names Dismissing and the summoner has a live summon of that item.
- Entry: `{ type: "npcSummon", shape, itemId, slug, name, cost, creatureRef?, summary }` with a deterministic `summary` ("Summon Steed: a war horse (elite), until slain or dismissed"). The shared per-turn cap on non-strike entries applies.

### Reasoning call and validation

As in #934/#982: `npcSummon` entries are validated by literal membership on `(type, itemId, creatureRef?)`; survivors become candidates `npcSummon:<itemId>[:<creatureRefId>]` appended before the existing `/v1/combat-decision` call. `commandMinion` and `dismiss` candidates use the same validation.

### Execution (`applyAgentDecision`, new `npcSummon` branch)

1. Spend the cost through `turnState`; decrement `system.frequency.value`; record recharge; post the usage message (`item.toMessage()`).
2. **Replace:** if `replacePrevious`, remove the summoner's existing summons of this item first (delete their tokens and actors).
3. **Spawn a creature:** call `spawnCreatures([entry], { nearActorId: summonerActorId, disposition: <the summoner's token disposition>, place: "beside", extraFlags: { summon: record } })`. After creation: set `system.attributes.adjustment` to `elite`/`weak` when required, add the `summoned` trait and any `addTraits` to the actor's traits, set the actor's alliance to the summoner's side, and add the token to the combat as a minion combatant (above). Placement failure (no free square) aborts before spending the action.
4. **Cast a summon spell:** the same spawn path with the chosen creature, the spell's rank-derived level cap already applied by the vocabulary; no spell slot is consumed (the ability's own frequency governs).
5. **Conjure objects:** create the items from the reviewed definition (as items on the summoner, or as a held/floating state recorded on the actor) with a counteract/dispel hook noted in the GM report; the dispel DC and rank come from the definition.
6. Announce publicly ("The dullahan summons a war horse!") and report through #925's result descriptor.

### Lifetime and cleanup

- **Expiry:** at the start of the summoner's turn and at each round change, summons with `expiresAtWorldTime <= game.time.worldTime` are dismissed (token and actor deleted, combatant removed) with a public line. Game-clock durations come from #785.
- **Slain:** a summon reduced to 0 HP is defeated like any creature and then removed from the combat and the scene at the end of the round (no corpse, no loot).
- **Dismissed or replaced:** by the `dismiss` candidate, or by `replacePrevious`.
- **Summoner defeated:** summons of a defeated summoner are dismissed at the same time unless the ability text states otherwise (planning confirms against each ability's text).
- **Combat end:** `resolveCombat` deletes all remaining summoned tokens and their temporary actors before loot conversion.

### Rewards and bookkeeping

Summoned combatants are excluded from the defeated-hostile list used for XP (`totalCombatXp`) and from loot conversion (#172); they do not count toward the "every hostile defeated" victory check while their summoner lives, nor against the party's victory when only summons remain (they are removed when the last non-summoned hostile is defeated).

## Error handling

- Parsing never throws; an unmatched sentence, unresolved creature or an object without a table entry is `null` (not offered).
- A compendium creature that cannot be loaded drops that choice; if all choices drop, the ability is not offered.
- Spawn or combatant-creation failure rolls back: the spawned token and actor are deleted, the action is not spent, and the GM is told.
- A minion that cannot be commanded (token gone) is dropped from the candidate list.
- The expiry sweep and the combat-end cleanup never throw; a failed deletion is logged and reported to the GM.
- Reasoning-service failure → no summon entries that turn; the existing candidate set proceeds.

## Testing

- **Parsers (pure), real-text fixtures:** Spider Minions (two linked creatures, 10 minutes, any number), Summon Steed (named creature, elite, added traits, replace-previous), Summon Aquatic Ally (a rank-2 Summon Animal with the aquatic restriction), Ritual Gate and a conjure with and without a table entry; texts that must return `null` (storms, debris, visions, an unresolved creature).
- **Summon spell table:** each supported spell/rank maps to the expected creature trait and level cap; the restriction filter.
- **Vocabulary builder:** one entry per creature choice, the cap and ranking for summon spells, `maxAlive` and replace behavior, `commandMinion` offered only for uncommanded live minions, `dismiss` only when applicable, requirements and frequency gating.
- **Minion rules:** summoned-trait restrictions remove the right candidates from a minion's list (no summons, no cost spells, no equal-or-higher-rank spells); a minion never takes its own turn; a command runs a two-action turn exactly once per turn.
- **Executors (mocked Foundry):** spawn placement beside the summoner with the right disposition, the elite/weak adjustment and the added traits, combatant creation and flags, rollback on failure, replacement of the previous summon, spell-cast summon, conjured objects from the definition, frequency/recharge recorded, public announcement.
- **Lifetime:** expiry by game-clock duration, removal when slain, dismissal, removal when the summoner is defeated, deletion at combat end; no XP or loot for summoned creatures.
- **Regression:** `spawnCreatures` callers (encounter generation), the combat turn and `resolveCombat` tests, XP and loot tests keep passing.
- **Live verification:** a dullahan summoning a war horse and commanding it, a morrigna with several spiders expiring after 10 minutes of game time, a triton summoning an aquatic ally, and a fight ending with summons still alive (cleaned up, no XP).

## Explicitly out of scope

- Spell-derived mounts and companions with stat-copy rules (Phantom Mount) — #1069.
- Player-controlled summoners and summon spells cast by characters.
- Sight-sharing, riding and mount movement rules.
- Reactions that react to summoned creatures, and corpse interactions (#982) with summoned creatures.
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the reviewed `SUMMON_SPELL_TABLE` and `CONJURED_ITEM_DEFINITIONS` contents, how the turn driver skips minion combatants, the exact summoner-defeated behavior per ability text, and how a conjured item is represented for an NPC actor.
