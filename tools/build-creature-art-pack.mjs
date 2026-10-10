/**
 * Builds the `generated-creature-art` compendium pack (#599) from
 * data/creature-art.json: reads each referenced source pack's full Actor
 * documents off the local pf2e system install, overrides img /
 * prototypeToken.texture.src with the generated art path, and compiles
 * the result into a real LevelDB pack this module ships.
 *
 * Safety: the system's pack directories are never opened in place (a
 * running Foundry holds them locked). Each is COPIED (minus LOCK) into the
 * scratch dir and extracted from the copy; nothing under systemPacksDir is
 * written.
 *
 * The new actors do not reuse the source docId as `_id` (64 docIds recur
 * across source packs); `_id` is derived from `${pack}:${docId}` and
 * traceability lives in flags["pf2e-dungeon-crawl"].
 */
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync, existsSync,
} from "node:fs";
import { join, basename, resolve, dirname, sep, parse } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";

const MODULE_ID = "pf2e-dungeon-crawl";

export function deriveActorId(pack, docId) {
  return createHash("sha1")
    .update(`${pack}:${docId}`)
    .digest("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 16);
}

export function readPackDirectories(systemPacksDir) {
  const systemJsonPath = join(systemPacksDir, "..", "system.json");
  if (!existsSync(systemJsonPath)) {
    throw new Error(`system.json not found at ${systemJsonPath}; cannot resolve pack directories`);
  }
  const system = JSON.parse(readFileSync(systemJsonPath, "utf8"));
  return new Map((system.packs ?? []).map((p) => [p.name, p.path]));
}

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const isInside = (child, parent) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Pure guard (string comparison only, never touches the filesystem):
 * throws before anything is deleted if the output paths could clobber
 * something that is not ours. */
export function assertSafeOutputDirs({
  packOutDir,
  sourceOutDir,
  systemPacksDir,
  repoRoot = REPO_ROOT,
}) {
  packOutDir = resolve(packOutDir);
  sourceOutDir = resolve(sourceOutDir);
  const systemDir = resolve(systemPacksDir);
  const repo = resolve(repoRoot);
  const forbidden = [parse(packOutDir).root, repo, systemDir, dirname(systemDir)];
  for (const [label, dir] of [["packOutDir", packOutDir], ["sourceOutDir", sourceOutDir]]) {
    if (forbidden.includes(dir) || forbidden.some((f) => isInside(f, dir))) {
      throw new Error(`Refusing to build: ${label} ${dir} is the filesystem root, the repo root, the system packs dir, its parent, or contains one of them`);
    }
  }
  if (packOutDir === sourceOutDir || isInside(packOutDir, sourceOutDir)) {
    throw new Error(`Refusing to build: packOutDir ${packOutDir} must not be or lie inside sourceOutDir ${sourceOutDir}`);
  }
}

export async function buildCreatureArtPack({
  creatureArtPath,
  systemPacksDir,
  scratchDir,
  sourceOutDir,
  packOutDir,
  log = false,
}) {
  assertSafeOutputDirs({ packOutDir, sourceOutDir, systemPacksDir });
  packOutDir = resolve(packOutDir);
  sourceOutDir = resolve(sourceOutDir);
  const entries = JSON.parse(readFileSync(creatureArtPath, "utf8"));
  const dirOf = readPackDirectories(systemPacksDir);
  const entriesByPack = new Map();
  for (const entry of entries) {
    const list = entriesByPack.get(entry.pack) ?? [];
    list.push(entry);
    entriesByPack.set(entry.pack, list);
  }

  rmSync(sourceOutDir, { recursive: true, force: true });
  mkdirSync(sourceOutDir, { recursive: true });

  const usedIds = new Set();
  let droppedItems = 0;

  for (const [pack, packEntries] of entriesByPack) {
    const packName = pack.replace(/^pf2e\./, "");
    const relDir = dirOf.get(packName);
    if (!relDir) {
      throw new Error(`Pack "${pack}" is not declared in system.json`);
    }
    const srcDir = join(systemPacksDir, "..", relDir);
    if (!existsSync(srcDir)) {
      throw new Error(`Pack "${pack}" declares directory ${srcDir}, which does not exist`);
    }

    const copyDir = join(scratchDir, "copies", packName);
    const extractDir = join(scratchDir, "extract", packName);
    rmSync(copyDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    cpSync(srcDir, copyDir, { recursive: true, filter: (s) => basename(s) !== "LOCK" });

    try {
      await extractPack(copyDir, extractDir, { log });
    } catch (e) {
      throw new Error(`Failed to extract source pack "${pack}" from ${srcDir}: ${e.message}`);
    }

    const docsById = new Map();
    for (const file of readdirSync(extractDir)) {
      if (!file.endsWith(".json")) continue;
      const doc = JSON.parse(readFileSync(join(extractDir, file), "utf8"));
      docsById.set(doc._id, doc);
    }

    for (const entry of packEntries) {
      const source = docsById.get(entry.docId);
      if (!source) {
        throw new Error(
          `docId "${entry.docId}" (${entry.name}) not found in extracted pack "${pack}" ` +
            `(${docsById.size} documents extracted from ${srcDir})`,
        );
      }
      const newId = deriveActorId(entry.pack, entry.docId);
      if (usedIds.has(newId)) {
        throw new Error(`Derived id collision "${newId}" for ${pack}:${entry.docId}`);
      }
      usedIds.add(newId);

      const artPath = `modules/${MODULE_ID}/assets/creature-art/${entry.art}`;
      const seen = new Set();
      const items = [];
      for (const item of source.items ?? []) {
        if (seen.has(item._id)) {
          droppedItems++;
          continue;
        }
        seen.add(item._id);
        items.push({ ...item, _key: `!actors.items!${newId}.${item._id}` });
      }
      const effects = (source.effects ?? []).map((fx) => ({
        ...fx,
        _key: `!actors.effects!${newId}.${fx._id}`,
      }));

      const doc = {
        ...source,
        _id: newId,
        _key: `!actors!${newId}`,
        folder: null,
        img: artPath,
        items,
        effects,
        prototypeToken: {
          ...(source.prototypeToken ?? {}),
          texture: { ...(source.prototypeToken?.texture ?? {}), src: artPath },
        },
        flags: {
          ...(source.flags ?? {}),
          [MODULE_ID]: { artEntryId: entry.id, sourcePack: entry.pack, sourceDocId: entry.docId },
        },
      };
      writeFileSync(join(sourceOutDir, `${newId}.json`), JSON.stringify(doc));
    }
    if (log) console.log(`${pack}: ${packEntries.length} actors`);
  }

  if (log) console.log(`${droppedItems} duplicate embedded item(s) dropped (first copy kept)`);

  // packOutDir may contain sourceOutDir (the shipped layout); clear only the
  // previously compiled LevelDB files, never the freshly written _source.
  if (existsSync(packOutDir)) {
    for (const name of readdirSync(packOutDir)) {
      if (resolve(packOutDir, name) === sourceOutDir) continue;
      rmSync(join(packOutDir, name), { recursive: true, force: true });
    }
  }
  await compilePack(sourceOutDir, packOutDir, { log });
  return { actors: usedIds.size, droppedItems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ROOT = new URL("..", import.meta.url).pathname;
  const { actors, droppedItems } = await buildCreatureArtPack({
    creatureArtPath: join(ROOT, "data", "creature-art.json"),
    systemPacksDir:
      process.env.PF2E_SYSTEM_PACKS_DIR ?? "/srv/foundry/data/Data/systems/pf2e/packs",
    scratchDir: join(ROOT, "tools", ".pack-build-scratch"),
    sourceOutDir: join(ROOT, "packs", "generated-creature-art", "_source"),
    packOutDir: join(ROOT, "packs", "generated-creature-art"),
    log: false,
  });
  console.log(`Done. ${actors} actors, ${droppedItems} duplicate embedded items dropped.`);
}
