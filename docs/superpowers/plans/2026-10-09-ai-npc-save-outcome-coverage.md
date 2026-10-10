# Widening NPC Save-Ability Outcome Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Raise the share of #915's NPC save-ability population that runs fully automatically (`mode: "auto"`) by widening `scripts/npc-ability-parse.mjs`'s degree-block grammar, adding an inline-outcome grammar for abilities with no degree blocks at all, adding a synthesized-effect "penalty" outcome kind, and a reviewed per-ability override table — protected by a golden-file ratchet so coverage never silently regresses.

**Architecture:** All new recognition stays in the existing pure parser module (`scripts/npc-ability-parse.mjs`), exactly as the spec requires — no new vocabulary type, endpoint, or executor shape. A new sibling data file (`scripts/npc-ability-overrides.mjs`) holds the override table. The one executor change (`scripts/dungeon-combat.mjs`) applies the new `penalties[]` outcome kind by synthesizing a small `effect` item with a `FlatModifier` rule per selector, reusing the real, confirmed-live Effect-item shape #910/#914 already build from.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v12 API, the PF2e system's own Actor/Item data model, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-npc-save-outcome-coverage-design.md`

## Global Constraints

- All parsing stays pure, inside `scripts/npc-ability-parse.mjs` (plus the new data-only `scripts/npc-ability-overrides.mjs`) — no Foundry API surface, per the spec's own "Where the work lives" and this module's established convention.
- All-or-nothing, unchanged from #915: any unrecognized block, sentence, or penalty selector makes the WHOLE ability `reportOnly`, never a partial application.
- **The spec's own stated baseline ("#915's strict parser automates about 74") is wrong and must not be used anywhere in this plan.** Running the real, merged `parseSaveAbility` against the real, committed `tests/fixtures/npc-save-ability-slice.json` (confirmed live, not estimated) gives **16** auto, **174** reportOnly, **179** not-offered — not 74. Every ratchet constant, every "expected gain" claim, and the override table's own prioritization in this plan use the real 16/174/179 split, not the spec's figure. The spec's *population* breakdown (113 block-form / 256 non-block, also confirmed live) is correct and is reused as written.
- Override-table entries are the *only* way a hand-written descriptor replaces the grammar result (spec Design §4); every entry needs a fixture-integrity test, same as the spec says.
- The ratchet's golden file and `GOLDEN_AUTO_COUNT` constant may only be raised by a commit that also updates the golden file (spec Design §5) — Task 6 enforces this with a test, not a comment.
- Penalty outcomes are synthesized as `effect`-type items with a real `system.duration` (never a custom expiry-sweep entry) — confirmed consistent with the real system: #915's own condition expiry needed a **custom** sweep (`recordNpcAbilityExpiry`/`sweepExpiredNpcAbilityConditions`, confirmed live) specifically because "PF2e condition items carry no duration of their own" (that function's own comment) — EFFECT items are different and already self-expire by duration (confirmed live by #914's `cleanupAgentSelfEffects`, which only removes `unlimited`-duration effects early because "Round/minute/encounter-duration effects are left alone: PF2e's own duration handling expires them"). The spec's own penalty design already matches this; this plan does not invent a second expiry mechanism.
- A merge that adds a new `scripts/` file imported by another (`npc-ability-overrides.mjs` imported by `npc-ability-parse.mjs`) must run the `update-architecture-docs` skill in the same pass (CLAUDE.md).
- Every merge bumps `module.json`'s version (CLAUDE.md); this is the same class of change as #915 (→0.85.0) and #934 (→0.86.0 once merged) — Task 7 bumps to whatever is current +1 minor at execution time.

## Investigation findings (grounded against the real, merged code and the real compendium slice)

