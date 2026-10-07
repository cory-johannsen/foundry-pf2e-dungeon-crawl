import { describe, it, expect } from "vitest";
import { doorSoundForWallTransition } from "../scripts/dungeon-sound.mjs";

const OPEN = 1, LOCKED = 2, CLOSED = 0;

describe("#868 doorSoundForWallTransition", () => {
  it("open: a reveal-door or stub-door transition to OPEN", () => {
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: true, hasStubFlag: false, hasGateFlag: false })).toBe("open");
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: false, hasStubFlag: true, hasGateFlag: false })).toBe("open");
  });

  it("lock: a progress-gate door transition to LOCKED", () => {
    expect(doorSoundForWallTransition(LOCKED, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: true })).toBe("lock");
  });

  it("unlock: a progress-gate OR stub door transition to CLOSED", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: true })).toBe("unlock");
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: false, hasStubFlag: true, hasGateFlag: false })).toBe("unlock");
  });

  it("stays silent for a bare reveal-door re-close (relockDoorFromRoom's own undo branch)", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: true, hasStubFlag: false, hasGateFlag: false })).toBeNull();
  });

  it("stays silent for a wall with none of this module's own door flags", () => {
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: false })).toBeNull();
    expect(doorSoundForWallTransition(LOCKED, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: false })).toBeNull();
  });

  it("stays silent for an untracked ds value", () => {
    expect(doorSoundForWallTransition(undefined, { hasRevealFlag: true, hasStubFlag: false, hasGateFlag: false })).toBeNull();
  });

  it("OPEN on a gate-only door plays open", () => {
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: true })).toBe("open");
  });

  it("LOCKED -> CLOSED plays unlock", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasGateFlag: true }, LOCKED)).toBe("unlock");
    expect(doorSoundForWallTransition(CLOSED, { hasStubFlag: true }, LOCKED)).toBe("unlock");
  });

  it("OPEN -> CLOSED plays open (same sound) on any door flag", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasGateFlag: true }, OPEN)).toBe("open");
    expect(doorSoundForWallTransition(CLOSED, { hasStubFlag: true }, OPEN)).toBe("open");
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: true }, OPEN)).toBe("open");
    expect(doorSoundForWallTransition(CLOSED, {}, OPEN)).toBeNull();
  });

  it("unknown previous state keeps the old CLOSED behaviour", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasGateFlag: true }, undefined)).toBe("unlock");
  });
});
