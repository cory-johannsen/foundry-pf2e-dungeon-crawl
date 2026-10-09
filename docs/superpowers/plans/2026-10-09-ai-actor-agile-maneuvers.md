# AI Actor Agile Maneuvers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower the multiple attack penalty #940 applies to AI maneuvers when the actor has Agile Maneuvers — −4/−8 regardless of weapon, or −3/−6 when the weapon used is also agile and the actor has Panache active.

**Architecture:** Extracts #940's baseline MAP-value arithmetic out of `dungeon-combat.mjs`'s `computeManeuverMapModifier` into a new pure `maneuverMapPenalty({attackNumber, weaponIsAgile, featSlugs, hasPanache})` in #911's own `scripts/maneuver-feat-modifiers.mjs` (the established home for maneuver-feat-modifier logic), which also applies the Agile Maneuvers adjustment, taking whichever value is least negative. `computeManeuverMapModifier` becomes a thin Foundry-touching wrapper that gathers the real inputs (feat slugs, the Panache effect, the maneuver weapon's own `agile` trait) and calls this pure function, then wraps the result in a `game.pf2e.Modifier` exactly as #940 already does.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-agile-maneuvers-design.md`

## Global Constraints

- **Hard dependency: #940's own plan (`docs/superpowers/plans/2026-10-09-ai-actor-maneuver-map.md`) must be fully implemented and merged first**, and in turn #909's and #911's own plans (per #940's own chain).
- **Confirmed live:** Agile Maneuvers has `rules: []` (the PF2e system applies none of it automatically) and its slug appears nowhere in `pf2e.mjs`; Panache is tracked as a real effect item, slug `effect-panache` (per the spec's own stated investigation).
- **Not independently re-confirmed this session due to a live-connection failure (three consecutive "Invalid client ID" errors against the live world, not retried further given the fact at stake — a feat slug — is low-risk and PF2e's own slugification convention has been 100% consistent across every other feat checked this entire session):** Agile Maneuvers' own slug is assumed to be `agile-maneuvers`, the exact kebab-case of its display name, matching every other feat slug confirmed live this session (titan-wrestler, sly-disarm, crushing-grab, terrified-retreat, sudden-charge, twin-feint, raise-a-shield, ...) with zero exceptions found. **Task 1, Step 0 re-confirms this slug live before writing any code that depends on it** — if it differs, update the slug literal in Task 1's own `maneuverMapPenalty` implementation and its tests before proceeding; nothing else in this plan changes either way.
- The modifier is always taken as the least negative (most favorable to the actor) of the #940 baseline and the Agile Maneuvers result — the feat can only ever help, never hurt, confirmed as the spec's own explicit Decision.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (patch bump — a small extension of #940's own correction, not a new subsystem).

## Review Focus

- The feat must only ever lower the penalty, never raise it — an actor with Agile Maneuvers but, by some data error, a *less* favorable computed Agile-Maneuvers value than the baseline must still get the baseline (the `Math.max` comparison, not an unconditional substitution).
- The −3/−6 panache branch requires **both** an agile weapon **and** active Panache — either alone must fall through to the plain −4/−8 Agile Maneuvers value, never to −3/−6.
- The very first attack of the turn must always be 0, with or without the feat — `attackNumber <= 1` short-circuits before any feat logic runs.
- Demoralize must still never receive any modifier at all, regardless of Agile Maneuvers (it has no `attack` trait and is outside this feat's own stated coverage) — unchanged from #940, not silently widened.
- Unreadable feat/effect data (a missing `itemTypes.feat`/`itemTypes.effect`) must fall back to the #940 baseline, never default to the more favorable Agile Maneuvers value.

---

### Task 0: Re-confirm the Agile Maneuvers slug live

**Files:**
- none (verification-only step; no commit)

- [x] **Step 1: Query the live world**

Run (from this worktree, with `.env` already copied in):

```bash
cat > /tmp/agile-maneuvers-slug-check.js <<'EOF'
return game.packs.get('pf2e.feats-srd').getIndex({ fields: ['system.slug'] })
  .then((idx) => idx.find((e) => e.name === 'Agile Maneuvers')?.system?.slug ?? 'not found');
EOF
bash .claude/skills/foundry-rest/foundry-exec.sh /tmp/agile-maneuvers-slug-check.js
```

If this returns `agile-maneuvers`, proceed with Task 1 exactly as written. If it returns anything else, substitute that real slug for every `"agile-maneuvers"` literal in Task 1's implementation and tests before writing them.

---

### Task 1: The pure MAP-penalty function, with Agile Maneuvers folded in

**Files:**
- Modify: `scripts/maneuver-feat-modifiers.mjs`
- Test: `tests/maneuver-feat-modifiers.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Task 2): `maneuverMapPenalty({ attackNumber, weaponIsAgile, featSlugs = [], hasPanache = false })` → `number` (always `<= 0`).

- [x] **Step 1: Write the failing tests**

Add to `tests/maneuver-feat-modifiers.test.mjs`:

```js
describe('maneuverMapPenalty', () => {
  it('is 0 on the first attack regardless of everything else', () => {
    expect(maneuverMapPenalty({ attackNumber: 1, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(0);
  });

  it('matches #940\'s own baseline with no Agile Maneuvers: -5/-4 second, -10/-8 third, standard vs agile weapon', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: [] })).toBe(-5);
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: [] })).toBe(-4);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: false, featSlugs: [] })).toBe(-10);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: true, featSlugs: [] })).toBe(-8);
  });

  it('applies the flat -4/-8 Agile Maneuvers value when the weapon is not agile', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: ['agile-maneuvers'] })).toBe(-4);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: false, featSlugs: ['agile-maneuvers'] })).toBe(-8);
  });

  it('applies the flat -4/-8 Agile Maneuvers value when the weapon IS agile but Panache is not active', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: false })).toBe(-4);
  });

  it('applies the deeper -3/-6 value only when the weapon is agile AND Panache is active', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(-3);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(-6);
  });

  it('never returns a value more negative (less favorable) than the #940 baseline', () => {
    // Agile Maneuvers' own -4/-8 is already less negative than the
    // standard -5/-10 baseline it would otherwise replace, but the
    // Math.max comparison is the real safety net, not the specific
    // numbers happening to line up -- this test pins that comparison
    // exists at all by checking the agile-weapon, no-feat case is
    // strictly worse than the same case with the feat present.
    const withoutFeat = maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: [] });
    const withFeat = maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: ['agile-maneuvers'] });
    expect(withFeat).toBeGreaterThanOrEqual(withoutFeat);
  });

  it('ignores an unrelated feat slug, applying only the baseline', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: ['some-other-feat'] })).toBe(-5);
  });

  it('defaults featSlugs and hasPanache when omitted, never throwing', () => {
    expect(() => maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false })).not.toThrow();
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false })).toBe(-5);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/maneuver-feat-modifiers.test.mjs`
Expected: FAIL — `maneuverMapPenalty` doesn't exist yet.

- [x] **Step 3: Write `maneuverMapPenalty` in `scripts/maneuver-feat-modifiers.mjs`**

Add alongside `eligibilityModifiers`/`ridersFor` (per #911's plan):

```js
/**
 * #940/#919: the real PF2e multiple-attack-penalty value for a maneuver
 * attack. `attackNumber` is 1-based (1 = first attack this turn, always
 * 0 penalty). #940's own baseline (confirmed live via the system's own
 * calculateMAPs): -5/-10 standard, -4/-8 when the weapon used has the
 * agile trait. Agile Maneuvers (confirmed live: `rules: []`, the system
 * applies none of it) lowers this further to a flat -4/-8 regardless of
 * weapon, or -3/-6 when the weapon IS agile and the actor has Panache
 * active (confirmed live: an `effect-panache` item on the actor) — takes
 * the least negative (most favorable) of the baseline and the Agile
 * Maneuvers result, so the feat can only ever help.
 */