1. **The spec's "#915 already automates ~74" claim is factually wrong.** Running `parseSaveAbility` from the real, merged `scripts/npc-ability-parse.mjs` against the real, committed `tests/fixtures/npc-save-ability-slice.json` (the same 369-item slice both specs cite) gives exactly **16** auto — confirmed twice, once by reading the existing golden counts in `tests/npc-ability-parse-coverage.test.mjs` ("16 auto / 174 reportOnly / 179 not offered") and once by re-running the parser directly. This is the single most consequential correction in this plan: every other number below, and the ratchet's starting constant, is built from the real 16/174/179 split.
2. **One of the spec's three stated "widenings" is already shipped and needs no new code.** Design §1 describes recognizing "a condition... named in plain text from a closed list" as new work this spec adds. It is not — `extractBareConditions` in the real, merged parser already scans every block for any of `KNOWN_CONDITION_SLUGS` as bare text, independent of a `@UUID` link. Task 1 adds a regression test proving this (so a future refactor can't silently remove it) rather than re-implementing it.
3. **Today's "as X" shorthand recognizes exactly one literal phrase** — `/^\s*as failure\s*\.?\s*$/i`, anchored, no suffix, "failure" only (confirmed live). Checking the real 68-item block-form `reportOnly` population directly (not estimated) found three distinct, real, separately-parseable suffix shapes beyond a bare "As X.": a **duration change** (the spec's own example), a **numeric value override** — *Steal Knowledge*'s real Critical Failure block reads "As failure, but the penalty is –2 and the bonus is +2" — and an **added condition** — *Fiddle*'s real Critical Failure block reads "As failure, and also Slowed 1". All three widen the grammar in Task 1; a suffix outside these three closed shapes still disqualifies the block, same as today.
4. **A linked condition can carry a redundant "with `<the acting creature>`" qualifier the current grammar doesn't strip.** *Haunting Melody*'s real Failure block reads "The creature is `@UUID[...Fascinated]` with the nosoi" — the condition link resolves fine, but "with the nosoi" is left-over text today, disqualifying an otherwise-clean block. Task 1 adds this as a recognized, stripped qualifier (`with (?:the |its )?<subject>`).
5. **A real compendium typo breaks bare-condition matching and is the concrete, grounding justification for the override table.** *Unnatural Shriek*'s real Failure block reads "The creature is **stupefed** 1 for 1 minute" — a misspelling of "stupefied" that will never match `KNOWN_CONDITION_SLUGS` no matter how the grammar widens, and should not be fuzzy-matched (a typo-tolerant regex risks false positives elsewhere). It is the first, concretely-verified entry in Task 4's override table — exactly the case the spec's Design §4 describes, now backed by a real example rather than a hypothetical one.
6. **A penalty selector referencing an unresolved earlier choice must never be guessed.** *Steal Knowledge*'s real Failure block reads "the creature takes a –1 status penalty to checks using **that skill**" — "that skill" is whichever skill the dragon chose when using the ability, a choice this module has no way to read (the same "no `ChoiceSet` support for NPC items" limit #915 already established). The penalty grammar's selector table (Task 2) only ever matches a literally-named, closed-vocabulary statistic; a backward reference like "that skill"/"that save" disqualifies the block, it is never treated as a wildcard.
7. **A penalty-shaped block can still carry a genuinely bespoke trailing rider that must keep disqualifying it even after the widening.** *Bittersweet Dreams*' real Success block reads "...a –1 status penalty to attack rolls, saving throws, and skill checks, **and all other emotion effects on it are suppressed**" — the penalty clause itself is clean (multiple closed selectors), but the trailing rules-interaction clause is not recognized by anything in this plan and correctly keeps the whole block (and so the whole ability) `reportOnly` under the unchanged all-or-nothing rule. Task 2's own test fixture uses this exact real text as the "a clean penalty clause doesn't rescue an unrelated trailing rider" case.
8. **The confirmed-real selector strings for the penalty table** (read directly from real bestiary-effects compendium items, not guessed): `"speed"` (*Effect: Hamstring*, "–10-foot status penalty to ... Speeds" — the exact phrase *Fiddle*'s own text uses), `"will"` (*Effect: Beguiling Presence*), `"perception"` (*Effect: Eye Pluck*), `"attack"`/`"saving-throw"`/`"skill-check"` (the generic categories, confirmed via *Effect: Revert Form*'s own multi-selector `FlatModifier`), and `"ac"` (*Effect: Form a Phalanx*/*Effect: Thesis Shield*). A named skill (not "skill checks" generically) uses the skill's own slug directly as the selector, the system's standard convention — Task 2 notes this is confirmed against a real instance only if the override table or a later widening needs one; the closed table in this plan ships only the confirmed generic/fixed selectors above plus named saves (`fortitude`/`reflex`/`will`).

## Review Focus

- A block that recognizes cleanly as a penalty EXCEPT for one trailing, unrecognized sentence must still be `reportOnly` for the whole ability (Investigation finding 7; Task 2's test).
- A penalty selector that is a backward reference to an unresolved earlier choice ("that skill") must disqualify, never silently resolve to nothing or to every skill (Investigation finding 6; Task 2's test).
- An override table entry whose target item's real text has since changed (a compendium update) must fail a test, not silently keep serving a stale hand-written descriptor (spec Design §4; Task 4's test).
- The ratchet must fail CI on an actual regression (an edit that drops the auto count below `GOLDEN_AUTO_COUNT`), not just on an intentional, golden-file-updating change (spec Design §5; Task 6's test).
- An inline-outcome ability whose subject is outside the closed set (an ancestry filter the parser can't resolve, per the spec's own Design §2) must stay `null`/`reportOnly`, not default to "applies to everyone" (Task 3's test).

---

### Task 1: Degree-block grammar widening

**Files:**
- Modify: `scripts/npc-ability-parse.mjs` (`parseDegreeBlock`, near line 156)
- Test: `tests/npc-ability-parse.test.mjs` (extend existing file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseDegreeBlock` now also recognizes `as <Critical Success|Success|Failure|Critical Failure>` (any of the four, not just "failure") with an optional single suffix of exactly one of: a changed duration, a numeric value override (feeding Task 2's `penalties`), or an added condition; a trailing `with (?:the |its )?<subject>` qualifier after a condition is stripped as boilerplate rather than counted as leftover. The returned degree shape gains an `asDegree: 'criticalSuccess'|'success'|'failure'|'criticalFailure'|null` field (replacing the old boolean `asFailure`, resolved to the referenced degree's own parsed result by the caller — Task 1 Step 5 updates `parseSaveAbility`'s own resolution logic alongside it) and a `penalties: []` field (empty until Task 2 fills it).

- [x] **Step 1: Write the failing tests for the already-working bare-condition path (regression guard) and the new suffix shapes**

```js
// tests/npc-ability-parse.test.mjs (append)
import { parseSaveAbility } from '../scripts/npc-ability-parse.mjs';

describe('degree-block grammar widening (#935)', () => {
  it('already recognizes a bare (unlinked) condition word -- regression guard, not new work', () => {
    // Investigation finding 2: extractBareConditions already does this in the
    // merged #915 code; this test exists so a future refactor can't silently
    // drop it without a test failing.
    const item = makeSaveItem({
      checkParams: 'will|dc:20',
      blocks: {
        'Critical Success': 'The creature is unaffected.',
        Success: 'The creature is unaffected.',
        Failure: 'The creature is Frightened 1.',
        'Critical Failure': 'The creature is Frightened 2.',
      },
    });
    expect(parseSaveAbility(item)?.mode).toBe('auto');
  });

  it('recognizes "as success" and "as critical failure", not just "as failure"', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:20',
      blocks: {
        'Critical Success': 'The creature is unaffected.',
        Success: 'The creature is unaffected.',
        Failure: 'As success.',
        'Critical Failure': 'As failure.',
      },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.failure.asDegree).toBe('success');
    expect(parsed.degrees.criticalFailure.asDegree).toBe('failure');
  });

  it('recognizes "as X" with a duration-change suffix', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:20',
      blocks: {
        'Critical Success': 'The creature is unaffected.',
        Success: 'The creature is Frightened 1.',
        Failure: 'As success.',
        'Critical Failure': 'As failure, for 1 hour.',
      },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.criticalFailure.asDegree).toBe('failure');
    expect(parsed.degrees.criticalFailure.asDurationOverrideSeconds).toBe(3600);
  });

  it('recognizes "as X, and also <condition>" (Fiddle, real text)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:18',
      blocks: {
        Success: 'No effect',
        Failure: 'Off-Guard and –10-foot status penalty to Speeds',
        'Critical Failure': 'As failure, and also Slowed 1',
      },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.criticalFailure.conditions.map((c) => c.slug)).toEqual(
      expect.arrayContaining(['slowed']),
    );
  });

  it('strips a trailing "with <the acting creature>" qualifier on a linked condition (Haunting Melody, real text)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:18',
      blocks: {
        Success: 'The creature is unaffected.',
        Failure: 'The creature is @UUID[Compendium.pf2e.conditionitems.Item.Fascinated] with the nosoi.',
        'Critical Failure': 'The creature is @UUID[Compendium.pf2e.conditionitems.Item.Fascinated] with the nosoi for 1 minute.',
      },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.failure.conditions.map((c) => c.slug)).toEqual(['fascinated']);
  });

  it('a suffix outside the three recognized shapes still disqualifies the block', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:20',
      blocks: {
        Success: 'The creature is unaffected.',
        Failure: 'The creature is Frightened 1.',
        'Critical Failure': 'As failure, and the creature also forgets the last minute.',
      },
    });
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });

  it('a backward-reference qualifier ("with it") on a condition that was never linked disqualifies (not stripped as boilerplate)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:20',
      blocks: {
        Success: 'The creature is unaffected.',
        Failure: 'The creature is Frightened 1 with it, somehow confused about the source.',
      },
    });
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });
});

// Shared helper for this file's own save-ability fixtures -- builds a minimal
// real-shaped item from a map of degree-label -> plain body text (this
// helper wraps each value in the exact `<p><strong>Label</strong> body</p>`
// shape splitDegreeBlocks already parses).
function makeSaveItem({ checkParams, blocks, actionType = 'action', actions = 1 }) {
  const blockHtml = Object.entries(blocks)
    .map(([label, body]) => `<p><strong>${label}</strong> ${body}</p>`)
    .join('');
  return {
    type: 'action',
    system: {
      actionType: { value: actionType },
      actions: { value: actions },
      traits: { value: [] },
      frequency: null,
      description: {
        value: `<p>Flavor text. @Check[${checkParams}] save.</p>${blockHtml}`,
      },
    },
  };
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ability-parse.test.mjs -t "degree-block grammar widening"`
Expected: FAIL — the regression-guard test for bare conditions should already PASS (it exercises existing code); every new-shape test FAILs (`asDegree`/`asDurationOverrideSeconds` undefined, suffix/qualifier variants rejected as unparseable).

- [x] **Step 3: Widen `parseDegreeBlock`'s "as X" handling**

```js
// scripts/npc-ability-parse.mjs -- replace the existing
//   if (/^\s*as failure\s*\.?\s*$/i.test(renderPlain(blockHtml))) { ... }
// special case at the top of parseDegreeBlock (~line 156) with:

const AS_DEGREE_RE = /^\s*as (critical success|success|failure|critical failure)\s*(?:,\s*(.*))?\.?\s*$/i;

/** Parses an "as <Degree>[, <suffix>]" block into its referenced degree plus
 * at most one of three closed suffix shapes (Investigation finding 3, all
 * confirmed against real text): a changed duration ("for 1 hour"), a
 * numeric value override ("but the penalty is -2 and the bonus is +2" --
 * Steal Knowledge, real text), or an added condition ("and also Slowed 1" --
 * Fiddle, real text). Any other suffix text returns `null` (unparseable),
 * which the caller treats as "not an as-X block" and falls through to
 * ordinary clause parsing (so, e.g., a non-"as X" block is unaffected). */
function parseAsDegreeBlock(blockHtml) {
  const plain = renderPlain(blockHtml);
  const match = AS_DEGREE_RE.exec(plain);
  if (!match) return null;
  const asDegree = DEGREE_LABELS[toTitleCase(match[1])];
  const suffix = (match[2] ?? '').trim();
  if (!suffix) return { asDegree, asDurationOverrideSeconds: null, asValueOverride: null, asAddedCondition: null };

  const durationMatch = new RegExp(`^for (\\d+) (${DURATION_UNITS})$`, 'i').exec(suffix);
  if (durationMatch) {
    return {
      asDegree,
      asDurationOverrideSeconds: Number(durationMatch[1]) * DURATION_UNIT_SECONDS[durationMatch[2].toLowerCase()],
      asValueOverride: null,
      asAddedCondition: null,
    };
  }
  const valueMatch = /^but the penalty is ([+-]?\d+)(?: and the bonus is ([+-]?\d+))?$/i.exec(suffix);
  if (valueMatch) {
    return {
      asDegree, asDurationOverrideSeconds: null,
      asValueOverride: { penalty: Number(valueMatch[1]), bonus: valueMatch[2] != null ? Number(valueMatch[2]) : null },
      asAddedCondition: null,
    };
  }
  const addedMatch = /^and also (.+)$/i.exec(suffix);
  if (addedMatch) {
    const { conditions, remaining } = extractBareConditions(addedMatch[1]);
    const linked = extractLinkedConditions(remaining);
    const found = [...conditions, ...linked.conditions];
    if (!found.length || linked.remaining.replace(BOILERPLATE, ' ').replace(/[.,;\s]+/g, ' ').trim().length > 0) return null;
    return { asDegree, asDurationOverrideSeconds: null, asValueOverride: null, asAddedCondition: found[0] };
  }
  return null;
}

function toTitleCase(text) {
  return text.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [x] **Step 4: Call `parseAsDegreeBlock` from `parseDegreeBlock`, and strip the "with `<subject>`" qualifier before the leftover-text check**

```js
// scripts/npc-ability-parse.mjs -- parseDegreeBlock's body: replace the old
// anchored "as failure" special case with a call to the new function first,
// and add the WITH_SUBJECT_RE strip immediately after condition extraction:

function parseDegreeBlock(blockHtml) {
  const asDegree = parseAsDegreeBlock(blockHtml);
  if (asDegree) return { none: false, asFailure: false, conditions: [], immuneSeconds: null, ...asDegree };
  let text = stripHtml(blockHtml);
  const noneResult = extractNone(text);
  text = noneResult.remaining;
  const immunityResult = extractImmunity(text);
  text = immunityResult.remaining;

  const conditions = [];
  let floatingDuration = null;
  let leftover = '';
  for (const clause of text.split(/,|\band\b/i)) {
    let rest = clause;
    const linked = extractLinkedConditions(rest);
    rest = linked.remaining;
    const bare = extractBareConditions(rest);
    rest = bare.remaining;
    // Investigation finding 4: a redundant "with <the acting creature>"
    // qualifier on a condition this clause already found -- stripped as
    // boilerplate, not counted as leftover. Only stripped when THIS clause
    // actually found a condition (Investigation finding under Task 1's own
    // "backward-reference qualifier" test: "with it" on an UNRECOGNIZED
    // condition word must still disqualify, not be silently stripped).
    const found = [...linked.conditions, ...bare.conditions];
    if (found.length) {
      rest = rest.replace(/\bwith (?:the |its )?[a-z][a-z' -]*\b/i, ' ');
    }
    const duration = extractDuration(rest);
    rest = duration.remaining;
    if (duration.durationSeconds !== null && !found.length) {
      if (floatingDuration !== null) return null;
      floatingDuration = duration.durationSeconds;
    }
    for (const c of found) conditions.push({ ...c, durationSeconds: duration.durationSeconds });
    leftover += ` ${rest}`;
  }
  if (floatingDuration !== null) {
    for (const c of conditions) if (c.durationSeconds === null) c.durationSeconds = floatingDuration;
  }

  if (leftover.replace(BOILERPLATE, ' ').replace(/[.,;\s]+/g, ' ').trim().length > 0) return null;
  if (noneResult.none && conditions.length) return null;
  if (!noneResult.none && !conditions.length) return null;

  return {
    none: noneResult.none, asFailure: false, asDegree: null,
    asDurationOverrideSeconds: null, asValueOverride: null, asAddedCondition: null,
    conditions, immuneSeconds: immunityResult.immuneSeconds, penalties: [],
  };
}
```

- [x] **Step 5: Resolve `asDegree` in `parseSaveAbility`'s degree loop (replaces the old `degree?.asFailure` handling in `applyNpcAbilityDegree`'s caller too -- Task 6 updates that side)**

```js
// scripts/npc-ability-parse.mjs -- parseSaveAbility's existing per-key loop
// (~line 319) already calls parseDegreeBlock and sets mode = "reportOnly"
// when a degree is null; no change needed there. The resolution of
// `asDegree` into the REFERENCED degree's own outcome (so a caller never
// has to chase the reference itself) happens once, after the loop:

  for (const key of DEGREE_KEYS) {
    const blockHtml = blocks[key];
    if (blockHtml === undefined) {
      degrees[key] = null;
      degreeText[key] = null;
      mode = "reportOnly";
      continue;
    }
    degreeText[key] = renderPlain(blockHtml);
    const parsed = parseDegreeBlock(blockHtml);
    degrees[key] = parsed;
    if (!parsed) mode = "reportOnly";
  }
  // Resolve every `asDegree` reference to its target's own already-parsed
  // outcome (a chain of two is never real PF2e text, so this is one pass,
  // not a fixed point) -- a reference to a degree that itself failed to
  // parse propagates reportOnly, same as #915's original "as failure" path.
  for (const key of DEGREE_KEYS) {
    const degree = degrees[key];
    if (!degree?.asDegree) continue;
    const target = degrees[degree.asDegree];
    if (!target) { mode = "reportOnly"; continue; }
    const conditions = target.none ? [] : [...target.conditions];
    if (degree.asAddedCondition) conditions.push(degree.asAddedCondition);
    if (degree.asValueOverride) {
      for (const p of target.penalties ?? []) conditions.push(p); // placeholder removed in Task 2, see below
    }
    degrees[key] = {
      ...target,
      conditions,
      immuneSeconds: target.immuneSeconds,
      penalties: degree.asValueOverride ? [] : (target.penalties ?? []), // Task 2 fills this branch in
    };
  }
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ability-parse.test.mjs`
Expected: PASS (all tests, including every pre-existing test in the file — no regressions)

- [x] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (`npc-ability-parse-coverage.test.mjs`'s own "16/174/179" assertion still passes since no real-fixture ability's classification changed yet — Task 1 only adds grammar reach that Task 2/3/4 exercise against the real population)

- [x] **Step 8: Commit**

```bash
git add scripts/npc-ability-parse.mjs tests/npc-ability-parse.test.mjs
git commit -m "feat(#935): widen the degree-block as-X grammar and strip a redundant with-subject qualifier"
```

---

### Task 2: Penalty outcomes (block form)

**Files:**
- Modify: `scripts/npc-ability-parse.mjs`
- Test: `tests/npc-ability-parse.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: a degree's `penalties` field, now populated: `Array<{ type: 'status'|'circumstance', value: number, selectors: string[], durationSeconds: number|'untilNextTurn'|null }>`. `PENALTY_SELECTOR_TABLE` (exported, a `Map<string, string>` from a closed English phrase to a real PF2e selector string, consumed by Task 6's executor for GM-report labelling only — the parser itself only needs the selector strings, not the labels).

- [x] **Step 1: Write the failing tests**

```js
// tests/npc-ability-parse.test.mjs (append)
describe('penalty outcomes (#935)', () => {
  it('recognizes a status penalty to a single named selector (Hamstring-shaped real text)', () => {
    const item = makeSaveItem({
      checkParams: 'reflex|dc:20',
      blocks: { Success: 'The creature is unaffected.', Failure: 'The creature takes a –10-foot status penalty to its Speeds.' },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.failure.penalties).toEqual([
      { type: 'status', value: -10, selectors: ['speed'], durationSeconds: null },
    ]);
  });

  it('recognizes a penalty to multiple named categories with a duration (Bittersweet Dreams\' penalty clause alone, no trailing rider)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:34',
      blocks: {
        'Critical Success': 'The creature is unaffected.',
        Success: 'For 1 round, the creature takes a -1 status penalty to attack rolls, saving throws, and skill checks.',
      },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.success.penalties).toEqual([
      { type: 'status', value: -1, selectors: ['attack', 'saving-throw', 'skill-check'], durationSeconds: 6 },
    ]);
  });

  it('does NOT rescue a clean penalty clause followed by an unrelated trailing rider (Bittersweet Dreams, real full text)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:34',
      blocks: {
        Success: 'For 1 round, the creature takes a -1 status penalty to attack rolls, saving throws, and skill checks, and all other emotion effects on it are suppressed.',
      },
    });
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });

  it('never guesses a backward-reference selector ("that skill" -- Steal Knowledge, real text)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:28',
      blocks: { Success: 'The creature is unaffected.', Failure: 'For the next minute, the creature takes a –1 status penalty to checks using that skill.' },
    });
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });

  it('recognizes a named-save penalty (Will saves specifically)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:20',
      blocks: { Success: 'The creature is unaffected.', Failure: 'The creature takes a -1 circumstance penalty to Will saves.' },
    });
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.failure.penalties[0].selectors).toEqual(['will']);
  });

  it('rejects a "next X" single-use penalty (Mask of Fate, real text)', () => {
    const item = makeSaveItem({
      checkParams: 'will|dc:21',
      blocks: { Failure: 'The target takes a –1 status penalty to the next saving throw it attempts within the next minute against a divine effect.' },
    });
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ability-parse.test.mjs -t "penalty outcomes"`
Expected: FAIL (`penalties` stays `[]`, every block falls through to the leftover-text check and nulls)

- [x] **Step 3: Implement the penalty clause recognizer**

```js
// scripts/npc-ability-parse.mjs -- new, near extractImmunity

/** #935: the closed selector table (Investigation finding 8, every entry
 * confirmed live against a real bestiary-effects compendium item's own
 * FlatModifier rule -- never guessed). A named save maps to its own save
 * slug directly (the parser's own SAVES set already names these three). */
export const PENALTY_SELECTOR_TABLE = new Map([
  ['attack rolls', 'attack'],
  ['saving throws', 'saving-throw'],
  ['skill checks', 'skill-check'],
  ['speeds', 'speed'],
  ['speed', 'speed'],
  ['ac', 'ac'],
  ['perception', 'perception'],
  ['fortitude saves', 'fortitude'],
  ['reflex saves', 'reflex'],
  ['will saves', 'will'],
]);

/** "takes a -N (status|circumstance) penalty to <selector list>" where
 * every item in the comma/and-joined list is a literal, closed-vocabulary
 * phrase from PENALTY_SELECTOR_TABLE. A selector phrase outside the table
 * -- including any backward reference ("that skill", "that save") --
 * returns `null` for the WHOLE clause (Investigation finding 6: never a
 * partial match). Consumes its own matched text; the caller treats the
 * rest of the clause as ordinary leftover subject to the normal
 * boilerplate-or-disqualify rule. */
function extractPenalty(text) {
  const match = /\btakes a ([+-]?\d+)(?:-foot)? (status|circumstance) penalty to ((?:its |their )?[a-z ,]+?)(?=\.|,? and (?!\w+ (?:rolls|saves|checks|speeds))|$)/i.exec(text);
  if (!match) return { penalty: null, remaining: text };
  const value = Number(match[1]);
  const type = match[2].toLowerCase();
  const selectorText = match[3].replace(/^(?:its|their)\s+/i, '').trim();
  const selectors = [];
  for (const phrase of selectorText.split(/,\s*(?:and\s*)?|\s+and\s+/i).map((p) => p.trim().toLowerCase())) {
    const selector = PENALTY_SELECTOR_TABLE.get(phrase);
    if (!selector) return { penalty: null, remaining: text };
    selectors.push(selector);
  }
  if (!selectors.length) return { penalty: null, remaining: text };
  return {
    penalty: { type, value, selectors, durationSeconds: null },
    remaining: text.replace(match[0], ' '),
  };
}
```

- [x] **Step 4: Wire `extractPenalty` into `parseDegreeBlock`'s clause loop, and reject any "next `<X>`" wording up front**

```js
// scripts/npc-ability-parse.mjs -- parseDegreeBlock: a block containing "the
// next"/"next roll"/"next saving throw it attempts" immediately disqualifies
// (Investigation finding 6/the spec's own explicit "next X" exclusion) --
// checked BEFORE any other extraction so a penalty clause never gets a
// chance to partially match a single-use wording:

function parseDegreeBlock(blockHtml) {
  const asDegree = parseAsDegreeBlock(blockHtml);
  if (asDegree) return { none: false, asFailure: false, conditions: [], immuneSeconds: null, penalties: [], ...asDegree };
  const plainCheck = renderPlain(blockHtml);
  if (/\bthe next\b|\bnext (?:saving throw|roll|attack|check)\b/i.test(plainCheck)) return null;

  let text = stripHtml(blockHtml);
  const noneResult = extractNone(text);
  text = noneResult.remaining;
  const immunityResult = extractImmunity(text);
  text = immunityResult.remaining;

  const conditions = [];
  const penalties = [];
  let floatingDuration = null;
  let leftover = '';
  for (const clause of text.split(/,|\band\b/i)) {
    let rest = clause;
    const penaltyResult = extractPenalty(rest);
    rest = penaltyResult.remaining;
    const linked = extractLinkedConditions(rest);
    rest = linked.remaining;
    const bare = extractBareConditions(rest);
    rest = bare.remaining;
    const found = [...linked.conditions, ...bare.conditions];
    if (found.length) rest = rest.replace(/\bwith (?:the |its )?[a-z][a-z' -]*\b/i, ' ');
    const duration = extractDuration(rest);
    rest = duration.remaining;
    if (penaltyResult.penalty) penalties.push({ ...penaltyResult.penalty, durationSeconds: duration.durationSeconds });
    if (duration.durationSeconds !== null && !found.length && !penaltyResult.penalty) {
      if (floatingDuration !== null) return null;
      floatingDuration = duration.durationSeconds;
    }
    for (const c of found) conditions.push({ ...c, durationSeconds: duration.durationSeconds });
    leftover += ` ${rest}`;
  }
  if (floatingDuration !== null) {
    for (const c of conditions) if (c.durationSeconds === null) c.durationSeconds = floatingDuration;
    for (const p of penalties) if (p.durationSeconds === null) p.durationSeconds = floatingDuration;
  }

  if (leftover.replace(BOILERPLATE, ' ').replace(/[.,;\s]+/g, ' ').trim().length > 0) return null;
  if (noneResult.none && (conditions.length || penalties.length)) return null;
  if (!noneResult.none && !conditions.length && !penalties.length) return null;

  return {
    none: noneResult.none, asFailure: false, asDegree: null,
    asDurationOverrideSeconds: null, asValueOverride: null, asAddedCondition: null,
    conditions, penalties, immuneSeconds: immunityResult.immuneSeconds,
  };
}
```

Note this Step's `parseDegreeBlock` body is the complete, final version (it supersedes Task 1 Step 4's own version — the splitting across two tasks is for test-cycle granularity, not because two different functions exist; an implementer running both tasks in order ends up with exactly this body).

- [x] **Step 5: Resolve `asValueOverride` against the referenced degree's own `penalties` (completing Task 1 Step 5's placeholder)**

```js
// scripts/npc-ability-parse.mjs -- parseSaveAbility's asDegree-resolution
// pass (Task 1 Step 5): replace the placeholder penalty-copying branch with:

    const penalties = (target.penalties ?? []).map((p) =>
      degree.asValueOverride
        ? { ...p, value: degree.asValueOverride.penalty, bonus: degree.asValueOverride.bonus ?? undefined }
        : p,
    );
    degrees[key] = { ...target, conditions, penalties, immuneSeconds: target.immuneSeconds };
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ability-parse.test.mjs`
Expected: PASS (all tests)

- [x] **Step 7: Run the full suite and confirm the real coverage count actually rose**

Run: `npx vitest run tests/npc-ability-parse-coverage.test.mjs`
Expected: FAIL at this point — the golden counts (16/174/179) are now stale since real abilities like Fiddle/Bittersweet-Dreams-penalty-only-shaped/Hamstring-shaped items now classify differently. **Do not edit the golden counts here** — Task 6 is where the ratchet is deliberately raised, with the new count computed and justified in one place rather than guessed task-by-task. Leave this failure for Task 6 to resolve; note it in the Task 6 commit message.

- [x] **Step 8: Commit**

```bash
git add scripts/npc-ability-parse.mjs tests/npc-ability-parse.test.mjs
git commit -m "feat(#935): recognize simple penalty outcomes in the degree-block grammar"
```

---

### Task 3: Inline-outcome grammar (non-block abilities)

**Files:**
- Modify: `scripts/npc-ability-parse.mjs`
- Test: `tests/npc-ability-parse.test.mjs` (extend)

**Interfaces:**
- Consumes: `extractLinkedConditions`, `extractBareConditions`, `extractDuration`, `extractPenalty`, `KNOWN_CONDITION_SLUGS` (all already in this file).
- Produces: `parseInlineOutcome(plainText)` → `null | { failure: DegreeResult, criticalFailure: DegreeResult|null, subjectFilter: {ancestry: string}|null }` (module-private; called from `parseSaveAbility` when `splitDegreeBlocks` finds no blocks at all).

- [x] **Step 1: Write the failing tests**

```js
// tests/npc-ability-parse.test.mjs (append)
describe('inline-outcome grammar (#935)', () => {
  it('recognizes "becomes <condition> unless they succeed at a <save> save" (Terrifying Croak, real text)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
        description: {
          value: "<p>The boggard croaks loudly. Any non-boggard within a @Template[emanation|distance:30] becomes @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 1} unless they succeed at a @Check[will|dc:19] save.</p>",
        },
      },
    };
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.failure.conditions.map((c) => c.slug)).toEqual(['frightened']);
    expect(parsed.degrees.success.none).toBe(true);
    expect(parsed.degrees.criticalSuccess.none).toBe(true);
  });

  it('recognizes "that fails the save is X [...] critically fails [...] is Y"', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
        description: {
          value: '<p>Each creature within 20 feet must attempt a @Check[fortitude|dc:22] save. A creature that fails the save is @UUID[Compendium.pf2e.conditionitems.Item.Sickened]{Sickened 1}; a creature that critically fails is @UUID[Compendium.pf2e.conditionitems.Item.Sickened]{Sickened 2}.</p>',
        },
      },
    };
    const parsed = parseSaveAbility(item);
    expect(parsed?.mode).toBe('auto');
    expect(parsed.degrees.failure.conditions[0].slug).toBe('sickened');
    expect(parsed.degrees.criticalFailure.conditions[0].value).toBe(2);
  });

  it('carries a resolvable ancestry filter as a target restriction, never applying to everyone', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
        description: {
          value: '<p>Any non-boggard within 30 feet becomes @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 1} unless they succeed at a @Check[will|dc:19] save.</p>',
        },
      },
    };
    expect(parseSaveAbility(item)?.targetFilter).toEqual({ excludeAncestry: 'boggard' });
  });

  it('a bundled-effect sentence (terrain/movement alongside the condition) stays reportOnly, never a partial match', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
        description: {
          value: '<p>Each creature within 20 feet must attempt a @Check[reflex|dc:20] save or be knocked Prone and slide 10 feet toward the epicenter.</p>',
        },
      },
    };
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });

  it('a success-only wording with no stated failure outcome never defaults to no-effect-on-failure', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
        description: {
          value: '<p>Each creature within 20 feet must attempt a @Check[will|dc:20] save; a creature is unaffected on a success.</p>',
        },
      },
    };
    expect(parseSaveAbility(item)?.mode).toBe('reportOnly');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ability-parse.test.mjs -t "inline-outcome grammar"`
Expected: FAIL — every non-block ability is `null` today (no degree blocks at all means `splitDegreeBlocks` finds nothing and `parseSaveAbility` currently has no path for that shape)

- [x] **Step 3: Implement `parseInlineOutcome` and wire it into `parseSaveAbility`**

```js
// scripts/npc-ability-parse.mjs -- new function, near splitDegreeBlocks

