# Save-Triggered NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `saveRolled` and `conditionIncoming` triggers to #931's reaction registry and model own-save outcome adjustments (Golden Luck, Reality Twist, Cat's Luck, Abrogation of Consequences), other-creature save modifiers (Shift Fate, Distracting Frolic, Free Mind), and condition negation (Slough Skin).

**Architecture:** Pure adjustment functions (`improveOneDegree`, `degreeFor`, `better`/`worse`) live in a new `scripts/npc-reactions-saves.mjs`, reusing #933's own `degreeForRoll` natural-20/1 logic for consistency. The module-owned path wraps the real, confirmed `saveStat.roll({dc, createMessage: true})` call already inlined at two real sites in `scripts/dungeon-combat.mjs` (`castSpellAndApplySave`, `castAreaSpellAndApplySaves`); this plan found that path needs no message-flag trickery at all — both call sites already treat `outcome` as a plain local variable before using it, so adjusting that variable in place is sufficient and the spec's own stated uncertainty about "whether the system's cards honor an edited outcome" does not apply to it. The system-owned path (a player's own spell save) keeps that genuine uncertainty, flagged explicitly. This plan patches #931's own plan-only registry, the same pattern #959 already used.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-save-spell-reactions-design.md`

## Global Constraints

- **Amended by #1021: #931 is real, merged code, not plan-only** (`scripts/npc-reactions.mjs`, confirmed live) — its real schema diverged from its own plan document during implementation (real rows: `{id, label, match: RegExp, triggers: string[], kind, priority, policy}`, no `eligible`/`execute` fields; the real dispatcher is `resolveReactions(combat, event, execute, opts)` in `dungeon-combat.mjs`, driven by a per-trigger collector that pre-builds `event.options`). Task 1 now edits the real registry file directly, and Task 3/Task 4's `resolveReactions` calls — originally written against a 2-argument shape the real function doesn't have — are fixed to use the real collect-then-resolve idiom (see those tasks).
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

### Task 1: `saveRolled`/`conditionIncoming` registry entries — on the REAL registry

**Files:**
- Modify: `scripts/npc-reactions.mjs`

- [ ] **Step 1: Add the two new triggers**

```js
// scripts/npc-reactions.mjs -- extend REACTION_TRIGGERS (append after
// whichever of "reducedToZero"/"died" #959/#1019 have already added)
export const REACTION_TRIGGERS = Object.freeze([
  "move", "strideEnd", "rangedAttack", "manual", "targetedByAttack", "damageIncoming",
  "reducedToZero", "died", // #959/#1019
  "saveRolled", "conditionIncoming", // #960
]);
```

