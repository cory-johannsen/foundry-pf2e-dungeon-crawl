import { describe, it, expect } from 'vitest';
import { roomTileName } from '../scripts/dungeon-retreat.mjs';
import { buildRoomAtGraphNode } from '../scripts/dungeon-scene.mjs';

const KINDS = {
  safe_entry: 'Entry', safe_rest: 'Rest', skill_challenge: 'Skill challenge', combat: 'Combat',
  trap: 'Trap', puzzle: 'Puzzle', narrative: 'Narrative', treasure: 'Treasure',
};

describe('roomTileName (#574)', () => {
  for (const [kind, word] of Object.entries(KINDS)) {
    it(`names a ${kind} room`, () => {
      expect(roomTileName(kind, 2, 1)).toBe(`${word} (rank 2, col 1)`);
    });
  }
  it('names the goal room Goal regardless of kind', () => {
    expect(roomTileName('combat', 5, 0, true)).toBe('Goal (rank 5, col 0)');
  });
  it('falls back when rank/col are missing', () => {
    expect(roomTileName('trap', undefined, undefined)).toBe('Trap');
    expect(roomTileName('trap', 3, undefined)).toBe('Trap');
  });
  it('falls back to a generic name for an unknown or missing kind', () => {
    expect(roomTileName(undefined, 1, 2)).toBe('Room (rank 1, col 2)');
    expect(roomTileName('weird', 1, 2)).toBe('Room (rank 1, col 2)');
  });
  it('localises through an injected i18n', () => {
    const i18n = { localize: (k) => `L:${k}`, format: (k, d) => `${k}|${d.kind}|${d.rank ?? ''}|${d.col ?? ''}` };
    expect(roomTileName('trap', 3, 1, false, i18n)).toBe('PF2EDC.Dungeon.RoomTile.Name|L:PF2EDC.Dungeon.RoomTile.Kind.trap|3|1');
    expect(roomTileName('trap', 3, 1, true, i18n)).toBe('PF2EDC.Dungeon.RoomTile.Name|L:PF2EDC.Dungeon.RoomTile.Goal|3|1');
  });
});

function makeFakeScene() {
  const tiles = []; const walls = []; let n = 0;
  return {
    id: 's', walls, tiles,
    async createEmbeddedDocuments(type, docs) {
      return docs.map((d) => {
        const doc = { id: `${type}-${++n}`, ...d, getFlag: (m, k) => d.flags?.[m]?.[k] };
        if (type === 'Tile') tiles.push(doc);
        if (type === 'Wall') walls.push(doc);
        return doc;
      });
    },
    async deleteEmbeddedDocuments() {},
  };
}

describe('buildRoomAtGraphNode names the floor tile (#574)', () => {
  globalThis.CONST = {
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 }, WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 }, WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  };
  const cases = [...Object.entries(KINDS).map(([k, w]) => [k, false, `${w} (rank 1, col 0)`]), ['combat', true, 'Goal (rank 1, col 0)']];
  for (const [kind, isGoal, expected] of cases) {
    it(`${kind}${isGoal ? ' (goal)' : ''}`, async () => {
      const scene = makeFakeScene();
      await buildRoomAtGraphNode(scene, 'r1', {
        rank: 1, col: 0, kind, isGoal, seed: 's',
        layoutPositionByRoomId: { r1: { rank: 1, col: 0 } }, occupiedCells: { '1,0': 'r1' },
      });
      const tile = scene.tiles.find((t) => t.getFlag('pf2e-dungeon-crawl', 'dungeonRoomBuilt') === 'r1');
      expect(tile.name).toBe(expected);
    });
  }
});
