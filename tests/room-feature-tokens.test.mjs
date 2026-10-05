import { describe, it, expect } from "vitest";
import {
  ROOM_FEATURE_TOKEN_TYPES,
  buildRoomFeatureTokenActorData,
} from "../scripts/room-feature-tokens.mjs";

describe("ROOM_FEATURE_TOKEN_TYPES", () => {
  it("has exactly the three room kinds this feature covers", () => {
    expect(Object.keys(ROOM_FEATURE_TOKEN_TYPES).sort()).toEqual([
      "puzzle",
      "skill_challenge",
      "treasure",
    ]);
  });

  it("every entry has a name and an icon path", () => {
    for (const entry of Object.values(ROOM_FEATURE_TOKEN_TYPES)) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.img).toMatch(/^icons\/svg\/.+\.svg$/);
    }
  });
});

describe("buildRoomFeatureTokenActorData", () => {
  it("builds a loot-type actor with the kind's own name and icon", () => {
    const data = buildRoomFeatureTokenActorData("treasure", "room-1");
    expect(data.type).toBe("loot");
    expect(data.name).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.name);
    expect(data.img).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.img);
    expect(data.prototypeToken.texture.src).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.img);
  });

  it("flags the actor with its room-feature kind and room id", () => {
    const data = buildRoomFeatureTokenActorData("puzzle", "room-42");
    expect(data.flags["pf2e-dungeon-crawl"]).toEqual({
      roomFeatureKind: "puzzle",
      roomFeatureRoomId: "room-42",
    });
  });

  it("builds a distinct actor per kind", () => {
    const puzzle = buildRoomFeatureTokenActorData("puzzle", "room-1");
    const challenge = buildRoomFeatureTokenActorData("skill_challenge", "room-1");
    expect(puzzle.name).not.toBe(challenge.name);
    expect(puzzle.img).not.toBe(challenge.img);
  });

  it("throws on an unknown kind", () => {
    expect(() => buildRoomFeatureTokenActorData("not-a-kind", "room-1")).toThrow(
      /not-a-kind/,
    );
  });
});
