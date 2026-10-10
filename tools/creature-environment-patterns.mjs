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

/** Words (prefix, with simple suffixes) -> environment. */
export const KEYWORDS = {
  forest: ["forest", "woods?", "woodland", "jungle"],
  swamp: ["swamp", "marsh", "bog", "fen"],
  cave: ["cave", "cavern", "underdark"],
  desert: ["desert", "dune", "sand"],
  urban: ["city", "cities", "town", "village", "urban", "street"],
  underwater: ["ocean", "sea", "lake", "river", "underwater", "reef"],
  mountain: ["mountain", "peak", "crag"],
  arctic: ["arctic", "tundra", "glacier", "ice", "snow"],
  plains: ["plain", "grassland", "farm", "prairie"],
  "underground-ruin": ["ruin", "dungeon", "crypt", "tomb", "temple", "catacomb"],
  planar: ["plane", "planar", "abyss", "hell", "heaven", "shadow plane"],
};

const KEYWORD_RES = ENVIRONMENTS.map((env) => [
  env,
  new RegExp(`\\b(?:${(KEYWORDS[env] ?? []).join("|")})(?:s|es|ed|y|ous|ing)?\\b`, "i"),
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
  return KEYWORD_RES.filter(([, re]) => re.test(joined)).map(([env]) => env);
}

const TRAIT_MAP = {
  aquatic: "underwater", amphibious: "underwater", plant: "forest", fungus: "forest",
  swamp: "swamp", cold: "arctic", ice: "arctic", earth: "cave", fire: "desert",
  air: "mountain", water: "underwater", fiend: "planar", celestial: "planar",
  monitor: "planar", aeon: "planar", archon: "planar", undead: "any", construct: "any",
};

export function traitHints(traits) {
  const list = Array.isArray(traits) ? traits : [];
  const out = new Set();
  for (const t of list) {
    if (Object.hasOwn(TRAIT_MAP, t)) out.add(TRAIT_MAP[t]);
  }
  if (list.includes("elemental") && list.includes("extraplanar")) out.add("planar");
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
