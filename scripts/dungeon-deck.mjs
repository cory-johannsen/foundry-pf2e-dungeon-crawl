/**
 * The abstract "dungeon crawl" sequence — a linear generalization of the
 * sourcebook's Journey Spread (a Challenge card each day, then a card read as
 * a Reward or a Ruin depending on how the challenge went) into rooms instead
 * of days, ending in a goal/boss room. Kept free of any Foundry dependency,
 * same split as encounter-deck.mjs, so the sequencing/outcome rules are fully
 * unit-testable.
 *
 * Room kinds and outcomes are picked by a seeded hash of the room's own index
 * rather than a pre-shuffled fixed-length array, so growing the sequence
 * later (Extra Travel Time inserting a room) never disturbs rooms already
 * handed to the table.
 */
import { splitmix32, seedFromString, shuffle } from './prng.mjs';

// Tunable, with no anchor in the source material — unlike the encounter
// deck's XP table, the Journey Spread never specifies a room-kind mix.
export const ROOM_KIND_WEIGHTS = [
  { kind: 'combat', weight: 5 },
  { kind: 'skill_challenge', weight: 2 },
  { kind: 'puzzle_or_trap', weight: 2 },
  { kind: 'narrative', weight: 1 },
  { kind: 'treasure', weight: 2 }
];

// Each slot pairs a Reward meaning (the challenge was handled well) with a
// Ruin meaning (handled poorly), read off the SAME drawn slot — the book
// never fixes a Reward/Ruin correspondence, so these pairings are a tunable,
// thematic choice that covers all 4 rewards and all 5 ruins from the Journey
// Spread. `mutation` describes what a resolution does to the room sequence
// or the encounter flow; absent means "flavor only, no mechanical effect."
export const OUTCOME_SLOT_TEMPLATES = [
  {
    id: 'aid_or_ambush',
    reward: { key: 'friendly_aid' },
    ruin: { key: 'encounter', mutation: 'rerun_encounter' }
  },
  {
    id: 'rest_or_ruin',
    reward: { key: 'ready_foraging' },
    ruin: { key: 'restless_night' }
  },
  {
    id: 'pace',
    reward: { key: 'reduced_travel_time', mutation: 'remove_next' },
    ruin: { key: 'extra_travel_time', mutation: 'insert_after' }
  },
  {
    id: 'loot_or_loss',
    reward: { key: 'treasure' },
    ruin: { key: 'lost_gear' }
  },
  {
    id: 'cost_of_loot',
    reward: { key: 'treasure' },
    ruin: { key: 'exhaustion' }
  }
];

export function findOutcomeTemplate(id) {
  return OUTCOME_SLOT_TEMPLATES.find((t) => t.id === id) ?? null;
}

// Tunable. +2 pushes an already-hard late creature slot from the top of the
// normal spread (+2) to the edge of the XP table's meaningful range (+4) —
// real escalation deeper into the dungeon without exceeding it.
export const MAX_DEPTH_BIAS = 2;

/**
 * How much harder a combat room should run, purely from its position in the
 * dungeon — a linear ramp from 0 at room 0 up to MAX_DEPTH_BIAS by the last
 * room actually built. The goal room always gets the max regardless of where
 * it lands (a short dungeon shouldn't have a soft final boss).
 */
export function depthBiasFor({ physicalSlot, roomCount, isGoal }) {
  if (isGoal) return MAX_DEPTH_BIAS;
  const fraction = physicalSlot / Math.max(1, roomCount - 1);
  return Math.round(fraction * MAX_DEPTH_BIAS);
}

// Placeholder heuristic, not a real treasure table — same disclosed-tunable
// spirit as combat-rewards.mjs's LOOT_GP_PER_XP, until a real treasure-table
// pass exists (#169).
export const TREASURE_GP_PER_LEVEL = 10;

/**
 * A treasure room's real coin grant — a party-level-scaled base, scaled up
 * by the room's own depthBiasFor ramp (1x at room 0, up to 2x at
 * MAX_DEPTH_BIAS/the goal room), the same depth-escalation signal combat
 * rooms already use for encounter difficulty.
 */
export function lootGpForTreasureRoom({ partyLevel, physicalSlot, roomCount, isGoal }) {
  const bias = depthBiasFor({ physicalSlot, roomCount, isGoal });
  return Math.round(partyLevel * TREASURE_GP_PER_LEVEL * (1 + bias / MAX_DEPTH_BIAS));
}

