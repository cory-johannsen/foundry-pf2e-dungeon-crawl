// Pure extraction helpers for the creature -> environment audit (#1272).
// Imports only the environment vocabulary; never throws on malformed input.
//
// Probe finding (2026-10-10, `--probe` over the first 200 npc docs of each
// of the 58 packs referenced by data/creature-art.json, 5233 docs):
//   - Only `system.details.publicNotes` carries habitat-like prose (266 hits,
//     ~5% of docs). `blurb` and `privateNotes` had no hits.
//   - Monster Core: 26/200 docs (13%) had a habitat-like sentence; Monster
//     Core 2: 13/200. So prose covers a minority of creatures; trait hints
//     and manual curation (the documented fallback) carry the rest.
// Hence extractHabitatText reads publicNotes only.
import { ENVIRONMENTS } from "../scripts/environments.mjs";

const HABITAT_FIELDS = ["publicNotes"];

/** Word stems (regex fragments) -> environment. Each stem may take an
 * optional s/es/ed suffix and must match whole words. Tuned against the
 * audit samples (Step 5): "plain" (plain sight), "sand" (sandy) and "temple"
 * (webs as big as temples) were too loose and are gone or narrowed. */
export const KEYWORDS = {
  forest: ["forest", "rainforest", "woods?", "woodland", "jungle", "grove"],
  swamp: ["swamp", "marsh", "bog", "fen", "wetland", "mire"],
  cave: ["cave", "cavern", "underdark", "darklands", "underground", "subterranean", "mine"],
  desert: ["desert", "dune", "sands"],
  urban: ["city", "cities", "town", "village", "urban", "street", "sewer"],
  underwater: ["ocean", "sea", "lake", "river", "underwater", "reef"],
  mountain: ["mountain", "mountainous", "peak", "crag"],
  arctic: ["arctic", "tundra", "glacier", "ice", "icy", "snow"],
  plains: ["plains", "grassland", "savanna", "prairie", "steppe", "farm", "farmland"],
  "underground-ruin": ["ruin", "dungeon", "crypt", "tomb", "catacomb", "graveyard", "cemetery", "cemeteries", "mausoleum"],
  planar: [
    "(?<!material )plane", "planar", "abyss", "abyssal", "hell", "heaven", "nirvana", "elysium",
    "axis", "maelstrom", "first world", "astral", "ethereal",
  ],
};

const KEYWORD_RES = ENVIRONMENTS.map((env) => [
  env,
  new RegExp(`\\b(?:${(KEYWORDS[env] ?? []).join("|")})(?:s|es|ed)?\\b`, "i"),
]);

const PATTERNS = [
  /\bhabitat\b[:\s-]*([^.]*)/gi,
  /\b(?:lives?|dwells?|found|dwelling|inhabits?)\s+(?:in|among|within|near|throughout)\s+([^.;]*)/gi,
];

export function extractHabitatText(doc) {
  const details = doc?.system?.details;
  if (!details || typeof details !== "object") return "";
  return HABITAT_FIELDS
    .map((f) => (typeof details[f] === "string" ? details[f] : ""))
    .join(" ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

export function habitatEnvironments(text) {
  if (typeof text !== "string" || !text) return [];
  const clauses = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) clauses.push(m[1] ?? "");
  }
  const joined = clauses.join(" ; ");
  const found = KEYWORD_RES.filter(([, re]) => re.test(joined)).map(([env]) => env);
  // A habitat on another plane is planar only: "the mountain of Heaven" or
  // "Hell's waterways" are not Material Plane mountains or oceans.
  return found.includes("planar") ? ["planar"] : found;
}

const TRAIT_MAP = {
  aquatic: "underwater", amphibious: "underwater", plant: "forest", fungus: "forest",
  swamp: "swamp", cold: "arctic", ice: "arctic", earth: "cave", fire: "desert",
  air: "mountain", water: "underwater", fiend: "planar", celestial: "planar",
  monitor: "planar", aeon: "planar", archon: "planar", undead: "any", construct: "any",
};

const ELEMENT_TRAITS = ["air", "earth", "fire", "water", "wood", "metal"];
const OUTSIDER_TRAITS = ["fiend", "celestial", "monitor", "aeon", "archon"];

/** Trait -> environment hints. Multi-element creatures (genies, chaos
 * falcons, elementalist casters) get no element hints: several elements are
 * a damage/magic signal, not a habitat. Outsiders are planar only. */
export function traitHints(traits) {
  const list = Array.isArray(traits) ? traits : [];
  const multiElement = list.filter((t) => ELEMENT_TRAITS.includes(t)).length >= 2;
  const outsider = list.some((t) => OUTSIDER_TRAITS.includes(t));
  const out = new Set();
  for (const t of list) {
    if (!Object.hasOwn(TRAIT_MAP, t)) continue;
    if (multiElement && ELEMENT_TRAITS.includes(t)) continue;
    out.add(TRAIT_MAP[t]);
  }
  if (list.includes("elemental") && list.includes("extraplanar")) out.add("planar");
  if (outsider && !out.has("any")) return ["planar"];
  return [...out];
}

/** Prose wins; else trait hints. `any` (undead/construct) wins over other
 * trait hints so the result never combines `any` with others. */
export function candidateFor(doc) {
  const prose = habitatEnvironments(extractHabitatText(doc));
  if (prose.length) return { environments: prose, basis: "prose" };
  const hints = traitHints(doc?.system?.traits?.value);
  if (hints.includes("any")) return { environments: ["any"], basis: "traits" };
  if (hints.length) {
    const order = [...ENVIRONMENTS];
    return { environments: hints.sort((a, b) => order.indexOf(a) - order.indexOf(b)), basis: "traits" };
  }
  return { environments: [], basis: "none" };
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Adds candidates for ids not already mapped; skips empty candidates;
 * never overwrites. Returns new objects (inputs untouched). */
export function mergeCandidates(existing, sources, candidates) {
  const creatures = { ...(existing?.creatures ?? {}) };
  const srcs = { ...(sources?.sources ?? {}) };
  let added = 0;
  for (const [id, envs] of Object.entries(candidates ?? {})) {
    if (id in creatures) continue;
    if (!Array.isArray(envs) || !envs.length) continue;
    creatures[id] = [...envs];
    srcs[id] = "audit";
    added++;
  }
  return {
    map: { ...existing, version: existing?.version ?? 1, creatures: sortKeys(creatures) },
    sources: { ...sources, version: sources?.version ?? 1, sources: sortKeys(srcs) },
    added,
  };
}

/** Pairs art entries with their extracted docs; entries whose docId has no
 * extracted doc go to `missing` so the caller can warn instead of dropping
 * them silently. */
export function matchArtToDocs(entries, docsById) {
  const matched = [];
  const missing = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const doc = docsById instanceof Map ? docsById.get(entry?.docId) : undefined;
    if (doc) matched.push({ entry, doc });
    else missing.push(entry);
  }
  return { matched, missing };
}
