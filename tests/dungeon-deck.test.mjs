import { describe, it, expect } from 'vitest';
import {
  buildRoomSequence,
  buildRoomGraph,
  attachHiddenPaths,
  resolveRoomOutcome,
  applySequenceMutation,
  findOutcomeTemplate,
  OUTCOME_SLOT_TEMPLATES,
  depthBiasFor,
  MAX_DEPTH_BIAS,
  locationTagAt,
  LOCATION_TAGS,
  roomArtVariantAt,
  ROOM_ART_VARIANTS,
  MID_DUNGEON_REST_THRESHOLD,
  ROOM_KIND_WEIGHTS,
  roomKindAt,
  lootGpForTreasureRoom,
  TREASURE_GP_PER_LEVEL,
  seededPick,
  treasureRoomItemTableName,
  TREASURE_ROOM_CATEGORY_WEIGHTS,
  EXIT_COUNT_WEIGHTS,
  exitCountAt
} from '../scripts/dungeon-deck.mjs';
import { nthLevelTableName, VALUABLE_TIERS } from '../scripts/treasure.mjs';

function sequenceRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('buildRoomSequence', () => {
  it('ends with a combat goal room carrying no outcome slot', () => {
    const rooms = buildRoomSequence({ seed: 'alpha', roomCount: 6 });
    const goal = rooms.at(-1);
    expect(goal.isGoal).toBe(true);
    expect(goal.kind).toBe('combat');
    expect(goal.outcomeSlotId).toBeNull();
    expect(goal.setpieceId).toBeNull();
  });

  it('respects roomCount, including the goal room but not the prepended safe entry', () => {
    const rooms = buildRoomSequence({ seed: 'alpha', roomCount: 4 });
    expect(rooms).toHaveLength(5); // 4 + the entry
    expect(rooms.slice(1, 4).every((r) => !r.isGoal)).toBe(true);
  });

  it('always starts with a safe entry room, never counted in roomCount', () => {
    const rooms = buildRoomSequence({ seed: 'alpha', roomCount: 4 });
    const entry = rooms[0];
    expect(entry.kind).toBe('safe_entry');
    expect(entry.isGoal).toBe(false);
    expect(entry.outcomeSlotId).toBeNull();
    expect(entry.setpieceId).toBeNull();
    // roomCount real rooms follow it, unaffected by its presence.
    expect(rooms.length - 1).toBe(4);
  });

  it('rejects a roomCount below 2', () => {
    expect(() => buildRoomSequence({ seed: 'alpha', roomCount: 1 })).toThrow();
    expect(() => buildRoomSequence({ seed: 'alpha', roomCount: 0 })).toThrow();
  });

  it('is deterministic for the same seed', () => {
    const a = buildRoomSequence({ seed: 'alpha', roomCount: 8, puzzleSetpieceIds: ['x', 'y', 'z'] });
    const b = buildRoomSequence({ seed: 'alpha', roomCount: 8, puzzleSetpieceIds: ['x', 'y', 'z'] });
    expect(a).toEqual(b);
  });

  it('produces different sequences for different seeds', () => {
    const a = buildRoomSequence({ seed: 'alpha', roomCount: 8 });
    const b = buildRoomSequence({ seed: 'beta', roomCount: 8 });
    expect(a).not.toEqual(b);
  });

  it('every non-goal, non-entry, non-rest room carries an outcome slot that resolves to a real template', () => {
    const rooms = buildRoomSequence({ seed: 'gamma', roomCount: 10 });
    for (const room of rooms.filter((r) => !r.isGoal && r.kind !== 'safe_entry' && r.kind !== 'safe_rest')) {
      expect(findOutcomeTemplate(room.outcomeSlotId)).not.toBeNull();
    }
  });

  describe('mid-dungeon rest room (ITEM-5)', () => {
    it('adds no rest room at or below the threshold', () => {
      for (const roomCount of [2, 4, MID_DUNGEON_REST_THRESHOLD]) {
        const rooms = buildRoomSequence({ seed: 'rest-a', roomCount });
        expect(rooms.some((r) => r.kind === 'safe_rest')).toBe(false);
        // Not counted against roomCount either way — entry + roomCount rooms.
        expect(rooms).toHaveLength(roomCount + 1);
      }
    });

    it('adds exactly one safe rest room above the threshold, uncounted against roomCount', () => {
      for (const roomCount of [MID_DUNGEON_REST_THRESHOLD + 1, 10, 20]) {
        const rooms = buildRoomSequence({ seed: 'rest-b', roomCount });
        const restRooms = rooms.filter((r) => r.kind === 'safe_rest');
        expect(restRooms).toHaveLength(1);
        expect(restRooms[0].isGoal).toBe(false);
        expect(restRooms[0].outcomeSlotId).toBeNull();
        expect(restRooms[0].setpieceId).toBeNull();
        // entry + roomCount real/goal rooms + 1 bonus rest room.
        expect(rooms).toHaveLength(roomCount + 2);
      }
    });

    it('lands the rest room roughly at the midpoint, strictly between the entry and the goal', () => {
      const rooms = buildRoomSequence({ seed: 'rest-c', roomCount: 12 });
      const restIndex = rooms.findIndex((r) => r.kind === 'safe_rest');
      expect(restIndex).toBeGreaterThan(0);
      expect(restIndex).toBeLessThan(rooms.length - 1);
      // Roughly balanced: neither half is more than a couple rooms longer
      // than the other.
      const before = restIndex; // rooms strictly before it, excluding the entry itself is still counted as "before" here
      const after = rooms.length - 1 - restIndex; // rooms strictly after it, excluding the rest room itself
      expect(Math.abs(before - after)).toBeLessThanOrEqual(2);
    });

    it('still produces the correct goal room and total length regardless of the rest room', () => {
      const rooms = buildRoomSequence({ seed: 'rest-d', roomCount: 9 });
      const goal = rooms.at(-1);
      expect(goal.isGoal).toBe(true);
      expect(goal.kind).toBe('combat');
      expect(rooms.filter((r) => r.isGoal)).toHaveLength(1);
    });
  });

  it('gives every room a locationTag, including the goal room', () => {
    const rooms = buildRoomSequence({ seed: 'epsilon', roomCount: 7 });
    for (const room of rooms) {
      expect(LOCATION_TAGS).toContain(room.locationTag);
    }
  });

  it('gives every room an artVariant in range, including the goal room', () => {
    const rooms = buildRoomSequence({ seed: 'epsilon', roomCount: 7 });
    for (const room of rooms) {
      expect(room.artVariant).toBeGreaterThanOrEqual(0);
      expect(room.artVariant).toBeLessThan(ROOM_ART_VARIANTS);
    }
  });

  it('only assigns a set-piece to puzzle rooms, and only when puzzle set-pieces are supplied (#32)', () => {
    const withPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, puzzleSetpieceIds: ['p1', 'p2'] });
    expect(withPieces.some((r) => r.kind === 'puzzle')).toBe(true);
    for (const room of withPieces) {
      if (room.kind === 'puzzle') expect(['p1', 'p2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, puzzleSetpieceIds: [] });
    for (const room of withoutPieces) expect(room.setpieceId).toBeNull();
  });

  it('only assigns a set-piece to trap rooms, and only when trap set-pieces are supplied (#32)', () => {
    const withPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, trapSetpieceIds: ['t1', 't2'] });
    expect(withPieces.some((r) => r.kind === 'trap')).toBe(true);
    for (const room of withPieces) {
      if (room.kind === 'trap') expect(['t1', 't2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, trapSetpieceIds: [] });
    for (const room of withoutPieces) expect(room.setpieceId).toBeNull();
  });

  it('only assigns a set-piece to narrative rooms, and only when narrative set-pieces are supplied (#165)', () => {
    // seed 'gamma' + roomCount 12 is confirmed (roomKindAt) to include at
    // least one narrative-kind room, so this actually exercises the
    // assignment rather than passing vacuously.
    const withPieces = buildRoomSequence({
      seed: 'gamma', roomCount: 12, narrativeSetpieceIds: ['n1', 'n2']
    });
    expect(withPieces.some((r) => r.kind === 'narrative')).toBe(true);
    for (const room of withPieces) {
      if (room.kind === 'narrative') expect(['n1', 'n2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'gamma', roomCount: 12, narrativeSetpieceIds: [] });
    for (const room of withoutPieces) expect(room.setpieceId).toBeNull();
  });

  it('only assigns a set-piece to treasure rooms, and only when treasure set-pieces are supplied (#89)', () => {
    // seed 'gamma' + roomCount 12 is confirmed (roomKindAt) to include at
    // least one treasure-kind room, so this actually exercises the
    // assignment rather than passing vacuously.
    const withPieces = buildRoomSequence({
      seed: 'gamma', roomCount: 12, treasureSetpieceIds: ['tr1', 'tr2']
    });
    expect(withPieces.some((r) => r.kind === 'treasure')).toBe(true);
    for (const room of withPieces) {
      if (room.kind === 'treasure') expect(['tr1', 'tr2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'gamma', roomCount: 12, treasureSetpieceIds: [] });
    for (const room of withoutPieces) expect(room.setpieceId).toBeNull();
  });

  it('draws puzzle, trap, narrative and treasure set-pieces from independent pools (#32, #165, #89)', () => {
    const rooms = buildRoomSequence({
      seed: 'gamma',
      roomCount: 12,
      puzzleSetpieceIds: ['p1', 'p2'],
      trapSetpieceIds: ['t1', 't2'],
      narrativeSetpieceIds: ['n1', 'n2'],
      treasureSetpieceIds: ['tr1', 'tr2']
    });
    expect(rooms.some((r) => r.kind === 'puzzle')).toBe(true);
    expect(rooms.some((r) => r.kind === 'trap')).toBe(true);
    expect(rooms.some((r) => r.kind === 'narrative')).toBe(true);
    expect(rooms.some((r) => r.kind === 'treasure')).toBe(true);
    for (const room of rooms) {
      if (room.kind === 'puzzle') expect(['p1', 'p2']).toContain(room.setpieceId);
      else if (room.kind === 'trap') expect(['t1', 't2']).toContain(room.setpieceId);
      else if (room.kind === 'narrative') expect(['n1', 'n2']).toContain(room.setpieceId);
      else if (room.kind === 'treasure') expect(['tr1', 'tr2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
  });
});

describe('resolveRoomOutcome', () => {
  it('reads the reward branch on success and the ruin branch on failure, for every template', () => {
    for (const template of OUTCOME_SLOT_TEMPLATES) {
      const reward = resolveRoomOutcome(template, true);
      expect(reward.effectKey).toBe(template.reward.key);
      expect(reward.mutation).toBe(template.reward.mutation ?? null);

      const ruin = resolveRoomOutcome(template, false);
      expect(ruin.effectKey).toBe(template.ruin.key);
      expect(ruin.mutation).toBe(template.ruin.mutation ?? null);
    }
  });
});

describe('applySequenceMutation', () => {
  const rooms = () => buildRoomSequence({ seed: 'seq', roomCount: 5 });

  it('remove_next drops the following room', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 0, 'remove_next', { seed: 'seq' });
    expect(after).toHaveLength(before.length - 1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).toBe(before[2].id);
  });

  it('remove_next is a no-op when the next room is the goal room', () => {
    const before = rooms();
    const lastNonGoalIndex = before.length - 2;
    const after = applySequenceMutation(before, lastNonGoalIndex, 'remove_next', { seed: 'seq' });
    expect(after).toBe(before);
  });

  it('insert_after adds one room without disturbing the goal room at the end', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 1, 'insert_after', { seed: 'seq' });
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1).isGoal).toBe(true);
    expect(after.at(-1).id).toBe(before.at(-1).id);
    expect(after[2].isGoal).toBe(false);
  });

  it('the inserted room carries a locationTag like any other room', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 1, 'insert_after', { seed: 'seq' });
    expect(LOCATION_TAGS).toContain(after[2].locationTag);
  });

  it('the inserted room carries an artVariant like any other room', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 1, 'insert_after', { seed: 'seq' });
    expect(after[2].artVariant).toBeGreaterThanOrEqual(0);
    expect(after[2].artVariant).toBeLessThan(ROOM_ART_VARIANTS);
  });

  it('an unrecognised mutation is a no-op', () => {
    const before = rooms();
    expect(applySequenceMutation(before, 0, null, { seed: 'seq' })).toBe(before);
    expect(applySequenceMutation(before, 0, 'rerun_encounter', { seed: 'seq' })).toBe(before);
  });

  it('an inserted treasure room draws from treasureSetpieceIds when supplied (#89)', () => {
    // seed/currentIndex/rooms.length picked (by probing roomKindAt) so the
    // inserted room actually lands on kind 'treasure' — otherwise this
    // would pass vacuously the same way the buildRoomSequence pool tests
    // above guard against.
    let found = null;
    for (let seed = 0; seed < 50 && !found; seed += 1) {
      const before = buildRoomSequence({ seed: `insert-treasure-${seed}`, roomCount: 5 });
      const after = applySequenceMutation(before, 1, 'insert_after', {
        seed: `insert-treasure-${seed}`,
        treasureSetpieceIds: ['tr1', 'tr2'],
      });
      if (after[2]?.kind === 'treasure') found = after[2];
    }
    expect(found).not.toBeNull();
    expect(['tr1', 'tr2']).toContain(found.setpieceId);
  });
});

describe('depthBiasFor', () => {
  it('is zero at room 0', () => {
    expect(depthBiasFor({ physicalSlot: 0, roomCount: 8, isGoal: false })).toBe(0);
  });

  it('always gives the goal room the maximum bias, regardless of dungeon length', () => {
    expect(depthBiasFor({ physicalSlot: 1, roomCount: 2, isGoal: true })).toBe(MAX_DEPTH_BIAS);
    expect(depthBiasFor({ physicalSlot: 19, roomCount: 20, isGoal: true })).toBe(MAX_DEPTH_BIAS);
  });

  it('is monotonically non-decreasing across a dungeon\'s non-goal rooms', () => {
    const roomCount = 9;
    let previous = -Infinity;
    for (let slot = 0; slot < roomCount - 1; slot += 1) {
      const bias = depthBiasFor({ physicalSlot: slot, roomCount, isGoal: false });
      expect(bias).toBeGreaterThanOrEqual(previous);
      previous = bias;
    }
  });

  it('never exceeds MAX_DEPTH_BIAS', () => {
    for (let slot = 0; slot < 10; slot += 1) {
      expect(depthBiasFor({ physicalSlot: slot, roomCount: 10, isGoal: false })).toBeLessThanOrEqual(MAX_DEPTH_BIAS);
    }
  });
});

describe('ROOM_KIND_WEIGHTS', () => {
  it('includes a treasure kind (#169)', () => {
    expect(ROOM_KIND_WEIGHTS.some((w) => w.kind === 'treasure')).toBe(true);
  });

  it('splits puzzle and trap into independent kinds with an even 1/1 weight (#32)', () => {
    expect(ROOM_KIND_WEIGHTS.some((w) => w.kind === 'puzzle_or_trap')).toBe(false);
    const puzzle = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'puzzle');
    const trap = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'trap');
    expect(puzzle?.weight).toBe(1);
    expect(trap?.weight).toBe(1);
  });

  it('keeps the combined puzzle+trap weight, and the overall total, unchanged from before the split (#32)', () => {
    const puzzle = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'puzzle');
    const trap = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'trap');
    expect(puzzle.weight + trap.weight).toBe(2);
    const total = ROOM_KIND_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBe(12);
  });
});

