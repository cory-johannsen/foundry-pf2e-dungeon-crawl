const MODULE_ID = "pf2e-dungeon-crawl";

// #773: a document created with no explicit `ownership` defaults to
// "creator owns it, nobody else" -- if ensureWorldMacros() happens to run
// on a client connected as the foundry-rest relay's own bot user (rather
// than the real GM's own browser), the resulting macro is invisible to
// everyone else. A literal number here, not CONST.DOCUMENT_OWNERSHIP_LEVELS
// (confirmed live this value is 3/OWNER) -- this file is imported by
// tests/world-macros.test.mjs before any Foundry global exists, so a
// CONST reference at module-evaluation time would throw.
const GENERATED_MACRO_OWNERSHIP = { default: 3 };

// #96: dropped the "DOMMT:"/"PF2EDC:" prefix from the dungeon-crawl macro's
// display name. Scoped to just this one macro — "PF2EDC: Generate Encounter"
// keeps its prefix for now.
export const MACRO_DEFS = [
  {
    name: "PF2EDC: Generate Encounter",
    img: `modules/${MODULE_ID}/assets/icons/macro-encounter.webp`,
    command: `game.modules.get('${MODULE_ID}').api.generateEncounter();`,
  },
  {
    name: "Dungeon Crawl",
    img: `modules/${MODULE_ID}/assets/icons/macro-dungeon.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openDungeon();`,
  },
];

/** #96: a world macro created by this module always carries
 * `flags.<MODULE_ID>.generated === true`. That flag — not the macro's
 * (renameable) name — is this module's own identity marker for "this is a
 * macro I generated." Within that pool, a macro's `command` is what ties it
 * to a specific MACRO_DEFS entry, since the command doesn't change across a
 * display-name rename the way the name itself just did. */
function findGeneratedMatches(def) {
  return game.macros.filter(
    (m) =>
      m.getFlag(MODULE_ID, "generated") === true && m.command === def.command,
  );
}

async function ensureWorldMacros({ force = false } = {}) {
  const toCreate = [];
  const toUpdate = [];
  for (const def of MACRO_DEFS) {
    const matches = findGeneratedMatches(def);
    if (matches.length > 1) {
      console.warn(
        `${MODULE_ID} | ensureWorldMacros: found ${matches.length} generated macros matching "${def.name}"; updating the first (${matches[0].id}) and leaving the rest (${matches
          .slice(1)
          .map((m) => m.id)
          .join(", ")}) as-is`,
      );
    }
    const existing = matches[0];
    if (existing) {
      if (
        force ||
        existing.name !== def.name ||
        existing.command !== def.command ||
        existing.img !== def.img ||
        existing.ownership?.default !== GENERATED_MACRO_OWNERSHIP.default
      ) {
        toUpdate.push({
          _id: existing.id,
          name: def.name,
          command: def.command,
          img: def.img,
          ownership: GENERATED_MACRO_OWNERSHIP,
        });
      }
    } else {
      toCreate.push({
        name: def.name,
        type: "script",
        img: def.img,
        command: def.command,
        scope: "global",
        ownership: GENERATED_MACRO_OWNERSHIP,
        flags: { [MODULE_ID]: { generated: true } },
      });
    }
  }
  if (toCreate.length) await Macro.createDocuments(toCreate);
  if (toUpdate.length) await Macro.updateDocuments(toUpdate);
  const msg = `PF2e Dungeon Crawl: ${toCreate.length} macro(s) created, ${toUpdate.length} updated.`;
  ui.notifications?.info(msg);
  console.log(`${MODULE_ID} | ${msg}`);
  return { created: toCreate.length, updated: toUpdate.length };
}

export { ensureWorldMacros };