// Broad PF2e creature-type traits, deliberately common ones rather than
// narrow subtypes, so a room's tag rarely starves the bestiary query to zero
// once it's combined with whatever the dungeon-wide theme already asks for.
export const LOCATION_TAGS = ['undead', 'beast', 'fiend', 'aberration', 'construct', 'elemental', 'plant', 'dragon'];

/** Deterministic per-room pick, same seeded pattern as outcomeSlotAt/setpieceAt. */
export function locationTagAt(seed, index) {
  return pickAt(seed, `location-${index}`, LOCATION_TAGS.map((tag) => ({ tag }))).tag;
}

// How many pregenerated art variants exist per locationTag (see
// dungeon-scene.mjs's roomArtPath) — tunable, not tied to any logic here.
export const ROOM_ART_VARIANTS = 3;

/**
 * Deterministic per-room art variant index, same seeded-per-index pattern as
 * the rest of this file. A plain uniform integer pick rather than routed
 * through pickAt/weightedPick, since there's no weighting concept for "which
 * copy of the same theme's art" — every variant is equally likely.
 */
export function roomArtVariantAt(seed, index) {
  const r = splitmix32(seedFromString(`${seed}-art-${index}`))();
  return Math.floor(r * ROOM_ART_VARIANTS);
}

function weightedPick(items, r) {
  const weights = items.map((it) => it.weight ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < items.length; i += 1) {
    x -= weights[i];
    if (x < 0) return items[i];
  }
  return items[items.length - 1];
}

function pickAt(seed, salt, items) {
  const r = splitmix32(seedFromString(`${seed}-${salt}`))();
  return weightedPick(items, r);
}

/** The room kind at a given absolute room index, deterministic per seed. */
export function roomKindAt(seed, index) {
  return pickAt(seed, `kind-${index}`, ROOM_KIND_WEIGHTS).kind;
}

/** The outcome-slot template at a given absolute room index. */
export function outcomeSlotAt(seed, index) {
  return pickAt(seed, `outcome-${index}`, OUTCOME_SLOT_TEMPLATES);
}

/**
 * The set-piece for the Nth puzzle_or_trap room encountered in a run (0
 * indexed by occurrence, not by absolute room index). `setpieceIds` is
 * shuffled once per seed, then cycled by occurrence, so a short dungeon
 * rarely repeats a set-piece and a long one cycles rather than repeating the
 * same one back-to-back. Returns null when no set-pieces are available.
 */
export function setpieceAt(seed, occurrenceIndex, setpieceIds, salt = 'setpiece-order') {
  if (!setpieceIds?.length) return null;
  const rand = splitmix32(seedFromString(`${seed}-${salt}`));
  const order = shuffle(setpieceIds, rand);
  return order[occurrenceIndex % order.length];
}

// A dungeon this long or longer gets one bonus safe rest room, inserted
// near its midpoint — never counted against roomCount, same as the entry
// (ITEM-5).
export const MID_DUNGEON_REST_THRESHOLD = 6;

/**
 * Build a fresh linear room sequence. `roomCount` includes the goal room, so
 * it must be at least 2 — it does NOT include the safe entry room prepended
 * below, which is always there in addition to `roomCount`, not counted
 * against it. The last room is always a combat room flagged `isGoal: true`
 * with no outcome slot — the climactic fight, and the end of the line for
 * reward/ruin resolution.
 */
