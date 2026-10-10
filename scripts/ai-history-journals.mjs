/**
 * #953: the Foundry side of the run-wide AI action history -- two Journal
 * Entries per dungeon run, found by flag (`flags.pf2e-dungeon-crawl.aiHistory
 * = {historyId, kind: "public"|"gm", sceneId}`), never by name, so a rename
 * never breaks the link:
 *
 * - the public journal, `ownership.default` OBSERVER (2): every player can
 *   open it from the Journal sidebar;
 * - the GM journal, `ownership.default` NONE (0): only GMs can open it. It
 *   is a separate top-level document (not a restricted page inside the
 *   public one) because top-level document ownership is the permission
 *   Foundry enforces most broadly; page-level ownership was not relied on.
 *
 * Both live in an "AI Action History" folder (found by its own flag, created
 * lazily). Each archived combat adds one page to each journal, flagged
 * `aiHistory.combatId`, which is also the idempotence key: a combat whose
 * page already exists in a journal is never written there again.
 *
 * Ownership levels are literal numbers (CONST.DOCUMENT_OWNERSHIP_LEVELS
 * NONE 0 / OBSERVER 2, live-checked on Foundry 14.368) rather than CONST
 * references, the same reason world-macros.mjs's GENERATED_MACRO_OWNERSHIP
 * is: this file is imported by tests before any Foundry global exists.
 * Foundry collections and document classes are injectable (`deps`) for the
 * same reason; the defaults read the live globals only when called.
 *
 * Every function here is GM-client work (journal/folder create and delete
 * need GM permission): resolveCombat and abandonRun already only run there.
 */
import { buildPublicPageHtml, buildGmPageHtml, publicJournalName, gmJournalName } from "./ai-history-pages.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
export const AI_HISTORY_FOLDER_NAME = "AI Action History";
export const PUBLIC_JOURNAL_OWNERSHIP = Object.freeze({ default: 2 });
export const GM_JOURNAL_OWNERSHIP = Object.freeze({ default: 0 });
/** CONST.SORT_INTEGER_DENSITY: pages are appended in archive order. */
const PAGE_SORT_STEP = 100000;
/** CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML (live-checked on 14.368). */
const PAGE_FORMAT_HTML = 1;

function defaultDeps() {
  return {
    journals: globalThis.game?.journal,
    folders: globalThis.game?.folders,
    JournalEntryCls: globalThis.JournalEntry,
    FolderCls: globalThis.Folder,
  };
}

function withDefaults(deps) {
  return { ...defaultDeps(), ...(deps ?? {}) };
}

function list(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  return Array.from(collection);
}

function flagOf(doc, key) {
  const viaGetter = typeof doc?.getFlag === "function" ? doc.getFlag(MODULE_ID, key) : undefined;
  return viaGetter ?? doc?.flags?.[MODULE_ID]?.[key];
}

function createdTime(doc) {
  const t = doc?._stats?.createdTime;
  return Number.isFinite(t) ? t : 0;
}

/** The run's journal of `kind`, or null. Duplicates (two journals carrying
 * the same historyId and kind) resolve to the oldest, with a warning. */
export function findRunJournal(historyId, kind, deps) {
  const { journals } = withDefaults(deps);
  const matches = list(journals).filter((j) => {
    const flag = flagOf(j, "aiHistory");
    return flag?.historyId === historyId && flag?.kind === kind;
  });
  if (!matches.length) return null;
  if (matches.length > 1) {
    console.warn(`${MODULE_ID} | #953: ${matches.length} "${kind}" AI history journals share history id ${historyId}; using the oldest.`);
    matches.sort((a, b) => createdTime(a) - createdTime(b));
  }
  return matches[0];
}

async function ensureFolder(deps) {
  const { folders, FolderCls } = deps;
  const journalFolders = list(folders).filter((f) => f?.type === "JournalEntry");
  const existing =
    journalFolders.find((f) => flagOf(f, "aiHistoryFolder") === true) ??
    journalFolders.find((f) => f.name === AI_HISTORY_FOLDER_NAME);
  if (existing) return existing;
  return FolderCls.create({
    name: AI_HISTORY_FOLDER_NAME,
    type: "JournalEntry",
    flags: { [MODULE_ID]: { aiHistoryFolder: true } },
  });
}

/**
 * The run's `{publicJournal, gmJournal}`, creating whichever is missing (and
 * the folder) on the way. `displayName` names newly created journals only;
 * an existing journal is never renamed.
 */
