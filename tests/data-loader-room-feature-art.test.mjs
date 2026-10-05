import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadRoomFeatureArt, invalidateCaches } from "../scripts/data-loader.mjs";

describe("loadRoomFeatureArt", () => {
  beforeEach(() => invalidateCaches());
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the manifest and caches a successful result", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ undead: ["door"] }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadRoomFeatureArt()).toEqual({ undead: ["door"] });
    expect(await loadRoomFeatureArt()).toEqual({ undead: ["door"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("modules/pf2e-dungeon-crawl/data/room-feature-art.json");
  });
  it("returns an empty manifest and does not cache when the fetch rejects", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadRoomFeatureArt()).toEqual({});
    expect(await loadRoomFeatureArt()).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("returns an empty manifest for a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await loadRoomFeatureArt()).toEqual({});
  });
  it("returns an empty manifest when the body is not valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })));
    expect(await loadRoomFeatureArt()).toEqual({});
  });
  it("returns an empty manifest when fetch is not defined", async () => {
    vi.stubGlobal("fetch", undefined);
    expect(await loadRoomFeatureArt()).toEqual({});
  });
});
