// tests/npc-ability-parse-coverage.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseSaveAbility } from '../scripts/npc-ability-parse.mjs';

// #915: the spec's data-driven coverage audit. The fixture is the full
// 369-ability slice (active 1-3 action / free NPC actions with a
// fortitude/reflex/will @Check and no @Damage) from the PF2e system's own
// source data for Monster Core 1-2 and Bestiary 1-3 -- the same population
// the spec counted. Each entry's `expected` mode is a snapshot of this
// parser's classification: any change to the parser (or a refreshed
// compendium) shows up here as an explicit diff, and it is the baseline
// #935 measures widened coverage against. Note the source data spells
// condition links by name (`Item.Frightened`, no label) where compiled
// runtime text carries an id plus a `{Label}`; the parser handles both.
const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-save-ability-slice.json', import.meta.url), 'utf8'),
);

const classify = (entry) => parseSaveAbility(entry.item)?.mode ?? null;

describe('npc save-ability parser coverage (#915)', () => {
  it('covers the spec\'s whole 369-ability slice', () => {
    expect(entries).toHaveLength(369);
  });

  it('classifies the slice as 16 auto / 174 reportOnly / 179 not offered', () => {
    const counts = { auto: 0, reportOnly: 0, none: 0 };
    for (const entry of entries) counts[classify(entry) ?? 'none'] += 1;
    expect(counts).toEqual({ auto: 16, reportOnly: 174, none: 179 });
  });

  it('matches every entry\'s snapshot classification', () => {
    const mismatches = entries
      .filter((entry) => classify(entry) !== entry.expected)
      .map((entry) => `${entry.actor}: ${entry.name} (${entry.expected} -> ${classify(entry)})`);
    expect(mismatches).toEqual([]);
  });

  it('classifies the abilities checked by hand against their real text', () => {
    const find = (actor, name) => entries.find((e) => e.actor === actor && e.name === name);
    // Clean degree blocks; the Off-Guard rider is reported to the GM.
    expect(classify(find('Megaprimatus', 'Terrifying Display'))).toBe('auto');
    expect(classify(find('Owlbear', 'Bloodcurdling Screech'))).toBe('auto');
    // "Creatures within 30 feet of the aqudel" -- an emanation.
    expect(parseSaveAbility(find('Aqudel', 'Strobe').item).shape).toEqual({ areaType: 'emanation', distanceFeet: 30 });
    // Burst "centered on a corner within reach" -- no stated range.
    expect(classify(find('Mokele-Mbembe', 'Whip Tail'))).toBeNull();
  });
});
