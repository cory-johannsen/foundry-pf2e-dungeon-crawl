import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DUNGEON_SOUND_FILES,
  strikeHitSoundKey,
  strikeSoundPath,
  spellSaveSoundPath,
  spellAttackSoundPath,
  soundPreviewEntries,
} from "../scripts/dungeon-sound.mjs";

const assetsDir = fileURLToPath(
  new URL("../assets/sounds/", import.meta.url),
);

describe("every declared dungeon sound file exists", () => {
  for (const [key, file] of Object.entries(DUNGEON_SOUND_FILES)) {
    it(`${key} -> ${file}`, () => {
      expect(existsSync(assetsDir + file)).toBe(true);
    });
  }
});

describe("strikeHitSoundKey", () => {
  it("buckets melee by damage type", () => {
    expect(
      strikeHitSoundKey({ isRanged: false, damageType: "bludgeoning" }),
    ).toBe("strikeHitBludgeoning");
    expect(strikeHitSoundKey({ isRanged: false, damageType: "piercing" })).toBe(
      "strikeHitPiercing",
    );
    expect(strikeHitSoundKey({ isRanged: false, damageType: "slashing" })).toBe(
      "strikeHitSlashing",
    );
  });

  it("falls back to bludgeoning for an unrecognized melee damage type", () => {
    expect(strikeHitSoundKey({ isRanged: false, damageType: "fire" })).toBe(
      "strikeHitBludgeoning",
    );
    expect(strikeHitSoundKey({ isRanged: false, damageType: undefined })).toBe(
      "strikeHitBludgeoning",
    );
  });

  it("buckets ranged by weapon group", () => {
    expect(strikeHitSoundKey({ isRanged: true, weaponGroup: "bow" })).toBe(
      "strikeHitBow",
    );
    expect(strikeHitSoundKey({ isRanged: true, weaponGroup: "crossbow" })).toBe(
      "strikeHitCrossbow",
    );
  });

  it("falls back to thrown for an unrecognized ranged weapon group", () => {
    expect(strikeHitSoundKey({ isRanged: true, weaponGroup: "sling" })).toBe(
      "strikeHitThrown",
    );
    expect(strikeHitSoundKey({ isRanged: true, weaponGroup: undefined })).toBe(
      "strikeHitThrown",
    );
  });
});

describe("strikeSoundPath", () => {
  const SOUND_DIR = "modules/pf2e-dungeon-crawl/assets/sounds";

  it("gives a critical hit its own sting regardless of weapon", () => {
    expect(
      strikeSoundPath("criticalSuccess", {
        isRanged: false,
        damageType: "slashing",
      }),
    ).toBe(`${SOUND_DIR}/strike-critical-hit.ogg`);
    expect(
      strikeSoundPath("criticalSuccess", {
        isRanged: true,
        weaponGroup: "bow",
      }),
    ).toBe(`${SOUND_DIR}/strike-critical-hit.ogg`);
  });

  it("gives a critical failure its own fumble sound", () => {
    expect(strikeSoundPath("criticalFailure")).toBe(
      `${SOUND_DIR}/strike-critical-miss.ogg`,
    );
  });

  it("gives a plain failure the miss sound", () => {
    expect(strikeSoundPath("failure")).toBe(`${SOUND_DIR}/strike-miss.ogg`);
  });

  it("a blocked success plays the blocked sound instead of the weapon sound", () => {
    expect(
      strikeSoundPath("success", {
        isRanged: false,
        damageType: "slashing",
        blocked: true,
      }),
    ).toBe(`${SOUND_DIR}/strike-blocked.ogg`);
  });

  it("an unblocked success plays the weapon-specific hit sound", () => {
    expect(
      strikeSoundPath("success", { isRanged: false, damageType: "piercing" }),
    ).toBe(`${SOUND_DIR}/strike-hit-piercing.ogg`);
    expect(
      strikeSoundPath("success", { isRanged: true, weaponGroup: "crossbow" }),
    ).toBe(`${SOUND_DIR}/strike-hit-crossbow.ogg`);
  });

  it("returns null for an outcome that is not one of PF2e's four degrees of success", () => {
    expect(strikeSoundPath(null)).toBeNull();
    expect(strikeSoundPath(undefined)).toBeNull();
    expect(strikeSoundPath("somethingElse")).toBeNull();
  });
});