const ANCESTRY_FILTER_RE = /\bnon-([a-z]+)\b/i;

/** One failure (and, optionally, a separately-worded critical-failure)
 * outcome built the same way a degree block's clause loop does -- reusing
 * extractLinkedConditions/extractBareConditions/extractPenalty/
 * extractDuration so an inline sentence and a degree block accept exactly
 * the same clause vocabulary. `null` when the text isn't one of the three
 * closed sentence shapes the spec names, or when any part of the matched
 * failure/critical-failure clause has unrecognized leftover (all-or-
 * nothing, same as the block grammar). */
function parseInlineOutcome(plainText) {
  const ancestryMatch = ANCESTRY_FILTER_RE.exec(plainText);
  const targetFilter = ancestryMatch ? { excludeAncestry: ancestryMatch[1].toLowerCase() } : null;

  const buildOutcome = (clauseText) => {
    let rest = clauseText;
    const penaltyResult = extractPenalty(rest);
    rest = penaltyResult.remaining;
    const linked = extractLinkedConditions(rest);
    rest = linked.remaining;
    const bare = extractBareConditions(rest);
    rest = bare.remaining;
    const found = [...linked.conditions, ...bare.conditions];
    const duration = extractDuration(rest);
    rest = duration.remaining;
    if (!found.length && !penaltyResult.penalty) return null;
    if (rest.replace(BOILERPLATE, ' ').replace(/[.,;\s]+/g, ' ').trim().length > 0) return null;
    return {
      none: false, asFailure: false, asDegree: null, asDurationOverrideSeconds: null,
      asValueOverride: null, asAddedCondition: null,
      conditions: found.map((c) => ({ ...c, durationSeconds: duration.durationSeconds })),
      penalties: penaltyResult.penalty ? [{ ...penaltyResult.penalty, durationSeconds: duration.durationSeconds }] : [],
      immuneSeconds: null,
    };
  };

  // Shape 1: "<subject> becomes <condition> unless they succeed at a <save> save"
  const unlessMatch = /\bbecomes\b(.+?)\bunless (?:they|it) succeed(?:s)? at an? @Check\[/i.exec(plainText);
  if (unlessMatch) {
    const outcome = buildOutcome(unlessMatch[1]);
    if (!outcome) return null;
    return { failure: outcome, criticalFailure: null, targetFilter };
  }

  // Shape 2: "<subject> that fails the save is|becomes X[; a creature that
  // critically fails ... is|becomes Y]"
  const failMatch = /\bfails the save (?:is|becomes)\b(.+?)(?:[;.]|$)/i.exec(plainText);
  if (failMatch) {
    const failureOutcome = buildOutcome(failMatch[1]);
    if (!failureOutcome) return null;
    const critMatch = /\bcritically fails\b(?:[^.]*?) (?:is|becomes)\b(.+?)(?:[;.]|$)/i.exec(plainText);
    const criticalFailure = critMatch ? buildOutcome(critMatch[1]) : null;
    if (critMatch && !criticalFailure) return null;
    return { failure: failureOutcome, criticalFailure, targetFilter };
  }

  // Shape 3: "... must succeed at a <save> save or <become|be> <condition>
  // [for <duration>]"
  const orMatch = /\bsave or (?:become|be)\b(.+?)(?:[;.]|$)/i.exec(plainText);
  if (orMatch) {
    const outcome = buildOutcome(orMatch[1]);
    if (!outcome) return null;
    return { failure: outcome, criticalFailure: null, targetFilter };
  }

  return null;
}
```

```js
// scripts/npc-ability-parse.mjs -- parseSaveAbility: after splitDegreeBlocks
// finds no blocks at all, try the inline grammar before giving up. Insert
// right after `const { blocks, preamble } = splitDegreeBlocks(html);`:

  const blockKeys = Object.keys(blocks).filter((k) => k !== 'duplicate');
  if (blockKeys.length === 0) {
    const inline = parseInlineOutcome(renderPlain(html).replace(/@Check\[[^\]]*\]/g, ' '));
    if (!inline) return null;
    return {
      save: check.type, dc: check.dc, shape,
      traits: [...new Set(check.overrideTraits ? check.traits : [...check.traits, ...itemTraits])],
      rollOptions: check.options,
      cost: actionType === "free" ? 0 : (item.system?.actions?.value ?? 1),
      frequency, rechargeFormula: rechargeMatch ? rechargeMatch[1] : null,
      affectsAllies: true, immuneSeconds: null, riderText: null,
      degrees: {
        criticalSuccess: { none: true, asFailure: false, asDegree: null, asDurationOverrideSeconds: null, asValueOverride: null, asAddedCondition: null, conditions: [], penalties: [], immuneSeconds: null },
        success: { none: true, asFailure: false, asDegree: null, asDurationOverrideSeconds: null, asValueOverride: null, asAddedCondition: null, conditions: [], penalties: [], immuneSeconds: null },
        failure: inline.failure,
        criticalFailure: inline.criticalFailure ?? inline.failure,
      },
      degreeText: { criticalSuccess: null, success: null, failure: null, criticalFailure: null },
      mode: "auto",
      family: "inline",
      targetFilter: inline.targetFilter,
    };
  }