describe('roomKindAt', () => {
  it('can produce a treasure room', () => {
    const kinds = new Set();
    for (let i = 0; i < 200; i += 1) kinds.add(roomKindAt('probe-seed', i));
    expect(kinds).toContain('treasure');
  });

  it('can produce a puzzle room and a trap room as independent kinds (#32)', () => {
    const kinds = new Set();
    for (let i = 0; i < 200; i += 1) kinds.add(roomKindAt('probe-seed', i));
    expect(kinds).toContain('puzzle');
    expect(kinds).toContain('trap');
    expect(kinds.has('puzzle_or_trap')).toBe(false);
  });
});

describe('lootGpForTreasureRoom', () => {
  it('follows the documented placeholder formula', () => {
    const args = { partyLevel: 5, physicalSlot: 0, roomCount: 8, isGoal: false };
    const expected = Math.round(5 * TREASURE_GP_PER_LEVEL);
    expect(lootGpForTreasureRoom(args)).toBe(expected);
  });

  it('is 0 for party level 0', () => {
    expect(lootGpForTreasureRoom({ partyLevel: 0, physicalSlot: 0, roomCount: 8, isGoal: false })).toBe(0);
  });

  it('scales up with party level', () => {
    const low = lootGpForTreasureRoom({ partyLevel: 2, physicalSlot: 0, roomCount: 8, isGoal: false });
    const high = lootGpForTreasureRoom({ partyLevel: 10, physicalSlot: 0, roomCount: 8, isGoal: false });
    expect(high).toBeGreaterThan(low);
  });

  it('doubles the base amount at maximum depth bias (the goal room)', () => {
    const base = lootGpForTreasureRoom({ partyLevel: 6, physicalSlot: 0, roomCount: 8, isGoal: false });
    const atGoal = lootGpForTreasureRoom({ partyLevel: 6, physicalSlot: 7, roomCount: 8, isGoal: true });
    expect(atGoal).toBe(base * 2);
  });

  it('is monotonically non-decreasing with depth for a fixed party level', () => {
    const roomCount = 9;
    let previous = -Infinity;
    for (let slot = 0; slot < roomCount - 1; slot += 1) {
      const gp = lootGpForTreasureRoom({ partyLevel: 4, physicalSlot: slot, roomCount, isGoal: false });
      expect(gp).toBeGreaterThanOrEqual(previous);
      previous = gp;
    }
  });
});

