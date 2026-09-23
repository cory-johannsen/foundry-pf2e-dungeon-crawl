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

  it("leaves the generate-encounter macro's name untouched (out of #96's scope)", () => {
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    expect(encounterDef.name).toBe("PF2EDC: Generate Encounter");
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
    expect(created[0].name).toBe("PF2EDC: Generate Encounter");

    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toEqual([
      expect.objectContaining({ _id: "stale-pf2edc", name: "Dungeon Crawl" }),
    ]);
    expect(result).toEqual({ created: 1, updated: 1 });
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
      }),
    );
    installFoundryStubs({ macros: upToDate });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0 });
  });

  it("force:true updates every matching generated macro even when already in sync", async () => {
    const upToDate = MACRO_DEFS.map((def, i) =>
      makeMacro({
        id: `macro-${i}`,
        name: def.name,
        command: def.command,
        img: def.img,
        generated: true,
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
