const MODULE_ID = 'pf2e-dungeon-crawl';

let SETPIECES_CACHE = null;
let CREATURE_ART_CACHE = null;
let ROOM_FEATURE_ART_CACHE = null;
let CREATURE_ENVIRONMENTS_CACHE = null;

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

/** Manifest of themed room-feature art (#750). Never rejects: any failure
 * (offline, 404, bad JSON, no fetch) yields `{}` so every marker falls back
 * to its core icon / native door; failures are not cached. */
export async function loadRoomFeatureArt() {
  if (ROOM_FEATURE_ART_CACHE) return ROOM_FEATURE_ART_CACHE;
  try {
    const res = await fetch(`modules/${MODULE_ID}/data/room-feature-art.json`);
    if (!res.ok) return {};
    ROOM_FEATURE_ART_CACHE = await res.json();
    return ROOM_FEATURE_ART_CACHE;
  } catch {
    return {};
  }
}

/** Creature -> environments map (#1272). Never rejects: any failure (404,
 * bad JSON, wrong shape, no fetch) warns once and yields an empty map so
 * encounters still generate. A failure is cached too (as the empty map) for
 * the page lifetime, so only one warning is ever emitted and rooms don't
 * refetch; `invalidateCaches` resets it. */
export async function loadCreatureEnvironments() {
  if (CREATURE_ENVIRONMENTS_CACHE) return CREATURE_ENVIRONMENTS_CACHE;
  try {
    const res = await fetch(`modules/${MODULE_ID}/data/creature-environments.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const c = data?.creatures;
    if (!data || typeof data !== 'object' || !c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error('unexpected shape');
    }
    CREATURE_ENVIRONMENTS_CACHE = data;
    return data;
  } catch (e) {
    console.warn(`${MODULE_ID} | creature-environments.json unavailable (${e?.message ?? e}); environment filtering disabled`);
    CREATURE_ENVIRONMENTS_CACHE = { version: 0, creatures: {} };
    return CREATURE_ENVIRONMENTS_CACHE;
  }
}

export function invalidateCaches() {
  SETPIECES_CACHE = null;
  CREATURE_ART_CACHE = null;
  ROOM_FEATURE_ART_CACHE = null;
  CREATURE_ENVIRONMENTS_CACHE = null;
}
