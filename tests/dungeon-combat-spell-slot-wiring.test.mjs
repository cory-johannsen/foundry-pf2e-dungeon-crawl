// tests/dungeon-combat-spell-slot-wiring.test.mjs
//
// Structural guard for #620: every ready-spell candidate builder in
// getPendingAgentTurn must chain hasSpellSlotRemaining right after
// hasSpellUsesRemaining. The 12-site wiring has no behavioral unit coverage,
// so a missed site would silently keep the exhausted-slot bug.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scripts/dungeon-combat.mjs", import.meta.url), "utf8");
const USES_FILTER = ".filter(hasSpellUsesRemaining)";
const SLOT_FILTER = ".filter((spell) => hasSpellSlotRemaining(spell, entry))";
const EXPECTED_SITES = 12;

function lineOf(offset) {
  return SRC.slice(0, offset).split("\n").length;
}

describe("#620 spell-slot check wiring in dungeon-combat.mjs", () => {
  it("imports hasSpellSlotRemaining from ./agent-candidates.mjs", () => {
    const m = SRC.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/agent-candidates\.mjs"/);
    expect(m, "no import from ./agent-candidates.mjs found").not.toBeNull();
    expect(m[1]).toMatch(/\bhasSpellSlotRemaining\b/);
  });

  it(`has exactly ${EXPECTED_SITES} ${USES_FILTER} candidate-builder sites`, () => {
    expect(SRC.split(USES_FILTER).length - 1).toBe(EXPECTED_SITES);
  });

  it("chains hasSpellSlotRemaining immediately after every hasSpellUsesRemaining filter", () => {
    const offenders = [];
    let from = 0;
    for (;;) {
      const at = SRC.indexOf(USES_FILTER, from);
      if (at === -1) break;
      const end = at + USES_FILTER.length;
      const after = SRC.slice(end).replace(/^\s+/, "");
      if (!after.startsWith(SLOT_FILTER)) offenders.push(lineOf(at));
      from = end;
    }
    expect(offenders, `hasSpellUsesRemaining filter(s) not followed by the slot filter at line(s): ${offenders.join(", ")}`).toEqual([]);
  });

  it("has one hasSpellSlotRemaining(spell, entry) call per hasSpellUsesRemaining site", () => {
    const calls = SRC.split("hasSpellSlotRemaining(spell, entry)").length - 1;
    expect(calls).toBe(SRC.split(USES_FILTER).length - 1);
  });
});
