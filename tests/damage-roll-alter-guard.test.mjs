import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// #1289: PF2e's DamageRoll#alter() returns a NEW roll and leaves the original
// untouched. A statement-position `await roll.alter(...)` throws the scaled
// roll away, so the original, unscaled roll is what gets applied.
const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const PATTERN = /^[ \t]*(?:await[ \t]+)?[\w.?]+\.alter\([^;]*\);[ \t]*$/gm;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".mjs")) yield full;
  }
}

describe("DamageRoll.alter() result is never discarded (#1289)", () => {
  it("no statement-position .alter() call in scripts/", () => {
    const hits = [];
    for (const file of walk(SCRIPTS)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(PATTERN)) {
        hits.push(`${file.slice(SCRIPTS.length)}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(hits, "use the roll alter() returns: `const finalRoll = await roll.alter(...)`").toEqual([]);
  });

  it("the pattern matches the bug shape and not the correct shapes (guard against a vacuous test)", () => {
    expect("          await damageRoll.alter(1.5, 0);".match(PATTERN)).not.toBeNull();
    expect("    damageRoll.alter(2, 0);".match(PATTERN)).not.toBeNull();
    expect("const finalRoll = await damageRoll.alter(1.5, 0);".match(PATTERN)).toBeNull();
    expect("      ? await damageRoll.alter(0.5, 0)".match(PATTERN)).toBeNull();
    expect("damage: multiplier === 1 ? damageRoll : damageRoll.alter(multiplier, 0),".match(PATTERN)).toBeNull();
  });
});
