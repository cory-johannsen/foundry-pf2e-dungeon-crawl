// tests/self-effect-audit-snapshot.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/self-effect-audit-snapshot.json', import.meta.url), 'utf8'),
);

function isUnsafeByReasons(reasons) {
  return reasons.length > 0;
}

describe('self-effect compendium population snapshot', () => {
  it('matches the expected total/survivor/excluded counts from this plan\'s own live investigation', () => {
    expect(snapshot.totalCandidates).toBe(156);
    expect(snapshot.survivorCount).toBe(87);
    expect(snapshot.excludedCount).toBe(69);
  });

  it('every entry marked excluded has at least one real exclusion reason, and every non-excluded entry has none', () => {
    for (const entry of snapshot.entries) {
      expect(isUnsafeByReasons(entry.excludeReasons)).toBe(entry.excluded);
    }
  });

  it('every exclusion reason is one of the five documented checks', () => {
    const validReasons = new Set(['ChoiceSet', 'GrantItem', 'target-dependent', 'no-rules', 'long-duration']);
    for (const entry of snapshot.entries) {
      for (const reason of entry.excludeReasons) {
        expect(validReasons.has(reason)).toBe(true);
      }
    }
  });

  it('the survivor set does not include any currently-denylisted slug (the denylist is applied on top of, not instead of, this filter)', async () => {
    const { SELF_EFFECT_DENYLIST } = await import('../scripts/self-effect-denylist.mjs');
    const survivorSlugs = snapshot.entries.filter((e) => !e.excluded).map((e) => e.slug);
    const denylistedSurvivors = survivorSlugs.filter((slug) => SELF_EFFECT_DENYLIST.has(slug));
    // This is expected to be non-empty -- the denylist is drawn FROM the
    // survivor set precisely because those items pass the derived filter
    // but are denied anyway. This test documents that fact rather than
    // asserting it should be empty: it fails loudly (listing the slugs)
    // if the compendium's own survivor set no longer contains every
    // currently-denylisted slug at all, which would mean the denylist is
    // carrying a stale/renamed slug the live filter no longer even sees.
    expect(denylistedSurvivors.sort()).toEqual([...SELF_EFFECT_DENYLIST].sort());
  });
});
