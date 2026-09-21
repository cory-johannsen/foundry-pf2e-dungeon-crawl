const MODULE_ID = 'pf2e-dungeon-crawl';

let SETPIECES_CACHE = null;
let CREATURE_ART_CACHE = null;

export async function loadDungeonSetpieces() {
  if (SETPIECES_CACHE) return SETPIECES_CACHE;
  const res = await fetch(`modules/${MODULE_ID}/data/dungeon-setpieces.json`);
  SETPIECES_CACHE = await res.json();
  return SETPIECES_CACHE;
}

export async function loadCreatureArt() {
  if (CREATURE_ART_CACHE) return CREATURE_ART_CACHE;
  const res = await fetch(`modules/${MODULE_ID}/data/creature-art.json`);
  CREATURE_ART_CACHE = await res.json();
  return CREATURE_ART_CACHE;
}

export function invalidateCaches() {
  SETPIECES_CACHE = null;
  CREATURE_ART_CACHE = null;
}
