# Natural-Roll-Only Critical/Fumble Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Critical Hit/Fumble Deck cards should only draw on an actual natural 20 (critical success) or natural 1 (critical failure) — not merely a 10+ margin on a non-extreme roll — per the owner's own explicit, recorded deviation from the deck's usual "any critical hit/fumble" guidance.

**Architecture:** A new shared helper, `lastRollWasNatural(face)`, reads the real natural-die-face field PF2e's own `CheckRoll#degreeOfSuccess` getter exposes (`dieResult`) off the most recently created chat message's own roll — confirmed live by reading the `DegreeOfSuccess` class directly. `drawCriticalCardForStrike`'s two branches and the spell-attack critical/fumble block's two conditions each gain this one extra check.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** none — bounded fix, approved via a short in-chat design (see this plan's own commit message / issue comment); not written to a separate spec file per the brainstorming skill's bounded path.

## Global Constraints

- **This is a deliberate, owner-approved deviation from PF2e's usual Critical Hit/Fumble Deck guidance** ("draw whenever a PC scores a critical hit/fumble," which RAW includes the 10+-margin case) — recorded on issue #976 itself per this repo's own `CLAUDE.md` "Game rules" section, not invented unilaterally.
- **Confirmed live by reading the installed PF2e system directly:** `CheckRoll#degreeOfSuccess` is a public getter (`get degreeOfSuccess() { return this.options.degreeOfSuccess ?? null; }`) returning the real `DegreeOfSuccess` instance that roll was evaluated with; that instance's own `dieResult` field (set in its constructor from the roll's own d20 term, confirmed directly in that class's source) is the actual natural face value, 1–20, and survives chat-message storage since `Roll#options` serializes as plain data.
- **Two independent call sites need the same gate**, confirmed live by reading both directly: `drawCriticalCardForStrike` (shared by all three Strike paths — manual/human strikes via `handleManualStrikeDamage`, and the two AI Strike paths `rollAndApplyStrike`/`rollAndApplyStrikeAtVariant`) and the separate spell-attack critical/fumble block inside `castAttackSpellAndApplyRoll` (the function starting ~line 4775), which checks `outcome` directly rather than going through `drawCriticalCardForStrike` at all.
- **Nothing else about either call site changes** — damage application, strike-rider resolution, sounds, and the `success`/`criticalSuccess` damage-rolling branches all stay exactly as they are; only the card-draw condition itself gains the new check.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (patch bump — a scoped rules-deviation fix, not a new subsystem).

## Review Focus

- A `criticalSuccess` outcome reached via a 10+ margin on a non-natural-20 roll must **not** draw a Hit deck card — the exact bug this plan exists to fix.
- A `criticalSuccess` reached via an actual natural 20 must still draw a card, even when the roll's total also happens to beat the DC by 10+ (the common case) — the fix must not accidentally suppress the legitimate case.
- The same two assertions apply symmetrically to `criticalFailure`/the Fumble deck and natural 1s.
- A roll whose `degreeOfSuccess`/`dieResult` is missing or unreadable (e.g. a test stub, or a genuinely malformed message) must be treated as "not natural" — never draw a card by default on missing data, since drawing a card is the rarer, more consequential path.
- The `success`/`failure` (non-critical) outcomes, and the strike-rider/damage-rolling logic that runs alongside the card draw, must be completely unaffected by this change — a regression there would be worse than the bug this plan fixes.

---

### Task 1: Gate both card-draw points on the natural die result

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-auto-apply-damage.test.mjs` (existing fixtures, per the file found during this plan's own investigation)
- Test: `tests/dungeon-critical-deck.test.mjs` (existing fixtures, if it exercises `drawCriticalCardForStrike` directly — confirm during implementation)
- Test: `tests/dungeon-combat-natural-roll-cards.test.mjs` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `drawCriticalCardForStrike` and the spell-attack critical/fumble block both additionally require a natural 20/1; the terminal consumer in this plan.

- [x] **Step 1: Update the existing fixture helper to carry a real `degreeOfSuccess`**

In `tests/dungeon-combat-auto-apply-damage.test.mjs`, `makeMessage`'s own `roll` default (`{ total: 7 }`) needs a `degreeOfSuccess` field added to every call site that currently exercises a `criticalSuccess`/`criticalFailure` outcome and expects a card to draw, matching the real PF2e shape confirmed live: `{ total: 7, degreeOfSuccess: { dieResult: 20 } }` for a criticalSuccess case, `{ dieResult: 1 }` for criticalFailure. Find every existing test in this file that sets `outcome: "criticalSuccess"` or `"criticalFailure"` and currently expects a card draw to happen, and add the matching `dieResult` to that test's own `roll` fixture — without this, every one of those tests will start failing once Step 3 lands (the new check will see no `degreeOfSuccess` at all and correctly refuse to draw), which is the expected, correct behavior change this plan makes, not a regression to work around by leaving the fixtures broken.

- [x] **Step 2: Write the new failing tests**

```js
// tests/dungeon-combat-natural-roll-cards.test.mjs
import { describe, it, expect, vi } from 'vitest';

// Reuse this suite's own existing installFoundryStubs()/installCriticalDeckStubs()/
// makeAttackerCombatant()/makeTargetCombatant()/makeWeaponItem() helpers from
// tests/dungeon-combat-auto-apply-damage.test.mjs -- read that file first and
// either import its helpers (if exported) or copy its exact fixture shapes,
// rather than inventing new ones here. The sketch below assumes
// `rollAndApplyStrikeAtVariant`-level access isn't available (it's
// module-private); drive this through `rollAndApplyStrike` or
// `handleManualStrikeDamage` instead, whichever this suite's own existing
// helpers already wire up to a Strike, matching that file's own test style
// exactly before filling in the real assertions below.

describe('critical/fumble card draw requires a natural 20/1', () => {
  it('does not draw a Hit card for a criticalSuccess reached by a 10+ margin on a non-natural-20 roll', async () => {
    // outcome: 'criticalSuccess', roll.degreeOfSuccess.dieResult: 15 (not 20).
    // expect ChatMessage.calls (the card-draw chat message) to contain no
    // Hit-deck card creation.
  });

  it('still draws a Hit card for a criticalSuccess reached by an actual natural 20', async () => {
    // outcome: 'criticalSuccess', roll.degreeOfSuccess.dieResult: 20.
    // expect the Hit-deck card draw to happen, matching this suite's own
    // existing "draws and applies a Hit card" test's assertions exactly.
  });

  it('does not draw a Fumble card for a criticalFailure reached by a 10+ margin on a non-natural-1 roll', async () => {
    // outcome: 'criticalFailure', roll.degreeOfSuccess.dieResult: 6.
  });

  it('still draws a Fumble card for a criticalFailure reached by an actual natural 1', async () => {
    // outcome: 'criticalFailure', roll.degreeOfSuccess.dieResult: 1.
  });

  it('treats a missing degreeOfSuccess as "not natural", never drawing a card by default', async () => {
    // roll: { total: 7 } -- no degreeOfSuccess field at all.
  });

  it('leaves the success/failure damage-rolling and strike-rider paths completely unaffected', async () => {
    // outcome: 'success' -- confirm damage still applies and no card-draw
    // logic is even reached, matching this suite's own existing
    // non-critical test (if one exists) rather than inventing a new
    // assertion shape here.
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-natural-roll-cards.test.mjs tests/dungeon-combat-auto-apply-damage.test.mjs`
Expected: FAIL — the new tests fail since no gate exists yet; the updated existing fixtures from Step 1 also fail until Step 4's own implementation lands (both failure sets converge once Step 4 is done).

- [x] **Step 4: Implement the shared helper and gate both call sites in `scripts/dungeon-combat.mjs`**

Add near `drawCriticalCardForStrike`:

```js
/** #976: the owner's own explicit, recorded deviation from the Critical
 * Hit/Fumble Deck's usual "any critical hit/fumble" guidance — cards
 * only draw on an actual natural 20/1, not merely a 10+ margin. Reads
 * the real natural-die-face field PF2e's own CheckRoll#degreeOfSuccess
 * getter exposes (confirmed live by reading the DegreeOfSuccess class
 * directly: `dieResult` is set from the roll's own d20 term and
 * survives chat-message storage as plain data). Missing/unreadable data
 * is treated as "not natural" — never defaults to drawing a card. */
function lastRollWasNatural(face) {
  return game.messages.contents.at(-1)?.rolls?.[0]?.degreeOfSuccess?.dieResult === face;
}
```

Update `drawCriticalCardForStrike`:

```js
async function drawCriticalCardForStrike(
  outcome,
  strike,
  soundContext,
  combatant,
  target,
) {
  if (outcome === "criticalSuccess" && lastRollWasNatural(20)) {
    return drawHitCardMultiplier(hitDeckCategory(soundContext.damageType), {
      combatant,
      target,
      damageType: soundContext.damageType,
    });
  } else if (outcome === "criticalFailure" && lastRollWasNatural(1)) {
    await drawAndApplyCriticalCard(
      "fumble",
      fumbleDeckCategory({
        isRanged: soundContext.isRanged,
        isUnarmed: strike.item?.system?.category === "unarmed",
      }),
      { combatant, target, strike },
    );
  }
  return 1;
}
```

(Only the two `if`/`else if` conditions gain the `&& lastRollWasNatural(...)` clause — everything else in this function, including its existing comment block above it, is unchanged.)

Update the spell-attack critical/fumble block inside `castAttackSpellAndApplyRoll` (the function starting ~line 4775):

```js
    if (outcome === "criticalSuccess" && lastRollWasNatural(20)) {
      const damageType = Object.values(spell.system.damage ?? {})[0]?.type;
      damageMultiplier = await drawHitCardMultiplier("Bomb or Spell", {
        combatant,
        target,
        damageType,
      });
    } else if (outcome === "criticalFailure" && lastRollWasNatural(1)) {
      await drawAndApplyCriticalCard("fumble", "Spell", { combatant, target });
    }
```

(Only the two condition lines change; the surrounding comment and the `damageMultiplier`/`rollDamage` logic below are unchanged.)

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-natural-roll-cards.test.mjs tests/dungeon-combat-auto-apply-damage.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — in particular, check `tests/dungeon-critical-deck.test.mjs` and any other existing test that exercises a Strike's criticalSuccess/criticalFailure path end to end (search `grep -rl "criticalSuccess\|criticalFailure" tests/*.mjs` for anything not already touched by Step 1) and add the same `degreeOfSuccess.dieResult` fixture field to each one found, rather than leaving any pre-existing test silently broken by this change.

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-auto-apply-damage.test.mjs tests/dungeon-combat-natural-roll-cards.test.mjs
git commit -m "fix(#976): only draw critical/fumble cards on an actual natural 20/1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Version bump

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
git commit -m "chore(#976): bump version for natural-roll-only critical cards

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (against the approved bounded design, no separate spec file):** both halves of the approved design are implemented exactly — the shared `lastRollWasNatural` helper, and both call sites (`drawCriticalCardForStrike` covering all three Strike paths, and the separately-checked spell-attack block) gated on it.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 1's own test file (Step 2) deliberately defers its exact fixture-wiring mechanics to whichever existing helper `tests/dungeon-combat-auto-apply-damage.test.mjs` already provides, named explicitly rather than invented — the same deliberate, flagged exception every prior plan in this session's sequence uses. Step 1's own instruction to update existing fixtures is explicit about *why* those tests will fail without the update (the correct new behavior, not a bug to route around).

**3. Type consistency:** `lastRollWasNatural(face)`'s single `number` parameter and `boolean` return are used identically at all four call sites it gates (two in `drawCriticalCardForStrike`, two in the spell-attack block).

**4. Review Focus:** all five items have a direct test — the margin-only criticalSuccess/criticalFailure cases being suppressed (Step 2's first and third tests), the genuine natural-20/1 cases still working (Step 2's second and fourth tests), missing/unreadable `degreeOfSuccess` defaulting to "not natural" (Step 2's fifth test), and the non-critical `success`/`failure` path being entirely unaffected (Step 2's sixth test).
