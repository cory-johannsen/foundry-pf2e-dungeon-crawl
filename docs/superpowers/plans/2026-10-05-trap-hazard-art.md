# Trap Hazard Art Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate dedicated token art for every trap-tagged hazard in `pf2e.hazards` and wire it into trap placement, so a spawned trap hazard shows real art instead of the system's generic `hazard.svg` icon — the same per-entry art mechanism combat creatures already get for free.

**Architecture:** This is the exact same pipeline ITEM-18/#229 already use for 5,904 bestiary creatures — `tools/generate-token-art.mjs`'s content-addressed `ALL` manifest (ComfyUI/OpenRouter/Gemini generation, per-entry hand-authored prompts) feeding `data/creature-art.json` (looked up by `{pack, docId}`), rendered via `scripts/creature-art.mjs`'s `findCreatureArt`/`creatureArtPath`. Nothing new is built: a new sibling manifest file holds the 24 trap entries (keeping `generate-token-art.mjs`'s already-11,500-line file from growing further), `data/creature-art.json` gains 24 real entries, and `scripts/dungeon-scene.mjs`'s `populateSlotTrap` gains the one `imgFallback` line combat rooms already have via `encounter-generator.mjs`'s `withArt`.

**Tech Stack:** Vanilla ES modules, Vitest, ComfyUI (local image generation), ajv schema validation.

