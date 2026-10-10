import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ENVIRONMENTS } from "../scripts/environments.mjs";
import { loadCreatureEnvironments, invalidateCaches } from "../scripts/data-loader.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), "utf8"));

describe("creature-environments data files", () => {
  const map = read("creature-environments.json");
  const sources = read("creature-environments.sources.json");
  const art = new Set(read("creature-art.json").map((e) => e.id));
  const allowed = new Set([...ENVIRONMENTS, "any"]);

  it("has the top-level shape", () => {
    expect(typeof map.version).toBe("number");
    expect(map.creatures && typeof map.creatures).toBe("object");
    expect(Array.isArray(map.creatures)).toBe(false);
  });
  it("only maps ids present in creature-art.json", () => {
    for (const id of Object.keys(map.creatures)) expect(art.has(id), id).toBe(true);
  });
  it("has non-empty unique valid environment arrays, never combining any", () => {
    for (const [id, envs] of Object.entries(map.creatures)) {
      expect(Array.isArray(envs) && envs.length > 0, id).toBe(true);
      expect(new Set(envs).size, id).toBe(envs.length);
      for (const e of envs) expect(allowed.has(e), `${id}:${e}`).toBe(true);
      if (envs.includes("any")) expect(envs, id).toEqual(["any"]);
    }
  });
  it("sources keys are a subset of map keys with valid values and cover the map", () => {
    expect(typeof sources.version).toBe("number");
    for (const [id, s] of Object.entries(sources.sources)) {
      expect(id in map.creatures, id).toBe(true);
      expect(["audit", "manual"]).toContain(s);
    }
    for (const id of Object.keys(map.creatures)) expect(id in sources.sources, id).toBe(true);
  });
});

describe("loadCreatureEnvironments", () => {
  const DEFAULT = { version: 0, creatures: {} };
  let warn;
  beforeEach(() => { invalidateCaches(); warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore(); });

  it("fetches and caches a successful result", async () => {
    const body = { version: 1, creatures: { a: ["cave"] } };
    const f = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal("fetch", f);
    expect(await loadCreatureEnvironments()).toEqual(body);
    expect(await loadCreatureEnvironments()).toEqual(body);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("modules/pf2e-dungeon-crawl/data/creature-environments.json");
    expect(warn).not.toHaveBeenCalled();
  });
  it("returns default + one warn on 404, not cached", async () => {
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal("fetch", f);
    expect(await loadCreatureEnvironments()).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledTimes(1);
    await loadCreatureEnvironments();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("returns default + warn when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await loadCreatureEnvironments()).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("returns default + warn on malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { throw new Error("bad"); } })));
    expect(await loadCreatureEnvironments()).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it.each([[null], [[]], [{ version: 1 }], [{ creatures: [] }], ["x"]])("returns default for invalid body %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
    expect(await loadCreatureEnvironments()).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
