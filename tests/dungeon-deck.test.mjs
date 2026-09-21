import { describe, it, expect } from 'vitest';
import {
  buildRoomSequence,
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
  TREASURE_GP_PER_LEVEL
} from '../scripts/dungeon-deck.mjs';

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
    const a = buildRoomSequence({ seed: 'alpha', roomCount: 8, setpieceIds: ['x', 'y', 'z'] });
    const b = buildRoomSequence({ seed: 'alpha', roomCount: 8, setpieceIds: ['x', 'y', 'z'] });
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

  it('only assigns a set-piece to puzzle_or_trap rooms, and only when set-pieces are supplied', () => {
    const withPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, setpieceIds: ['p1', 'p2'] });
    for (const room of withPieces) {
      if (room.kind === 'puzzle_or_trap') expect(['p1', 'p2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, setpieceIds: [] });
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

  it('draws puzzle_or_trap and narrative set-pieces from independent pools (#165)', () => {
    const rooms = buildRoomSequence({
      seed: 'gamma', roomCount: 12, setpieceIds: ['p1', 'p2'], narrativeSetpieceIds: ['n1', 'n2']
    });
    expect(rooms.some((r) => r.kind === 'puzzle_or_trap')).toBe(true);
    expect(rooms.some((r) => r.kind === 'narrative')).toBe(true);
    for (const room of rooms) {
      if (room.kind === 'puzzle_or_trap') expect(['p1', 'p2']).toContain(room.setpieceId);
      else if (room.kind === 'narrative') expect(['n1', 'n2']).toContain(room.setpieceId);
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
});

describe('roomKindAt', () => {
  it('can produce a treasure room', () => {
    const kinds = new Set();
    for (let i = 0; i < 200; i += 1) kinds.add(roomKindAt('probe-seed', i));
    expect(kinds).toContain('treasure');
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