**Spec:** None — bounded addition reusing an existing, established pipeline end-to-end. This plan implements GitHub issue #759 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). This adds real new content/assets: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- Scope is the 24 trap-tagged `pf2e.hazards` entries that exist **today** (confirmed live, 2026-10-05) — not blocked on #756 (trap library expansion, still open/unclaimed). Exactly like every prior #229-style art batch (#252, #241, ...), a future library expansion gets its own follow-up batch through this same pipeline; it does not block this one.
- `data/creature-art.json` entries must validate against `data/schema/creature-art.schema.json`: `id` matches `^[a-z][a-z0-9_]*$`, `pack` matches `^pf2e\.[a-z0-9-]+$`, `art` matches `^[a-z][a-z0-9-]*/[a-z0-9][a-z0-9-]*\.webp$`.
- Art files follow the established per-source-folder convention (#628): `assets/creature-art/hazards/<slug>.webp`, id prefixed `hazards__`.
- Every new prompt follows `generate-token-art.mjs`'s own documented "Prompt-authoring checklist" (lines 459-493): grounded in the real bestiary text (done below, fetched live), no creature-comparison metaphors, no "ring"-like circular-frame associations, explicit isolation framing for a standalone object, `shapeless: true` (a trap mechanism has no head for a bust portrait, same reasoning as `clockwork-spy`/`animated-broom`).
- No changes to `scripts/trap-mechanics.mjs`, `scripts/trap-combat.mjs`, or the detect/disable/trigger/reveal engine (#753's territory) — this plan only supplies art for the token that engine already spawns and reveals.

## Review Focus

- **A trap's generated art must actually reach the spawned token**, not just sit unused in `data/creature-art.json` — the wiring in Task 3 is what makes this real, verified live in Task 4 rather than assumed from the data file existing.
- **A hazard with no matching art entry must not crash trap placement** — `findCreatureArt` already returns `null` for a miss (existing behavior, unchanged), and `spawnCreatures`'s existing `img ?? entry.img` fallback chain already tolerates a `null`/`undefined` `imgFallback`; Task 3's own test must cover the "no art for this pack/id" case explicitly, not just the happy path.
- **Every one of the 24 prompts must stay a self-contained object/mechanism, never implying a floor, wall, or room around it** — `SHAPELESS_STYLE`/`SHAPELESS_NEGATIVE` actively fight scenery (no ground, no backdrop), so a prompt that describes "a pit in the floor" rather than "the trapdoor hatch itself" will fight its own style block exactly the way `bloodseeker`'s water-reflection regression did (see `generate-token-art.mjs` lines 310-317). Each entry below is written to describe only the isolable object, not its surroundings.
- **Regenerating/reviewing 24 real images is real, fallible creative work**, not a mechanical step — `npm run tokens:check` only catches bright/pale backgrounds (confirmed by the file's own documented lesson 6); every image still needs an eye check against the per-entry "defining features" the prompt asked for, same discipline as every prior ITEM-18/#229 batch.
- **The trap's player-facing flavor text already comes from the hazard actor's own name/description** (confirmed this session for #754) — this plan changes only the token's visual `img`, never its name/description/mechanics, so no interaction with `ensureTrapState`/`trapCustomization` is needed or expected.

---

### Task 1: New trap-art prompt manifest, merged into the generator

**Files:**
- Create: `tools/trap-art-prompts.mjs`
- Modify: `tools/generate-token-art.mjs` (new import, splice into `ALL`)

**Interfaces:**
- Produces: `export const TRAP_ART` — an array of `{id, file, dir, shapeless, prompt, avoid}` objects, in the exact same shape `MONSTER_ART` entries already use. Consumed by Task 1's own edit to `ALL`, and by Task 4's live generation run.

- [ ] **Step 1: Create `tools/trap-art-prompts.mjs`**

```js
/**
 * Token art for #759: every trap-tagged hazard in `pf2e.hazards` (24,
 * confirmed live 2026-10-05 -- none has any token art today, every one
 * still shows the system's default hazard.svg icon). Kept in its own file
 * rather than appended to generate-token-art.mjs's own already-11,500-line
 * `MONSTER_ART` array.
 *
 * Every prompt describes only the isolable mechanism/object itself, never
 * its surrounding floor/wall/room -- `SHAPELESS_STYLE`/`SHAPELESS_NEGATIVE`
 * actively exclude ground/floor/backdrop, so a prompt that leans on "a pit
 * in the floor" rather than "the trapdoor hatch" fights its own style
 * block (see generate-token-art.mjs's own documented bloodseeker lesson).
 * All descriptions are grounded in each hazard's real `pf2e.hazards` text,
 * fetched live via foundry-rest rather than guessed.
 */
export const TRAP_ART = [
  { id: 'fireball-rune', file: 'fireball-rune', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single glowing fire-red magical rune, an angular arcane sigil etched in flickering '
      + 'orange-gold light, wisps of flame and heat shimmer curling off its lines, hovering alone '
      + 'in the dark, nothing else in the frame',
    avoid: 'campfire, bonfire, explosion, fireball projectile, hands casting, person, wand, staff' },
  { id: 'electric-latch-rune', file: 'electric-latch-rune', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single small arcane rune crackling with bright blue-white electricity, jagged '
      + 'lightning arcs branching off its glowing lines, faint sparks drifting outward, hovering '
      + 'alone in the dark, nothing else in the frame',
    avoid: 'door, latch, handle, lock, hands, person, storm clouds, sky' },
  { id: 'slamming-door', file: 'slamming-door', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A massive rectangular slab of rough grey stone, thick and heavy, angled as if caught '
      + 'mid-drop, chipped edges and old chisel marks across its surface, suspended alone in the '
      + 'dark, nothing else in the frame',
    avoid: 'ceiling, hallway, corridor, walls, floor, person, doorway, crushing a figure' },
  { id: 'scythe-blades', file: 'scythe-blades', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A pair of long curved scythe blades, dark pitted steel with a wicked honed edge, '
      + 'crossing past one another mid-swing, a taut thin wire trailing from their mounting '
      + 'bracket, suspended alone in the dark, nothing else in the frame',
    avoid: 'ceiling, groove, track, person, blood, scenery' },
  { id: 'telekinetic-swarm-trap', file: 'telekinetic-swarm-trap', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A swirling cyclone of debris, broken wood splinters, stone chips, and rusted metal '
      + 'shards caught in a violent spinning telekinetic vortex, faint violet arcane energy '
      + 'threading through the wreckage, suspended alone in the dark, nothing else in the frame',
    avoid: 'room, furniture intact, person, decorations shown clearly, tornado weather, sky' },
  { id: 'hidden-pit', file: 'hidden-pit', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A square wooden trapdoor hatch, weathered grey planks bound with rusted iron straps, '
      + 'one recessed iron pull-latch, hinges on one edge, angled open as if swinging down into '
      + 'darkness below, suspended alone in the dark, nothing else in the frame',
    avoid: 'pit, hole, floor, ground, person falling, room, ring' },
  { id: 'wheel-of-misery', file: 'wheel-of-misery', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'An ornate wooden wheel, divided into six wedge segments each inked with a different '
      + 'glowing colored rune, a heavy iron hub at its center, ancient weathered wood with '
      + 'tarnished brass fittings, suspended alone in the dark, nothing else in the frame',
    avoid: 'wall, mounted, steering wheel, ship wheel, person, clock, frame, halo' },
  { id: 'polymorph-trap', file: 'polymorph-trap', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single glowing green druidic glyph, organic vine-like linework twisting into a '
      + 'sigil, faint leaves and small animal silhouettes dissolving into its glow, hovering '
      + 'alone in the dark, nothing else in the frame',
    avoid: 'person transforming, hands, full animal body, forest, trees, ground' },
  { id: 'spinning-blade-pillar', file: 'spinning-blade-pillar', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A tall iron pole fitted with three long curved blades radiating outward near its '
      + 'top, honed steel edges catching a faint light, blurred with motion as if spinning '
      + 'rapidly, suspended alone in the dark, nothing else in the frame',
    avoid: 'floor, tiles, control panel, person, ceiling fan, propeller aircraft' },
  { id: 'vorpal-executioner', file: 'vorpal-executioner', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A massive circular saw blade, rows of vicious serrated steel teeth, dark '
      + 'oil-streaked metal, angled as if slicing sideways through the air, trailing a faint arc '
      + 'of motion, suspended alone in the dark, nothing else in the frame',
    avoid: 'room, track, groove, person, decapitation shown, blood, head, ring, halo' },
  { id: 'steam-vents', file: 'steam-vents', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A cluster of corroded brass and iron pipes with a wide nozzle, a violent jet of '
      + 'billowing white steam blasting outward from its opening, rivets and valve wheels along '
      + 'its surface, suspended alone in the dark, nothing else in the frame',
    avoid: 'wall, trip wire visible, person, kettle, factory, machine room' },
  { id: 'drowning-pit', file: 'drowning-pit', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A carved stone spout shaped like a snarling beast’s open mouth, water gushing '
      + 'forcefully from within, slick wet stone pitted with age, suspended alone in the dark, '
      + 'nothing else in the frame',
    avoid: 'wall, pit, person drowning, fountain, garden, waterfall scenery, pool' },
  { id: 'web-lurker-noose', file: 'web-lurker-noose', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A dense tangle of pale sticky spider silk strands woven into a loose snare shape, '
      + 'faint strands trailing off into the dark, a few strands glistening wet, suspended alone '
      + 'in the dark, nothing else in the frame',
    avoid: 'spider, person, neck, throat, forest, web across a doorway, rope noose, gallows, hanging' },
  { id: 'poisoned-dart-gallery', file: 'poisoned-dart-gallery', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A cluster of small iron darts, slender grooved shafts tipped with a dull green '
      + 'poisoned sheen, fletched with dark feathers, angled as if frozen mid-flight, suspended '
      + 'alone in the dark, nothing else in the frame',
    avoid: 'hallway, wall holes, control panel, person, target board, dartboard' },
  { id: 'pharaohs-ward', file: 'pharaohs-ward', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single glowing golden hieroglyphic curse sigil, angular ancient symbols etched in '
      + 'light, faint sand and dust drifting off its edges, hovering alone in the dark, nothing '
      + 'else in the frame',
    avoid: 'mummy, sarcophagus, pyramid, doorway, threshold, person, desert scenery, sand dunes' },
  { id: 'insistent-privacy-fence', file: 'insistent-privacy-fence', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A short stretch of wrought iron fence, pointed finials along its top rail, crackling '
      + 'arcs of blue-white electricity dancing across its bars, suspended alone in the dark, '
      + 'nothing else in the frame',
    avoid: 'garden, yard, house, person, lightning storm, sky, fence stretching into distance, ground' },
  { id: 'summoning-rune', file: 'summoning-rune', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single large glowing violet summoning sigil, layered bands of angular arcane '
      + 'script radiating outward from its center, faint motes of magical light drifting just '
      + 'above its surface, hovering alone in the dark, nothing else in the frame',
    avoid: 'creature emerging, demon, monster, person, floor, ground, pentagram cliche, candles, ritual' },
  { id: 'lava-flume-tube', file: 'lava-flume-tube', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A heavy stone sluice gate, a rough iron grille raised to release a thick stream of '
      + 'molten orange-red lava pouring through the gap, glowing heat radiating off the rock, '
      + 'suspended alone in the dark, nothing else in the frame',
    avoid: 'room, chamber, floor, person, volcano landscape, lava field scenery' },
  { id: 'hammer-of-forbiddance', file: 'hammer-of-forbiddance', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A massive stone war-hammer head bound to a thick iron chain, weathered granite '
      + 'block scarred with old impact marks, swinging as if caught mid-arc, suspended alone in '
      + 'the dark, nothing else in the frame',
    avoid: 'entrance, edifice, doorway, person, ceiling, temple scenery' },
  { id: 'hallucination-powder-trap', file: 'hallucination-powder-trap', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A small brass cylinder canister, a cracked seam along one side leaking a swirling '
      + 'cloud of shimmering violet-pink powder, faint sparks from a tiny fuse mechanism, '
      + 'suspended alone in the dark, nothing else in the frame',
    avoid: 'doorknob, latch, door, person, smoke bomb grenade, explosion fireball' },
  { id: 'poisoned-lock', file: 'poisoned-lock', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single slender iron spine, a dull green poisoned sheen along its point, mounted '
      + 'on a small coiled spring mechanism, suspended alone in the dark, nothing else in the frame',
    avoid: 'lock, keyhole, key, door, person, hand, finger' },
  { id: 'spear-launcher', file: 'spear-launcher', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single iron-tipped wooden spear, a honed leaf-shaped head, angled as if launched '
      + 'mid-flight with a faint motion blur along its shaft, suspended alone in the dark, '
      + 'nothing else in the frame',
    avoid: 'wall, socket, floor, tile, person, target, javelin competition' },
  { id: 'bottomless-pit', file: 'bottomless-pit', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A square iron trapdoor hatch, dark riveted plates with a heavy recessed pull-latch, '
      + 'one edge hinged open as if swinging down into an endless black void beneath, faint cold '
      + 'mist curling from the opening, suspended alone in the dark, nothing else in the frame',
    avoid: 'pit, hole, floor, ground, person falling, room, ring' },
  { id: 'planar-rift', file: 'planar-rift', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A jagged tear in reality, crackling violet-blue energy along its torn edges, '
      + 'impossible shifting colors and faint alien light glimpsed through the opening, hovering '
      + 'alone in the dark, nothing else in the frame',
    avoid: 'portal frame, doorway, person, planet, galaxy, stars, wormhole tunnel effect' },
];
```

- [ ] **Step 2: Splice `TRAP_ART` into `generate-token-art.mjs`'s `ALL`**

Add the import near the top of `tools/generate-token-art.mjs`, alongside its other local imports:

```js
import { TRAP_ART } from './trap-art-prompts.mjs';
```

Change the `ALL` definition (currently):

```js
const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES.map((c) => ({ ...c, file: c.file })),
  ...MONSTER_ART,
  ...ICONS
];
```

to:

```js
const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES.map((c) => ({ ...c, file: c.file })),
  ...MONSTER_ART,
  ...TRAP_ART,
  ...ICONS
];
```

- [ ] **Step 3: Confirm the whole repo still runs clean**

Run: `npx vitest run`
Expected: PASS — `generate-token-art.mjs` has no existing unit-test coverage (confirmed: no test file in `tests/` references it or `MONSTER_ART`), so this step is a regression check on the rest of the suite, not new coverage for this file.

- [ ] **Step 4: Commit**

```bash
git add tools/trap-art-prompts.mjs tools/generate-token-art.mjs
git commit -m "feat(#759): add trap hazard art prompts to the token art generator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Register the 24 hazards in `data/creature-art.json`

**Files:**
- Modify: `data/creature-art.json`

**Interfaces:**
- Consumes: the real `{pack, docId, name, level}` for every trap-tagged `pf2e.hazards` entry, already fetched live (2026-10-05) — see the table below. The `art` path must match Task 1's `dir`/`file` choices (`hazards/<slug>.webp`) exactly.
- Produces: 24 new entries in `data/creature-art.json`, each keyed `{pack: "pf2e.hazards", docId}`, consumed by Task 3's `findCreatureArt({pack, id})` lookup.

No test file: `data/creature-art.json` already has `npm run validate:creature-art` (ajv schema) as its one standing check, exercised in Step 2 below — adding a Vitest test around a plain data file this module already schema-validates on every run would duplicate that check, not add coverage.

- [ ] **Step 1: Append the 24 entries**

Open `data/creature-art.json`. It is a flat JSON array; insert these 24 objects before the final closing `]`, each separated by a comma exactly like the file's existing entries:

```json
  {
    "id": "hazards__fireball_rune",
    "pack": "pf2e.hazards",
    "docId": "2GAOUxDfoA48uCWP",
    "name": "Fireball Rune",
    "level": 5,
    "art": "hazards/fireball-rune.webp"
  },
  {
    "id": "hazards__electric_latch_rune",
    "pack": "pf2e.hazards",
    "docId": "491qhVbjsHnOuMZW",
    "name": "Electric Latch Rune",
    "level": 3,
    "art": "hazards/electric-latch-rune.webp"
  },
  {
    "id": "hazards__slamming_door",
    "pack": "pf2e.hazards",
    "docId": "4O7wKZdeAemTEbvG",
    "name": "Slamming Door",
    "level": 1,
    "art": "hazards/slamming-door.webp"
  },
  {
    "id": "hazards__scythe_blades",
    "pack": "pf2e.hazards",
    "docId": "7VqibTAEXXX6PIhh",
    "name": "Scythe Blades",
    "level": 4,
    "art": "hazards/scythe-blades.webp"
  },
  {
    "id": "hazards__telekinetic_swarm_trap",
    "pack": "pf2e.hazards",
    "docId": "AM3YY2Zfe2ChJHd7",
    "name": "Telekinetic Swarm Trap",
    "level": 12,
    "art": "hazards/telekinetic-swarm-trap.webp"
  },
  {
    "id": "hazards__hidden_pit",
    "pack": "pf2e.hazards",
    "docId": "BHq5wpQU8hQEke8D",
    "name": "Hidden Pit",
    "level": 0,
    "art": "hazards/hidden-pit.webp"
  },
  {
    "id": "hazards__wheel_of_misery",
    "pack": "pf2e.hazards",
    "docId": "H2GX04CQXLPQHT8h",
    "name": "Wheel Of Misery",
    "level": 6,
    "art": "hazards/wheel-of-misery.webp"
  },
  {
    "id": "hazards__polymorph_trap",
    "pack": "pf2e.hazards",
    "docId": "H8CPGJn81JSTCRNx",
    "name": "Polymorph Trap",
    "level": 12,
    "art": "hazards/polymorph-trap.webp"
  },
  {
    "id": "hazards__spinning_blade_pillar",
    "pack": "pf2e.hazards",
    "docId": "HnPd9Vqh5NHKEdRq",
    "name": "Spinning Blade Pillar",
    "level": 4,
    "art": "hazards/spinning-blade-pillar.webp"
  },
  {
    "id": "hazards__vorpal_executioner",
    "pack": "pf2e.hazards",
    "docId": "J4YChuob7MIPT5Mq",
    "name": "Vorpal Executioner",
    "level": 19,
    "art": "hazards/vorpal-executioner.webp"
  },
  {
    "id": "hazards__steam_vents",
    "pack": "pf2e.hazards",
    "docId": "OSPYSuckHhHl4Cr9",
    "name": "Steam Vents",
    "level": 4,
    "art": "hazards/steam-vents.webp"
  },
  {
    "id": "hazards__drowning_pit",
    "pack": "pf2e.hazards",
    "docId": "OekigjNLNp9XENjx",
    "name": "Drowning Pit",
    "level": 3,
    "art": "hazards/drowning-pit.webp"
  },
  {
    "id": "hazards__web_lurker_noose",
    "pack": "pf2e.hazards",
    "docId": "Or0jjL8xS3GyiMq0",
    "name": "Web Lurker Noose",
    "level": 2,
    "art": "hazards/web-lurker-noose.webp"
  },
  {
    "id": "hazards__poisoned_dart_gallery",
    "pack": "pf2e.hazards",
    "docId": "lVqVDjXnHboMif7F",
    "name": "Poisoned Dart Gallery",
    "level": 8,
    "art": "hazards/poisoned-dart-gallery.webp"
  },
  {
    "id": "hazards__pharaohs_ward",
    "pack": "pf2e.hazards",
    "docId": "m4PRYxFq9ojcwesh",
    "name": "Pharaoh's Ward",
    "level": 7,
    "art": "hazards/pharaohs-ward.webp"
  },
  {
    "id": "hazards__insistent_privacy_fence",
    "pack": "pf2e.hazards",
    "docId": "mWhmhYBHH9X1Ebb9",
    "name": "Insistent Privacy Fence",
    "level": 8,
    "art": "hazards/insistent-privacy-fence.webp"
  },
  {
    "id": "hazards__summoning_rune",
    "pack": "pf2e.hazards",
    "docId": "nO4osrBRnpWKFCMP",
    "name": "Summoning Rune",
    "level": 1,
    "art": "hazards/summoning-rune.webp"
  },
  {
    "id": "hazards__lava_flume_tube",
    "pack": "pf2e.hazards",
    "docId": "oNLgR1iq6MVvNRWo",
    "name": "Lava Flume Tube",
    "level": 10,
    "art": "hazards/lava-flume-tube.webp"
  },
  {
    "id": "hazards__hammer_of_forbiddance",
    "pack": "pf2e.hazards",
    "docId": "tbwGr6FIr5WpvQ6l",
    "name": "Hammer Of Forbiddance",
    "level": 11,
    "art": "hazards/hammer-of-forbiddance.webp"
  },
  {
    "id": "hazards__hallucination_powder_trap",
    "pack": "pf2e.hazards",
    "docId": "uEZ4Jv2wNyukJTRL",
    "name": "Hallucination Powder Trap",
    "level": 6,
    "art": "hazards/hallucination-powder-trap.webp"
  },
  {
    "id": "hazards__poisoned_lock",
    "pack": "pf2e.hazards",
    "docId": "v2xIxZ9ZZ6fJyATF",
    "name": "Poisoned Lock",
    "level": 1,
    "art": "hazards/poisoned-lock.webp"
  },
  {
    "id": "hazards__spear_launcher",
    "pack": "pf2e.hazards",
    "docId": "vlMuFskctUvjJe8X",
    "name": "Spear Launcher",
    "level": 2,
    "art": "hazards/spear-launcher.webp"
  },
  {
    "id": "hazards__bottomless_pit",
    "pack": "pf2e.hazards",
    "docId": "xkqjwu1ox0pQLOnb",
    "name": "Bottomless Pit",
    "level": 9,
    "art": "hazards/bottomless-pit.webp"
  },
  {
    "id": "hazards__planar_rift",
    "pack": "pf2e.hazards",
    "docId": "yM4G2LvMwvkIRx0G",
    "name": "Planar Rift",
    "level": 13,
    "art": "hazards/planar-rift.webp"
  }
```

- [ ] **Step 2: Validate the schema**

Run: `npm run validate:creature-art`
Expected: PASS — all 24 new entries satisfy `data/schema/creature-art.schema.json` (`id` pattern, `pack` pattern, `art` pattern, `level` integer).

- [ ] **Step 3: Commit**

```bash
git add data/creature-art.json
git commit -m "feat(#759): register trap hazard art entries in creature-art.json

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire `populateSlotTrap` to apply the art

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`populateSlotTrap`, its imports)
- Test: `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `loadCreatureArt()` (`scripts/data-loader.mjs`, already exported, parameterless, cached), `findCreatureArt(list, {pack, id})` / `creatureArtPath(filename)` (`scripts/creature-art.mjs`, already exported).
- Produces: nothing further in this plan consumes it — this is the feature's final wiring, mirroring `scripts/encounter-generator.mjs`'s own `resolveArt`/`withArt` pattern exactly (confirmed current, lines 90-96 and 116).

- [ ] **Step 1: Write the failing test**

Check `tests/dungeon-scene.test.mjs`'s existing top-of-file mocks first (its `vi.mock` calls and fixture helpers) and match its conventions exactly. Add a new `describe('populateSlotTrap art', ...)` block using the file's own existing Foundry-stub/fixture style. Two cases:

```js
describe('populateSlotTrap art', () => {
  it('applies creature art as imgFallback when a matching entry exists', async () => {
    vi.doMock('../scripts/data-loader.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        loadCreatureArt: vi.fn().mockResolvedValue([
          { id: 'hazards__hidden_pit', pack: 'pf2e.hazards', docId: 'BHq5wpQU8hQEke8D', name: 'Hidden Pit', level: 0, art: 'hazards/hidden-pit.webp' },
        ]),
      };
    });
    const { populateSlotTrap } = await import('../scripts/dungeon-scene.mjs');
    // ...use this file's own existing scene/trap fixture setup...
    // assert the api.spawnCreatures call received an entries[0].imgFallback
    // equal to 'modules/pf2e-dungeon-crawl/assets/hazards/hidden-pit.webp'
    // when the stubbed selectTrap/findHazards resolves to {pack:'pf2e.hazards', id:'BHq5wpQU8hQEke8D'}.
  });

  it('passes no imgFallback when the selected hazard has no art entry', async () => {
    vi.doMock('../scripts/data-loader.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, loadCreatureArt: vi.fn().mockResolvedValue([]) };
    });
    const { populateSlotTrap } = await import('../scripts/dungeon-scene.mjs');
    // ...same fixture setup, different hazard id...
    // assert entries[0].imgFallback is undefined/null, and spawnCreatures
    // is still called (a miss must never block placement).
  });
});
```

Adapt the exact mock/fixture mechanics (scene stub, `api.spawnCreatures` spy, `selectTrap` stub) to however this file's existing `populateSlotTrap` tests (if any) or its sibling `populateSlotEncounter`/combat-room tests already do it — reuse the established harness rather than inventing a new one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "populateSlotTrap art"`
Expected: FAIL — no `imgFallback` is set on the spawned entry today.