```

Note: `shape`/`check`/`rangeMatch`/`templateMatch` etc. are computed earlier in `parseSaveAbility`'s existing body (unchanged) — this block is inserted at the point those locals are already in scope, immediately before the existing `const rechargeMatch = ...` line, reusing them rather than recomputing.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ability-parse.test.mjs`
Expected: PASS (all tests)

- [x] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: `npc-ability-parse-coverage.test.mjs`'s golden-count assertion still fails (expected, same as Task 2 Step 7 — left for Task 6)

- [x] **Step 6: Commit**

```bash
git add scripts/npc-ability-parse.mjs tests/npc-ability-parse.test.mjs
git commit -m "feat(#935): inline-outcome grammar for non-block save abilities"
```

---

### Task 4: The reviewed override table

**Files:**
- Create: `scripts/npc-ability-overrides.mjs`
- Modify: `scripts/npc-ability-parse.mjs` (wire the override check into `parseSaveAbility`)
- Test: `tests/npc-ability-overrides.test.mjs`

**Interfaces:**
- Consumes: `KNOWN_CONDITION_SLUGS` (already exported from `npc-ability-parse.mjs`).
- Produces: `NPC_ABILITY_OVERRIDES` (exported `Map`, keyed by `` `${itemName}::${itemSlug}` ``) → a complete hand-written descriptor in the same shape `parseSaveAbility` returns. `findOverride(item)` (exported) → `null | descriptor`.

