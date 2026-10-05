import { describe, it, expect } from "vitest";
import {
  ROOM_FEATURE_ART_THEMES,
  ROOM_FEATURE_ART_KINDS,
  ROOM_FEATURE_ART_DIR,
  roomFeatureArtPath,
  DOOR_ANIMATION,
  doorAnimationFor,
} from "../scripts/room-feature-art.mjs";

describe("room-feature art constants", () => {
  it("has the eight floor-art themes", () => {
    expect([...ROOM_FEATURE_ART_THEMES].sort()).toEqual([
      "aberration", "beast", "construct", "dragon",
      "elemental", "fiend", "plant", "undead",
    ]);
  });
  it("has door plus the three room-feature kinds", () => {
    expect([...ROOM_FEATURE_ART_KINDS].sort()).toEqual([
      "door", "puzzle", "skill_challenge", "treasure",
    ]);
  });
});

describe("roomFeatureArtPath", () => {
  const manifest = { undead: ["door", "treasure"], fiend: ["puzzle"] };

  it("returns the module path for a listed theme and kind", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "treasure", manifest })).toBe(
      `${ROOM_FEATURE_ART_DIR}/undead/treasure.webp`,
    );
    expect(roomFeatureArtPath({ theme: "fiend", kind: "puzzle", manifest })).toBe(
      `${ROOM_FEATURE_ART_DIR}/fiend/puzzle.webp`,
    );
  });
  it("returns null for a kind the theme does not list", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "puzzle", manifest })).toBeNull();
  });
  it("returns null for a theme the manifest does not list", () => {
    expect(roomFeatureArtPath({ theme: "plant", kind: "door", manifest })).toBeNull();
  });
  it("returns null for null, empty and unknown themes or kinds", () => {
    expect(roomFeatureArtPath({ theme: null, kind: "door", manifest })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: null, manifest })).toBeNull();
    expect(roomFeatureArtPath({ theme: "swamp", kind: "door", manifest: { swamp: ["door"] } })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "lever", manifest: { undead: ["lever"] } })).toBeNull();
  });
  it("returns null for a missing, null or malformed manifest", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door" })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", manifest: null })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", manifest: { undead: "door" } })).toBeNull();
  });
  it("is called with no arguments safely", () => {
    expect(roomFeatureArtPath()).toBeNull();
  });
});

describe("doorAnimationFor", () => {
  it("returns null when there is no art", () => {
    expect(doorAnimationFor(null)).toBeNull();
    expect(doorAnimationFor(undefined)).toBeNull();
  });
  it("carries the door animation type and the texture path", () => {
    expect(doorAnimationFor("modules/x/a.webp")).toEqual({
      ...DOOR_ANIMATION,
      texture: "modules/x/a.webp",
    });
  });
});
