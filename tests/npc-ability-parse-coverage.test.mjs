// tests/npc-ability-parse-coverage.test.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseSaveAbility, describeNpcAbility } from '../scripts/npc-ability-parse.mjs';

// #915: the spec's data-driven coverage audit. The fixture is the full
// 369-ability slice (active 1-3 action / free NPC actions with a
// fortitude/reflex/will @Check and no @Damage) from the PF2e system's own
// source data for Monster Core 1-2 and Bestiary 1-3 -- the same population
// the spec counted. Each entry's `expected` mode is a snapshot of this
// parser's classification. Note the source data spells condition links by
// name (`Item.Frightened`, no label) where compiled runtime text carries an
// id plus a `{Label}`; the parser handles both. A live item has a name (the
// override table matches on it), so the audit adds the entry's name.
//
// #935: the ratchet. tests/fixtures/npc-save-ability-audit.json is the
// committed golden audit -- one row per slice ability with its mode, family
// ("blocks" | "inline" | "override" when automatic, "reportOnly", or null
// when not offered), the deterministic summary the reasoning model sees, and
// why a reportOnly ability is not automatic. Every parser change shows up
// as a reviewable diff of that file. Regenerate it after a deliberate
// change with:
//   UPDATE_NPC_SAVE_AUDIT=1 npx vitest run tests/npc-ability-parse-coverage.test.mjs
// The automatic count may never drop below MIN_AUTO_COUNT; raising coverage
// raises the golden file's own autoCount, and MIN_AUTO_COUNT is raised with
// it in the same change.
const MIN_AUTO_COUNT = 51;

const SLICE_URL = new URL('./fixtures/npc-save-ability-slice.json', import.meta.url);
const AUDIT_URL = new URL('./fixtures/npc-save-ability-audit.json', import.meta.url);
const { entries } = JSON.parse(readFileSync(SLICE_URL, 'utf8'));

const parse = (entry) => parseSaveAbility({ ...entry.item, name: entry.name });
const classify = (entry) => parse(entry)?.mode ?? null;

function auditRow(entry) {
  const descriptor = parse(entry);
  const mode = descriptor?.mode ?? null;
  return {
    creature: entry.actor,
    ability: entry.name,
    mode,
    family: mode === 'auto' ? descriptor.family : mode,
    summary: descriptor ? describeNpcAbility(descriptor) : null,
    reasons: mode === 'reportOnly' ? descriptor.reportReasons : [],
  };
}

function buildAudit(rows) {
  const count = (pred) => rows.filter(pred).length;
  const reasonCounts = {};
  for (const row of rows) for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  return {
    autoCount: count((r) => r.mode === 'auto'),
    reportOnlyCount: count((r) => r.mode === 'reportOnly'),
    notOfferedCount: count((r) => r.mode === null),
    familyCounts: {
      blocks: count((r) => r.family === 'blocks'),
      inline: count((r) => r.family === 'inline'),
      override: count((r) => r.family === 'override'),
    },
    reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort(([a], [b]) => a.localeCompare(b))),
    rows,
  };
}

/** Rows whose automatic outcome was lost or silently changed meaning, and a
 * total that dropped below the floor -- what the ratchet fails on. */
function ratchetViolations(liveRows, goldenRows, floor) {
  const violations = [];
  const live = new Map(liveRows.map((r) => [`${r.creature}::${r.ability}`, r]));
  for (const golden of goldenRows) {
    const row = live.get(`${golden.creature}::${golden.ability}`);
    if (golden.mode === 'auto' && row?.mode !== 'auto') violations.push(`lost: ${golden.creature}: ${golden.ability}`);
    else if (golden.mode === 'auto' && row.summary !== golden.summary) violations.push(`changed: ${golden.creature}: ${golden.ability}`);
  }
  const autoCount = liveRows.filter((r) => r.mode === 'auto').length;
  if (autoCount < floor) violations.push(`auto count ${autoCount} < ${floor}`);
  return violations;
}

const liveRows = entries.map(auditRow);
if (process.env.UPDATE_NPC_SAVE_AUDIT) {
  writeFileSync(AUDIT_URL, `${JSON.stringify(buildAudit(liveRows), null, 2)}\n`);
}
const golden = JSON.parse(readFileSync(AUDIT_URL, 'utf8'));

describe('npc save-ability parser coverage (#915)', () => {
  it('covers the spec\'s whole 369-ability slice', () => {
    expect(entries).toHaveLength(369);
  });

  it('classifies the slice as 51 auto / 139 reportOnly / 179 not offered (#915 baseline: 16 / 174 / 179)', () => {
    const counts = { auto: 0, reportOnly: 0, none: 0 };
    for (const entry of entries) counts[classify(entry) ?? 'none'] += 1;
    expect(counts).toEqual({ auto: 51, reportOnly: 139, none: 179 });
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
    expect(parse(find('Aqudel', 'Strobe')).shape).toEqual({ areaType: 'emanation', distanceFeet: 30 });
    // Burst "centered on a corner within reach" -- no stated range.
    expect(classify(find('Mokele-Mbembe', 'Whip Tail'))).toBeNull();
    // #935: inline outcomes, an override, and bespoke outcomes left to the GM.
    expect(parse(find('Boggard Warrior', 'Terrifying Croak')).family).toBe('inline');
    expect(parse(find('Argorth', 'Unnatural Shriek')).family).toBe('override');
    expect(classify(find('Gnome Bard', 'Do a Jig!'))).toBe('reportOnly');
    expect(classify(find('Sarglagon', 'Drown'))).toBe('reportOnly');
  });
});

describe('npc save-ability outcome coverage ratchet (#935)', () => {
  it('matches the committed golden audit row for row (regenerate it deliberately, see the header)', () => {
    expect(golden.rows).toHaveLength(entries.length);
    const mismatches = liveRows
      .map((row, i) => ({ row, golden: golden.rows[i] }))
      .filter(({ row, golden: g }) => JSON.stringify(row) !== JSON.stringify(g))
      .map(({ row }) => `${row.creature}: ${row.ability}`);
    expect(mismatches).toEqual([]);
    expect(buildAudit(liveRows)).toEqual(golden);
  });

  it('never drops below the floor, and the golden file never claims less than it', () => {
    expect(golden.autoCount).toBe(golden.rows.filter((r) => r.mode === 'auto').length);
    expect(golden.autoCount).toBeGreaterThanOrEqual(MIN_AUTO_COUNT);
    expect(ratchetViolations(liveRows, golden.rows, MIN_AUTO_COUNT)).toEqual([]);
  });

  it('a deliberate regression fails the ratchet: a lost or re-meant automatic ability, or a lower count', () => {
    const autoIndex = liveRows.findIndex((r) => r.mode === 'auto');
    const lost = liveRows.map((r, i) => (i === autoIndex ? { ...r, mode: 'reportOnly', family: 'reportOnly' } : r));
    expect(ratchetViolations(lost, golden.rows, MIN_AUTO_COUNT)).toEqual([
      `lost: ${liveRows[autoIndex].creature}: ${liveRows[autoIndex].ability}`,
      `auto count ${MIN_AUTO_COUNT - 1} < ${MIN_AUTO_COUNT}`,
    ].filter((v) => golden.autoCount === MIN_AUTO_COUNT || !v.startsWith('auto count')));
    const changed = liveRows.map((r, i) => (i === autoIndex ? { ...r, summary: `${r.summary}; extra` } : r));
    expect(ratchetViolations(changed, golden.rows, MIN_AUTO_COUNT)).toEqual([
      `changed: ${liveRows[autoIndex].creature}: ${liveRows[autoIndex].ability}`,
    ]);
  });
});
