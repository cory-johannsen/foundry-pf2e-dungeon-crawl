// #603: the shipped pipeline's chosen seed + stubs/walls per sweep seed (reseed N = 20, topology routing, stubs, walls); the
// reseed is the slow part of every #603 measurement, so callers compute it once.
//   node tests/helpers/chosen-seeds.mjs <out.json> [seeds] [from]
import fs from 'node:fs';
import * as deck from '../../scripts/dungeon-deck.mjs';
import { chooseRunLayout } from '../../scripts/dungeon-reseed.mjs';
import { installFoundryStubs } from './scene-oracle.mjs';

installFoundryStubs();
export const roomCountOf = (i) => 6 + (i % 15);

/** `{ [i]: { seed, tries, goal, stubEdges, walledEdges, ms } }` for sweep seeds `from .. from + n - 1`. */
export async function chooseSeeds(n = 500, from = 0) {
  const rec = {};
  for (let i = from; i < from + n; i += 1) {
    const c = await chooseRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: roomCountOf(i), topologyRouting: true });
    rec[i] = { seed: c.seed, tries: c.reseedTries, goal: c.goalReachable, stubEdges: c.layout.stubEdges ?? {}, walledEdges: c.layout.walledEdges ?? {}, ms: c.ms };
  }
  return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.writeFileSync(process.argv[2], JSON.stringify(await chooseSeeds(Number(process.argv[3] ?? 500), Number(process.argv[4] ?? 0))));
}
