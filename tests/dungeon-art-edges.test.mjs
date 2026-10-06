import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * #823: the dungeon-room tile art once shipped with an opaque near-white border
 * baked in (a thin white line around every tile in the scene). Node has no WebP
 * decoder, so tools/strip-art-white-edge.py (PIL) measures every asset and
 * writes assets/dungeon-rooms/edge-report.json; this test (a) pins each asset's
 * sha256 so the report can't go stale and (b) asserts no outer band is white.
 *
 * Regenerating or adding art? Refresh the report with
 *   python3 -m venv .venv && .venv/bin/pip install pillow numpy   # once, .venv is gitignored
 *   .venv/bin/python tools/strip-art-white-edge.py assets/dungeon-rooms --report-only
 * (or run the script on the offending files, see its docstring, which also
 * writes the report). Rebuild corridor-corner.webp with
 * tools/make-corridor-corner.py after changing corridor.webp / corridor-mid.webp.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, '../assets/dungeon-rooms');

// Fraction of the outermost 3 rows/cols with R,G,B > 215.
// Measured after the fix: max 0.0 over all 37 assets.
// Measured before the fix: 0.19-0.24 on mid/end/rubble open edges' wall strips,
// 0.92-1.0 on their closed sides, 1.0 on corridor.webp and plant-1.webp.
// 0.05 leaves margin for legitimately bright art yet is far below every
// pre-fix offender (smallest 0.1888).
const MAX_NEAR_WHITE = 0.05;
const SMALLEST_PRE_FIX_OFFENDER = 0.1888;

const report = JSON.parse(readFileSync(resolve(DIR, 'edge-report.json'), 'utf8'));
const files = readdirSync(DIR).filter((f) => f.endsWith('.webp')).sort();

describe('dungeon-room art edge report', () => {
  it('threshold would have caught the pre-fix art', () => {
    expect(MAX_NEAR_WHITE).toBeLessThan(SMALLEST_PRE_FIX_OFFENDER / 3);
  });

  it('lists exactly the webp files on disk', () => {
    expect(Object.keys(report).sort()).toEqual(files);
  });

  it.each(files)('%s matches its recorded hash (rerun tools/strip-art-white-edge.py --report-only)', (f) => {
    const sha = createHash('sha256').update(readFileSync(resolve(DIR, f))).digest('hex');
    expect(sha).toBe(report[f].sha256);
  });

  it.each(files)('%s has no near-white outer band', (f) => {
    for (const side of ['N', 'E', 'S', 'W']) {
      expect(report[f].nearWhiteOuterBandPct[side], `${f} ${side}`).toBeLessThan(MAX_NEAR_WHITE);
    }
  });
});