describe('treasureRoomItemTableName', () => {
  const args = { partyLevel: 5, physicalSlot: 0, roomCount: 8, isGoal: false };

  it('lists permanent, valuable and consumable categories', () => {
    expect(TREASURE_ROOM_CATEGORY_WEIGHTS.map((w) => w.category)).toEqual([
      'permanent',
      'valuable',
      'consumable',
    ]);
  });

  it('always returns a tableName regardless of rng — a treasure room always drops something', () => {
    expect(typeof treasureRoomItemTableName({ ...args, rng: () => 0 })).toBe('string');
    expect(typeof treasureRoomItemTableName({ ...args, rng: () => 0.999999 })).toBe('string');
  });

  it('picks the permanent-item table when the category roll is low', () => {
    const result = treasureRoomItemTableName({ ...args, rng: sequenceRng([0]) });
    expect(result).toBe(nthLevelTableName('permanent', args.partyLevel));
  });

  it('picks a valuable tier table when the category roll is mid-range', () => {
    const result = treasureRoomItemTableName({ ...args, rng: sequenceRng([0.5]) });
    expect(VALUABLE_TIERS.some((t) => t.name === result)).toBe(true);
  });

  it('picks the consumable table when the category roll is high', () => {
    const result = treasureRoomItemTableName({ ...args, rng: sequenceRng([0.9]) });
    expect(result).toBe(nthLevelTableName('consumable', args.partyLevel));
  });

  it('uses partyLevel for the Nth-Level lookup', () => {
    const result = treasureRoomItemTableName({
      partyLevel: 1,
      physicalSlot: 0,
      roomCount: 8,
      isGoal: false,
      rng: sequenceRng([0]),
    });
    expect(result).toBe('1st-Level Permanent Items');
  });
});

