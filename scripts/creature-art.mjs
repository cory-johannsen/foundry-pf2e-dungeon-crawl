/**
 * Pure lookup over `data/creature-art.json` — no Foundry deps, mirrors the
 * data/pure-logic split `dungeon-deck.mjs` keeps from `dungeon-scene.mjs`.
 * The lookup key is `{pack, docId}`, matching `resolveEncounterRoster`'s own
 * `{pack, id}` shape exactly.
 */
const ART_DIR = 'creature-art';

export function findCreatureArt(list, { pack, id } = {}) {
  const entry = (list ?? []).find((e) => e.pack === pack && e.docId === id);
  return entry ? entry.art : null;
}

export function creatureArtPath(filename) {
  return `${ART_DIR}/${filename}`;
}
