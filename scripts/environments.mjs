// Environment vocabulary and pure helpers for environment-based encounters (#1272).
// Pure module: no imports, never throws on malformed input.

export const ENVIRONMENTS = [
  "forest", "swamp", "cave", "desert", "urban", "underwater",
  "mountain", "arctic", "plains", "underground-ruin", "planar",
];
export const ANY = "any";

export const ADJACENCY = {
  forest: ["swamp", "plains", "mountain"],
  swamp: ["forest", "underwater"],
  cave: ["mountain", "underground-ruin"],
  desert: ["plains", "mountain"],
  urban: ["plains", "underground-ruin"],
  underwater: ["swamp", "cave"],
  mountain: ["cave", "arctic", "forest"],
  arctic: ["mountain", "plains"],
  plains: ["forest", "urban", "desert"],
  "underground-ruin": ["cave", "urban"],
  planar: [],
};

export function normalizeEnvironment(v) {
  return typeof v === "string" && ENVIRONMENTS.includes(v) ? v : null;
}

export function buildEnvironmentLookup(artList, envMap) {
  const lookup = new Map();
  const creatures = envMap?.creatures;
  if (!Array.isArray(artList) || !creatures || typeof creatures !== "object") return lookup;
  for (const e of artList) {
    if (!e || typeof e !== "object") continue;
    const list = creatures[e.id];
    if (!Array.isArray(list)) continue;
    const valid = list.filter((x) => x === ANY || ENVIRONMENTS.includes(x));
    if (!valid.length) continue;
    lookup.set(`${e.pack}:${e.docId}`, valid);
  }
  return lookup;
}

export function environmentsFor(entry, lookup) {
  if (!entry || !(lookup instanceof Map)) return null;
  return lookup.get(`${entry.pack}:${entry.id}`) ?? null;
}

export function creatureFitsEnvironment(entry, environment, lookup) {
  const envs = environmentsFor(entry, lookup);
  if (!envs) return false;
  return envs.includes(ANY) || envs.includes(environment);
}

export function widenEnvironments(environment) {
  const adj = Object.hasOwn(ADJACENCY, environment) ? ADJACENCY[environment] : [];
  return [[environment], [...new Set([environment, ...adj])]];
}

function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function mulberry32(a) {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function pickRandomEnvironment(seed, lookup) {
  if (!(lookup instanceof Map)) return null;
  const weights = new Map(ENVIRONMENTS.map((e) => [e, 0]));
  for (const envs of lookup.values()) {
    for (const e of envs) if (weights.has(e)) weights.set(e, weights.get(e) + 1);
  }
  const live = [...weights].filter(([, w]) => w > 0);
  if (!live.length) return null;
  const total = live.reduce((s, [, w]) => s + w, 0);
  let r = mulberry32(hashSeed(seed)) * total;
  for (const [e, w] of live) {
    if (r < w) return e;
    r -= w;
  }
  return live[live.length - 1][0];
}

/** Resolve the Start-form choice to a final run environment (#1272).
 * "none"/empty/unknown -> null; "random" -> seeded weighted pick; an id -> itself. */
export function resolveRunEnvironment(choice, seed, lookup) {
  if (choice === "random") return pickRandomEnvironment(seed, lookup);
  return normalizeEnvironment(choice);
}
