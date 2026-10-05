/**
 * Offline staleness report for the generated-creature-art compendium pack
 * (#599). Compares data/creature-art.json against the committed
 * packs/generated-creature-art/_source/*.json (matched through
 * flags["pf2e-dungeon-crawl"].artEntryId). Needs no pf2e install.
 *
 *   npm run packs:check            report, exit 0
 *   npm run packs:check -- --strict   exit 1 if the pack is stale
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ID = "pf2e-dungeon-crawl";
const ART_PREFIX = `modules/${MODULE_ID}/assets/creature-art/`;
const MAX_EXAMPLES = 10;

export function checkCreatureArtPack({ creatureArtPath, sourceDir }) {
  const entries = JSON.parse(readFileSync(creatureArtPath, "utf8"));
  const byId = new Map(entries.map((e) => [e.id, e]));

  const docsByEntry = new Map();
  const staleDocs = [];
  let packDocs = 0;
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith(".json")) continue;
    packDocs++;
    const doc = JSON.parse(readFileSync(join(sourceDir, file), "utf8"));
    const entryId = doc.flags?.[MODULE_ID]?.artEntryId;
    const entry = byId.get(entryId);
    if (!entry) {
      staleDocs.push(`stale: ${file} (art entry "${entryId}" no longer in creature-art.json)`);
      continue;
    }
    docsByEntry.set(entryId, doc);
    if (doc.img !== `${ART_PREFIX}${entry.art}`) {
      staleDocs.push(`stale: ${entry.id} (pack art "${doc.img}" != "${ART_PREFIX}${entry.art}")`);
    }
  }

  const missingEntries = entries.filter((e) => !docsByEntry.has(e.id));
  const examples = [
    ...missingEntries.map((e) => `missing: ${e.id} (${e.name})`),
    ...staleDocs,
  ].slice(0, MAX_EXAMPLES);

  const missing = missingEntries.length;
  const stale = staleDocs.length;
  return {
    total: entries.length,
    packDocs,
    missing,
    stale,
    fresh: missing === 0 && stale === 0,
    examples,
    exitCode: (strict) => (strict && (missing > 0 || stale > 0) ? 1 : 0),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ROOT = new URL("..", import.meta.url).pathname;
  const strict = process.argv.includes("--strict");
  const r = checkCreatureArtPack({
    creatureArtPath: join(ROOT, "data", "creature-art.json"),
    sourceDir: join(ROOT, "packs", "generated-creature-art", "_source"),
  });
  console.log(
    `creature-art.json: ${r.total} entries; pack: ${r.packDocs} docs; ` +
      `${r.missing} entries missing from the pack, ${r.stale} pack docs stale.`,
  );
  for (const ex of r.examples) console.log(`  ${ex}`);
  console.log(
    r.fresh
      ? "Pack is up to date."
      : "Pack is stale: run `npm run packs:build` at the next batch boundary and commit packs/generated-creature-art/.",
  );
  process.exit(r.exitCode(strict));
}