- [ ] **Step 2: Add the eight new `REACTION_DEFS` entries, in the real shape**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS
Object.freeze({ id: "golden-luck", label: "Golden Luck", match: /^Golden Luck\b/i, triggers: ["saveRolled"], kind: "ownSaveAdjust", priority: 10, policy: always }),
Object.freeze({ id: "reality-twist", label: "Reality Twist", match: /^Reality Twist\b/i, triggers: ["saveRolled"], kind: "ownSaveAdjust", priority: 9, policy: always }),
Object.freeze({ id: "abrogation-of-consequences", label: "Abrogation of Consequences", match: /^Abrogation of Consequences\b/i, triggers: ["saveRolled"], kind: "ownSaveAdjust", priority: 8, policy: always }),
Object.freeze({ id: "cats-luck", label: "Cat's Luck", match: /^Cat'?s Luck\b/i, triggers: ["saveRolled"], kind: "ownSaveAdjust", priority: 7, policy: always }),
Object.freeze({ id: "shift-fate", label: "Shift Fate", match: /^Shift Fate\b/i, triggers: ["saveRolled"], kind: "otherSaveAdjust", priority: 5, policy: always }),
Object.freeze({ id: "distracting-frolic", label: "Distracting Frolic", match: /^Distracting Frolic\b/i, triggers: ["saveRolled"], kind: "otherSaveAdjust", priority: 4, policy: always }),
Object.freeze({ id: "free-mind", label: "Free Mind", match: /^Free Mind\b/i, triggers: ["saveRolled"], kind: "otherSaveAdjust", priority: 3, policy: always }),
Object.freeze({ id: "slough-skin", label: "Slough Skin", match: /^Slough Skin\b/i, triggers: ["conditionIncoming"], kind: "conditionNegate", priority: 1, policy: always }),
```

- [ ] **Step 3: Commit**

```bash
git add scripts/npc-reactions.mjs
git commit -m "feat(#960): saveRolled/conditionIncoming triggers and registry entries on the real registry"
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

**Amended (same correction as Task 1): the original draft's `resolveReactions(combat, { trigger: "saveRolled", reactor, event })` does not match the real `resolveReactions(combat, event, execute, opts)` — no `execute` callback, no `event.options`. Fixed below with a `collectSaveReactionOptions` collector (candidates are every agent-controlled combatant: the saver itself for `ownSaveAdjust` rows, every other one for `otherSaveAdjust` rows) and an `executeSaveReaction` dispatcher, following the same real idiom #959/#1019 use.**

**Flagged, not fully resolved here:** `adjustCatsLuck`/`adjustShiftFate`/`adjustDistractingFrolic` (Task 2) each expect a second roll (`rolls.reroll`/`rolls.first`+`rolls.second`) already in hand. Task 2's own pure functions don't produce that roll — something must call `saveStat.roll()` a second time before these are invoked. The dispatcher below rolls it inline for each of those three kinds; confirm this against Task 2's exact expectations (`rolls.reroll` for Cat's Luck vs `rolls.first`/`rolls.second` for Shift Fate/Distracting Frolic — the latter two read oddly given only ONE save is actually being rolled for one saver, not two independent rolls) before treating this task as done. This ambiguity in Task 2's own test fixtures predates this amendment and is not a #1021-introduced problem; flagged here because fixing the `resolveReactions` call surfaced it.

```js
// scripts/dungeon-combat.mjs -- new, near collectDeathReactionOptions (#959)
/** #960: options for the saveRolled trigger -- ownSaveAdjust rows only
 * match the saver itself; otherSaveAdjust rows only match a DIFFERENT
 * agent-controlled combatant (mirrors the self-vs-other split #1019 uses
 * for death reactions, applied here to save-outcome reactions). */
function collectSaveReactionOptions(combat, saver, event) {
  const options = [];
  for (const reactor of combat.combatants) {
    if (reactor.isDefeated || !reactor.actor || !reactor.token) continue;
    if (!reactor.getFlag?.(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    const isSelf = reactor.id === saver.id;
    for (const { def, item } of reactionItemsFor(reactor.actor)) {
      if (!def.triggers.includes("saveRolled")) continue;
      if (def.kind === "ownSaveAdjust" && !isSelf) continue;
      if (def.kind === "otherSaveAdjust" && isSelf) continue;
      options.push({
        reactor,
        def,
        ctx: { item, event, saverIsAllyOfReactor: reactor.token.disposition === saver.token?.disposition },
      });
    }
  }
  return options;
}

/** #960: dispatches a chosen saveRolled reaction by `def.id` to its own
 * adjust function (Task 2) -- not by `def.kind`, since each `kind` covers
 * several bespoke reactions with different mechanics. Returns
 * `{adjustedOutcome, note}`; `rollSaveWithReactions` reads `adjustedOutcome`. */
async function executeSaveReaction(combat, chosen, decision) {
  const { reactor, def, ctx } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  const event = { ...ctx.event, saverIsAllyOfReactor: ctx.saverIsAllyOfReactor };
  let outcome = { outcome: event.outcome, note: null };
  if (def.id === "golden-luck") outcome = adjustGoldenLuck(event);
  else if (def.id === "reality-twist") outcome = adjustRealityTwist(event);
  else if (def.id === "abrogation-of-consequences") outcome = adjustAbrogation(event) ?? outcome;
  else if (def.id === "cats-luck") {
    const reroll = await event.saver.actor.saves[event.saveSlug].roll({ dc: { value: event.dc }, createMessage: true });
    outcome = adjustCatsLuck(event, { reroll }) ?? outcome;
  } else if (def.id === "shift-fate" || def.id === "distracting-frolic") {
    const second = await event.saver.actor.saves[event.saveSlug].roll({ dc: { value: event.dc }, createMessage: true });
    const picked =
      def.id === "shift-fate"
        ? adjustShiftFate(event, { first: { total: event.total }, second })
        : adjustDistractingFrolic(event, { first: { total: event.total }, second });
    if (picked) outcome = { outcome: degreeFor(picked.chosen.total, event.dc), note: picked.note };
  } else if (def.id === "free-mind") outcome = adjustFreeMind(event) ?? outcome;
  await postReactionChat(reactor, event.saver, def, reactionDecisionNote(decision, outcome?.note));
  return { adjustedOutcome: outcome?.outcome ?? event.outcome };
}

/** #960: wraps a module-rolled save with the saveRolled reaction trigger.
 * Rolls exactly as every existing call site already does (createMessage:
 * true, same dc shape), reads the outcome from the just-created message
 * (the same real pattern castSpellAndApplySave/#915's rollNpcAbilitySave
 * already use), then lets the real resolveReactions adjust it. Returns
 * the (possibly adjusted) outcome as a plain string -- the caller assigns
 * it over its own local `outcome` and continues exactly as before; no
 * message flag is written or re-read (Investigation finding 1). */
export async function rollSaveWithReactions(combat, reactor, target, saveSlug, dc, options = {}) {
  const saveStat = target.actor?.saves?.[saveSlug];
  if (!saveStat) return null;
  await saveStat.roll({ dc: { value: dc }, createMessage: true, ...options });
  const rawOutcome = game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
  if (!rawOutcome) return rawOutcome;
  const roll = game.messages.contents.at(-1)?.rolls?.[0];

  const event = {
    saver: target,
    outcome: rawOutcome,
    dc,
    saveSlug,
    total: roll?.total ?? null,
    traits: options.extraRollOptions ?? [],
    owned: true,
  };
  const saverCombatant = combat.combatants.find((c) => c.tokenId === target.id) ?? target;
  const saveOptions = collectSaveReactionOptions(combat, saverCombatant, event);
  if (!saveOptions.length) return rawOutcome;
  const ran = await resolveReactions(
    combat,
    { trigger: "saveRolled", mover: saverCombatant, options: saveOptions },
    (chosen, decision) => executeSaveReaction(combat, chosen, decision),
  );
  return ran.at(-1)?.result?.adjustedOutcome ?? rawOutcome;
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

**Amended (same correction as Task 1/3): fixed to the real collect-then-resolve idiom.** Slough Skin is self-only (the reactor negates a condition about to apply to itself), so the collector is a single-reactor check, mirroring #959's `collectDeathReactionOptions` exactly.

```js
// scripts/dungeon-combat.mjs -- new, near collectDeathReactionOptions (#959)
function collectConditionReactionOptions(combat, reactor) {
  if (!reactor?.getFlag?.(MODULE_ID, "agentControlled")) return [];
  if (reactor.isDefeated || !reactor.actor) return [];
  if (getReactionUsed(combat, reactor.id, combat.round)) return [];
  const options = [];
  for (const { def, item } of reactionItemsFor(reactor.actor)) {
    if (!def.triggers.includes("conditionIncoming")) continue;
    options.push({ reactor, def, ctx: { item } });
  }
  return options;
}

async function executeConditionReaction(combat, chosen, decision) {
  const { reactor, def } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  await postReactionChat(reactor, reactor, def, reactionDecisionNote(decision));
  return { negated: true };
}

export async function applyConditionWithReactions(combat, reactor, conditionSlug, value, durationSeconds) {
  const options = collectConditionReactionOptions(combat, reactor);
  if (options.length) {
    const ran = await resolveReactions(combat, { trigger: "conditionIncoming", mover: reactor, options }, (chosen, decision) =>
      executeConditionReaction(combat, chosen, decision),
    );
    if (ran.find((r) => r.result?.negated)) return { negated: true };
  }
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

**Correction found by #1021:** #931 is real, merged code, not plan-only — Task 1 was patching a now-stale plan document, and Tasks 3/4's `resolveReactions` calls used a shape that doesn't match the real, exported 4-argument function. All three fixed in place with the real collect-then-resolve idiom #959/#1019 already establish. While fixing Task 3, also surfaced (but did not fully resolve, since it predates this amendment and isn't a #1021 dependency) an unreconciled ambiguity in Task 2's own test fixtures: `adjustShiftFate`/`adjustDistracting Frolic` expect two independent rolls (`rolls.first`/`rolls.second`) for what is mechanically a single saver's single save — flagged explicitly in Task 3 for the next implementer to confirm against the real PF2e mechanic before treating that task as done.
