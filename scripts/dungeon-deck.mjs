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
import {
  nthLevelTableName,
  valuableTierForBudget,
  pickWeightedCategory,
  ITEM_PRICE_BUDGET_FRACTION
} from './treasure.mjs';

// Tunable, with no anchor in the source material — unlike the encounter
// deck's XP table, the Journey Spread never specifies a room-kind mix.
// #32: puzzle and trap used to be one combined 'puzzle_or_trap' kind
// (weight 2) whose actual identity was only decided after the room was
// drawn, by resolving whichever setpiece a shared shuffle landed on. Split
// into two independent kinds, decided up front like every other room kind
// — an even 1/1 split (confirmed with the user), keeping the combined
// weight (and so the overall room-kind mix) unchanged from before the split.
export const ROOM_KIND_WEIGHTS = [
  { kind: 'combat', weight: 5 },
  { kind: 'skill_challenge', weight: 2 },
  { kind: 'puzzle', weight: 1 },
  { kind: 'trap', weight: 1 },
  { kind: 'narrative', weight: 1 },
  { kind: 'treasure', weight: 2 }
];

// Frequent branching, capped at 2 extra exits (3 total) — confirmed with
// Cory during #93's design. Skewed toward 1-2 so most rooms still read as
// a single path and full 3-way branches stay a genuine event.
export const EXIT_COUNT_WEIGHTS = [
  { count: 1, weight: 5 },
  { count: 2, weight: 4 },
  { count: 3, weight: 1 }
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
export function depthBiasFor({ rank, maxRank, isGoal }) {
  if (isGoal) return MAX_DEPTH_BIAS;
  const fraction = rank / Math.max(1, maxRank);
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
export function lootGpForTreasureRoom({ partyLevel, rank, maxRank, isGoal }) {
  const bias = depthBiasFor({ rank, maxRank, isGoal });
  return Math.round(partyLevel * TREASURE_GP_PER_LEVEL * (1 + bias / MAX_DEPTH_BIAS));
}

// Which kind of table a treasure room's item draws from — tunable, no
// anchor in the source material, same disclosed-heuristic spirit as
// ROOM_KIND_WEIGHTS above. Unlike an NPC corpse's incidental drop, a
// treasure room is the deliberate payoff moment, so this is skewed toward
// the exciting stuff (a permanent magic item) rather than consumables.
export const TREASURE_ROOM_CATEGORY_WEIGHTS = [
  { category: 'permanent', weight: 45 },
  { category: 'valuable', weight: 35 },
  { category: 'consumable', weight: 20 }
];

/**
 * A treasure room's item draw (#29) — unlike rollNpcTreasure's ITEM_CHANCE
 * gate, a treasure room always drops something; this only decides which
 * real `pf2e.rollable-tables` table to draw from. Reuses
 * lootGpForTreasureRoom's own gp figure as the price budget for a
 * 'valuable' category pick, so the two stay in sync.
 */
export function treasureRoomItemTableName({ partyLevel, rank, maxRank, isGoal, rng }) {
  const gp = lootGpForTreasureRoom({ partyLevel, rank, maxRank, isGoal });
  const category = pickWeightedCategory(TREASURE_ROOM_CATEGORY_WEIGHTS, rng());
  return category === 'valuable'
    ? valuableTierForBudget(gp * ITEM_PRICE_BUDGET_FRACTION)
    : nthLevelTableName(category, partyLevel);
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

/**
 * The same deterministic-per-salt pick `outcomeSlotAt`/`roomKindAt` use
 * internally, exposed for callers outside this file that need a seeded,
 * reproducible choice among their own candidates (e.g. dungeon-app.mjs
 * picking which party member loses a gear item, or which bestiary entry
 * answers a `friendly_aid` outcome) — uniform unless an item carries its
 * own `.weight`.
 */
export function seededPick(seed, salt, items) {
  return pickAt(seed, salt, items);
}

/** The room kind at a given absolute room index, deterministic per seed. */
export function roomKindAt(seed, index) {
  return pickAt(seed, `kind-${index}`, ROOM_KIND_WEIGHTS).kind;
}

/** Deterministic per-room exit count (1-3), same seeded-per-salt pattern as roomKindAt. */
export function exitCountAt(seed, roomId) {
  return pickAt(seed, `exits-${roomId}`, EXIT_COUNT_WEIGHTS).count;
}

/** The outcome-slot template at a given absolute room index. */
export function outcomeSlotAt(seed, index) {
  return pickAt(seed, `outcome-${index}`, OUTCOME_SLOT_TEMPLATES);
}

/**
 * The set-piece for the Nth occurrence of a given kind's room encountered in
 * a run (0 indexed by occurrence, not by absolute room index) — used for
 * puzzle, trap and narrative rooms alike, each with its own occurrence
 * counter, its own `setpieceIds` pool and its own `salt` so the three draws
 * are fully independent of one another. `setpieceIds` is shuffled once per
 * seed+salt, then cycled by occurrence, so a short dungeon rarely repeats a
 * set-piece and a long one cycles rather than repeating the same one
 * back-to-back. Returns null when no set-pieces are available.
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
export function buildRoomSequence({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = []
}) {
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
  let trapOccurrence = 0;
  let narrativeOccurrence = 0;
  let treasureOccurrence = 0;
  for (let i = 0; i < roomCount - 1; i += 1) {
    const kind = roomKindAt(seed, i);
    // #32/#165/#89: puzzle, trap, narrative and treasure rooms each get a
    // set-piece from their own pool — a separate occurrence counter and a
    // separate salted shuffle per kind, so drawing one never depends on or
    // exhausts another kind's pool.
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, trapOccurrence++, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, treasureOccurrence++, treasureSetpieceIds, 'treasure-setpiece-order')
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
export function applySequenceMutation(
  rooms,
  currentIndex,
  mutation,
  {
    seed,
    puzzleSetpieceIds = [],
    trapSetpieceIds = [],
    narrativeSetpieceIds = [],
    treasureSetpieceIds = []
  } = {}
) {
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
      kind === 'puzzle' ? setpieceAt(seed, rooms.length, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, rooms.length, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, rooms.length, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, rooms.length, treasureSetpieceIds, 'treasure-setpiece-order')
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

/**
 * Build a fresh branching room graph (#93). Unlike buildRoomSequence, this
 * has no single fixed "next room" — each non-goal, non-entry room rolls its
 * own exit count (exitCountAt) and grows one child per exit. To guarantee
 * the goal room ends up with exactly one incoming edge no matter how much
 * branching happened, generation tracks "open tips" (leaf rooms still
 * awaiting children) and forces merges — routing 2+ open tips into the SAME
 * next room — once the remaining room budget can no longer afford to keep
 * every tip open through to its own goal connection.
 */
export function buildRoomGraph({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = [],
}) {
  if (!Number.isInteger(roomCount) || roomCount < 2) {
    throw new Error('roomCount must be an integer of at least 2 (rooms plus a goal room)');
  }

  const rooms = {};
  const edges = {};
  let puzzleOccurrence = 0;
  let trapOccurrence = 0;
  let narrativeOccurrence = 0;
  let treasureOccurrence = 0;
  let built = 0; // non-entry, non-goal rooms built so far

  const entry = {
    id: 'room-entry', kind: 'safe_entry', isGoal: false, setpieceId: null, outcomeSlotId: null,
    locationTag: locationTagAt(seed, 'entry'), artVariant: roomArtVariantAt(seed, 'entry')
  };
  rooms[entry.id] = entry;
  edges[entry.id] = [];

  function makeRoom(salt) {
    const kind = roomKindAt(seed, salt);
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, trapOccurrence++, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, treasureOccurrence++, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
    const outcomeSlot = outcomeSlotAt(seed, salt);
    const room = {
      id: `room-${salt}`, kind, isGoal: false, setpieceId, outcomeSlotId: outcomeSlot.id,
      locationTag: locationTagAt(seed, salt), artVariant: roomArtVariantAt(seed, salt)
    };
    rooms[room.id] = room;
    edges[room.id] = [];
    return room;
  }

  // Open tips grow the graph breadth-first; each pop may add 1-3 children.
  let tips = [entry.id];
  while (built < roomCount - 1) {
    // Forced merge: once every remaining tip would need its own room just
    // to reach the goal, and the budget can't afford one room per tip PLUS
    // the goal, collapse all open tips onto a single new shared room before
    // continuing — this is what guarantees exactly one goal parent.
    const remaining = roomCount - 1 - built;
    if (tips.length > 1 && remaining <= tips.length) {
      const merged = makeRoom(`merge-${built}`);
      built += 1;
      for (const tipId of tips) edges[tipId].push(merged.id);
      tips = [merged.id];
      continue;
    }

    const tipId = tips.shift();
    // #93 pre-flight fix (Task 2 review found this empirically: capping
    // exitCount only by total remaining budget lets a single tip's own
    // branching alone consume the whole budget while OTHER already-open
    // tips (still sitting in `tips` below) never get a chance to reach
    // this loop's own merge check again — the loop then exits with every
    // one of them wired straight to goal, violating "goal always has
    // exactly one incoming edge" in ~22% of (seed, roomCount) pairs
    // (confirmed by sweep: e.g. seed='seed-0', roomCount=3 -> 2 goal
    // parents; seed='seed-1', roomCount=26 -> 4 goal parents). The fix:
    // cap exitCount so that AFTER this tip's children are created, the
    // loop's own invariant (remaining budget >= open tip count) still
    // holds for every tip still waiting — otherTips is `tips.length`
    // right after the shift above, i.e. every OTHER currently-open tip
    // that isn't the one being processed right now.
    const otherTips = tips.length;
    const avail = roomCount - 1 - built;
    const maxExitCount = Math.max(1, Math.floor((avail - otherTips) / 2));
    const exitCount = Math.min(exitCountAt(seed, tipId), maxExitCount);
    const nextTips = [];
    for (let i = 0; i < Math.max(1, exitCount); i += 1) {
      if (built >= roomCount - 1) break;
      const child = makeRoom(`${tipId}-${i}`);
      built += 1;
      edges[tipId].push(child.id);
      nextTips.push(child.id);
    }
    tips.push(...nextTips);
  }

  // Every remaining open tip becomes the goal's parent — force-merge to one
  // if more than one tip is still open (mirrors the loop's own merge step).
  const goal = {
    id: 'room-goal', kind: 'combat', isGoal: true, setpieceId: null, outcomeSlotId: null,
    locationTag: locationTagAt(seed, 'goal'), artVariant: roomArtVariantAt(seed, 'goal')
  };
  rooms[goal.id] = goal;
  edges[goal.id] = [];
  for (const tipId of tips) edges[tipId].push(goal.id);

  return { rooms, edges };
}

/**
 * #93 post-merge fix (Task 15's final review): buildRoomGraph never
 * creates a mid-dungeon rest room (ITEM-5) the way the old
 * buildRoomSequence did — this restores it as a discrete post-processing
 * pass, the same relationship attachHiddenPaths already has to
 * buildRoomGraph's output, rather than complicating the forced-merge
 * algorithm itself with rest-room placement.
 *
 * Picks the non-entry, non-goal room whose generation-order position is
 * closest to Math.floor((roomCount - 2) / 2) — the same "nearest the
 * midpoint of the run" semantics buildRoomSequence's own restAfterIndex
 * used for a linear chain. Generation order is read from `rooms`' own key
 * insertion order (buildRoomGraph inserts each room exactly when it builds
 * it, and none of its ids are integer-like, so JS preserves that order),
 * NOT parsed from the id: buildRoomGraph's ids are path-shaped
 * ('room-room-entry-0', 'room-merge-6', ...), never a bare 'room-N'.
 *
 * Splices `room-rest` in as the new SOLE parent of the selected target:
 * every room that currently points at the target is redirected to point
 * at room-rest instead, and room-rest gets a single outgoing edge to the
 * target. This works identically whether the target had one real parent
 * (a normal room) or several (a merge room) — the target's own incoming
 * face count only ever goes DOWN (to exactly 1, from room-rest), never up,
 * so no room's exit-count budget is disturbed by this splice.
 *
 * Pure — returns new `rooms`/`edges` objects, never mutates its inputs.
 * Must run BEFORE attachHiddenPaths (which excludes the rest room from
 * hidden-path eligibility) and before any rank/column computation.
 */
export function insertRestRoom({ rooms, edges, seed, roomCount }) {
  if (roomCount <= MID_DUNGEON_REST_THRESHOLD) return { rooms, edges };

  const targetPosition = Math.floor((roomCount - 2) / 2);
  let target = null;
  let bestDistance = Infinity;
  let position = 0;
  for (const room of Object.values(rooms)) {
    if (room.id === 'room-entry' || room.isGoal) continue;
    const distance = Math.abs(position - targetPosition);
    if (distance < bestDistance) {
      bestDistance = distance;
      target = room;
    }
    position += 1;
  }
  if (!target) return { rooms, edges }; // degenerate graph, nothing to splice before

  const rest = {
    id: 'room-rest', kind: 'safe_rest', isGoal: false, setpieceId: null, outcomeSlotId: null,
    locationTag: locationTagAt(seed, 'rest'), artVariant: roomArtVariantAt(seed, 'rest')
  };
  const newRooms = { ...rooms, [rest.id]: rest };
  const newEdges = { ...edges, [rest.id]: [target.id] };
  for (const [parentId, children] of Object.entries(edges)) {
    if (children.includes(target.id)) {
      newEdges[parentId] = children.map((id) => (id === target.id ? rest.id : id));
    }
  }
  return { rooms: newRooms, edges: newEdges };
}

// Tunable — how often a branch edge gets an optional pregenerated hidden
// extra (a shortcut past the next room, or a detour room spliced in front
// of it). Neither counts against roomCount, same treatment as the
// mid-dungeon rest room.
export const HIDDEN_PATH_CHANCE = 0.2;

/**
 * Attach pregenerated-but-hidden shortcuts/detours to a graph's non-entry,
 * non-goal rooms (#93 — replaces runtime insert_after/remove_next
 * splicing; #156 — fixes the face-budget overflow and layout/build
 * unreachability the original version of this function had). A shortcut
 * edge skips the immediate next room on a branch; a detour room is spliced
 * hidden between two already-adjacent rooms. At most ONE hidden extra per
 * room, decided once per candidate room (not once per edge), and only
 * when the room (and, for a shortcut, its target) has a spare outgoing
 * face left after its real exits (`exitFaceForIndex` only has 3 slots:
 * south/east/west).
 *
 * What's actually hidden is the INCOMING connection, in `hiddenEdges`, not
 * a detour room's own outgoing edge: `edges[detour.id] = [toId]` (and
 * `layoutEdges[detour.id]`) is a real entry in the live map — a detour
 * room needs SOME recorded path onward, live, or it's a guaranteed dead
 * end the moment it's revealed (caught by pre-flight review; do not
 * remove that line believing it belongs in `hiddenEdges` instead — an
 * earlier implementer made exactly this mistake). Normal traversal still
 * never reaches `detour.id` regardless, since nothing in the live `edges`
 * graph points INTO it until an outcome reveal adds that incoming edge —
 * see dungeon-runner.mjs's revealTravelTimeEffect.
 */
export function attachHiddenPaths({
  rooms, edges, seed,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = [],
}) {
  const hiddenRooms = new Set();
  const hiddenEdges = {};
  const hiddenIncomingByRoomId = {};
  const layoutEdges = Object.fromEntries(
    Object.entries(edges).map(([id, children]) => [id, [...children]]),
  );
  let detourSalt = 0;
  // #93 post-merge fix: dedicated occurrence counters, one per kind, never
  // shared with buildRoomGraph's own main-graph counters — a detour room
  // and a main-graph room drawing from the same pool must never collide
  // on the exact same setpiece.
  let detourPuzzleOccurrence = 0;
  let detourTrapOccurrence = 0;
  let detourNarrativeOccurrence = 0;
  let detourTreasureOccurrence = 0;

  for (const [fromId, children] of Object.entries(edges)) {
    const fromRoom = rooms[fromId];
    // #93 post-merge fix: exclude safe_rest — its own outcome always
    // resolves as the fixed 'rest_room_passed' effectKey, never
    // reduced_travel_time/extra_travel_time, so a hidden path attached to
    // it could never be revealed by anything — permanently sealing off
    // whatever it leads to.
    if (!fromRoom || fromRoom.isGoal || fromId === 'room-entry' || fromRoom.kind === 'safe_rest') continue;
    if (children.length === 0 || children.length > 2) continue; // no spare face

    const r = splitmix32(seedFromString(`${seed}-hidden-${fromId}`))();
    if (r >= HIDDEN_PATH_CHANCE) continue;

    // Anchor on the room's first real child — deterministic, and this
    // function only needs *a* nearby room to build a shortcut/detour off
    // of, not a specific one.
    const toId = children[0];
    const toRoom = rooms[toId];
    if (!toRoom || toRoom.isGoal) continue;

    const wantsDetour = splitmix32(seedFromString(`${seed}-hidden-kind-${fromId}`))() < 0.5;
    if (wantsDetour) {
      const kind = roomKindAt(seed, `detour-${detourSalt}`);
      // #93 post-merge fix: a detour room needs real content — with
      // outcomeSlotId null, markRoomOutcome no-ops forever on it and the
      // party is stuck the moment they walk in. Same per-kind assignment
      // buildRoomGraph's own makeRoom uses, but with dedicated
      // 'detour-*-setpiece-order' salts and dedicated occurrence counters
      // so this pool draw stays independent of makeRoom's own.
      const setpieceId =
        kind === 'puzzle' ? setpieceAt(seed, detourPuzzleOccurrence++, puzzleSetpieceIds, 'detour-puzzle-setpiece-order')
        : kind === 'trap' ? setpieceAt(seed, detourTrapOccurrence++, trapSetpieceIds, 'detour-trap-setpiece-order')
        : kind === 'narrative' ? setpieceAt(seed, detourNarrativeOccurrence++, narrativeSetpieceIds, 'detour-narrative-setpiece-order')
        : kind === 'treasure' ? setpieceAt(seed, detourTreasureOccurrence++, treasureSetpieceIds, 'detour-treasure-setpiece-order')
        : null;
      const outcomeSlot = outcomeSlotAt(seed, `detour-${detourSalt}`);
      const detour = {
        id: `room-detour-${detourSalt}`, kind,
        isGoal: false, setpieceId, outcomeSlotId: outcomeSlot.id,
        locationTag: locationTagAt(seed, `detour-${detourSalt}`),
        artVariant: roomArtVariantAt(seed, `detour-${detourSalt}`)
      };
      detourSalt += 1;
      rooms[detour.id] = detour;
      edges[detour.id] = [toId];
      layoutEdges[detour.id] = [toId];
      hiddenRooms.add(detour.id);
      hiddenEdges[fromId] = [detour.id];
      layoutEdges[fromId] = [...children, detour.id];
    } else {
      // A shortcut needs a room beyond `toId` to skip TO — only attach one
      // when `toId` itself has an onward edge to skip past, that target
      // isn't the goal (pre-flight fix: a shortcut's target is ONE HOP
      // PAST `toId` — `edges[toId][0]` — so `toRoom.isGoal` above does NOT
      // already cover this; a room adjacent to goal could otherwise
      // shortcut straight onto it), and the target has a spare incoming
      // face left (own real exit count <= 2, since it already uses one
      // face for its real incoming edge and needs one more for this
      // shortcut's second incoming door).
      const skipTarget = edges[toId]?.[0];
      const skipTargetRoom = skipTarget ? rooms[skipTarget] : null;
      if (!skipTarget || !skipTargetRoom || skipTargetRoom.isGoal) continue;
      if ((edges[skipTarget]?.length ?? 0) > 2) continue;
      hiddenEdges[fromId] = [skipTarget];
      (hiddenIncomingByRoomId[skipTarget] ??= []).push(fromId);
      // Shortcuts don't add a new node, so layoutEdges is untouched here —
      // the target's rank/col already comes from its real parent.
    }
  }

  return { rooms, edges, hiddenRooms, hiddenEdges, layoutEdges, hiddenIncomingByRoomId };
}

/**
 * Resolve a reduced_travel_time/extra_travel_time outcome against a
 * pregenerated graph (#93) — reveals whatever hidden shortcut/detour edge
 * generation attached to `roomId` (attachHiddenPaths), if any. Never
 * builds or removes a room; the target was already constructed at
 * scene-creation time. A no-op if nothing was hidden there.
 */
// Data-only reveal — see #156, filed during #93 pre-flight review: no
// door/room geometry is built for the revealed edge anywhere in this
// plan yet. Deliberately deferred; do not block this task on it.
export function revealTravelTimeEffect({ edges, hiddenEdges }, roomId, effectKey) {
  if (effectKey !== 'reduced_travel_time' && effectKey !== 'extra_travel_time') {
    return { edges, hiddenEdges, revealedRoomId: null };
  }
  const hidden = hiddenEdges[roomId];
  if (!hidden?.length) return { edges, hiddenEdges, revealedRoomId: null };
  const newHiddenEdges = { ...hiddenEdges };
  delete newHiddenEdges[roomId];
  return {
    edges: { ...edges, [roomId]: [...(edges[roomId] ?? []), ...hidden] },
    hiddenEdges: newHiddenEdges,
    revealedRoomId: hidden[0], // attachHiddenPaths (#156) guarantees at most one hidden target per room
  };
}
