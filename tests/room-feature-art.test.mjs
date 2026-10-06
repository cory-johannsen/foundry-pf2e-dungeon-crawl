import { describe, it, expect } from "vitest";
import {
  ROOM_FEATURE_ART_THEMES,
  ROOM_FEATURE_ART_KINDS,
  ROOM_FEATURE_ART_BASE_KINDS,
  ROOM_FEATURE_ART_STATE_KINDS,
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
  it("has door plus the three room-feature base kinds", () => {
    expect([...ROOM_FEATURE_ART_BASE_KINDS].sort()).toEqual([
      "door", "puzzle", "skill_challenge", "treasure",
    ]);
  });
  it("has the four state kinds (#764)", () => {
    expect([...ROOM_FEATURE_ART_STATE_KINDS].sort()).toEqual([
      "door_locked", "puzzle_used", "skill_challenge_used", "treasure_used",
    ]);
  });
  it("kinds is base plus state", () => {
    expect([...ROOM_FEATURE_ART_KINDS]).toEqual([
      ...ROOM_FEATURE_ART_BASE_KINDS, ...ROOM_FEATURE_ART_STATE_KINDS,
    ]);
  });
});

describe("roomFeatureArtPath", () => {
  const manifest = { undead: { door: [0], treasure: [0] }, fiend: { puzzle: [0] } };

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
    expect(roomFeatureArtPath({ theme: "swamp", kind: "door", manifest: { swamp: { door: [0] } } })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "lever", manifest: { undead: { lever: [0] } } })).toBeNull();
  });
  it("returns null for a missing, null or malformed manifest", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door" })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", manifest: null })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", manifest: { undead: ["door"] } })).toBeNull();
  });
  it("is called with no arguments safely", () => {
    expect(roomFeatureArtPath()).toBeNull();
  });
});

describe("roomFeatureArtPath variants (#764)", () => {
  const manifest = { undead: { door: [0, 1], treasure: [0], door_locked: [0] } };
  const D = `${ROOM_FEATURE_ART_DIR}/undead`;

  it("returns the exact variant when listed", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", variant: 1, manifest })).toBe(`${D}/door-1.webp`);
  });
  it("variant 0 keeps the unsuffixed filename", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", variant: 0, manifest })).toBe(`${D}/door.webp`);
  });
  it("falls back to variant 0 when the requested variant is missing", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", variant: 2, manifest })).toBe(`${D}/door.webp`);
  });
  it("returns null when even variant 0 is missing for that kind", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "treasure", variant: 1, manifest })).toBe(`${D}/treasure.webp`);
    expect(roomFeatureArtPath({ theme: "undead", kind: "puzzle", variant: 1, manifest })).toBeNull();
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", variant: 1, manifest: { undead: { door: [1] } } }))
      .toBe(`${D}/door-1.webp`);
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", variant: 2, manifest: { undead: { door: [1] } } })).toBeNull();
  });
  it("a state kind resolves from its own unsuffixed file", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door_locked", manifest })).toBe(`${D}/door_locked.webp`);
  });
  it("defaults variant to 0 when omitted", () => {
    expect(roomFeatureArtPath({ theme: "undead", kind: "door", manifest })).toBe(`${D}/door.webp`);
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