export async function findOrCreateRunJournals({ historyId, sceneId = null, displayName }, deps) {
  const d = withDefaults(deps);
  let publicJournal = findRunJournal(historyId, "public", d);
  let gmJournal = findRunJournal(historyId, "gm", d);
  if (publicJournal && gmJournal) return { publicJournal, gmJournal };

  const folder = await ensureFolder(d);
  const make = (kind, name, ownership) =>
    d.JournalEntryCls.create({
      name,
      folder: folder?.id ?? null,
      ownership: { ...ownership },
      flags: { [MODULE_ID]: { aiHistory: { historyId, kind, sceneId } } },
    });
  if (!publicJournal) publicJournal = await make("public", publicJournalName(displayName), PUBLIC_JOURNAL_OWNERSHIP);
  if (!gmJournal) gmJournal = await make("gm", gmJournalName(displayName), GM_JOURNAL_OWNERSHIP);
  return { publicJournal, gmJournal };
}

function pageForCombat(journal, combatId) {
  return list(journal?.pages).find((p) => flagOf(p, "aiHistory")?.combatId === combatId) ?? null;
}

function nextPageSort(journal) {
  const sorts = list(journal?.pages).map((p) => (Number.isFinite(p?.sort) ? p.sort : 0));
  return (sorts.length ? Math.max(...sorts) : 0) + PAGE_SORT_STEP;
}

async function addPage(journal, { combatId, label, html }) {
  if (pageForCombat(journal, combatId)) return false;
  await journal.createEmbeddedDocuments("JournalEntryPage", [
    {
      name: label,
      type: "text",
      sort: nextPageSort(journal),
      text: { content: html, format: PAGE_FORMAT_HTML },
      flags: { [MODULE_ID]: { aiHistory: { combatId } } },
    },
  ]);
  return true;
}

/**
 * Archives one combat's agentLog `records` as a page in each run journal.
 * Creates nothing at all (not even the folder or journals) for an empty or
 * malformed log. The public page is skipped when no row is visible to
 * players (every action came from a hidden actor), so the public journal
 * never even hints at a hidden fight. Idempotent per journal by `combatId`.
 * `publicNames`/`gmNames` `{[combatantId]: name}` as players / the GM see
 * them. Throws on a failing write -- the caller (dungeon-combat.mjs's
 * archiveCombatAiLog) owns the never-block-resolution catch.
 * Returns `{publicPage, gmPage}` booleans (whether each page was written).
 */
export async function archiveAiLogToJournals(
  { records, combatId, historyId, sceneId = null, displayName, label, publicNames = {}, gmNames = {} },
  deps,
) {
  const none = { publicPage: false, gmPage: false };
  const log = Array.isArray(records) ? records.filter((r) => r && typeof r === "object") : [];
  if (!log.length || !combatId || !historyId) return none;
  const publicHtml = buildPublicPageHtml(log, { names: publicNames });
  const hasPublicRows = log.some((r) => r.visibility !== "gm");
  const { publicJournal, gmJournal } = await findOrCreateRunJournals({ historyId, sceneId, displayName }, deps);
  const gmPage = await addPage(gmJournal, { combatId, label, html: buildGmPageHtml(log, { names: gmNames }) });
  const publicPage = hasPublicRows ? await addPage(publicJournal, { combatId, label, html: publicHtml }) : false;
  return { publicPage, gmPage };
}

/**
 * Best-effort deletion of a run's journals -- every journal flagged with
 * `historyId`, plus (when `sceneId` is given) any flagged with that run's
 * scene id, which also catches a pair orphaned by a lost `aiHistoryId` --
 * then the folder if that left it empty. A failing delete is logged and the
 * rest still run. Returns the number of journals deleted.
 */
export async function deleteRunJournals({ historyId = null, sceneId = null } = {}, deps) {
  const d = withDefaults(deps);
  if (!historyId && !sceneId) return 0;
  const matches = list(d.journals).filter((j) => {
    const flag = flagOf(j, "aiHistory");
    if (!flag) return false;
    return (historyId && flag.historyId === historyId) || (sceneId && flag.sceneId === sceneId);
  });
  const folderIds = new Set();
  let deleted = 0;
  for (const journal of matches) {
    const folderId = journal.folder?.id ?? journal.folder ?? null;
    try {
      await journal.delete();
      deleted += 1;
      if (folderId) folderIds.add(folderId);
    } catch (err) {
      console.error(`${MODULE_ID} | #953: deleting AI history journal "${journal.name}" failed:`, err?.message);
    }
  }
  for (const folderId of folderIds) {
    const folder = d.folders?.get?.(folderId);
    if (!folder || flagOf(folder, "aiHistoryFolder") !== true) continue;
    const empty = list(folder.contents).length === 0 && list(folder.children).length === 0;
    if (!empty) continue;
    try {
      await folder.delete();
    } catch (err) {
      console.error(`${MODULE_ID} | #953: deleting the empty AI history folder failed:`, err?.message);
    }
  }
  return deleted;
}