describe('locationTagAt', () => {
  it('always returns a member of LOCATION_TAGS', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(LOCATION_TAGS).toContain(locationTagAt('seed', i));
    }
  });

  it('is deterministic for the same seed and index', () => {
    expect(locationTagAt('alpha', 3)).toBe(locationTagAt('alpha', 3));
  });

  it('varies across indices (not the same tag every time)', () => {
    const tags = new Set(Array.from({ length: 20 }, (_, i) => locationTagAt('alpha', i)));
    expect(tags.size).toBeGreaterThan(1);
  });
});

describe('seededPick', () => {
  it('is deterministic for the same seed and salt', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(seededPick('alpha', 'lost-gear-room-3', items)).toBe(seededPick('alpha', 'lost-gear-room-3', items));
  });

  it('always returns one of the given items', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    for (let i = 0; i < 20; i += 1) {
      expect(items).toContain(seededPick('seed', `salt-${i}`, items));
    }
  });

  it('picks uniformly across items with no explicit weight', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const picks = new Set(Array.from({ length: 30 }, (_, i) => seededPick('alpha', `salt-${i}`, items).id));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('returns the single item when only one is given', () => {
    const only = [{ id: 'only' }];
    expect(seededPick('seed', 'salt', only)).toBe(only[0]);
  });
});

