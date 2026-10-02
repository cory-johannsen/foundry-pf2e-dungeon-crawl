// #555: at a room's south door the hallway sat one cell LEFT of the door and was not connected to it.
// Root cause: the corner connector's horizontal leg spans [min(x), min(x) + |dx|), so a leg heading WEST from a
// gap-START door point omits the door's own cell (the door span is [point, point + DOOR_WIDTH)); heading east it
// includes it. Fixed for layoutVersion >= 3 only (v1/v2 keep their pinned geometry).
import { describe, it, expect } from 'vitest';
import { buildSweepScene } from './helpers/scene-oracle.mjs';
import { doorCorridorMismatches } from './helpers/door-corridor-oracle.mjs';

const SEEDS = 500;
const southOut = (m) => m.kind === 'uncovered' && m.face === 'south' && !m.hidden && !m.flags.dungeonRevealDoorForSlot;

describe('door/corridor coverage: the live repro (#555)', () => {
  it('sweep-0 v3: room-room-entry-1 south door [328,329) has a corridor tile in its own column', async () => {
    const { layout, scene } = await buildSweepScene(0, 3);
    const door = scene.walls.find((w) => w.door && w.flags['pf2e-dungeon-crawl'].dungeonDoorFromRoomId === 'room-room-entry-1');
    expect(door.c).toEqual([32800, 1900, 32900, 1900]);
    // the first tile below the door sits in the door's own column (cell 328, center x 32850)
    expect(scene.tiles.some((t) => t.width === 100 && t.x === 32850 && t.y === 1950)).toBe(true);
    expect(doorCorridorMismatches(layout, scene).filter(southOut)).toEqual([]);
  });
});

const tally = async (version) => {
  const t = { total: 0, southOut: 0, northReveal: 0, westFace: 0 };
  for (let i = 0; i < SEEDS; i += 1) {
    const { layout, scene } = await buildSweepScene(i, version);
    for (const m of doorCorridorMismatches(layout, scene)) {
      t.total += 1;
      if (southOut(m)) t.southOut += 1;
      if (m.face === 'north' && m.kind === 'uncovered') t.northReveal += 1;
      if (m.face === 'west') t.westFace += 1;
    }
  }
  return t;
};

// Measured over sweep-0..499. Ratchets only fall.
// v3 before the #555 fix: total 1607 (south outgoing 1312, north reveal 70, west 172, ambiguous 28, ...).
describe('door/corridor coverage sweep (#555, layoutVersion 3)', () => {
  it('every south outgoing door and north reveal door has a corridor tile in its own column', async () => {
    const t = await tally(3);
    expect(t.southOut).toBe(0);
    expect(t.northReveal).toBe(0);
    // Residual: a WEST-face reveal door on a null-path fallback corridor (the corner shape assumes a north
    // face; #490's dead edges) and 28 reveal doors inside a foreign room's footprint (ambiguous).
    expect(t.westFace).toBeLessThanOrEqual(172);
    expect(t.total).toBeLessThanOrEqual(200);
  }, 300000);
});

// v1/v2 keep the bug (pinned geometry, see the file header); characterized, never loosened.
describe('door/corridor coverage sweep (#555, v1/v2 characterization: bug NOT fixed there)', () => {
  it('v2 stays at its measured baseline', async () => {
    const t = await tally(2);
    expect(t.total).toBeLessThanOrEqual(1704);
    expect(t.southOut).toBeLessThanOrEqual(1289);
  }, 300000);
  it('v1 stays at its measured baseline', async () => {
    const t = await tally(1);
    expect(t.total).toBeLessThanOrEqual(2677);
    expect(t.southOut).toBeLessThanOrEqual(1264);
  }, 300000);
});
