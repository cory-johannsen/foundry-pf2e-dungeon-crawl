# Advanced AI Actors: Other-Triggered NPC Reactions (Attack Counters, Proximity, Grab, Damage/Hit)

**Issue:** #961 — the NPC reaction triggers that do not fit #931's, #959's or #960's families (approach, ally events, grabs, being hit or damaged, attack-triggered counters), including Tail Lash, Avenging Bite, Archon's Protection, Icy Deflection, Deflecting Lie, Vengeful Spite and Trip Up noted on the issue.

**Builds on:** #931 / `docs/superpowers/specs/2026-10-08-ai-npc-reactions-design.md` (the reaction registry, `resolveReactions`, shared gates, the hybrid decision, the reaction-used economy, the GM-confirm vs automatic rule), #959 / `docs/superpowers/specs/2026-10-09-ai-npc-death-reactions-design.md` and #960 / `docs/superpowers/specs/2026-10-09-ai-npc-save-spell-reactions-design.md` (trigger kinds and the seam-plus-fallback pattern), #933 (Strike-plus shapes, grab-state tracking), #915 / #935 (save and outcome grammars, timed conditions and penalties, coverage ratchet) and #947's recognition approach (shapes plus a reviewed override table).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#931 modeled reactions triggered by movement and by being targeted for a defensive bonus; #959 modeled dropping to 0 HP; #960 modeled saving throws and conditions. What remains of the 734 NPC reaction actions is a spread of trigger shapes with bespoke effects. This spec classifies the trigger vocabulary and models four families on #931's registry: **attack-triggered counters**, **proximity triggers**, **grab and swallow reactions**, and **damage-taken / hit-reactive reactions**.

