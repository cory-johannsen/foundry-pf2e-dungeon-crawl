import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeJournalWorld as makeWorld } from "./helpers/fake-journal-world.mjs";
import {
  findOrCreateRunJournals,
  findRunJournal,
  archiveAiLogToJournals,
  deleteRunJournals,
  AI_HISTORY_FOLDER_NAME,
} from "../scripts/ai-history-journals.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

const RECORDS = [
  { combatantId: "c1", round: 1, index: 0, summary: "Dagger vs Fighter", result: { text: "hit", tone: "success" }, rationale: "Closest.", visibility: "all" },
  { combatantId: "c3", round: 1, index: 0, summary: "Claw vs Fighter", result: { text: "miss", tone: "failure" }, rationale: "Hidden.", visibility: "gm" },
];

let world;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => vi.restoreAllMocks());

describe("findOrCreateRunJournals (#953)", () => {
  it("creates the folder and both journals with the right ownership and flags", async () => {
    const { publicJournal, gmJournal } = await findOrCreateRunJournals(
      { historyId: "h1", sceneId: "s1", displayName: "Crypt" },
      world.deps,
    );
    expect(world.deps.FolderCls.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: AI_HISTORY_FOLDER_NAME, type: "JournalEntry" }),
    );
    expect(publicJournal.name).toBe("AI Action History — Crypt");
    expect(gmJournal.name).toBe("AI Action Details — Crypt (GM)");
    // Asserted on the created documents' own ownership maps.
    expect(publicJournal.ownership).toEqual({ default: 2 });
    expect(gmJournal.ownership).toEqual({ default: 0 });
    expect(publicJournal.getFlag(MODULE_ID, "aiHistory")).toEqual({ historyId: "h1", kind: "public", sceneId: "s1" });
    expect(gmJournal.getFlag(MODULE_ID, "aiHistory")).toEqual({ historyId: "h1", kind: "gm", sceneId: "s1" });
    expect(publicJournal.folder.id).toBe(world.folders[0].id);
    expect(gmJournal.folder.id).toBe(world.folders[0].id);
  });

  it("finds existing journals by historyId (even renamed) instead of creating", async () => {
    const first = await findOrCreateRunJournals({ historyId: "h1", displayName: "Crypt" }, world.deps);
    first.publicJournal.name = "Renamed by a GM";
    const again = await findOrCreateRunJournals({ historyId: "h1", displayName: "Other" }, world.deps);
    expect(again.publicJournal).toBe(first.publicJournal);
    expect(again.gmJournal).toBe(first.gmJournal);
    expect(world.deps.JournalEntryCls.create).toHaveBeenCalledTimes(2);
    expect(world.deps.FolderCls.create).toHaveBeenCalledTimes(1);
  });

  it("recreates only a journal that was deleted by hand, reusing the folder", async () => {
    const first = await findOrCreateRunJournals({ historyId: "h1", displayName: "Crypt" }, world.deps);
    await first.gmJournal.delete();
    const again = await findOrCreateRunJournals({ historyId: "h1", displayName: "Crypt" }, world.deps);
    expect(again.publicJournal).toBe(first.publicJournal);
    expect(again.gmJournal).not.toBe(first.gmJournal);
    expect(again.gmJournal.ownership).toEqual({ default: 0 });
    expect(world.deps.FolderCls.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a different run's journals separate", async () => {
    const a = await findOrCreateRunJournals({ historyId: "h1", displayName: "A" }, world.deps);
    const b = await findOrCreateRunJournals({ historyId: "h2", displayName: "B" }, world.deps);
    expect(b.publicJournal).not.toBe(a.publicJournal);
    expect(world.journals).toHaveLength(4);
  });
});

describe("findRunJournal (#953)", () => {
  it("uses the oldest of duplicates and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const older = world.addJournal({ name: "old", flags: { [MODULE_ID]: { aiHistory: { historyId: "h1", kind: "public" } } } });
    world.addJournal({ name: "new", flags: { [MODULE_ID]: { aiHistory: { historyId: "h1", kind: "public" } } } });
    world.journals.reverse();
    expect(findRunJournal("h1", "public", world.deps)).toBe(older);
    expect(warn).toHaveBeenCalled();
  });
});