- [ ] **Step 3: Wire the art lookup**

Add to the existing `data-loader.mjs` import in `scripts/dungeon-scene.mjs` (currently `import { loadDungeonSetpieces } from "./data-loader.mjs";`):

```js
import { loadDungeonSetpieces, loadCreatureArt } from "./data-loader.mjs";
```

Add a new import alongside the others:

```js
import { findCreatureArt, creatureArtPath } from "./creature-art.mjs";
```

In `populateSlotTrap`, change:

```js
  const api = makeFoundryApi(scene);
  const rng = splitmix32(seedFromString(`${seed}-trap-${slot}`));
  const trap = await selectTrap({ api, partyLevel, levelOffsetBias, rng });
  if (!trap) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.Trap.NoneFoundWarning"),
    );
    return;
  }
  const [spawned] = await api.spawnCreatures(
    [{ pack: trap.pack, id: trap.id }],
    {
```

to:

```js
  const api = makeFoundryApi(scene);
  const rng = splitmix32(seedFromString(`${seed}-trap-${slot}`));
  const trap = await selectTrap({ api, partyLevel, levelOffsetBias, rng });
  if (!trap) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.Trap.NoneFoundWarning"),
    );
    return;
  }
  const creatureArt = await loadCreatureArt();
  const artFilename = findCreatureArt(creatureArt, { pack: trap.pack, id: trap.id });
  const imgFallback = artFilename
    ? `modules/${MODULE_ID}/assets/${creatureArtPath(artFilename)}`
    : null;
  const [spawned] = await api.spawnCreatures(
    [{ pack: trap.pack, id: trap.id, imgFallback }],
    {
```