Recognition is **data-driven**: a closed grammar of trigger phrasings produces a trigger kind plus its parameters, and the effect text is accepted only if it fits an effect shape already specified elsewhere (a Strike with a named limb, a Strike with an on-hit effect, a save with outcomes, a simple defensive effect); a **reviewed override table** covers high-use exceptions. A reaction whose trigger or effect falls outside that is not offered (all-or-nothing). Round- and initiative-timing reactions (#1026) and reactions that invoke other abilities or move the reactor (#1027) are filed as follow-ups.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3; 734 NPC reaction actions across 625 NPCs).

- **What #931/#959/#960 take.** #931: movement-triggered attacks (Reactive Strike/Attack of Opportunity and variants, Twisting Tail, Wing Rebuff) and defensive reactions to being targeted (Shield Block, Wing Deflection, Ghost Dodge, Swat Projectile). #959: the reactor reduced to 0 HP. #960: the reactor's own or others' saving throws and incoming conditions. #1019: another creature's death.
- **What remains in this issue's four families** (counted by trigger shape over reaction items with an explicit trigger): **damage-taken / hit-reactive 78**, **attack-triggered counters 43**, **proximity 17**, **grab 15** — about 150 reaction items. A further ~150 "other" and ~14 no-trigger items are the long tail (#1026, #1027, and bespoke one-offs).
- **Trigger phrasings** (examples from the data), each reducible to a closed set of templates:
  - *Ally attacked:* "a creature within reach of the witchwarg's jaws attacks one of the witchwarg's allies" (Avenging Bite, Avenging Claws).
  - *Attack in reach:* "a creature within reach of the river drake's tail uses an action to Strike or attempt a skill check" (Tail Lash); "a creature adjacent to the dragon turtle targets it with a melee attack" (Shell Block); "a creature critically fails a melee attack to hit the gimmerling or moves into a space within its aura" (Trip Up).
  - *Enemy damages ally:* "an enemy damages the archon's ally and both are within 15 feet of the archon" (Archon's Protection).
  - *Proximity:* "a creature approaches within 10 feet of the poltergeist" (Telekinetic Defense); "a creature ends its turn adjacent to the medusa" (Biting Snakes); "a creature ends its movement adjacent to the viper or within the viper's space" (Slink); "a creature within 30 feet that the basilisk can see starts its turn" (Petrifying Glance, Draining Glance).
  - *Grab:* "the worm grabs a creature" (Fast Swallow); "a creature Grabbed by the wyvern …" (Savage); "the mantis grabs a creature with its leg" (Deadly Mandibles).
  - *Hit/damaged:* "the dragon is hit or critically hit by an attack made by a creature the dragon can see" (Retract Body), "is critically hit with a melee attack" (Hell's Sting), "takes damage from a creature 20 feet or further away" (Vengeful Throw), "takes damage from any source" (Retaliating Strike).
- **Effect shapes among those ~150** (first-pass classification): a Strike with a named limb or object (14), a save the triggering creature or target attempts with outcomes (39), a defensive effect — AC/resistance/temporary HP (33), and other (the rest, which includes "uses Swallow Whole", Strides/Burrows, counteract, knock-prone follow-ups). So the existing shapes plausibly cover roughly half of these families; the data-driven audit (below) measures it exactly.
- **Events the module can already observe.** Attack rolls and damage rolls arrive as `createChatMessage` (`attack-roll`, `damage-roll`, with origin, target and options); the module applies damage itself at `applyDefeatIfReducedToZero`'s call sites and in `handleManualStrikeDamage`; movement events come from #931's emitters; turn start/end come from the combat turn hook and the system's `pf2e.endTurn`; grabs are recorded by #933's `recordGrab`.
- **The registry already enforces the shared gates** (agent-controlled, observed the trigger's creature, reaction unused this round, line of sight where relevant) and the GM-confirm vs automatic rule for flows the module does not own.

## Resolved decisions

1. **All four families are in the first slice:** attack-triggered counters, proximity triggers, grab and swallow reactions, and damage-taken / hit-reactive reactions.
2. **Recognition: a closed trigger grammar × reused effect shapes, plus a reviewed override table** (#947's approach). Everything else is not offered.
3. **Round/initiative timing (#1026) and "uses another ability / moves the reactor" (#1027) are follow-ups.**

## Design

### Trigger grammar (`scripts/npc-reaction-triggers.mjs`, pure)

`parseReactionTrigger(item)` reads the `Trigger` block (and `Requirements`) and returns `null` or `{ kind, params }`. Normalization follows #915/#933 (strip HTML, resolve `@UUID` condition links to names). The closed set of kinds:

| Kind | Phrase pattern | Params | Event source |
|---|---|---|---|
| `allyAttacked` | "a creature [within reach of <limb>] attacks one of the reactor's allies" | `limb?`, `rangeFeet?` | `attack-roll` message whose target is an ally of the reactor |
| `attackedInReach` | "a creature within reach of <limb> uses an action to Strike [or attempt a skill check]" / "a creature adjacent to <reactor> targets it with a melee attack" | `limb?`, `melee: boolean` | `attack-roll` message by a creature within reach (targeting anyone, or the reactor) |
| `enemyDamagesAlly` | "an enemy damages <reactor>'s ally and both are within N feet" | `rangeFeet` | `damage-roll` message / module damage seam against an ally |
| `proximityApproach` | "a creature approaches within N feet" | `rangeFeet` | #931's `moveInReach` generalized with a distance threshold |
| `proximityEndTurn` | "a creature ends its turn | its movement adjacent to <reactor>" | `adjacent: true` | combat turn-end hook / movement end |
| `proximityStartTurn` | "a creature within N feet that <reactor> can see|perceive starts its turn" | `rangeFeet`, `senses` | combat turn-start hook |
| `reactorGrabs` | "<reactor> grabs a creature [with <limb>]" / "a creature Grabbed by <reactor> …" | `limb?` | #933's grab recording |
| `reactorHit` | "<reactor> is [critically] hit [with a melee attack | by an attack made by a creature <reactor> can see]" | `crit?`, `melee?`, `seen?` | `attack-roll`/`damage-roll` messages and the module's damage seam |
| `reactorDamaged` | "<reactor> takes [type] damage [from a hostile source | from a creature N feet or further away | from any source]" | `damageTypes?`, `minDistanceFeet?`, `hostileOnly?` | the module damage seam and `updateActor` HP changes |

Anything the grammar does not consume is `null`. The reactor's own limbs (`<limb>`) are resolved to a ready strike with the existing `matchMultiStrikeActionSlug`.

### Effect shapes (reused)

After the trigger parses, `parseReactionEffect(item, trigger)` accepts the `Effect` block only if every sentence fits one of these:

1. **`counterStrike`** — "makes a <limb> Strike [against the triggering creature | an adjacent target]" with an optional penalty ("with a –2 penalty") and an optional on-hit rider drawn from #933's shapes (knocked prone, a stated condition with duration, "the creature takes a –N circumstance penalty to the triggering roll" as a retroactive adjustment like #931's).
2. **`saveEffect`** — "the target must attempt a <save> save" with outcomes parsed by #935's block/inline grammars (conditions, penalties, immunity), applied through #915's executor and timed helpers.
3. **`defensive`** — "gains a +N circumstance bonus to AC", "gains resistance N to all damage against the triggering damage", "gains N temporary Hit Points", applied through #931's `acBonus` and `damageReduction` kinds (retroactive adjustment for system-driven attacks, seam for module-owned ones).
4. **`counterStrikePlusDefensive`** — a combination of 1 and 3 in one effect (Archon's Protection: the ally gains resistance 20 and the archon Strikes the enemy).

An effect that invokes another ability ("uses Swallow Whole"), moves or transforms the reactor, counteracts, or has any unconsumed sentence makes the reaction `null` (#1027 and the long tail).

### The override table (`scripts/npc-reaction-overrides.mjs`)

Keyed by reaction name plus source, a complete hand-written descriptor (`trigger`, `effect`) for high-use reactions the grammar misreads or misses. Each entry has a reviewer comment and a fixture assertion that it matches the item's text; an override replaces the parsed result.

### Registry integration

Parsed reactions are turned into #931 registry definitions at vocabulary-build time by `deriveReactionDef(item)` (not hand-written one by one): `trigger` kind, `kind` (`strike` | `acBonus` | `damageReduction` | `saveEffect`), `priority` from the shared table (counter-strikes before defensive), shared gates plus the kind-specific eligibility (limb ready and in reach, the triggering creature observed and in range), and a deterministic default policy (counter-strikes: always when legal; defensive: the #931 policies; save effects: always). Several eligible definitions for the same trigger use #931's hybrid decision. Economy, GM-confirm vs automatic and announcements are unchanged from #931.

### New event emitters

- `reactorHit` / `reactorDamaged`: emitted from the module's damage seams (and the `updateActor` HP-change fallback from #959's pattern) with `{ target, attacker, damage, types, hit, crit, melee, distanceFeet }`.
- `proximityStartTurn` / `proximityEndTurn`: emitted from the existing combat turn hook (turn start) and the system's `pf2e.endTurn` hook; adjacency and distance are computed with the existing token geometry helpers.
- `allyAttacked` / `attackedInReach` / `enemyDamagesAlly`: emitted from the `attack-roll` and `damage-roll` chat-message handlers #931 already registers.
- `reactorGrabs`: emitted from #933's `recordGrab`.

Every emitter feeds one `resolveReactions(combat, event)` entry point; a failing emitter never breaks the pipeline it hooks.

## Error handling

- A parse failure is `null` (not offered); parsing never throws into the turn.
- Emitters log failures and never block the chat message, damage application or turn change they observe.
- A reaction whose reactor, trigger creature or limb data is missing at fire time is skipped.
- If the reaction-used flag cannot be written the reaction is skipped (never executed unrecorded).
- Retroactive adjustments follow #931's rules (an unreliable message edit falls back to a visible note).

## Testing

- **Trigger grammar (pure), real-text fixtures:** each kind with representative texts above; near-misses that must return `null` (timing triggers, death/save/spell triggers handled elsewhere, unrecognized phrasings).
- **Effect shapes:** a counter-Strike with and without a penalty/rider, a save effect with outcomes, a defensive effect, the combined Archon's-Protection form, and effects that must return `null` ("uses Swallow Whole", a Burrow/Stride, a counteract).
- **Coverage audit with ratchet (#935's pattern):** a golden file over every reaction item in the four families with `{ creature, reaction, trigger kind | notOffered, effect shape | notOffered, reason }` and a monotonic count test; a coverage drop or a silent change of meaning fails CI.
- **Override table:** each entry matches its fixture and takes precedence.
- **Emitters (mocked Foundry):** the right event for each source (attack/damage messages, the damage seam, turn hooks, grab recording), distance and adjacency filters, one event per cause.
- **Registry derivation and decision:** `deriveReactionDef` output for each shape, shared gates, economy, hybrid decision with the service mocked.
- **Regression:** #202/#931/#959/#960 reaction tests keep passing.
- **Live verification:** a warg pack (Avenging Bite), a river drake (Tail Lash), a medusa or viper (proximity), a worm (grab reaction) and a Retract Body/Resilient Form dragon being hit, in a human-GM run and a GM-less run.

## Explicitly out of scope

- Round- and initiative-timing reactions (Warning Howl, All This Has Happened Before, Spring upon Prey, Rise Up) — #1026.
- Reactions that invoke other abilities or move/transform the reactor (Fast Swallow → Swallow Whole, Slink, Crumble, Overwhelming Light) — #1027.
- Death, save and spell triggers (#959, #960, #1019, #1021, #1022) and movement/defensive triggers already in #931.
- AI-controlled party characters' reactions — #962; intercepting player attacks before they resolve — #963.
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the exact trigger grammar finalized against the fixture, the initial override list, how adjacency/distance are measured for proximity triggers at turn boundaries, and the per-event dedupe so one cause cannot fire the same reaction twice.
