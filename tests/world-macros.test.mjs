import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { MACRO_DEFS, ensureWorldMacros } from "../scripts/world-macros.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

/** Builds a minimal stand-in for a Foundry Macro document, with the same
 * `flags`/`getFlag` shape `ensureWorldMacros()` relies on. */
function makeMacro({
  id,
  name,
  command,
  img,
  generated = false,
  extraFlags = {},
  // #773: Foundry's own default for a document created with no explicit
  // ownership is "creator owns it, nobody else" -- {default: NONE (0)}.
  // Defaulting every test fixture to this exact shape means an existing
  // test that doesn't care about ownership still accurately represents
  // today's real bug, rather than accidentally pre-fixing itself.
  ownership = { default: 0 },
}) {
  const flags = generated
    ? { [MODULE_ID]: { generated: true, ...extraFlags } }
    : { ...extraFlags };
  return {
    id,
    name,
    command,
    img,
    flags,
    ownership,
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
  };
}

function installFoundryStubs({ macros = [] } = {}) {
  globalThis.Macro = {
    createDocuments: vi.fn(async () => []),
    updateDocuments: vi.fn(async () => []),
  };
  globalThis.game = { macros };
  globalThis.ui = { notifications: { info: vi.fn() } };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete globalThis.Macro;
  delete globalThis.game;
  delete globalThis.ui;
});

describe("MACRO_DEFS", () => {
  it("names the dungeon-crawl macro plainly, with no DOMMT/PF2EDC prefix (#96)", () => {
    const dungeonCrawlDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    expect(dungeonCrawlDef.name).toBe("Dungeon Crawl");
  });

  it("names the generate-encounter macro plainly, with no PF2EDC prefix (#770)", () => {
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    expect(encounterDef.name).toBe("Generate Encounter");
  });
});

