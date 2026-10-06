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
/** System prompt for the paid backends (OpenRouter): the shared creature one
 * demands a head-and-shoulders bust, which turns every object into a face. */
export const TRAP_OBJECT_SYSTEM_PROMPT = [
  'You are generating a single dark-fantasy object illustration for a tabletop VTT token. Follow these rules exactly:',
  '1. SUBJECT: The described object or mechanism ONLY, centered and filling most of the frame. It is an inanimate thing: no creature, no face, no eyes, no person, no character, no bust portrait.',
  '2. BACKGROUND: Plain, flat, solid BLACK background. Nothing else in the frame: no landscape, no room, no ground, no floor, no shadow on a floor, no walls, no props.',
  '3. STYLE: Hand-painted dark fantasy illustration with intricate linework and rich saturated colors. Not a photograph, not a 3D render.',
  '4. NO TEXT: No watermark, signature, logo or lettering.',
  '5. NO FRAMES: No circular border, halo, ring, medallion or decorative frame around the subject.'
].join('\n\n');

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
    prompt: 'A flat glowing green spiral symbol drawn in thin twisting vine linework with a few small '
      + 'leaves along the lines, a symbol only with no body and no figure, hovering alone in the '
      + 'dark, nothing else in the frame',
    avoid: 'person transforming, hands, full animal body, forest, tree, humanoid figure, person-shaped, circle, ring, border, ground, arms, legs, head, body, silhouette' },
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
    prompt: 'A plain round stone water pipe opening set in a rough stone block, water gushing '
      + 'forcefully from the opening, slick wet stone pitted with age, suspended alone in the dark, '
      + 'nothing else in the frame',
    avoid: 'wall, pit, person drowning, fountain, garden, waterfall scenery, pool, creature, monster, face, eyes, teeth, tongue, frog, animal head' },
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
    prompt: 'A short stone pipe section with a raised iron grille, thick molten orange-red lava pouring '
      + 'from its open end, glowing heat radiating off the stone, suspended alone in the dark, '
      + 'nothing else in the frame',
    avoid: 'room, chamber, floor, person, volcano landscape, lava field scenery, cavern, canyon, cliff, chasm, river, mountain' },
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
    prompt: 'A small iron padlock with a thin needle spike protruding from its keyhole, a dull green '
      + 'poison sheen on the needle point, suspended alone in the dark, nothing else in the frame',
    avoid: 'door, person, hand, finger, creature, animal, lizard, insect, chain' },
  { id: 'spear-launcher', file: 'spear-launcher', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A single iron-tipped wooden spear, a broad triangular iron head, angled as if launched '
      + 'mid-flight with a faint motion blur along its shaft, suspended alone in the dark, '
      + 'nothing else in the frame',
    avoid: 'wall, socket, floor, tile, person, target, javelin competition, leaf, maple leaf, feather, plant, autumn' },
  { id: 'bottomless-pit', file: 'bottomless-pit', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A square iron trapdoor hatch, dark riveted plates with a heavy recessed pull-latch, '
      + 'one edge hinged open as if swinging down into an endless black void beneath, faint cold '
      + 'mist curling from the opening, suspended alone in the dark, nothing else in the frame',
    avoid: 'pit, hole, floor, ground, person falling, room, ring' },
  { id: 'planar-rift', file: 'planar-rift', dir: 'assets/creature-art/hazards', shapeless: true,
    prompt: 'A tall narrow vertical crack of crackling violet-blue light splitting empty darkness, '
      + 'jagged glowing edges, bright shifting colors inside the slit, only the glowing crack, '
      + 'nothing else in the frame',
    avoid: 'portal frame, doorway, person, planet, galaxy, stars, wormhole tunnel effect, creature, monster, animal, humanoid, eyes, claws, wings, insect, bat, moth' },
];

for (const entry of TRAP_ART) entry.systemPrompt = TRAP_OBJECT_SYSTEM_PROMPT;