describe("spellSaveSoundPath", () => {
  const SOUND_DIR = "modules/pf2e-dungeon-crawl/assets/sounds";

  it("a failed save (the spell lands) plays the hit sound", () => {
    expect(spellSaveSoundPath("failure")).toBe(`${SOUND_DIR}/card-arcane.ogg`);
    expect(spellSaveSoundPath("criticalFailure")).toBe(
      `${SOUND_DIR}/card-arcane.ogg`,
    );
  });

  it("a successful save (the spell does little or nothing) plays the miss sound", () => {
    expect(spellSaveSoundPath("success")).toBe(`${SOUND_DIR}/card-query.ogg`);
    expect(spellSaveSoundPath("criticalSuccess")).toBe(
      `${SOUND_DIR}/card-query.ogg`,
    );
  });

  it("returns null for an unrecognized outcome", () => {
    expect(spellSaveSoundPath(null)).toBeNull();
  });
});

describe("spellAttackSoundPath", () => {
  const SOUND_DIR = "modules/pf2e-dungeon-crawl/assets/sounds";

  it("is NOT inverted like spellSaveSoundPath -- success/criticalSuccess is a hit", () => {
    expect(spellAttackSoundPath("success")).toBe(
      `${SOUND_DIR}/card-arcane.ogg`,
    );
    expect(spellAttackSoundPath("criticalSuccess")).toBe(
      `${SOUND_DIR}/card-arcane.ogg`,
    );
  });

  it("failure/criticalFailure is a miss", () => {
    expect(spellAttackSoundPath("failure")).toBe(`${SOUND_DIR}/card-query.ogg`);
    expect(spellAttackSoundPath("criticalFailure")).toBe(
      `${SOUND_DIR}/card-query.ogg`,
    );
  });

  it("returns null for an unrecognized outcome", () => {
    expect(spellAttackSoundPath(null)).toBeNull();
  });
});

describe("soundPreviewEntries", () => {
  const SOUND_DIR = "modules/pf2e-dungeon-crawl/assets/sounds";

  it("returns one row per DUNGEON_SOUND_FILES key plus the two spell-outcome sounds", () => {
    expect(soundPreviewEntries()).toHaveLength(
      Object.keys(DUNGEON_SOUND_FILES).length + 2,
    );
  });

  it("every row's path resolves to a file that actually exists on disk", () => {
    for (const { path } of soundPreviewEntries()) {
      expect(existsSync(path.replace(SOUND_DIR, assetsDir.replace(/\/$/, "")))).toBe(
        true,
      );
    }
  });

  it("humanizes a camelCase catalog key into a spaced, capitalized label", () => {
    const row = soundPreviewEntries().find((r) => r.key === "strikeHitBludgeoning");
    expect(row.label).toBe("Strike Hit Bludgeoning");
  });

  it("resolves a catalog key's row to the same path strikeSoundPath-style resolution would give", () => {
    const row = soundPreviewEntries().find((r) => r.key === "doorOpen");
    expect(row.path).toBe(`${SOUND_DIR}/door-open.ogg`);
  });

  it("includes the two spell-outcome sounds with their own keys and real card-sound paths", () => {
    const entries = soundPreviewEntries();
    expect(entries.find((r) => r.key === "spellHit")).toEqual({
      key: "spellHit",
      label: "Spell Hit",
      path: `${SOUND_DIR}/card-arcane.ogg`,
    });
    expect(entries.find((r) => r.key === "spellMiss")).toEqual({
      key: "spellMiss",
      label: "Spell Miss",
      path: `${SOUND_DIR}/card-query.ogg`,
    });
  });
});