describe('roomArtVariantAt', () => {
  it('always returns an index in [0, ROOM_ART_VARIANTS)', () => {
    for (let i = 0; i < 20; i += 1) {
      const variant = roomArtVariantAt('seed', i);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(ROOM_ART_VARIANTS);
    }
  });

  it('is deterministic for the same seed and index', () => {
    expect(roomArtVariantAt('alpha', 3)).toBe(roomArtVariantAt('alpha', 3));
  });

  it('varies across indices (not the same variant every time)', () => {
    const variants = new Set(Array.from({ length: 20 }, (_, i) => roomArtVariantAt('alpha', i)));
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe('exitCountAt', () => {
  it('always returns a count between 1 and 3', () => {
    for (let i = 0; i < 200; i += 1) {
      const count = exitCountAt('alpha', `room-${i}`);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('is deterministic for the same seed and room id', () => {
    expect(exitCountAt('alpha', 'room-3')).toBe(exitCountAt('alpha', 'room-3'));
  });

  it('skews toward 1-2 exits over 3, per EXIT_COUNT_WEIGHTS', () => {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < 1000; i += 1) counts[exitCountAt('alpha', `room-${i}`)] += 1;
    expect(counts[3]).toBeLessThan(counts[1]);
    expect(counts[3]).toBeLessThan(counts[2]);
  });
});

function parentsOf(edges, roomId) {
  return Object.entries(edges)
    .filter(([, children]) => children.includes(roomId))
    .map(([parent]) => parent);
}

describe('buildRoomGraph', () => {
  it('at the minimum roomCount (2), still produces a single-entrance goal', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'alpha', roomCount: 2 });
    const goal = Object.values(rooms).find((r) => r.isGoal);
    expect(goal).toBeDefined();
    expect(parentsOf(edges, goal.id)).toHaveLength(1);
  });

  it('the entry room has no incoming edges and is never the goal', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'alpha', roomCount: 8 });
    expect(parentsOf(edges, 'room-entry')).toHaveLength(0);
    expect(rooms['room-entry'].isGoal).toBe(false);
    expect(rooms['room-entry'].kind).toBe('safe_entry');
  });

  it('every non-entry, non-goal room has 1-3 outgoing edges', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'gamma', roomCount: 20 });
    for (const room of Object.values(rooms)) {
      if (room.id === 'room-entry' || room.isGoal) continue;
      expect(edges[room.id]?.length).toBeGreaterThanOrEqual(1);
      expect(edges[room.id]?.length).toBeLessThanOrEqual(3);
    }
  });

  it('the goal room always has exactly one incoming edge, even under heavy branching', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const { rooms, edges } = buildRoomGraph({ seed, roomCount: 25 });
      const goal = Object.values(rooms).find((r) => r.isGoal);
      expect(parentsOf(edges, goal.id)).toHaveLength(1);
    }
  });

  it('the goal room has exactly one incoming edge across a wide seed/roomCount sweep, including near-budget-exhaustion 3-exit rolls (#93 pre-flight fix regression — concrete repros before the fix: seed-0@3, seed-1@26)', () => {
    for (let n = 0; n < 60; n += 1) {
      const seed = `seed-${n}`;
      for (const roomCount of [2, 3, 4, 5, 6, 8, 12, 20, 26, 40]) {
        const { rooms, edges } = buildRoomGraph({ seed, roomCount });
        const goal = Object.values(rooms).find((r) => r.isGoal);
        expect(parentsOf(edges, goal.id)).toHaveLength(1);
      }
    }
  });

  it('is a DAG — no room is reachable from itself', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'delta', roomCount: 15 });
    for (const startId of Object.keys(rooms)) {
      const seen = new Set();
      const stack = [...(edges[startId] ?? [])];
      while (stack.length) {
        const id = stack.pop();
        expect(id).not.toBe(startId);
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...(edges[id] ?? []));
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const a = buildRoomGraph({ seed: 'alpha', roomCount: 10 });
    const b = buildRoomGraph({ seed: 'alpha', roomCount: 10 });
    expect(a).toEqual(b);
  });

  it('rejects a roomCount below 2', () => {
    expect(() => buildRoomGraph({ seed: 'alpha', roomCount: 1 })).toThrow();
  });
});