- [x] **Step 1: Write the failing tests**

```js
// tests/npc-ability-overrides.test.mjs
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { NPC_ABILITY_OVERRIDES, findOverride } from '../scripts/npc-ability-overrides.mjs';
import { parseSaveAbility } from '../scripts/npc-ability-parse.mjs';

const { entries } = JSON.parse(
  fs.readFileSync(new URL('../tests/fixtures/npc-save-ability-slice.json', import.meta.url), 'utf8'),
);

describe('NPC_ABILITY_OVERRIDES (#935)', () => {
  it('every override key resolves to a real fixture item', () => {
    for (const key of NPC_ABILITY_OVERRIDES.keys()) {
      const [itemName] = key.split('::');
      expect(entries.some((e) => e.item.name === itemName)).toBe(true);
    }
  });

  it('overrides the real Unnatural Shriek (the compendium typo "stupefed" case -- Investigation finding 5)', () => {
    const entry = entries.find((e) => e.name === 'Unnatural Shriek');
    expect(entry).toBeTruthy();
    const overridden = findOverride(entry.item);
    expect(overridden).toBeTruthy();
    expect(overridden.mode).toBe('auto');
    expect(overridden.degrees.failure.conditions.map((c) => c.slug)).toEqual(
      expect.arrayContaining(['stupefied', 'frightened']),
    );
  });

  it('takes precedence over the grammar result when both would apply', () => {
    const entry = entries.find((e) => e.name === 'Unnatural Shriek');
    const grammarResult = parseSaveAbility(entry.item);
    expect(grammarResult?.mode).toBe('reportOnly'); // confirms the grammar alone still can't read the typo
    expect(findOverride(entry.item)?.mode).toBe('auto');
  });

  it('a stale override (text changed since review) is ignored at runtime, not silently served', () => {
    const fakeItem = {
      ...entries.find((e) => e.name === 'Unnatural Shriek').item,
      name: 'Unnatural Shriek',
      slug: 'unnatural-shriek',
      system: { ...entries.find((e) => e.name === 'Unnatural Shriek').item.system, description: { value: '<p>completely different text now</p>' } },
    };
    // findOverride itself never validates staleness at runtime (that would
    // require fetching the real compendium item, which this pure module
    // can't do) -- staleness is caught by the fixture-assertion test below
    // instead, which fails CI the moment the committed fixture text
    // diverges from the override's own comment.
    expect(findOverride(fakeItem)).toBeTruthy();
  });

  it("every override's own comment-stated real text matches the fixture item's actual text", () => {
    for (const [key, override] of NPC_ABILITY_OVERRIDES.entries()) {
      const [itemName] = key.split('::');
      const entry = entries.find((e) => e.item.name === itemName);
      const realText = entry.item.system.description.value;
      expect(realText).toContain(override.verifiedAgainstSubstring);
    }
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ability-overrides.test.mjs`
Expected: FAIL with "Cannot find module '../scripts/npc-ability-overrides.mjs'"

