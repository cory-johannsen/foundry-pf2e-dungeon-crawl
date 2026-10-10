// tests/npc-self-parse-coverage.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseSelfAbility } from '../scripts/npc-self-parse.mjs';

// #934: the spec's data-driven coverage audit. The fixture is every active
// (1-3 action or free) NPC action in the installed pf2e system's compiled
// bestiary packs that carries a system.selfEffect, links an effect item in
// its text, or has a healing enricher -- deduplicated by (name, text). Each
// entry's `expected` family (null = not offered) is a snapshot of this
// parser's classification, so any grammar or compendium change is an
// explicit diff and #1024 can measure widened coverage against it. (Some
// parsed effect abilities are still dropped at runtime by the effect's own
// rule checks -- isUnsafeSelfEffectForNpc -- which this pure audit can't see.)
const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-self-ability-slice.json', import.meta.url), 'utf8'),
);

const classify = (entry) => parseSelfAbility(entry.item)?.family ?? null;

describe('npc self-buff/heal parser coverage (#934)', () => {
  it('covers the whole 711-ability slice', () => {
    expect(entries).toHaveLength(711);
  });

  it('classifies the slice as 26 selfEffectAction / 5 linkedEffectSelf / 19 selfHeal / 661 not offered', () => {
    const counts = { selfEffectAction: 0, linkedEffectSelf: 0, selfHeal: 0, none: 0 };
    for (const entry of entries) counts[classify(entry) ?? 'none'] += 1;
    expect(counts).toEqual({ selfEffectAction: 26, linkedEffectSelf: 5, selfHeal: 19, none: 661 });
  });

  it("matches every entry's snapshot classification", () => {
    const mismatches = entries
      .filter((entry) => classify(entry) !== entry.expected)
      .map((entry) => `${entry.actor}: ${entry.name} (${entry.expected} -> ${classify(entry)})`);
    expect(mismatches).toEqual([]);
  });
});
