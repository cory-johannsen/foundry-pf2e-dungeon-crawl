import { vi } from "vitest";

/** A small in-memory stand-in for game.journal/game.folders and the
 * JournalEntry/Folder classes -- documents expose getFlag, pages, folder,
 * ownership, createEmbeddedDocuments and delete like Foundry's do. */
export function makeFakeJournalWorld() {
  let nextId = 1;
  let clock = 1000;
  const journals = [];
  const folders = [];
  const folderCollection = {
    get contents() { return folders; },
    get: (id) => folders.find((f) => f.id === id),
    [Symbol.iterator]: () => folders[Symbol.iterator](),
  };
  const journalCollection = {
    get contents() { return journals; },
    get: (id) => journals.find((j) => j.id === id),
  };
  function makeDoc(data) {
    return {
      ...data,
      flags: data.flags ?? {},
      _stats: { createdTime: clock++ },
      getFlag(mod, key) { return this.flags?.[mod]?.[key]; },
    };
  }
  const FolderCls = {
    create: vi.fn(async (data) => {
      const f = makeDoc({ id: `f${nextId++}`, ...data });
      Object.defineProperty(f, "contents", { get: () => journals.filter((j) => j.folderId === f.id) });
      f.children = [];
      f.delete = vi.fn(async () => { folders.splice(folders.indexOf(f), 1); });
      folders.push(f);
      return f;
    }),
  };
  function addJournal(data) {
    const j = makeDoc({ id: `j${nextId++}`, ...data, folderId: data.folder ?? null });
    const pages = [];
    j.pages = { get contents() { return pages; } };
    Object.defineProperty(j, "folder", { get: () => folders.find((f) => f.id === j.folderId) ?? null });
    j.createEmbeddedDocuments = vi.fn(async (type, docs) => {
      if (type !== "JournalEntryPage") throw new Error(`unexpected embedded type ${type}`);
      const created = docs.map((p) => makeDoc({ id: `p${nextId++}`, ...p }));
      pages.push(...created);
      return created;
    });
    j.delete = vi.fn(async () => { journals.splice(journals.indexOf(j), 1); });
    journals.push(j);
    return j;
  }
  const JournalEntryCls = { create: vi.fn(async (data) => addJournal(data)) };
  return {
    journals,
    folders,
    addJournal,
    deps: { journals: journalCollection, folders: folderCollection, JournalEntryCls, FolderCls },
  };
}