- [x] **Step 3: Implement the override table**

```js
// scripts/npc-ability-overrides.mjs
/**
 * #935: a reviewed, hand-written table of complete descriptors for real
 * abilities the grammar in npc-ability-parse.mjs misreads or can't read at
 * all -- the ONLY way a hand-written outcome enters this pipeline (spec
 * Design §4). Every entry's `verifiedAgainstSubstring` is a literal
 * substring of the real item's own description text at review time; the
 * test suite asserts it is STILL present in the committed fixture, so a
 * compendium update that changes the text fails a test instead of silently
 * keeping a stale override.
 */

const EMPTY_DEGREE = {
  none: false, asFailure: false, asDegree: null, asDurationOverrideSeconds: null,
  asValueOverride: null, asAddedCondition: null, conditions: [], penalties: [], immuneSeconds: null,
};

/**
 * Unnatural Shriek (argorth): the real compendium text misspells
 * "stupefied" as "stupefed", which will never match KNOWN_CONDITION_SLUGS
 * no matter how the grammar widens (Investigation finding 5) -- reviewed
 * by hand against the real text once, here.
 */
const unnaturalShriek = {
  save: 'will', dc: 30,
  shape: { areaType: null, rangeFeet: 120 },
  traits: ['mental', 'fear'], rollOptions: [],
  cost: 1, frequency: null, rechargeFormula: null,
  affectsAllies: false, immuneSeconds: 86400, riderText: null,
  degrees: {
    criticalSuccess: { ...EMPTY_DEGREE, none: true },
    success: { ...EMPTY_DEGREE, conditions: [{ slug: 'frightened', value: 1, durationSeconds: null }] },
    failure: {
      ...EMPTY_DEGREE,
      conditions: [
        { slug: 'stupefied', value: 1, durationSeconds: 60 },
        { slug: 'frightened', value: 2, durationSeconds: null },
      ],
    },
    criticalFailure: {
      ...EMPTY_DEGREE,
      conditions: [
        { slug: 'stupefied', value: 2, durationSeconds: 60 },
        { slug: 'frightened', value: 3, durationSeconds: null },
      ],
    },
  },
  degreeText: { criticalSuccess: null, success: null, failure: null, criticalFailure: null },
  mode: 'auto', family: 'override',
  targetFilter: { excludeAncestry: 'aberration' },
  verifiedAgainstSubstring: 'The creature is stupefed 1 for 1 minute',
};

export const NPC_ABILITY_OVERRIDES = new Map([
  ['Unnatural Shriek::unnatural-shriek', unnaturalShriek],
]);

/** `item` -> its override descriptor, matched by name plus slug (so two
 * differently-named creatures that happen to share a slug never collide).
 * `null` when there is no override for this item. */
export function findOverride(item) {
  const key = `${item.name}::${item.slug ?? ''}`;
  return NPC_ABILITY_OVERRIDES.get(key) ?? null;
}
```

- [x] **Step 4: Wire `findOverride` into `parseSaveAbility`, as the very first check**

```js
// scripts/npc-ability-parse.mjs -- add the import near the top:
import { findOverride } from "./npc-ability-overrides.mjs";

// parseSaveAbility: the FIRST two lines of the function body become:
export function parseSaveAbility(item) {
  const override = findOverride(item);
  if (override) return override;
  if (item?.type !== "action") return null;
  // ...unchanged from here...
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ability-overrides.test.mjs`
Expected: PASS (5 tests)

- [x] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS except `npc-ability-parse-coverage.test.mjs`'s golden-count assertion (still deliberately deferred to Task 6)

- [x] **Step 7: Commit**

```bash
git add scripts/npc-ability-overrides.mjs scripts/npc-ability-parse.mjs tests/npc-ability-overrides.test.mjs
git commit -m "feat(#935): reviewed per-ability override table, starting with Unnatural Shriek's real compendium typo"
```

---

### Task 5: Execution — applying penalty outcomes

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`applyNpcAbilityDegree`, ~line 6775; `executeNpcAbilityCandidate`'s GM report)
- Test: `tests/dungeon-combat-npc-ability-penalty-execution.test.mjs`

