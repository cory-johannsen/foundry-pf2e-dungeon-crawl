import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// #1284: PF2e's strike.damage() ignores `outcome` (it always rolls as a
// success). A `.damage({ ..., outcome })` call therefore rolls single damage
// on a critical hit while looking correct. Use rollStrikeDamage() instead.
const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const PATTERN = /\.damage\(\s*\{(?:[^{}]|\{[^{}]*\})*?\boutcome\b/g;

describe("no strike.damage({ outcome }) calls (#1284)", () => {
  it("scripts/*.mjs never passes outcome to .damage()", () => {
    const hits = [];
    for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
      const text = readFileSync(join(SCRIPTS, file), "utf8");
      for (const m of text.matchAll(PATTERN)) {
        hits.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(hits, "use rollStrikeDamage() from scripts/strike-damage.mjs").toEqual([]);
  });

  it("the pattern really matches the bug shape (guard against a vacuous test)", () => {
    expect("await strike.damage({\n target: targetRef,\n outcome,\n createMessage: true })".match(PATTERN)).not.toBeNull();
    expect("a.damage({ target: { document: t }, outcome: degree, createMessage: true })".match(PATTERN)).not.toBeNull();
    expect("strike.damage({ target: targetRef, createMessage: true })".match(PATTERN)).toBeNull();
  });
});
