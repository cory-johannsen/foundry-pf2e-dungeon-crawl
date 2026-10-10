// tests/npc-move-parse-coverage.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseMovementAbility } from '../scripts/npc-move-parse.mjs';

// #932: the spec's data-driven coverage audit. The fixture is every active
// (1-3 action or free) NPC action in Monster Core 1-2 and Bestiary 1-3 whose
// text names a movement verb (Stride/Fly/Swim/Burrow/Climb/jump/Leap) or a
// teleport -- read from the PF2e system's own source data. Each entry's
// `expected` kind ("move", "teleport" or null = not offered) is a snapshot
// of this parser's classification, so any grammar or compendium change is
// an explicit diff and #972 can measure widened rider coverage against it.
const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-move-ability-slice.json', import.meta.url), 'utf8'),
);

const classify = (entry) => parseMovementAbility(entry.item)?.plan?.kind ?? null;

describe('npc movement-ability parser coverage (#932)', () => {
  it('covers the whole 345-ability slice', () => {
    expect(entries).toHaveLength(345);
  });

  it('classifies the slice as 34 move / 8 teleport / 303 not offered', () => {
    const counts = { move: 0, teleport: 0, none: 0 };
    for (const entry of entries) counts[classify(entry) ?? 'none'] += 1;
    expect(counts).toEqual({ move: 34, teleport: 8, none: 303 });
  });

  it("matches every entry's snapshot classification", () => {
    const mismatches = entries
      .filter((entry) => classify(entry) !== entry.expected)
      .map((entry) => `${entry.actor}: ${entry.name} (${entry.expected} -> ${classify(entry)})`);
    expect(mismatches).toEqual([]);
  });
});