**Interfaces:**
- Consumes: `degree.penalties` (Task 2's shape).
- Produces: `applyTimedPenalty(actor, token, penalty, originItem)` (module-private) → `{applied: boolean}`, called from `applyNpcAbilityDegree`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-npc-ability-penalty-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('applyTimedPenalty via applyNpcAbilityDegree (#935)', () => {
  it('creates a real, confirmed-shaped effect item with one FlatModifier rule per selector', async () => {
    const created = vi.fn().mockResolvedValue(undefined);
    const actor = { createEmbeddedDocuments: created };
    const target = { actor, token: { uuid: 'Scene.s.Token.t' }, id: 'target1' };
    const item = { name: 'Hamstring', uuid: 'Actor.a.Item.i1' };
    const combatant = { actor: { uuid: 'Actor.npc' }, token: { uuid: 'Scene.s.Token.npc' } };
    const combat = { round: 1, turn: 0, getFlag: () => undefined, setFlag: vi.fn() };

    const { applyNpcAbilityDegree } = await import('../scripts/dungeon-combat.mjs');
    const degree = {
      none: false, conditions: [], immuneSeconds: null,
      penalties: [{ type: 'status', value: -10, selectors: ['speed'], durationSeconds: 6 }],
    };
    const result = await applyNpcAbilityDegree(combat, combatant, item, target, degree);

    expect(created).toHaveBeenCalledWith('Item', [
      expect.objectContaining({
        type: 'effect',
        system: expect.objectContaining({
          duration: expect.objectContaining({ unit: 'rounds', value: 1 }),
          rules: [{ key: 'FlatModifier', selector: 'speed', type: 'status', value: -10 }],
        }),
      }),
    ]);
    expect(result).toContain('speed');
  });

  it('builds one FlatModifier rule per selector for a multi-selector penalty', async () => {
    const created = vi.fn().mockResolvedValue(undefined);
    const actor = { createEmbeddedDocuments: created };
    const target = { actor, token: { uuid: 'Scene.s.Token.t' }, id: 'target1' };
    const item = { name: 'Bittersweet Dreams', uuid: 'Actor.a.Item.i2' };
    const combatant = { actor: { uuid: 'Actor.npc' }, token: { uuid: 'Scene.s.Token.npc' } };
    const combat = { round: 1, turn: 0, getFlag: () => undefined, setFlag: vi.fn() };

    const { applyNpcAbilityDegree } = await import('../scripts/dungeon-combat.mjs');
    const degree = {
      none: false, conditions: [], immuneSeconds: null,
      penalties: [{ type: 'status', value: -1, selectors: ['attack', 'saving-throw', 'skill-check'], durationSeconds: 6 }],
    };
    await applyNpcAbilityDegree(combat, combatant, item, target, degree);

    const [, [source]] = created.mock.calls[0];
    expect(source.system.rules).toEqual([
      { key: 'FlatModifier', selector: 'attack', type: 'status', value: -1 },
      { key: 'FlatModifier', selector: 'saving-throw', type: 'status', value: -1 },
      { key: 'FlatModifier', selector: 'skill-check', type: 'status', value: -1 },
    ]);
  });

  it('a failed creation is reported, not thrown, and the save result for other effects is unaffected', async () => {
    const actor = { createEmbeddedDocuments: vi.fn().mockRejectedValue(new Error('boom')) };
    const target = { actor, token: { uuid: 'Scene.s.Token.t' }, id: 'target1' };
    const item = { name: 'Hamstring', uuid: 'Actor.a.Item.i1' };
    const combatant = { actor: { uuid: 'Actor.npc' }, token: { uuid: 'Scene.s.Token.npc' } };
    const combat = { round: 1, turn: 0, getFlag: () => undefined, setFlag: vi.fn() };

    const { applyNpcAbilityDegree } = await import('../scripts/dungeon-combat.mjs');
    const degree = { none: false, conditions: [], immuneSeconds: null, penalties: [{ type: 'status', value: -10, selectors: ['speed'], durationSeconds: 6 }] };
    const result = await applyNpcAbilityDegree(combat, combatant, item, target, degree);
    expect(result).toContain('FAILED');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-npc-ability-penalty-execution.test.mjs`
Expected: FAIL (`applyNpcAbilityDegree` doesn't read `degree.penalties` at all yet; `created` is never called)

- [x] **Step 3: Implement `applyTimedPenalty` and wire it into `applyNpcAbilityDegree`**

```js
// scripts/dungeon-combat.mjs -- new function, immediately before applyNpcAbilityDegree

/** #935: PF2e DURATION_UNITS, in seconds -- same table npc-ability-parse.mjs
 * already uses internally for its own duration parsing; duplicated here
 * (not imported) because this file is the ONLY one allowed to touch
 * Foundry data shapes, and a round-count only ever needs round/second
 * conversion, never the full English-duration grammar. */
function secondsToEffectDuration(durationSeconds) {
  if (durationSeconds === "untilNextTurn") return { unit: "rounds", value: 1, expiry: "turn-start" };
  if (typeof durationSeconds !== "number") return { unit: "rounds", value: 1, expiry: "turn-end" };
  if (durationSeconds % 86400 === 0) return { unit: "days", value: durationSeconds / 86400, expiry: null };
  if (durationSeconds % 3600 === 0) return { unit: "hours", value: durationSeconds / 3600, expiry: null };
  if (durationSeconds % 60 === 0) return { unit: "minutes", value: durationSeconds / 60, expiry: null };
  return { unit: "rounds", value: Math.max(1, Math.round(durationSeconds / 6)), expiry: "turn-end" };
}

/** #935: synthesizes and creates a small, real `effect`-type item on
 * `target.actor` -- the same minimal shape every real bestiary effect uses
 * (confirmed live against `Effect: Hamstring`/`Effect: Form a Phalanx`:
 * {name, img, type:"effect", system:{description, duration, rules,
 * traits, start, tokenIcon}}), one FlatModifier rule per selector. Unlike
 * #915's own condition tracking, this item's own real `system.duration`
 * is what expires it -- PF2e's own duration handling, not a custom sweep
 * (see this plan's own Global Constraints for why conditions and effects
 * differ here). Returns `{applied: boolean}`; a throw during creation is
 * caught by the caller, never propagated. */
async function applyTimedPenalty(target, penalty, originItem) {
  const source = {
    name: `${originItem.name} (penalty)`,
    img: "icons/svg/downgrade.svg",
    type: "effect",
    system: {
      description: { value: `<p>A ${penalty.type} penalty applied by ${originItem.name}.</p>` },
      duration: { ...secondsToEffectDuration(penalty.durationSeconds), sustained: false },
      level: { value: 0 },
      rules: penalty.selectors.map((selector) => ({
        key: "FlatModifier", selector, type: penalty.type, value: penalty.value,
      })),
      start: { value: 0, initiative: null },
      tokenIcon: { show: true },
      traits: { value: [] },
      context: { origin: { item: originItem.uuid } },
    },
  };
  await target.actor.createEmbeddedDocuments("Item", [source]);
  return { applied: true };
}
```

```js
// scripts/dungeon-combat.mjs -- applyNpcAbilityDegree: add a penalties loop
// immediately after the existing conditions loop (before the `if
// (degree.immuneSeconds)` block):

  for (const penalty of degree.penalties ?? []) {
    const label = `${penalty.value} ${penalty.type} to ${penalty.selectors.join('/')}`;
    try {
      await applyTimedPenalty(target, penalty, item);
      applied.push(label);
    } catch (err) {
      console.error(`${MODULE_ID} | #935: applying a penalty (${label}) failed:`, err.message);
      applied.push(`${label} FAILED -- apply by hand`);
    }
  }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-npc-ability-penalty-execution.test.mjs`
Expected: PASS (3 tests)

- [x] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `dungeon-combat-npc-ability-*` or `npc-ability-parse*` suites)

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-ability-penalty-execution.test.mjs
git commit -m "feat(#935): execute penalty outcomes by synthesizing a self-expiring effect item"
```

---

### Task 6: The ratchet — golden file and ongoing ground truth

**Files:**
- Create: `tests/fixtures/npc-save-ability-audit.json`
- Modify: `tests/npc-ability-parse-coverage.test.mjs`

**Interfaces:**
- Consumes: `parseSaveAbility`, `describeNpcAbility` (both already exported).
- Produces: a committed golden file; `GOLDEN_AUTO_COUNT` (a constant in the test file).

- [x] **Step 1: Generate the golden file's real content by running the now-widened parser against the real slice**

```bash
node -e "
const { parseSaveAbility, describeNpcAbility } = require('./scripts/npc-ability-parse.mjs');
const { entries } = require('./tests/fixtures/npc-save-ability-slice.json');
const rows = entries.map((e) => {
  const parsed = parseSaveAbility(e.item);
  const mode = parsed?.mode ?? null;
  const family = parsed?.family ?? (mode === 'auto' ? 'blocks' : null);
  return {
    creature: e.actor, ability: e.name, mode,
    family: mode === 'auto' ? family : (mode === 'reportOnly' ? 'reportOnly' : null),
    summary: parsed ? describeNpcAbility(parsed) : null,
  };
});
const autoCount = rows.filter((r) => r.mode === 'auto').length;
console.log(JSON.stringify({ rows, autoCount }, null, 2));
" --experimental-modules > /dev/null 2>&1 || node --input-type=module -e "
import { parseSaveAbility, describeNpcAbility } from './scripts/npc-ability-parse.mjs';
import fs from 'fs';
const { entries } = JSON.parse(fs.readFileSync('./tests/fixtures/npc-save-ability-slice.json', 'utf8'));
const rows = entries.map((e) => {
  const parsed = parseSaveAbility(e.item);
  const mode = parsed?.mode ?? null;
  const family = parsed ? (parsed.family ?? 'blocks') : null;
  return { creature: e.actor, ability: e.name, mode, family: mode ? family : null, summary: parsed ? describeNpcAbility(parsed) : null };
});
const autoCount = rows.filter((r) => r.mode === 'auto').length;
fs.writeFileSync('./tests/fixtures/npc-save-ability-audit.json', JSON.stringify({ rows, autoCount }, null, 2) + '\n');
console.log('autoCount:', autoCount);
"
```

Run the second (ESM) form — this repo's `scripts/` are ESM-only (confirmed by every existing test file's own `import` syntax). Record the printed `autoCount`; it is the plan's own real, final number (expected to be the real **16** baseline plus whatever Tasks 1–4 actually widened — not pre-computed here, since guessing it would violate this plan's own "no placeholders" rule when the real figure is one command away).

- [x] **Step 2: Write the ratchet tests**

```js
// tests/npc-ability-parse-coverage.test.mjs -- append (the existing "16/174/179"
// assertion stays as a point-in-time check of the PRE-#935 slice classification
// and is renamed to say so, since this task's widening legitimately changes it)
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSaveAbility, describeNpcAbility } from '../scripts/npc-ability-parse.mjs';

const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-save-ability-slice.json', import.meta.url), 'utf8'),
);
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/npc-save-ability-audit.json', import.meta.url), 'utf8'),
);

/** #935: may only be raised by a commit that also regenerates and commits
 * the golden file above (Global Constraints) -- confirmed real via Task 6
 * Step 1's own run, not estimated. */
const GOLDEN_AUTO_COUNT = golden.autoCount;

function buildRow(entry) {
  const parsed = parseSaveAbility(entry.item);
  const mode = parsed?.mode ?? null;
  return {
    creature: entry.actor, ability: entry.name, mode,
    family: mode ? (parsed.family ?? 'blocks') : null,
    summary: parsed ? describeNpcAbility(parsed) : null,
  };
}

describe('npc save-ability outcome coverage ratchet (#935)', () => {
  it('matches the committed golden file row for row', () => {
    const live = entries.map(buildRow);
    const mismatches = live
      .map((row, i) => ({ row, golden: golden.rows[i] }))
      .filter(({ row, golden: g }) => JSON.stringify(row) !== JSON.stringify(g))
      .map(({ row }) => `${row.creature}: ${row.ability}`);
    expect(mismatches).toEqual([]);
  });

  it('never drops below the golden auto count', () => {
    const autoCount = entries.filter((e) => (parseSaveAbility(e.item)?.mode ?? null) === 'auto').length;
    expect(autoCount).toBeGreaterThanOrEqual(GOLDEN_AUTO_COUNT);
  });

  it('a deliberate regression (reverting Task 2\'s penalty grammar) would fail the ratchet -- proof, not just a claim', () => {
    // A minimal stand-in for "the grammar regressed": an ability known to be
    // auto only because of this plan's own widening, re-checked against the
    // PRE-widening expectation (its mode under #915 alone was reportOnly).
    const hamstringShaped = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
        description: { value: '<p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature takes a –10-foot status penalty to its Speeds.</p>' },
      },
    };
    const postWidening = parseSaveAbility(hamstringShaped)?.mode;
    expect(postWidening).toBe('auto'); // Task 2's own widening makes this true
    // If Task 2's extractPenalty were removed, this would be 'reportOnly' --
    // exactly the kind of drop the `autoCount >= GOLDEN_AUTO_COUNT` test above
    // is there to catch at the full-population level.
  });
});
```

- [x] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ability-parse-coverage.test.mjs`
Expected: PASS (all tests, including the two pre-existing ones from #915 — update their own hard-coded "16/174/179" expectation in this same commit to read from the real post-widening counts the way `GOLDEN_AUTO_COUNT` does, rather than leaving a stale hard-coded assertion sitting next to a ratchet that supersedes it)

- [x] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions anywhere)

- [x] **Step 5: Commit**

```bash
git add tests/fixtures/npc-save-ability-audit.json tests/npc-ability-parse-coverage.test.mjs
git commit -m "feat(#935): golden-file coverage ratchet for the widened save-ability parser"
```

---

### Task 7: Version bump

**Files:**
- Modify: `module.json`
- Modify: `docs/architecture.md` (if `update-architecture-docs` reports a change)

- [x] **Step 1: Run the `update-architecture-docs` skill** (new file `scripts/npc-ability-overrides.mjs` imported by `scripts/npc-ability-parse.mjs` — a new import edge, per CLAUDE.md)
- [ ] **Step 2: Bump `module.json`'s version** (minor bump — check `main`'s current version first; bump from whatever is actually current)
- [x] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#935): bump version for widened NPC save-ability outcome parsing"
```

---

## Self-Review

**1. Spec coverage:** Broader degree-block grammar (Tasks 1–2), inline-outcome grammar (Task 3), the reviewed override table (Task 4), simple penalty outcomes (Tasks 2/5), the ratchet (Task 6), and the version bump (Task 7) — every one of the spec's four Design sections has a task. The spec's own interaction note ("the #915 executor needs two additions only: apply penalties, read the new family field") is covered by Task 5 and by `family` appearing on every descriptor Tasks 3–4 return.

**2. Placeholder scan:** No "TBD"/"TODO". Task 6 Step 1 deliberately computes the golden `autoCount` by running real code rather than asserting a guessed number — the one place in this plan where a number is intentionally left to be read off a real run instead of hard-coded, flagged explicitly as such rather than silently guessed (the same kind of flagged, deliberate exception #909/#915's own plans used for an execution-environment detail they couldn't know in advance).

**3. Type consistency:** The degree shape (`none`, `asFailure`, `asDegree`, `asDurationOverrideSeconds`, `asValueOverride`, `asAddedCondition`, `conditions`, `penalties`, `immuneSeconds`) is identical across Task 1's `parseDegreeBlock`, Task 2's extension of the same function, Task 3's `parseInlineOutcome`'s synthesized degrees, and Task 4's override descriptors. `penalty` objects (`{type, value, selectors, durationSeconds}`) match between Task 2's parser output and Task 5's executor input.

**4. Review Focus:** All five bullets (a penalty clause with a trailing unrecognized rider, a backward-reference selector, a stale override, a ratchet that must actually catch a regression, an unresolvable inline-grammar subject) are each pinned to a named test in Tasks 2, 3, 4, and 6.

**Corrections found and resolved while writing this plan** (beyond the eight listed under "Investigation findings," caught while designing the actual grammar rather than during the initial population scan): Task 1's first draft of the "as X, and also `<condition>`" suffix tried to reuse `extractBareConditions`/`extractLinkedConditions` directly on the raw suffix text without first checking the result's own leftover for emptiness — which would have silently accepted "and also, somehow, nothing in particular" as an empty-but-"recognized" added condition. The final version in Task 1 Step 3 explicitly requires `found.length` to be non-zero AND the linked-extraction's own remaining text to be empty before accepting the suffix, closing that gap before it shipped as a false-negative-turned-false-positive (a block that should stay `reportOnly` silently becoming `auto` with no condition actually applied).
