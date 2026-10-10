# Advanced AI NPCs: Prose Long Tail (Fires, Light Sources, Movable Auras and Other One-Offs)

**Issue:** #1078 — sense, communication, fire and other one-off prose NPC abilities, deferred from #984.

**Builds on:** #984 / `docs/superpowers/specs/2026-10-09-ai-npc-prose-abilities-design.md` (the reviewed declarative table `data/npc-prose-abilities.json`, closed primitive steps, toggles, zones at runtime, fixture hashes, golden-file audit), #1021 / `docs/superpowers/specs/2026-10-09-ai-npc-spell-counteract-reactions-design.md` (`rollCounteract`), #1077 (form-state flags), #914, #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

This is the long tail of prose-only NPC abilities left after #984: sense and communication abilities, fire and light-source interactions, stowing and item handling, and one-offs. Many need concepts the module does not model. The approach is a **frequency-ranked audit** that adds table entries or primitives only where an automatic model is feasible, plus two new concept primitives chosen by the owner: a **fire-source registry** (Drench) and a **movable aura source** (Direct Halo). Sense and communication abilities are filed as #1194.

## Investigation findings

- **Drench** (water mephit and five others; 1 action): "puts out all fires in a 5-foot emanation". The real text of related abilities also counteracts magical fires; the module has no notion of a fire (torches, braziers, burning terrain, fire hazards, spell-created fires).
- **Direct Halo** (empyreal dragons; six stat blocks; 1 action): tosses the dragon's halo to a square within 90 feet; while deployed the dragon loses its inspiring-presence aura, which instead emanates from the halo with the same radius; the dragon can Sustain to recall the halo from any distance; the halo is pure light, occupies no space and can't be targeted or destroyed.
- **The remainder** (#984's count): about 10 sense/communication abilities, ~24 concealment/light/illusion abilities (partly covered by #984's toggles), plus stowing/item-handling and singletons. Many rely on repeated names across creatures (Drench 6, Direct Halo 6), which makes ranking by shared name and encounter frequency worthwhile.
- **Existing machinery.** #984's table, primitives, toggles and zones; #1021's counteract helper; the module's aura handling for passive auras (Aura items/effects already exist for creatures with auras, e.g. Erosion Aura, inspiring presence); light-source handling in generated scenes is limited to the scene lighting and tokens' light settings.

## Resolved decisions

1. **Approach:** a frequency-ranked audit; entries and primitives only where an automatic model is feasible; unmodeled concepts stay out with reasons in the golden file.
2. **Primitives to add:** a **fire-source registry** and a **movable aura source**. Sense/communication abilities are #1194.

## Design

### Fire-source registry (`scripts/fire-sources.mjs`)

A scene-scoped registry of fire/light sources with a stable shape:

```js
{ id, kind: "torch" | "brazier" | "campfire" | "burningTerrain" | "spellFire" | "hazard", sceneId, position, tokenId?, tileId?, magical: boolean, spellRank?: number, casterDc?: number, lit: boolean }
```

- **Population:** sources are discovered from (a) tokens or tiles tagged `flags.pf2e-dungeon-crawl.fireSource` by the encounter/room generators when they place torches, braziers or fire hazards, (b) light-emitting tokens whose light color/animation marks them as fire (a reviewed config), and (c) spell effects/templates with the `fire` trait created in combat (registered by the spell executors when they create a persistent fire/area).
- **Query:** `fireSourcesInEmanation(center, feet)` (pure over snapshots).
- **Extinguish:** `extinguish(source)` sets `lit = false`, turns off the token/tile light, removes any fire-trait template/effect, and announces.

### Drench (`extinguishFires`)

A table entry: area = 5-foot emanation around the actor; for each fire source in it: a non-magical source is extinguished automatically; a magical source (a spell fire) is subject to a counteract check by the creature using its stated counteract modifier and rank if the item gives one (#1021's `rollCounteract`), else the ability extinguishes only non-magical fires (the text says "all fires"; the module uses the item's stated modifier if any, and otherwise treats magical fires as extinguished only on a counteract with the creature's spell DC, rank 1). No fire in the area → the ability is not offered. It affects fire sources only, not creatures' ongoing fire damage.

### Movable aura source (`aura-source.mjs`)

- **Concept:** an *aura emanation* whose center is a source other than the bearer. Aura-bearing creatures already have an Aura effect/item with an emanation radius; this adds an optional `auraSource: { type: "token"|"point", id|x,y }` that the aura membership helper (#915) uses as the center instead of the bearer's token.
- **Direct Halo:** a table entry `deployAuraSource`: choose a square within 90 ft (the planner picks the square that maximizes allies in the aura radius minus enemies, as #981 does for placements); set `auraSource` to that point, mark the bearer's own aura inactive ("loses their inspiring presence aura") by flagging it `displaced`, and create a marker (a light tile/token with no collision, not targetable) at the point. The ability records `flags…haloDeployed`.
- **Recall:** a Sustain-type free/1-action entry `recallAuraSource` offered while deployed; it clears the point, restores the bearer-centered aura and removes the marker. Sustain follows the turn: if the dragon doesn't Sustain on its turn, the halo remains (RAW: the dragon can Sustain to recall; no duration) and is also cleared at combat end or when the dragon is defeated.
- **Effects that use the aura** (e.g. Halo Pulse from #1057, "inspiring presence") consult `auraCenter(bearer)` instead of the bearer's token position, so they follow the halo.

### Audit and growth (`tools/audit-prose-long-tail.mjs`)

Reads #984's golden file, takes the `notOffered` rows, and ranks them by `creaturesSharingName × encounterFrequency`. For each it classifies the concept: `fire/light` (served by the new registry), `aura-source`, `sense/communication` (#1194), `item-handling`, `unmodeled`. Rows served by a primitive in #984 or this spec become table entries (fixture-hashed, reviewed); the rest stay listed with reasons. The monotonic ratchet in #984's golden file is extended.

### Reporting and vocabulary

Entries are `npcSelf` candidates with deterministic summaries ("extinguish 2 fires within 5 ft"; "toss the halo 60 ft away: 3 allies in the aura, 0 enemies"). Results report through #925.

## Error handling

- Source registry empty/unknown fire kinds: Drench is not offered rather than guessing.
- Aura center point blocked or off-scene: the nearest legal point is used; none → not offered.
- The halo marker is removed on scene change or combat end; a dangling `displaced` flag is cleared at the dragon's next turn start.
- Counteract failures are reported and leave the fire lit.

## Testing

- **Registry:** population from tags and spell registration, emanation queries, extinguish effects, magical vs non-magical handling.
- **Drench:** extinguishes tagged sources in 5 ft only; magical sources need a counteract; no-op not offered.
- **Aura source:** membership from a point source, displaced bearer aura, recall restores, defeat/combat end cleanup, interaction with Halo Pulse (#1057).
- **Audit:** classification fixture and ratchet; entries match fixture hashes.
- **Live verification:** a water mephit puts out a brazier; an empyreal dragon throws its halo across the room and allies in the new radius benefit.

## Explicitly out of scope

- Sense and communication abilities — #1194.
- Social contracts and similar narrative abilities (stay unmodeled).
- General dynamic lighting simulation.

## Open questions

None. Planning-time details: the reviewed fire-light configuration, the magical-fire counteract defaults and how tiles/tokens are tagged by the generators.
