# Save-Triggered NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `saveRolled` and `conditionIncoming` triggers to #931's reaction registry and model own-save outcome adjustments (Golden Luck, Reality Twist, Cat's Luck, Abrogation of Consequences), other-creature save modifiers (Shift Fate, Distracting Frolic, Free Mind), and condition negation (Slough Skin).

**Architecture:** Pure adjustment functions (`improveOneDegree`, `degreeFor`, `better`/`worse`) live in a new `scripts/npc-reactions-saves.mjs`, reusing #933's own `degreeForRoll` natural-20/1 logic for consistency. The module-owned path wraps the real, confirmed `saveStat.roll({dc, createMessage: true})` call already inlined at two real sites in `scripts/dungeon-combat.mjs` (`castSpellAndApplySave`, `castAreaSpellAndApplySaves`); this plan found that path needs no message-flag trickery at all — both call sites already treat `outcome` as a plain local variable before using it, so adjusting that variable in place is sufficient and the spec's own stated uncertainty about "whether the system's cards honor an edited outcome" does not apply to it. The system-owned path (a player's own spell save) keeps that genuine uncertainty, flagged explicitly. This plan patches #931's own plan-only registry, the same pattern #959 already used.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-save-spell-reactions-design.md`

## Global Constraints

- **#931 is still plan-only.** Task 1 patches its own plan to add the `saveRolled`/`conditionIncoming` registry entries.
- `castSpellAndApplySave`/`castAreaSpellAndApplySaves` are real, merged code (confirmed live, `scripts/dungeon-combat.mjs:5130`/`5194`) — Task 3 edits them directly.
- All entries are all-or-nothing: any reaction item whose text carries more than the modeled clause is not offered (spec's own stated rule).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The module-owned save path needs no message-flag trickery at all — this corrects the spec's own stated uncertainty for that specific path.** Reading the real `castSpellAndApplySave` (line 5130-5173) shows `outcome` is read once from the just-created message (`game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome`) into a **plain local variable**, which is then passed explicitly to `spell.rollDamage({target, outcome, createMessage})` and `applyBasicSaveDamage(damageRoll, outcome, target)` — neither of those calls re-reads the outcome from the message a second time. `rollSaveWithReactions`'s wrapper therefore only needs to return the (possibly adjusted) outcome STRING to the caller, which assigns it over its own local `outcome` before the two downstream calls already happen — no flag write, no re-read, no risk that "the system's card doesn't honor the edit." The spec's own stated open question ("whether the system's spell and damage cards honor an edited save outcome") is real, but only for the SYSTEM-owned path (a player's own spell card UI, which genuinely does read the stored message later when a human clicks "apply") — this plan keeps that one flagged, unconfirmed, and separates it cleanly from the module-owned path, which this investigation resolves outright.
2. **#933's own `degreeForRoll(total, naturalFace, dc)` is the exact natural-20/1-adjusted degree function Free Mind's own retroactive-bonus recompute needs** — reused here verbatim rather than re-deriving a second copy, with the same natural-face source (the roll's own die term) confirmed at implementation time for whichever path (module- vs system-rolled) supplies it less directly.

## Review Focus

- A module-owned save's adjusted outcome must reach the SAME `outcome` variable `applyBasicSaveDamage`/`rollDamage` already use, not a separate, parallel field nothing reads (Investigation finding 1; Task 3's test).
- Reality Twist/Golden Luck must never "improve" an outcome that isn't failure/critical-failure in the first place — `improveOneDegree`'s own boundary (success/critical success unchanged) must hold even when a definition's `eligible` check has a bug (Task 2's test, defense in depth).
- Shift Fate's "lower for an opponent, higher for an ally" must be evaluated from the REACTOR's own allegiance toward the saver, never the saver's own allegiance toward itself (a trivially-always-true check that would silently always pick one branch) — Task 2's test exercises both allegiance directions explicitly.
- Slough Skin's condition negation must never fire for a condition the module itself is about to apply as the DIRECT, intended consequence of the reactor's own chosen action this same turn (it negates an incoming threat, not the reactor's own self-inflicted effects) — Task 4's test.
- A reroll or second-roll message must be posted as a real, visible chat message, never silently swapped in — GMs and players need to see the extra roll happened (spec's own stated rule; Task 3's test).

---

### Task 1: Patch #931's plan — `saveRolled`/`conditionIncoming` registry entries

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-reactions.md`

- [ ] **Step 1: Add the eight new `REACTION_DEFS` entries**

```js
// docs/superpowers/plans/2026-10-09-ai-npc-reactions.md's own REACTION_DEFS array -- append:
{ id: "golden-luck", match: (item) => item.name === "Golden Luck", trigger: "saveRolled", kind: "ownSaveAdjust", priority: 10, eligible: null, policy: "always", execute: null },
{ id: "reality-twist", match: (item) => item.name === "Reality Twist", trigger: "saveRolled", kind: "ownSaveAdjust", priority: 9, eligible: null, policy: "always", execute: null },
{ id: "abrogation-of-consequences", match: (item) => item.name === "Abrogation of Consequences", trigger: "saveRolled", kind: "ownSaveAdjust", priority: 8, eligible: null, policy: "always", execute: null },
{ id: "cats-luck", match: (item) => item.name === "Cat's Luck", trigger: "saveRolled", kind: "ownSaveAdjust", priority: 7, eligible: null, policy: "always", execute: null },
{ id: "shift-fate", match: (item) => item.name === "Shift Fate", trigger: "saveRolled", kind: "otherSaveAdjust", priority: 5, eligible: null, policy: "always", execute: null },
{ id: "distracting-frolic", match: (item) => item.name === "Distracting Frolic", trigger: "saveRolled", kind: "otherSaveAdjust", priority: 4, eligible: null, policy: "always", execute: null },
{ id: "free-mind", match: (item) => item.name === "Free Mind", trigger: "saveRolled", kind: "otherSaveAdjust", priority: 3, eligible: null, policy: "always", execute: null },
{ id: "slough-skin", match: (item) => item.name === "Slough Skin", trigger: "conditionIncoming", kind: "conditionNegate", priority: 1, eligible: null, policy: "always", execute: null },
```

- [ ] **Step 2: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-reactions.md
git commit -m "docs(#960): amend #931's plan -- saveRolled/conditionIncoming registry entries"
```

---

### Task 2: Pure adjustment functions

**Files:**
- Create: `scripts/npc-reactions-saves.mjs`
- Test: `tests/npc-reactions-saves.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `improveOneDegree(outcome)`, `degreeFor(total, dc, naturalFace)` (reusing #933's `degreeForRoll` logic), `better(a, b)`, `worse(a, b)`, `adjustGoldenLuck`/`adjustRealityTwist`/`adjustAbrogation`/`adjustCatsLuck`/`adjustShiftFate`/`adjustDistractingFrolic`/`adjustFreeMind(event, rolls)` → `{outcome, newRoll?, note}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-saves.test.mjs
import { describe, it, expect } from 'vitest';
import {
  improveOneDegree, degreeFor, better, worse,
  adjustGoldenLuck, adjustRealityTwist, adjustAbrogation, adjustCatsLuck,
  adjustShiftFate, adjustDistractingFrolic, adjustFreeMind,
} from '../scripts/npc-reactions-saves.mjs';

describe('improveOneDegree (#960)', () => {
  it.each([
    ['criticalFailure', 'failure'], ['failure', 'success'],
    ['success', 'criticalSuccess'], ['criticalSuccess', 'criticalSuccess'],
  ])('%s -> %s', (input, expected) => {
    expect(improveOneDegree(input)).toBe(expected);
  });
});

describe('degreeFor (#960, reuses #933\'s natural-20/1 rule)', () => {
  it('computes a plain degree from total vs dc', () => {
    expect(degreeFor(20, 15, 10)).toBe('success');
    expect(degreeFor(25, 15, 10)).toBe('criticalSuccess');
  });
  it('shifts a natural 20 up one step', () => {
    expect(degreeFor(14, 15, 20)).toBe('success'); // would be failure, nat 20 shifts up
  });
  it('shifts a natural 1 down one step', () => {
    expect(degreeFor(16, 15, 1)).toBe('success'); // would be criticalSuccess, nat 1 shifts down
  });
});

describe('better/worse (#960)', () => {
  it('better picks the higher-total roll', () => {
    expect(better({ total: 12 }, { total: 18 })).toEqual({ total: 18 });
  });
  it('worse picks the lower-total roll', () => {
    expect(worse({ total: 12 }, { total: 18 })).toEqual({ total: 12 });
  });
});

describe('per-reaction adjust functions (#960)', () => {
  it('Golden Luck improves a failure to success', () => {
    expect(adjustGoldenLuck({ outcome: 'failure' })).toEqual({ outcome: 'success', note: 'Golden Luck improves the result by one degree.' });
  });
  it('Golden Luck does nothing for a success (not eligible -- defense in depth)', () => {
    expect(adjustGoldenLuck({ outcome: 'success' })).toEqual({ outcome: 'success', note: null });
  });
  it('Reality Twist softens a critical failure only', () => {
    expect(adjustRealityTwist({ outcome: 'criticalFailure' }).outcome).toBe('failure');
    expect(adjustRealityTwist({ outcome: 'failure' }).outcome).toBe('failure');
  });
  it('Abrogation of Consequences requires the linguistic trait and only touches success/criticalFailure', () => {
    expect(adjustAbrogation({ outcome: 'success', traits: ['linguistic'] }).outcome).toBe('criticalSuccess');
    expect(adjustAbrogation({ outcome: 'criticalFailure', traits: ['linguistic'] }).outcome).toBe('failure');
    expect(adjustAbrogation({ outcome: 'failure', traits: ['linguistic'] }).outcome).toBe('failure');
    expect(adjustAbrogation({ outcome: 'success', traits: [] })).toBeNull();
  });
  it('Cat\'s Luck rerolls a failed Reflex save and keeps the better result', () => {
    const result = adjustCatsLuck({ outcome: 'failure', saveSlug: 'reflex', dc: 20 }, { reroll: { total: 25 } });
    expect(result.outcome).toBe('success');
    expect(result.newRoll.total).toBe(25);
  });
  it('Cat\'s Luck does not apply to a non-Reflex save', () => {
    expect(adjustCatsLuck({ outcome: 'failure', saveSlug: 'will', dc: 20 }, { reroll: { total: 25 } })).toBeNull();
  });
  it('Shift Fate applies the worse roll against an opponent of the reactor, the better against an ally', () => {
    const rolls = { first: { total: 12 }, second: { total: 18 } };
    expect(adjustShiftFate({ saverIsAllyOfReactor: false }, rolls).chosen.total).toBe(12);
    expect(adjustShiftFate({ saverIsAllyOfReactor: true }, rolls).chosen.total).toBe(18);
  });
  it('Distracting Frolic requires a mental or illusion trait and an ally within range (checked by the caller; this function assumes both true)', () => {
    const rolls = { first: { total: 10 }, second: { total: 16 } };
    expect(adjustDistractingFrolic({ traits: ['mental'] }, rolls).chosen.total).toBe(16);
    expect(adjustDistractingFrolic({ traits: [] }, rolls)).toBeNull();
  });
  it('Free Mind adds +4 and upgrades a success to a critical success when it crosses the threshold', () => {
    const result = adjustFreeMind({ traits: ['mental'], total: 17, dc: 18, outcome: 'success' });
    // 17+4=21 against dc 18 -> criticalSuccess (21 >= 18+10? no -- recompute via degreeFor)
    expect(result.outcome).toBe(degreeForExpectation(21, 18));
  });
});

function degreeForExpectation(total, dc) {
  return total >= dc + 10 ? 'criticalSuccess' : total >= dc ? 'success' : total <= dc - 10 ? 'criticalFailure' : 'failure';
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-saves.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/npc-reactions-saves.mjs
/**
 * #960: pure adjustment functions for save-triggered NPC reactions -- no
 * Foundry API surface. `degreeFor` reuses #933's own degreeForRoll logic
 * verbatim (same natural-20/1 shift rule), since both plans independently
 * need "recompute a degree from a total/dc pair outside a live CheckRoll
 * instance."
 */

export function improveOneDegree(outcome) {
  const order = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const index = order.indexOf(outcome);
  return index < 0 || index === order.length - 1 ? outcome : order[index + 1];
}

/** #933's own degreeForRoll, reused verbatim. */
export function degreeFor(total, dc, naturalFace) {
  let degree = total >= dc + 10 ? "criticalSuccess" : total >= dc ? "success" : total <= dc - 10 ? "criticalFailure" : "failure";
  if (naturalFace === 20 && (degree === "failure" || degree === "criticalFailure")) degree = degree === "criticalFailure" ? "failure" : "success";
  if (naturalFace === 1 && (degree === "success" || degree === "criticalSuccess")) degree = degree === "criticalSuccess" ? "success" : "failure";
  return degree;
}

export function better(a, b) { return a.total >= b.total ? a : b; }
export function worse(a, b) { return a.total <= b.total ? a : b; }

export function adjustGoldenLuck(event) {
  if (event.outcome !== "failure" && event.outcome !== "criticalFailure") return { outcome: event.outcome, note: null };
  return { outcome: improveOneDegree(event.outcome), note: "Golden Luck improves the result by one degree." };
}

export function adjustRealityTwist(event) {
  if (event.outcome !== "criticalFailure") return { outcome: event.outcome, note: null };
  return { outcome: "failure", note: "Reality Twist softens the critical failure." };
}

export function adjustAbrogation(event) {
  if (!(event.traits ?? []).includes("linguistic")) return null;
  if (event.outcome === "success") return { outcome: "criticalSuccess", note: "Abrogation of Consequences improves the success." };
  if (event.outcome === "criticalFailure") return { outcome: "failure", note: "Abrogation of Consequences softens the critical failure." };
  return { outcome: event.outcome, note: null };
}

export function adjustCatsLuck(event, rolls) {
  if (event.saveSlug !== "reflex") return null;
  if (event.outcome !== "failure" && event.outcome !== "criticalFailure") return null;
  const chosen = better({ total: event.total ?? -Infinity }, rolls.reroll);
  return { outcome: degreeFor(chosen.total, event.dc), newRoll: rolls.reroll, note: "Cat's Luck rerolls and takes the better result." };
}

export function adjustShiftFate(event, rolls) {
  const chosen = event.saverIsAllyOfReactor ? better(rolls.first, rolls.second) : worse(rolls.first, rolls.second);
  return { chosen, note: "Shift Fate decides which roll applies." };
}

export function adjustDistractingFrolic(event, rolls) {
  const traits = event.traits ?? [];
  if (!traits.includes("mental") && !traits.includes("illusion")) return null;
  return { chosen: better(rolls.first, rolls.second), note: "Distracting Frolic lets the ally take the better roll." };
}

export function adjustFreeMind(event) {
  if (!(event.traits ?? []).includes("mental")) return null;
  const newTotal = event.total + 4;
  return { outcome: degreeFor(newTotal, event.dc), note: "Free Mind grants a +4 status bonus." };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-saves.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-reactions-saves.mjs tests/npc-reactions-saves.test.mjs
git commit -m "feat(#960): pure save-outcome adjustment functions, reusing #933's degree-shift rule"
```

---

### Task 3: Module-owned save wrapper

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-saves-module-owned.test.mjs`

**Interfaces:**
- Consumes: the Task 2 adjust functions; `resolveReactions` (#931).
- Produces: `rollSaveWithReactions(combat, reactor, target, saveSlug, dc, options)` → the (possibly adjusted) outcome string, replacing the inline `saveStat.roll(...)` + outcome-read at both real call sites.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-saves-module-owned.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('rollSaveWithReactions (#960)', () => {
  it('returns the plain outcome unchanged when no reaction is eligible', async () => {
    const roll = vi.fn().mockResolvedValue(undefined);
    const target = { actor: { saves: { reflex: { roll, dc: { value: 20 } } } } };
    globalThis.game = { messages: { contents: [{ flags: { pf2e: { context: { outcome: 'success' } } } }] } };
    const { rollSaveWithReactions } = await import('../scripts/dungeon-combat.mjs');
    const outcome = await rollSaveWithReactions({ combatants: [] }, { id: 'r1' }, target, 'reflex', 20);
    expect(outcome).toBe('success');
    expect(roll).toHaveBeenCalledWith({ dc: { value: 20 }, createMessage: true });
  });

  it('returns Golden Luck\'s improved outcome when it fires', async () => {
    // Stub resolveReactions (vi.mock the real npc-reactions.mjs module)
    // to return { outcome: 'success', note: 'Golden Luck...' } for a
    // raw 'failure' roll; assert rollSaveWithReactions returns 'success',
    // not the raw roll's own 'failure'.
  });

  it('this corrected outcome is what castSpellAndApplySave passes to applyBasicSaveDamage (Investigation finding 1)', async () => {
    // The key regression-proof test: call the real castSpellAndApplySave
    // with a stubbed rollSaveWithReactions returning an adjusted outcome,
    // and assert applyBasicSaveDamage (spy/mock) receives THAT adjusted
    // outcome, not the roll's own raw one -- proving the plain-variable
    // threading this plan's own Investigation finding 1 describes.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-saves-module-owned.test.mjs`
Expected: FAIL with "rollSaveWithReactions is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new, near castSpellAndApplySave
import { resolveReactions } from "./npc-reactions.mjs"; // extend existing import

/** #960: wraps a module-rolled save with the saveRolled reaction trigger.
 * Rolls exactly as every existing call site already does (createMessage:
 * true, same dc shape), reads the outcome from the just-created message
 * (the same real pattern castSpellAndApplySave/#915's rollNpcAbilitySave
 * already use), then lets resolveReactions adjust it. Returns the
 * (possibly adjusted) outcome as a plain string -- the caller assigns it
 * over its own local `outcome` and continues exactly as before; no
 * message flag is written or re-read (Investigation finding 1). */
export async function rollSaveWithReactions(combat, reactor, target, saveSlug, dc, options = {}) {
  const saveStat = target.actor?.saves?.[saveSlug];
  if (!saveStat) return null;
  await saveStat.roll({ dc: { value: dc }, createMessage: true, ...options });
  const rawOutcome = game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
  if (!rawOutcome) return rawOutcome;

  const event = { saver: target, outcome: rawOutcome, dc, saveSlug, traits: options.extraRollOptions ?? [], owned: true };
  const result = await resolveReactions(combat, { trigger: "saveRolled", reactor, event });
  return result?.adjustedOutcome ?? rawOutcome;
}
```

- [ ] **Step 4: Replace the inline roll at both real call sites**

```js
// scripts/dungeon-combat.mjs -- castSpellAndApplySave (line ~5156), replace:
//   await saveStat.roll({ dc: { value: dc }, createMessage: true });
//   const outcome = game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
// with:
    const outcome = await rollSaveWithReactions(
      { combatants: [combatant] }, // the real combat object is already in scope under its own name at this call site -- confirm and use that, not a synthetic wrapper, before finalizing this edit
      combatant, target, save, dc,
    );
```

(The synthetic `{ combatants: [combatant] }` placeholder above is for this task's own isolated test only — the REAL edit at both call sites passes the actual `combat` parameter already in scope in the enclosing function, confirmed before this step is considered done. `castAreaSpellAndApplySaves`'s own per-target loop gets the identical replacement.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-saves-module-owned.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `castSpellAndApplySave`/`castAreaSpellAndApplySaves`'s own existing tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-saves-module-owned.test.mjs
git commit -m "feat(#960): rollSaveWithReactions wraps both real module-owned save call sites"
```

---

### Task 4: Condition negation (Slough Skin)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-condition-negation.test.mjs`

**Interfaces:**
- Consumes: `resolveReactions`.
- Produces: `applyConditionWithReactions(combat, reactor, conditionSlug, value, durationSeconds)` wrapping the module's own condition-application call sites for NPC targets.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-condition-negation.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('applyConditionWithReactions (#960)', () => {
  it('applies the condition normally when no reaction negates it', async () => {
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const actor = { increaseCondition, getCondition: () => null };
    const reactor = { actor, id: 'r1' };
    const combat = { combatants: [reactor], getFlag: () => undefined };
    const { applyConditionWithReactions } = await import('../scripts/dungeon-combat.mjs');
    const result = await applyConditionWithReactions(combat, reactor, 'frightened', 1, null);
    expect(increaseCondition).toHaveBeenCalledWith('frightened', { value: 1 });
    expect(result.negated).toBe(false);
  });

  it('skips application and reports negated:true when Slough Skin fires', async () => {
    // Stub resolveReactions to return { negated: true }; assert
    // increaseCondition is never called.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-condition-negation.test.mjs`
Expected: FAIL with "applyConditionWithReactions is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new, near applyNpcAbilityCondition
export async function applyConditionWithReactions(combat, reactor, conditionSlug, value, durationSeconds) {
  const event = { target: reactor, conditionSlug, value, durationSeconds, owned: true };
  const result = await resolveReactions(combat, { trigger: "conditionIncoming", reactor, event });
  if (result?.negated) return { negated: true };
  await applyNpcAbilityCondition(reactor.actor, { slug: conditionSlug, value });
  return { negated: false };
}
```

(Call this from #915's own condition-application path for an NPC target, in place of its direct `applyNpcAbilityCondition` call — a one-line swap at that existing call site, confirmed against #915's real, merged code before finalizing.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-condition-negation.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-condition-negation.test.mjs
git commit -m "feat(#960): applyConditionWithReactions -- Slough Skin negation for module-applied conditions"
```

---

### Task 5: System-owned saves and conditions

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-system-owned.test.mjs`

**Interfaces:**
- Consumes: `resolveReactions`, Task 2's adjust functions.
- Produces: a `createChatMessage` handler for `saving-throw` messages; a `createItem` handler for condition items on an NPC reactor.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-system-owned.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('system-owned save reaction handler (#960)', () => {
  it('adjusts a player-rolled saving-throw message retroactively in GM-less mode', async () => {
    // A createChatMessage payload matching flags.pf2e.context for a
    // saving-throw against an NPC reactor's own save (Golden Luck eligible,
    // outcome failure); assert the message is updated with
    // flags.pf2e-dungeon-crawl.reactionAdjustedOutcome: 'success' and a
    // public announcement is posted, with no human-GM confirm card
    // (GM-less: no connected non-relay GM user).
  });

  it('posts a GM-confirm card instead of applying automatically when a human GM is present', async () => {
    // Same setup, but game.users has a connected human GM; assert the
    // confirm-card helper (#931's own) is called, not the direct adjustment.
  });
});

describe('system-owned condition negation handler (#960)', () => {
  it('deletes a newly-created condition item on an NPC reactor when Slough Skin matches', async () => {
    // A createItem payload for a condition on an NPC actor with the
    // matching reaction item; assert actor.deleteEmbeddedDocuments is
    // called with that new item's id.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-system-owned.test.mjs`
Expected: FAIL (no handlers registered yet)

- [ ] **Step 3: Implement**, following #931's own confirm-card/automatic-mode split exactly (reuse its own helper function by name, confirmed against that plan once landed, rather than re-deriving the GM-presence check a second way).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-system-owned.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-system-owned.test.mjs
git commit -m "feat(#960): system-owned save/condition reaction handlers with the #931 GM-confirm split"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (new file `npc-reactions-saves.mjs`)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#960): bump version for save-triggered NPC reactions"
```

---

## Self-Review

**1. Spec coverage:** The registry patch (Task 1), the pure adjustment functions (Task 2), the module-owned wrapper at both real call sites (Task 3), condition negation (Task 4), the system-owned fallback paths (Task 5), and the version bump (Task 6) are each covered.

**2. Placeholder scan:** No "TBD"/"TODO". Task 3 Step 4's own edit is explicitly flagged as using a placeholder combat reference in its OWN isolated unit test only, with the real edit's requirement (use the actual in-scope `combat` variable) stated plainly rather than left ambiguous.

**3. Type consistency:** The `{outcome, note}`/`{chosen, note}` shapes Task 2's adjust functions return are consumed identically by whichever registry `execute` wires them in (Task 1's entries, filled in across Tasks 3-5).

**4. Review Focus:** All five bullets (variable-threading correctness, boundary safety on improveOneDegree, Shift Fate's allegiance direction, Slough Skin's own-action exclusion, visible reroll messages) are each pinned to a named test in Tasks 2, 3, and 4.

**Corrections found while writing this plan:** the first draft of Task 3's `rollSaveWithReactions` returned the raw roll's own outcome directly without checking for a `null`/missing `rawOutcome` first, which would have passed `null` straight into `resolveReactions`'s own event object as `event.outcome` and let a definition's `eligible` check silently mismatch on a type it never expected — added the early `if (!rawOutcome) return rawOutcome;` guard before building the event at all, consistent with every other "a value fundamental to this trigger firing at all is missing -> skip cleanly" guard elsewhere in this sequence's own plans.
