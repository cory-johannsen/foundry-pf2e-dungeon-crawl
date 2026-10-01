// #415 Chunk 3: the plan-aware parameters are opt-in. Omitting them (or passing
// them as undefined) must reproduce today's output exactly. GOLDEN_DIGEST was
// computed from the geometry functions on main BEFORE Chunk 3 touched them
// (sha256 over the 500-seed sweep's buildEdgeCorridor results, outgoingMarginOffset,
// findPriorityCollision, pendingForeignMarginOpenings and roomEnclosureWalls).
// If this fails after an unrelated change to default geometry, that change is
// real: re-baseline deliberately, not casually.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  outgoingMarginOffset, findPriorityCollision, pendingForeignMarginOpenings, roomEnclosureWalls,
  exitFaceForIndex, incomingConnectionsFor,
} from '../scripts/dungeon-layout.mjs';
import { forEachEdge, buildSweepLayout, legacyExitSelector } from './helpers/layout-sweep.mjs';

const SEEDS = 500;
const NO_REST_ROOM = { restRoom: false }; // the digest predates the sweep mirroring insertRestRoom
const GOLDEN_DIGEST = 'f179b4c09a584cd2df8fc459b7647aa5207f65b65e45285967c6cd1cecf2f478';

function digest(explicitUndefined) {
  const h = createHash('sha256');
  const put = (tag, v) => h.update(`${tag}:${JSON.stringify(v ?? null)}\n`);
  forEachEdge(SEEDS, legacyExitSelector, ({ layout, sourceId, toId, face, result, toSlot }) => {
    put('corridor', result);
    const incFace = layout.incFace[toId];
    const args = [
      layout.seed, sourceId, toId, face, layout.rect[sourceId], layout.pos[sourceId], layout.pos[toId], layout.occ, incFace,
    ];
    put('margin', explicitUndefined ? outgoingMarginOffset(...args, undefined) : outgoingMarginOffset(...args));
    put('slot', toSlot);
  }, NO_REST_ROOM);
  for (let i = 0; i < SEEDS; i += 1) {
    const L = buildSweepLayout(i, NO_REST_ROOM);
    for (const id of Object.keys(L.rooms)) {
      const { rank, col } = L.pos[id];
      const conns = incomingConnectionsFor(L.layoutEdges, id, L.hiddenIncomingByRoomId);
      const pArgs = [L.seed, id, rank, col, conns, L.pos, L.occ, L.incFace[id]];
      put('prio', explicitUndefined ? findPriorityCollision(...pArgs, undefined) : findPriorityCollision(...pArgs));
      const fArgs = [L.seed, id, rank, col, L.edges, L.pos, L.incFace, L.occ, L.layoutEdges, L.hiddenIncomingByRoomId];
      put('foreign', explicitUndefined
        ? pendingForeignMarginOpenings(...fArgs, undefined, undefined)
        : pendingForeignMarginOpenings(...fArgs));
      const kids = L.edges[id] ?? [];
      const outgoingFaces = [...new Set(kids.map((_, k) => exitFaceForIndex(k, L.incFace[id])).filter(Boolean))];
      const eArgs = [L.seed, id, { incomingCount: conns.length, incomingFace: L.incFace[id], outgoingFaces }, L.rect[id]];
      put('enclosure', explicitUndefined
        ? roomEnclosureWalls(eArgs[0], eArgs[1], { ...eArgs[2], doorSpansByFace: undefined }, eArgs[3])
        : roomEnclosureWalls(...eArgs));
    }
  }
  return h.digest('hex');
}

describe('plan-aware geometry parameters are opt-in (#415)', () => {
  it('omitting them reproduces the pre-Chunk-3 output over the 500-seed sweep', () => {
    expect(digest(false)).toBe(GOLDEN_DIGEST);
  }, 120000);
  it('passing them explicitly as undefined is identical too', () => {
    expect(digest(true)).toBe(GOLDEN_DIGEST);
  }, 120000);
});
