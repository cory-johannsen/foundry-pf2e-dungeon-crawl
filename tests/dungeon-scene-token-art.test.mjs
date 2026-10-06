import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../scripts/data-loader.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    loadRoomFeatureArt: vi.fn(async () => ({
      undead: { treasure: [0, 1], treasure_used: [0] },
    })),
  };
});

import { spawnRoomFeatureToken, applyRoomFeatureUsedArt } from "../scripts/dungeon-scene.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const ART = "modules/pf2e-dungeon-crawl/assets/room-features/undead";

function makeScene(tokens = []) {
  return {
    tokens: Object.assign([...tokens], {}),
    createEmbeddedDocuments: vi.fn(async () => []),
  };
}

function makeToken(roomId, kind) {
  const flags = { roomFeatureRoomId: roomId, roomFeatureKind: kind };
  return {
    flags: { [MODULE_ID]: flags },
    getFlag: (m, k) => (m === MODULE_ID ? flags[k] : undefined),
    update: vi.fn(async () => {}),
    actor: { update: vi.fn(async () => {}) },
  };
}

describe("#764 spawnRoomFeatureToken floor variant", () => {
  let created;
  beforeEach(() => {
    created = [];
    globalThis.Actor = {
      createDocuments: vi.fn(async (docs) => {
        created.push(...docs);
        return [{
          getTokenDocument: async () => ({ toObject: () => ({ flags: {} }) }),
          delete: async () => {},
        }];
      }),
    };
  });

  it("uses the room's art variant when the manifest lists it", async () => {
    await spawnRoomFeatureToken(makeScene(), "r1", "treasure", { rank: 1, col: 0, seed: 1, theme: "undead", variant: 1 });
    expect(created[0].img).toBe(`${ART}/treasure-1.webp`);
    expect(created[0].prototypeToken.texture.src).toBe(`${ART}/treasure-1.webp`);
  });

  it("falls back to variant 0 when the variant is unlisted", async () => {
    await spawnRoomFeatureToken(makeScene(), "r1", "treasure", { rank: 1, col: 0, seed: 1, theme: "undead", variant: 2 });
    expect(created[0].img).toBe(`${ART}/treasure.webp`);
  });

  it("defaults to variant 0 with no variant given", async () => {
    await spawnRoomFeatureToken(makeScene(), "r1", "treasure", { rank: 1, col: 0, seed: 1, theme: "undead" });
    expect(created[0].img).toBe(`${ART}/treasure.webp`);
  });
});

describe("#764 applyRoomFeatureUsedArt", () => {
  const manifest = { undead: { treasure_used: [0] } };

  it("swaps the matching token's art when used art exists", async () => {
    const tok = makeToken("r1", "treasure");
    const other = makeToken("r2", "treasure");
    await applyRoomFeatureUsedArt(makeScene([other, tok]), "r1", "treasure", { theme: "undead", manifest });
    const art = `${ART}/treasure_used.webp`;
    expect(tok.actor.update).toHaveBeenCalledWith({ img: art, "prototypeToken.texture.src": art });
    expect(tok.update).toHaveBeenCalledWith({ "texture.src": art });
    expect(other.actor.update).not.toHaveBeenCalled();
  });

  it("does nothing when the manifest has no used art", async () => {
    const tok = makeToken("r1", "puzzle");
    await applyRoomFeatureUsedArt(makeScene([tok]), "r1", "puzzle", { theme: "undead", manifest });
    expect(tok.actor.update).not.toHaveBeenCalled();
    expect(tok.update).not.toHaveBeenCalled();
  });

  it("does nothing when no matching token exists", async () => {
    await expect(
      applyRoomFeatureUsedArt(makeScene([]), "r1", "treasure", { theme: "undead", manifest }),
    ).resolves.toBeUndefined();
  });

  it("never throws when an update fails", async () => {
    const tok = makeToken("r1", "treasure");
    tok.actor.update.mockRejectedValue(new Error("boom"));
    await expect(
      applyRoomFeatureUsedArt(makeScene([tok]), "r1", "treasure", { theme: "undead", manifest }),
    ).resolves.toBeUndefined();
  });
});