This mirrors `encounter-generator.mjs`'s own `resolveArt`/`withArt` exactly, including its `null`-safe behavior on a miss — `spawnCreatures`'s existing per-entry override logic (confirmed current, `scripts/foundry-api.mjs`) already treats a falsy `imgFallback` as "use the compendium's own default art", so a hazard with no art entry yet is unaffected.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "populateSlotTrap art"`
Expected: PASS, both cases green.

- [ ] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/dungeon-scene.test.mjs`
Expected: PASS, every existing test in this file still green.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene.test.mjs
git commit -m "feat(#759): apply generated art to spawned trap hazards

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Generate the art, live-verify, version bump

**Files:**
- Create: `assets/creature-art/hazards/*.webp` (24 files, via the generation run)
- Modify: `module.json`

No unit test: this task is the actual image-generation run plus live verification, not code.

- [ ] **Step 1: Generate the 24 images**

```bash
npm run tokens -- fireball-rune electric-latch-rune slamming-door scythe-blades \
  telekinetic-swarm-trap hidden-pit wheel-of-misery polymorph-trap spinning-blade-pillar \
  vorpal-executioner steam-vents drowning-pit web-lurker-noose poisoned-dart-gallery \
  pharaohs-ward insistent-privacy-fence summoning-rune lava-flume-tube \
  hammer-of-forbiddance hallucination-powder-trap poisoned-lock spear-launcher \
  bottomless-pit planar-rift
```

