// #873 re-pin: reopening west-face reveal doors' buffer margins removed 68 sealed doors (1,201 -> 1,133); the header counts below predate it.
// #603: why 1,201 of the 1,704 dead edges of the shipped v3 pipeline are SEALED DOORS, measured on 500 seeds (reseed N = 20,
// topology routing, stubs, walls; the dead edges are those of the stub-free layout the stub/wall planner starts from).
// Findings these numbers pin (test-only, no runtime change):
//   1. A sealed door is a symptom: 99% of the sealed edges are NULL-PATH edges (no free route, so the scene draws a straight
//      fallback line through foreign cells; 1,040 of them because a co-parent holds the merge room's one north gate cell).
//      The covering wall is the co-parent's cell-margin wall (898), a transit-cell margin wall (160) or a plain flank (143).
//   2. Cutting an opening of exactly the door span in the covering wall makes 1 of 1,133 edges walkable: the corridor behind
//      the door crosses 4+ more walls (it is a fallback line through other rooms).
//   3. Even a PERFECT fix would raise rooms with 2+ live exits only from 1,164 to 1,218 (graph ceiling 1,241): the generator's
//      own graph is that linear. What it would buy is fewer dead-end rooms (1,293 -> 434) and lost rooms (313 -> 50).
// Numbers are exact and deterministic; if the generator, router or scene change they move: re-measure with
//   node tests/helpers/chosen-seeds.mjs c.json 500 && node tests/helpers/sealed-door-causes.mjs c.json 500
//   node tests/helpers/opening-prototype.mjs c.json 500 && node tests/helpers/upper-bound.mjs c.json 500
// and update them (never loosen a ratchet without a recorded reason).
import { describe, it, expect, beforeAll } from 'vitest';
import { chooseSeeds } from './helpers/chosen-seeds.mjs';
import { causeTable } from './helpers/sealed-door-causes.mjs';
import { openingExperiment } from './helpers/opening-prototype.mjs';
import { upperBound } from './helpers/upper-bound.mjs';

const SEEDS = 500;

describe('sealed-door dead edges of the v3 pipeline (500 seeds)', () => {
  let chosen;
  beforeAll(async () => { chosen = await chooseSeeds(SEEDS); }, 600_000);

  it('cause table: the sealed doors are null-path edges under a co-parent margin wall', async () => {
    const { total, causeCounts, tbl } = await causeTable(chosen, SEEDS);
    expect(causeCounts).toEqual({ sealedDoor: 1133, wallCut: 569 });
    expect(total).toBe(1133);
    // The scene draws a fallback line for 1,123 of them (path = what the SCENE draws, router verdict included).
    expect(tbl.path).toEqual({ 'null/gateHeld': 1040, 'null/routerUnresolvable': 83, 'found/adjacent': 10 });
    expect(tbl.incoming).toEqual({ 'merge(2+)': 1064, single: 69 });
    expect(tbl.doorsCovered).toEqual({ rev: 1131, 'out+rev': 1, out: 1 });
    // Every gate-held edge: the second parent is EAST of the merge room (target - source column < 0), merge room entered from the north.
    expect(Object.keys(tbl['gateHeld shape (target - source)']).sort()).toEqual(
      ['dr1 dc- in-north', 'dr2 dc+ in-north', 'dr2 dc- in-north', 'dr2 dc0 in-north', 'dr3 dc- in-north'],
    );
    expect(tbl['gateHeld shape (target - source)']['dr1 dc- in-north'] + tbl['gateHeld shape (target - source)']['dr2 dc- in-north']).toBe(984);
    expect(tbl.coverKinds).toEqual({
      cellMargin: 803, plainFlank: 143, transitMargin: 69, 'cellMargin+plainFlank': 95, 'plainFlank+transitMargin': 23,
    });
    // Whose wall covers it: always the co-parent's own cell margin, a foreign transit cell, or an unflagged corridor flank.
    expect(tbl['cover(kind:relation)']).toEqual({
      'cellMargin:coParent': 803, 'plainFlank:plain': 143, 'transitMargin:foreign': 69, 'cellMargin:coParent|plainFlank:plain': 95,
      'plainFlank:plain|transitMargin:foreign': 23,
    });
  }, 600_000);

  it('prototype 1: an exact-span opening in the covering wall makes 1 of 1,133 edges walkable', async () => {
    const t = await openingExperiment(chosen, SEEDS);
    expect([t['null/gateHeld total'], t['null/other total'], t['found total']]).toEqual([1040, 83, 10]);
    const walkable = Object.entries(t).filter(([k]) => /WALKABLE/.test(k)).reduce((n, [, v]) => n + v, 0);
    expect(walkable).toBe(1);
    expect(t['null/gateHeld -> wallCut']).toBe(1039);
    // The corridor behind the door still crosses 4+ walls for 1,036 of the gate-held ones.
    expect(t['null/gateHeld cut by 4+ wall(s)']).toBe(1036);
  }, 600_000);

  it('ceiling: fixing every sealed door would add 54 rooms with 2+ live exits, but remove 859 dead-end rooms', async () => {
    const u = await upperBound(chosen, SEEDS);
    expect(u['status quo (all union-dead edges dropped)']).toEqual({ branching: 1164, exits: 6628, reached: 7128, dead: 1704, deadEnds: 1293 });
    expect(u['sealed-door edges live again']).toEqual({ branching: 1205, exits: 7769, reached: 7342, dead: 571, deadEnds: 433 });
    expect(u['nothing dead (graph upper bound)']).toEqual({ branching: 1241, exits: 8367, reached: 7441, dead: 0, deadEnds: 0 });
  }, 600_000);
});