describe('attachHiddenPaths', () => {
  it('never attaches a hidden shortcut/detour touching the entry or goal room', () => {
    const graph = buildRoomGraph({ seed: 'alpha', roomCount: 12 });
    const { hiddenEdges, hiddenRooms } = attachHiddenPaths({ ...graph, seed: 'alpha' });
    expect(hiddenEdges['room-entry']).toBeUndefined();
    const goalId = Object.values(graph.rooms).find((r) => r.isGoal).id;
    expect(hiddenEdges[goalId]).toBeUndefined();
    for (const roomId of hiddenRooms) expect(graph.rooms[roomId].isGoal).toBe(false);
  });

  it('never attaches a hidden shortcut/detour TARGETING the goal room — a shortcut skips ONE HOP past toId, which can itself be adjacent to goal, even though toId itself is never goal (#93 pre-flight fix regression)', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `hidden-goal-target-${n}`;
      for (const roomCount of [3, 4, 5, 6, 8, 12, 20]) {
        const graph = buildRoomGraph({ seed, roomCount });
        const goalId = Object.values(graph.rooms).find((r) => r.isGoal).id;
        const { hiddenEdges } = attachHiddenPaths({ ...graph, seed });
        for (const targets of Object.values(hiddenEdges)) {
          expect(targets).not.toContain(goalId);
        }
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const graph = buildRoomGraph({ seed: 'beta', roomCount: 10 });
    const a = attachHiddenPaths({ ...graph, seed: 'beta' });
    const b = attachHiddenPaths({ ...graph, seed: 'beta' });
    expect([...a.hiddenRooms]).toEqual([...b.hiddenRooms]);
    expect(a.hiddenEdges).toEqual(b.hiddenEdges);
  });

  it('every room that already existed before the call keeps its own edges array untouched (#93 pre-flight fix — this must NOT deep-equal the whole edges object: attaching a detour legitimately ADDS a new key for the new detour room itself, per its own outgoing edge below)', () => {
    const graph = buildRoomGraph({ seed: 'gamma', roomCount: 14 });
    const before = JSON.parse(JSON.stringify(graph.edges));
    const { edges } = attachHiddenPaths({ ...graph, seed: 'gamma' });
    for (const roomId of Object.keys(before)) {
      expect(edges[roomId]).toEqual(before[roomId]);
    }
  });

  it('every detour room has a discoverable outgoing path to its toId (#93 pre-flight fix regression — a detour with no recorded edge anywhere is a guaranteed dead end the moment it is revealed)', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `detour-reachable-${n}`;
      for (const roomCount of [4, 6, 8, 12, 16, 20]) {
        const graph = buildRoomGraph({ seed, roomCount });
        const { edges, hiddenRooms } = attachHiddenPaths({ ...graph, seed });
        for (const detourId of hiddenRooms) {
          expect(Array.isArray(edges[detourId]) && edges[detourId].length > 0).toBe(true);
        }
      }
    }
  });
});