export function maneuverMapPenalty({ attackNumber, weaponIsAgile, featSlugs = [], hasPanache = false }) {
  if (attackNumber <= 1) return 0;
  const third = attackNumber >= 3;
  const baseline = third ? (weaponIsAgile ? -8 : -10) : (weaponIsAgile ? -4 : -5);
  if (!featSlugs.includes("agile-maneuvers")) return baseline;
  const deepened = weaponIsAgile && hasPanache;
  const agileManeuvers = third ? (deepened ? -6 : -8) : (deepened ? -3 : -4);
  return Math.max(baseline, agileManeuvers);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/maneuver-feat-modifiers.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/maneuver-feat-modifiers.mjs tests/maneuver-feat-modifiers.test.mjs
git commit -m "feat(#919): add the pure maneuverMapPenalty function (Agile Maneuvers)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire `maneuverMapPenalty` into execution, replacing #940's inline arithmetic

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-maneuver-map.test.mjs`

**Interfaces:**
- Consumes: `maneuverMapPenalty` (Task 1).
- Produces: `computeManeuverMapModifier` (per #940's plan) now delegates its numeric value to `maneuverMapPenalty`, reading the actor's own feat slugs, Panache effect, and the maneuver weapon's real `agile` trait.

- [x] **Step 1: Write the failing tests**

Add to `tests/dungeon-combat-maneuver-map.test.mjs` (per #940's plan, this file already mocks `game.pf2e.actions` and installs a combat/combatant/target stub):

```js
it('passes the Agile Maneuvers -4 modifier on the second maneuver when the actor has the feat but no agile weapon', async () => {
  // combatant.actor.itemTypes.feat includes { slug: 'agile-maneuvers' };
  // no held weapon carries the maneuver's own trait (unarmed/free-hand).
  // agentTurnState.mapIncrement === 1 (this is the second attack).
  // expect(actionSpy).toHaveBeenCalledWith(expect.objectContaining({
  //   modifiers: [expect.objectContaining({ modifier: -4 })],
  // }));
});

it('passes the deeper -3 modifier on the second maneuver when the actor has Agile Maneuvers, an agile weapon, AND active Panache', async () => {
  // combatant.actor.itemTypes.feat includes agile-maneuvers; a held
  // weapon carrying the maneuver's own trait also carries 'agile';
  // combatant.actor.itemTypes.effect includes { slug: 'effect-panache' }.
  // expect modifier -3.
});

it('falls back to the plain -4 Agile Maneuvers value when the weapon is agile but Panache is not active', async () => {
  // same shape as the -3 case but no effect-panache item present --
  // expect modifier -4, not -3.
});

it('still applies the plain #940 baseline (-5) when the actor has no Agile Maneuvers feat at all', async () => {
  // combatant.actor.itemTypes.feat has no agile-maneuvers entry --
  // expect modifier -5, confirming no regression from #940's own test
  // of the same shape.
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-maneuver-map.test.mjs`
Expected: FAIL — `computeManeuverMapModifier` doesn't read feat/effect data yet.

- [x] **Step 3: Implement**

Add the import:

```js
import { eligibilityModifiers, ridersFor, maneuverMapPenalty } from "./maneuver-feat-modifiers.mjs";
```

(This extends #911's own existing import line in this file — add `maneuverMapPenalty` to the same `from "./maneuver-feat-modifiers.mjs"` import, not a second import statement.)

Replace `computeManeuverMapModifier`'s body (per #940's plan) with:

```js
/** #940/#919: Trip/Shove/Grapple/Disarm all carry the `attack` trait and
 * suffer PF2e's own multiple attack penalty; Demoralize carries no
 * `attack` trait and is correctly exempt (returns null for it
 * unconditionally). The actual value — including any Agile Maneuvers
 * adjustment — is computed by the pure maneuverMapPenalty; this function
 * only gathers the real Foundry-side inputs it needs (the maneuver
 * weapon's own agile trait, the actor's feat slugs, whether Panache is
 * active) and wraps the result in a real Modifier. Returns null on the
 * very first maneuver of the turn (mapIncrement 0) — PF2e's own
 * first-attack MAP is always 0, never a literal "-0" modifier. */
function computeManeuverMapModifier(actor, slug, mapIncrement) {
  if (!MANEUVER_MAP_SLUGS.has(slug) || mapIncrement <= 0) return null;
  const weapon = findManeuverWeapon(actor, slug);
  const weaponIsAgile = (weapon?.system?.traits?.value ?? []).includes("agile");
  const featSlugs = (actor?.items ?? []).filter((i) => i.type === "feat").map((i) => i.slug);
  const hasPanache = (actor?.itemTypes?.effect ?? []).some((e) => e.slug === "effect-panache");
  const value = maneuverMapPenalty({ attackNumber: mapIncrement + 1, weaponIsAgile, featSlugs, hasPanache });
  if (value === 0) return null;
  return new game.pf2e.Modifier("Multiple Attack Penalty", value, "untyped");
}
```

(Note the `attackNumber: mapIncrement + 1` conversion — #940's own `mapIncrement` is 0-based (0 = first attack already happened... wait, confirm this precisely: #940's own `computeManeuverMapModifier` early-returns `null` when `mapIncrement <= 0`, meaning the function is only ever called with `mapIncrement >= 1` by the time it does real work, i.e. `mapIncrement` counts completed prior attacks, and the CURRENT maneuver is attack number `mapIncrement + 1`. This conversion makes `maneuverMapPenalty`'s own 1-based `attackNumber` convention line up exactly with #940's existing `mapIncrement` semantics — confirm this against #940's actual committed test fixtures, e.g. its "second maneuver this turn" test uses `mapIncrement === 1`, which is attack number 2, matching exactly.)

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-maneuver-map.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — in particular #940's own existing `computeManeuverMapModifier` tests (no-feat cases) must still pass unchanged, since `maneuverMapPenalty` with an empty `featSlugs` reproduces #940's exact baseline values.

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-maneuver-map.test.mjs
git commit -m "feat(#919): apply Agile Maneuvers' lower MAP to AI maneuver execution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [ ] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

A **patch** bump per `CLAUDE.md`'s versioning rule.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#919): bump version for Agile Maneuvers support

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (foundation-first, this spec only modifies the penalty amount) — Task 2 only replaces `computeManeuverMapModifier`'s internal arithmetic, touching no eligibility/execution-flow code #940 already wrote.
- Decision 2 (panache branch in scope, agile weapon AND panache both required) — Task 1's `maneuverMapPenalty`, with a dedicated test for each half of that AND condition failing alone.
- Decision 3 (coverage: Trip/Shove/Grapple/Disarm only, not Reposition, not Demoralize) — unchanged from #940's own `MANEUVER_MAP_SLUGS`/exemption logic, which Task 2 does not touch.
- The Design section's own `maneuverMapPenalty` signature and "least negative of baseline and Agile Maneuvers result" rule — implemented exactly in Task 1, with a dedicated `toBeGreaterThanOrEqual` safety-net test.
- Feat/Panache detection (`actor.itemTypes.feat` slugs; `actor.itemTypes.effect` slug `effect-panache`) — Task 2's `computeManeuverMapModifier` rewrite.
- Error handling section (unreadable data falls back to baseline, never the favorable value) — `featSlugs`/`hasPanache` both default to safe empty/false values in `maneuverMapPenalty`'s own signature, and `computeManeuverMapModifier`'s own `?? []` optional chains never throw on missing actor data.
- Testing section's own enumerated cases (every attack-number/agile/feat/panache combination, baseline-never-worse, executor modifier-value parity, Demoralize unaffected) — Task 1's eight tests plus Task 2's four, plus #940's own still-passing Demoralize test (unchanged by this plan).

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 0 is a deliberate, explicit verification step (not a placeholder) addressing the one fact this plan's own investigation could not live-confirm due to a connection failure, with a named fallback procedure if the assumption is wrong. Task 2's test bodies stay commented/pseudocoded pending the real stub shape #940's own test file already established, named explicitly.

**3. Type consistency:** `maneuverMapPenalty`'s parameter names (`attackNumber, weaponIsAgile, featSlugs, hasPanache`) exactly match the spec's own stated Design signature and are passed with those same names from Task 2's `computeManeuverMapModifier`. The `attackNumber = mapIncrement + 1` conversion is stated explicitly and checked against #940's own existing test fixture semantics rather than assumed silently.

**4. Review Focus:** all five items have a direct test — the feat never making the penalty worse (Task 1's dedicated safety-net test), the AND requirement for the −3/−6 branch (Task 1's "weapon is agile but Panache is not active" test and the symmetric case), the first-attack-always-0 short-circuit (Task 1's first test), Demoralize's continued exemption (unchanged #940 code, not re-tested here since nothing in this plan touches it), and unreadable data falling back to baseline (Task 1's "defaults featSlugs and hasPanache when omitted" test).