export function buildRoomSequence({ seed, roomCount, setpieceIds = [], narrativeSetpieceIds = [] }) {
  if (!Number.isInteger(roomCount) || roomCount < 2) {
    throw new Error('roomCount must be an integer of at least 2 (rooms plus a goal room)');
  }
  // The entry: always safe (no encounter, trap or puzzle — no outcomeSlotId
  // at all, so there's nothing for markRoomOutcome to resolve), always first,
  // never counted against roomCount. Its own exit is unlocked immediately at
  // Start rather than waiting on a GM's Mark Succeeded — see dungeon-app.mjs.
  const rooms = [{
    id: 'room-entry', kind: 'safe_entry', isGoal: false, setpieceId: null, outcomeSlotId: null,
    locationTag: locationTagAt(seed, 'entry'), artVariant: roomArtVariantAt(seed, 'entry')
  }];
  // Index (within this loop) after which the rest room lands — the real room
  // nearest the midpoint of the run, so a long dungeon splits roughly in half
  // around it rather than the rest landing right before the goal.
  const restAfterIndex = roomCount > MID_DUNGEON_REST_THRESHOLD ? Math.floor((roomCount - 2) / 2) : -1;
  let puzzleOccurrence = 0;
  let narrativeOccurrence = 0;
  for (let i = 0; i < roomCount - 1; i += 1) {
    const kind = roomKindAt(seed, i);
    // #165: narrative rooms get a set-piece the same way puzzle_or_trap
    // rooms already do — a separate occurrence counter and a separate
    // salted shuffle (`narrative-setpiece-order`) over its own pool, so
    // drawing one never depends on or exhausts the puzzle/trap pool.
    const setpieceId =
      kind === 'puzzle_or_trap' ? setpieceAt(seed, puzzleOccurrence++, setpieceIds)
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : null;
    const outcomeSlot = outcomeSlotAt(seed, i);
    rooms.push({
      id: `room-${i}`, kind, isGoal: false, setpieceId, outcomeSlotId: outcomeSlot.id,
      locationTag: locationTagAt(seed, i), artVariant: roomArtVariantAt(seed, i)
    });
    if (i === restAfterIndex) {
      // Safe like the entry — no encounter, no outcomeSlotId — but reached
      // mid-run via the normal door-reveal flow rather than Start, so
      // dungeon-runner.mjs's markRoomOutcome and dungeon-scene.mjs's
      // handleDungeonDoorOpened both special-case `kind === 'safe_rest'` to
      // auto-advance past it the instant it's revealed.
      rooms.push({
        id: 'room-rest', kind: 'safe_rest', isGoal: false, setpieceId: null, outcomeSlotId: null,
        locationTag: locationTagAt(seed, 'rest'), artVariant: roomArtVariantAt(seed, 'rest')
      });
    }
  }
  rooms.push({
    id: `room-${roomCount - 1}`,
    kind: 'combat',
    isGoal: true,
    setpieceId: null,
    outcomeSlotId: null,
    locationTag: locationTagAt(seed, roomCount - 1),
    artVariant: roomArtVariantAt(seed, roomCount - 1)
  });
  return rooms;
}

/**
 * Resolve one non-goal room's outcome slot against how its challenge went.
 * Exported separately from the sequence builder (like encounter-deck.mjs's
 * resolveDraws) so each of the 9 reward/ruin branches can be tested directly
 * against a hand-picked template instead of fighting the seeded picks.
 */
export function resolveRoomOutcome(outcomeSlotTemplate, succeeded) {
  const branch = succeeded ? outcomeSlotTemplate.reward : outcomeSlotTemplate.ruin;
  return { effectKey: branch.key, mutation: branch.mutation ?? null };
}

/**
 * Apply a reward/ruin's sequence mutation. Pure — returns a new rooms array,
 * or the same array reference when there is nothing to do. Never removes or
 * inserts past the goal room: `remove_next` is a no-op if the next room is
 * the goal, and `insert_after` always lands strictly before it since the
 * goal room is never `currentIndex`'s neighbour once it's still ahead.
 */
export function applySequenceMutation(rooms, currentIndex, mutation, { seed, setpieceIds = [], narrativeSetpieceIds = [] } = {}) {
  if (mutation === 'remove_next') {
    const next = rooms[currentIndex + 1];
    if (!next || next.isGoal) return rooms;
    return [...rooms.slice(0, currentIndex + 1), ...rooms.slice(currentIndex + 2)];
  }
  if (mutation === 'insert_after') {
    const salt = `extra-${currentIndex}-${rooms.length}`;
    const kind = pickAt(seed, `${salt}-kind`, ROOM_KIND_WEIGHTS).kind;
    const outcomeTemplate = pickAt(seed, `${salt}-outcome`, OUTCOME_SLOT_TEMPLATES);
    const setpieceId =
      kind === 'puzzle_or_trap' ? setpieceAt(seed, rooms.length, setpieceIds)
      : kind === 'narrative' ? setpieceAt(seed, rooms.length, narrativeSetpieceIds, 'narrative-setpiece-order')
      : null;
    const newRoom = {
      id: `room-${salt}`,
      kind,
      isGoal: false,
      setpieceId,
      outcomeSlotId: outcomeTemplate.id,
      locationTag: locationTagAt(seed, salt),
      artVariant: roomArtVariantAt(seed, salt)
    };
    return [...rooms.slice(0, currentIndex + 1), newRoom, ...rooms.slice(currentIndex + 1)];
  }
  return rooms;
}