describe("ensureWorldMacros", () => {
  it("creates every macro on a fresh world with none of its own macros yet", async () => {
    installFoundryStubs({ macros: [] });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).toHaveBeenCalledTimes(1);
    const created = Macro.createDocuments.mock.calls[0][0];
    expect(created).toHaveLength(MACRO_DEFS.length);
    expect(created.map((c) => c.name).sort()).toEqual(
      MACRO_DEFS.map((d) => d.name).sort(),
    );
    for (const c of created) {
      expect(c.flags[MODULE_ID].generated).toBe(true);
    }
    expect(Macro.updateDocuments).not.toHaveBeenCalled();
    expect(result).toEqual({ created: MACRO_DEFS.length, updated: 0 });
  });

  it("creates every macro with ownership.default set so every connected user can run it (#773)", async () => {
    installFoundryStubs({ macros: [] });

    await ensureWorldMacros();

    const created = Macro.createDocuments.mock.calls[0][0];
    for (const c of created) {
      expect(c.ownership).toEqual({ default: 3 });
    }
  });

  it('renames an existing generated macro still called "DOMMT: Dungeon Crawl" in place, without creating a duplicate', async () => {
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const stale = makeMacro({
      id: "stale-dommt",
      name: "DOMMT: Dungeon Crawl",
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    const encounterMacro = makeMacro({
      id: "encounter-1",
      name: encounterDef.name,
      command: encounterDef.command,
      img: encounterDef.img,
      generated: true,
      ownership: { default: 3 }, // #773: already correctly owned
    });
    installFoundryStubs({ macros: [stale, encounterMacro] });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toEqual([
      expect.objectContaining({ _id: "stale-dommt", name: "Dungeon Crawl" }),
    ]);
    expect(result).toEqual({ created: 0, updated: 1 });
  });

  it('renames an existing generated macro still called "PF2EDC: Dungeon Crawl" in place, without creating a duplicate', async () => {
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const stale = makeMacro({
      id: "stale-pf2edc",
      name: "PF2EDC: Dungeon Crawl",
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    installFoundryStubs({ macros: [stale] });

    const result = await ensureWorldMacros();

    // The generate-encounter macro is still missing, so it's created; the
    // stale dungeon-crawl macro is renamed in place, not duplicated.
    expect(Macro.createDocuments).toHaveBeenCalledTimes(1);
    const created = Macro.createDocuments.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe("Generate Encounter");

    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toEqual([
      expect.objectContaining({ _id: "stale-pf2edc", name: "Dungeon Crawl" }),
    ]);
    expect(result).toEqual({ created: 1, updated: 1 });
  });

  it('renames an existing generated macro still called "PF2EDC: Generate Encounter" in place, without creating a duplicate (#770)', async () => {
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    const stale = makeMacro({
      id: "stale-encounter",
      name: "PF2EDC: Generate Encounter",
      command: encounterDef.command,
      img: encounterDef.img,
      generated: true,
    });
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const dungeonMacro = makeMacro({
      id: "dungeon-1",
      name: dungeonDef.name,
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    installFoundryStubs({ macros: [stale, dungeonMacro] });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toEqual([
      expect.objectContaining({ _id: "stale-encounter", name: "Generate Encounter" }),
    ]);
    expect(result).toEqual({ created: 0, updated: 1 });
  });

  it('does not match on name alone — a non-generated macro that happens to be named "Dungeon Crawl" is left untouched and a real one is still created', async () => {
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const userMacro = makeMacro({
      id: "user-macro",
      name: "Dungeon Crawl",
      command: "// a player's own unrelated macro",
      img: "icons/svg/mystery-man.svg",
      generated: false,
    });
    installFoundryStubs({ macros: [userMacro] });

    await ensureWorldMacros();

    expect(Macro.updateDocuments).not.toHaveBeenCalled();
    expect(Macro.createDocuments).toHaveBeenCalledTimes(1);
    const created = Macro.createDocuments.mock.calls[0][0];
    expect(created.some((c) => c.name === dungeonDef.name)).toBe(true);
  });

  it("leaves a correctly-named, up-to-date generated macro alone", async () => {
    const upToDate = MACRO_DEFS.map((def, i) =>
      makeMacro({
        id: `macro-${i}`,
        name: def.name,
        command: def.command,
        img: def.img,
        generated: true,
        ownership: { default: 3 }, // #773: already correctly owned
      }),
    );
    installFoundryStubs({ macros: upToDate });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0 });
  });

  it("fixes an otherwise-correct generated macro's wrong ownership, without touching its name/command/img (#773)", async () => {
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    // Both macros are otherwise perfectly correct (right name, right
    // command, right img) -- only ownership is wrong (makeMacro's own
    // default, simulating today's real bug: created while the
    // foundry-rest relay's own bot user was the active client).
    const dungeonMacro = makeMacro({
      id: "dungeon-1",
      name: dungeonDef.name,
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    const encounterMacro = makeMacro({
      id: "encounter-1",
      name: encounterDef.name,
      command: encounterDef.command,
      img: encounterDef.img,
      generated: true,
    });
    installFoundryStubs({ macros: [dungeonMacro, encounterMacro] });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toHaveLength(2);
    for (const u of updated) {
      expect(u.ownership).toEqual({ default: 3 });
    }
    expect(updated.find((u) => u._id === "dungeon-1").name).toBe(
      dungeonDef.name,
    );
    expect(updated.find((u) => u._id === "encounter-1").name).toBe(
      encounterDef.name,
    );
    expect(result).toEqual({ created: 0, updated: 2 });
  });

  it("force:true updates every matching generated macro even when already in sync", async () => {
    const upToDate = MACRO_DEFS.map((def, i) =>
      makeMacro({
        id: `macro-${i}`,
        name: def.name,
        command: def.command,
        img: def.img,
        generated: true,
        ownership: { default: 3 }, // #773: already correctly owned
      }),
    );
    installFoundryStubs({ macros: upToDate });

    const result = await ensureWorldMacros({ force: true });

    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    expect(Macro.updateDocuments.mock.calls[0][0]).toHaveLength(
      MACRO_DEFS.length,
    );
    expect(result).toEqual({ created: 0, updated: MACRO_DEFS.length });
  });

  it("when multiple generated macros match the same def, updates only the first and warns about the extras instead of duplicating", async () => {
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const dupeA = makeMacro({
      id: "dupe-a",
      name: "DOMMT: Dungeon Crawl",
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    const dupeB = makeMacro({
      id: "dupe-b",
      name: "PF2EDC: Dungeon Crawl",
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    installFoundryStubs({ macros: [dupeA, dupeB] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureWorldMacros();

    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toHaveLength(1);
    expect(updated[0]._id).toBe("dupe-a");
    expect(Macro.createDocuments).toHaveBeenCalledTimes(1); // the encounter macro is still missing
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