Per `project_comfyui_first_unless_routed` (standing convention): this runs ComfyUI first for every entry unless `data/token-art-routing.json` already routes a specific id elsewhere — none of these 24 ids are in that file today, so this is a plain ComfyUI batch, no `--route`/`--backend=gemini` needed unless a specific entry's ComfyUI attempts all fail (per `project_comfyui_defer_to_gemini`: 3 attempts before the existing fallback chain takes over automatically).

- [ ] **Step 2: Mechanical check**

Run: `npm run tokens:check`
Expected: PASS for all 24 — catches bright/pale backgrounds only (per the generator's own documented lesson 6), not a substitute for Step 3.

- [ ] **Step 3: Eye review against each prompt's defining features**

For each of the 24 generated images, confirm by eye (per `feedback_art_review_defining_features`: reject on wrong defining features, not just a technically clean background):
- The subject is the described mechanism/object itself (e.g. the trapdoor hatch, the rune, the blade), not a scene, a person, or an unrelated object.
- No floor/wall/room scenery leaked in despite `SHAPELESS_NEGATIVE`'s own exclusions.
- The object reads clearly at token scale (zoom out to roughly the size a Foundry token renders at).

Any failure: reroll with `npm run tokens -- --force --reroll=1 <id>` (and `=2`, `=3`, ... as needed), or add an `avoid` term to that entry in `tools/trap-art-prompts.mjs` and regenerate, following the same iterative process every prior ITEM-18/#229 batch used.

- [ ] **Step 4: Normalize layout**

Run: `npm run art:normalize`
Expected: confirms/fixes the per-source-folder layout (idempotent; safe even if Step 1 already wrote directly to `assets/creature-art/hazards/`).

- [ ] **Step 5: Live-verify via `foundry-rest`**

Generate a few real dungeon runs with seeds chosen to land a trap room, and confirm via `foundry-rest` that a spawned trap hazard's token `img`/`texture.src` now points at `modules/pf2e-dungeon-crawl/assets/creature-art/hazards/<slug>.webp` rather than `systems/pf2e/icons/default-icons/hazard.svg`:

```bash
echo 'const tokens = canvas.scene.tokens.filter(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard")); return tokens.map(t => ({ name: t.name, img: t.texture?.src }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: every trap hazard token found across several runs shows a `hazards/<slug>.webp` path, never the default `hazard.svg`.

- [ ] **Step 6: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (real new generated content + a real feature wiring), using whatever the fetch above shows as current.

- [ ] **Step 7: Commit**

```bash
git add assets/creature-art/hazards module.json
git commit -m "feat(#759): generate and ship trap hazard art

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #759's own ask ("generate dedicated art for each trap type... following the same pipeline/convention as ITEM-18/#229") is fully covered: Task 1 authors the prompts in that exact pipeline, Task 2 registers them in the exact data file combat creatures already use, Task 3 wires the lookup into the one real trap-spawn call site, Task 4 generates, reviews, and ships the result. The issue's own "feeds the hidden-Tile-reveal sub-issue" line is stale (that sub-issue, #758, closed 2026-10-05 as superseded by #753's already-shipped token-based reveal) — this plan correctly targets the existing token's own texture, not a Tile, matching #758's closure rationale. No gaps found.

**2. Placeholder scan:** No TBD/TODO. All 24 prompts are real, finished text, not "write a prompt for X". Task 3's test step names the exact assertions rather than "add appropriate tests", while leaving the mock/fixture mechanics to match this file's own established harness (the harness itself wasn't re-derived here, consistent with how #754's plan handled Foundry-glue functions with no existing test pattern to copy verbatim).

**3. Type consistency:** `TRAP_ART`'s `id`/`file`/`dir` values (Task 1) match `data/creature-art.json`'s `art` paths (Task 2) exactly (`hazards/<slug>.webp`). `findCreatureArt`/`creatureArtPath`'s existing signatures (Task 3) are used identically to `encounter-generator.mjs`'s own already-shipped `resolveArt` call. No renamed functions or mismatched shapes across tasks.

**4. Review Focus:** All five items (art reaching the real token, a no-art miss not crashing placement, prompts never implying scenery the style fights, real per-image review discipline, no accidental interaction with trap flavor text/mechanics) each map to a concrete step or test in the task that owns them. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-trap-hazard-art.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native** for Tasks 1-3 (small, well-isolated code/data changes mirroring an already-shipped pattern exactly) but flag that **Task 4 is substantially real creative/content work** (24 images to generate and review by eye) rather than code an implementer just executes mechanically — budget for iteration on art quality the way every prior ITEM-18/#229 batch needed, independent of which execution method you pick for the code tasks. Does the plan capture what you want, and which approach should we use?