describe("archiveAiLogToJournals (#953)", () => {
  const base = { combatId: "combat1", historyId: "h1", sceneId: "s1", displayName: "Crypt", label: "Room 2 — Combat" };

  it("creates nothing (no folder, journal or page) for an empty or malformed log", async () => {
    for (const records of [undefined, null, [], "junk", [null, 3]]) {
      expect(await archiveAiLogToJournals({ ...base, records }, world.deps)).toEqual({ publicPage: false, gmPage: false });
    }
    expect(world.deps.FolderCls.create).not.toHaveBeenCalled();
    expect(world.deps.JournalEntryCls.create).not.toHaveBeenCalled();
  });

  it("adds one titled, flagged page to each journal; public page carries no GM-only content", async () => {
    const res = await archiveAiLogToJournals(
      { ...base, records: RECORDS, publicNames: { c1: "Goblin" }, gmNames: { c1: "Goblin", c3: "Lurker" } },
      world.deps,
    );
    expect(res).toEqual({ publicPage: true, gmPage: true });
    const pub = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "public");
    const gm = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "gm");
    const [pubPage] = pub.pages.contents;
    const [gmPage] = gm.pages.contents;
    expect(pubPage.name).toBe("Room 2 — Combat");
    expect(pubPage.type).toBe("text");
    expect(pubPage.text.format).toBe(1);
    expect(pubPage.getFlag(MODULE_ID, "aiHistory")).toEqual({ combatId: "combat1" });
    expect(pubPage.text.content).toContain("Dagger vs Fighter");
    expect(pubPage.text.content).not.toContain("Claw vs Fighter");
    expect(pubPage.text.content).not.toContain("Closest.");
    expect(pubPage.text.content).not.toContain("Lurker");
    expect(gmPage.getFlag(MODULE_ID, "aiHistory")).toEqual({ combatId: "combat1" });
    expect(gmPage.text.content).toContain("Claw vs Fighter");
    expect(gmPage.text.content).toContain("Closest.");
    expect(gmPage.text.content).toContain("Lurker");
  });

  it("is idempotent per combat id", async () => {
    await archiveAiLogToJournals({ ...base, records: RECORDS }, world.deps);
    const second = await archiveAiLogToJournals({ ...base, records: RECORDS }, world.deps);
    expect(second).toEqual({ publicPage: false, gmPage: false });
    for (const j of world.journals) expect(j.pages.contents).toHaveLength(1);
  });

  it("appends a later combat's pages after the earlier ones", async () => {
    await archiveAiLogToJournals({ ...base, records: RECORDS }, world.deps);
    await archiveAiLogToJournals({ ...base, combatId: "combat2", label: "Room 3 — Combat", records: RECORDS }, world.deps);
    for (const j of world.journals) {
      const [a, b] = j.pages.contents;
      expect(b.sort).toBeGreaterThan(a.sort);
      expect(b.name).toBe("Room 3 — Combat");
    }
  });

  it("writes only the GM page when every action came from a hidden actor", async () => {
    const res = await archiveAiLogToJournals({ ...base, records: [RECORDS[1]] }, world.deps);
    expect(res).toEqual({ publicPage: false, gmPage: true });
    const pub = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "public");
    expect(pub.pages.contents).toHaveLength(0);
  });

  it("propagates a failing write to its caller", async () => {
    world.deps.JournalEntryCls.create.mockRejectedValueOnce(new Error("no permission"));
    await expect(archiveAiLogToJournals({ ...base, records: RECORDS }, world.deps)).rejects.toThrow("no permission");
  });
});

describe("deleteRunJournals (#953)", () => {
  it("deletes both journals by historyId and the now-empty folder", async () => {
    await archiveAiLogToJournals({ records: RECORDS, combatId: "c", historyId: "h1", displayName: "A", label: "L" }, world.deps);
    const folder = world.folders[0];
    expect(await deleteRunJournals({ historyId: "h1" }, world.deps)).toBe(2);
    expect(world.journals).toHaveLength(0);
    expect(folder.delete).toHaveBeenCalled();
  });

  it("keeps another run's journals and the folder they still use", async () => {
    await findOrCreateRunJournals({ historyId: "h1", displayName: "A" }, world.deps);
    await findOrCreateRunJournals({ historyId: "h2", displayName: "B" }, world.deps);
    await deleteRunJournals({ historyId: "h1" }, world.deps);
    expect(world.journals.map((j) => j.getFlag(MODULE_ID, "aiHistory").historyId)).toEqual(["h2", "h2"]);
    expect(world.folders).toHaveLength(1);
  });

  it("also catches journals flagged with the run's scene id", async () => {
    await findOrCreateRunJournals({ historyId: "lost", sceneId: "s1", displayName: "A" }, world.deps);
    expect(await deleteRunJournals({ historyId: "h-new", sceneId: "s1" }, world.deps)).toBe(2);
  });

  it("never touches a journal without the history flag, nor a folder it did not create", async () => {
    const userFolder = await world.deps.FolderCls.create({ name: AI_HISTORY_FOLDER_NAME, type: "JournalEntry" });
    world.addJournal({ name: "Notes", folder: userFolder.id });
    world.addJournal({ name: "Mine", folder: userFolder.id, flags: { [MODULE_ID]: { aiHistory: { historyId: "h1", kind: "public" } } } });
    await deleteRunJournals({ historyId: "h1" }, world.deps);
    expect(world.journals.map((j) => j.name)).toEqual(["Notes"]);
    expect(userFolder.delete).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing matches, and keeps going past a failing delete", async () => {
    expect(await deleteRunJournals({ historyId: "nope" }, world.deps)).toBe(0);
    expect(await deleteRunJournals({}, world.deps)).toBe(0);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { publicJournal } = await findOrCreateRunJournals({ historyId: "h1", displayName: "A" }, world.deps);
    publicJournal.delete.mockRejectedValueOnce(new Error("boom"));
    expect(await deleteRunJournals({ historyId: "h1" }, world.deps)).toBe(1);
    expect(err).toHaveBeenCalled();
  });
});
