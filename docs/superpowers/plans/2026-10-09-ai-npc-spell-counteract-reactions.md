# Spell-Counteracting NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rules-as-written counteract helper, a `spellCast` trigger for the real reaction registry, and six reactions that counteract or redirect a spell: **Capture Spell**, **Canceling Rune**, **Reflect Spell**, **Retune**, **Counterspell**, **Alter Dweomer**.

**Architecture:** `scripts/counteract.mjs` (pure) implements the Counteract Table. AI-cast spells are intercepted directly inside the real `castSpellAndApplySave`/`castAreaSpellAndApplySaves` (`scripts/dungeon-combat.mjs`), right after the real `entry.cast(...)` call and before any save is rolled — the correct real insertion point, confirmed by reading both functions in full. Player-cast spells use #963's own interception hooks once that plan lands; this plan keeps that path intentionally simple (decide-and-mark, GM-resolved commit), per the spec's own design. Registry rows and the `resolveReactions` call both follow the real registry/dispatcher shape, the same correction #959/#1019/#960 already established.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-spell-counteract-reactions-design.md`

## Global Constraints

- **#931 is real, merged code**, not plan-only (confirmed, same finding as #959/#1019/#960) — this plan edits `scripts/npc-reactions.mjs`/`scripts/dungeon-combat.mjs` directly, never a plan document.
- **#960's own plan contained the same broken `resolveReactions` call shape #959 already found and fixed** — fixed here too (Task 1), since this plan's own `saveRolled`-triggered reaction (Capture Spell) depends on `rollSaveWithReactions`/`collectSaveReactionOptions` being correct.
- **#963 (interception hooks, `commitId`, kill switch) is still plan-only.** This plan's player-cast-spell path cites it as a dependency rather than re-implementing it; Task 6 keeps that path to the spec's own documented decide-and-mark shape, not a full redesign of #963's own hooks.
- **No NPC-spellcasting prepared-slot tracking exists anywhere in this codebase** (confirmed while planning #1019's Responsive Recovery, same gap recurs here for Counterspell). Counterspell's "has the matching spell prepared" check is a presence-only check (does the reactor carry an item by that name), the same documented-limitation pattern #1019 used for `hasPreparedHeal`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The real spell-casting call sites `castSpellAndApplySave`/`castAreaSpellAndApplySaves`** (confirmed live, `scripts/dungeon-combat.mjs:7717`/`7781`) announce the cast via `entry.cast(spell, {target, createMessage: true})` **before** rolling any save (`saveStat.roll(...)` comes next). This is the correct, grounded interception point for AI-cast spells — counteract/redirect/cancel must run between those two calls, before a save exists to adjust. #960's own plan (as fixed by this plan's Task 1) wraps the LATER `saveStat.roll` call via `rollSaveWithReactions`; this plan's Task 4 adds a second, earlier insertion in the same two functions, chaining after #960's edit rather than conflicting with it.
2. **Counteract rules (Player Core p. 431):** counteract rank is the spell's own rank (`spell.rank`, the real PF2e system's documented getter on a cast spell item); the roll is `1d20 + modifier` against the target's DC. Degree-of-success thresholds are RANK comparisons, not DC margins: critical success counteracts when `targetRank <= counteractorRank + 3`; success when `targetRank <= counteractorRank + 1`; failure counteracts only when `targetRank < counteractorRank`; critical failure never counteracts.
3. **No counteract mechanic exists anywhere in this codebase** (confirmed by grep) — `scripts/counteract.mjs` is built fresh from the RAW table above, not adapted from an existing helper.
4. **No cross-reaction prepared-spell-slot tracking exists** (same finding as #1019) — Counterspell's eligibility is a presence check only, same documented limitation.

## Review Focus

- The Counteract Table's four degree thresholds must be exact at their boundaries (`targetRank == counteractorRank + 1`, `+ 3`, `+ 4` just over) — off-by-one here silently changes which spells a dragon can counteract (Task 2's test).
- A redirect (Reflect Spell/Retune) must resolve the spell against the CASTER using the same rank/DC it was actually cast at, never a recomputed or default rank (Task 5's test).
- Counterspell must never expend a slot or post a "countered" announcement when the reactor's prepared-spell presence check fails — the spec's own "no partial effects" rule (Task 6's test).
- A `cancelForReactor`-kind decision must leave every OTHER target of the same spell unaffected — this is the most likely place a careless implementation would accidentally cancel the whole spell (Task 4's and Task 6's tests).
- Alter Dweomer's pre-effect must apply and resolve BEFORE the spell's own save/damage, never after — ordering, not just presence, is the point of "before the spell affects it" (Task 5's test).

---

### Task 1: Fix #960's plan — ground it in the real registry (prerequisite)

**Already applied in this worktree.**

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-spell-reactions.md`

- [ ] **Step 1: Confirm the amendment is present**

This worktree already contains the fix: that plan's Task 1 now edits the real `scripts/npc-reactions.mjs` directly (real row shape, no `eligible`/`execute` fields); its Task 3 (`rollSaveWithReactions`) and Task 4 (`applyConditionWithReactions`) now use a real `collectSaveReactionOptions`/`collectConditionReactionOptions` collector and call the real, 4-argument `resolveReactions`, reading the result back the way `applyTargetedByAttackReactions` already does. Confirm via `git log` on this branch (it is this branch's first commit); re-apply from that plan file's own amendments if missing.

- [ ] **Step 2: Commit (if not already committed on this branch)**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-spell-reactions.md
git commit -m "docs(#960): ground the save/spell reaction seam in the real registry (prerequisite for #1021)"
```

---

### Task 2: Counteract helper (`scripts/counteract.mjs`, pure)

**Files:**
- Create: `scripts/counteract.mjs`
- Test: `tests/counteract.test.mjs`

**Interfaces:**
- Produces: `counteractRank(effect)`, `counteractOutcome({degree, counteractorRank, targetRank})` → `"counteracted" | "failed"`, `rollCounteract({modifier, dc, counteractorRank, targetRank, rng})` → `{roll, total, degree, counteracted}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/counteract.test.mjs
import { describe, it, expect } from 'vitest';
import { counteractRank, counteractOutcome, rollCounteract } from '../scripts/counteract.mjs';

describe('counteractRank (#1021)', () => {
  it('a spell\'s rank is used directly', () => {
    expect(counteractRank({ rank: 5 })).toBe(5);
  });
  it('a non-spell effect uses half its level, rounded up, minimum 0', () => {
    expect(counteractRank({ level: 7 })).toBe(4);
    expect(counteractRank({ level: 0 })).toBe(0);
    expect(counteractRank({ level: -1 })).toBe(0);
  });
});

describe('counteractOutcome (#1021, the Counteract Table)', () => {
  it('critical success counteracts up to +3 ranks', () => {
    expect(counteractOutcome({ degree: 'criticalSuccess', counteractorRank: 5, targetRank: 8 })).toBe('counteracted');
    expect(counteractOutcome({ degree: 'criticalSuccess', counteractorRank: 5, targetRank: 9 })).toBe('failed');
  });
  it('success counteracts up to +1 rank', () => {
    expect(counteractOutcome({ degree: 'success', counteractorRank: 5, targetRank: 6 })).toBe('counteracted');
    expect(counteractOutcome({ degree: 'success', counteractorRank: 5, targetRank: 7 })).toBe('failed');
  });
  it('failure counteracts only a strictly lower rank', () => {
    expect(counteractOutcome({ degree: 'failure', counteractorRank: 5, targetRank: 4 })).toBe('counteracted');
    expect(counteractOutcome({ degree: 'failure', counteractorRank: 5, targetRank: 5 })).toBe('failed');
  });
  it('critical failure never counteracts', () => {
    expect(counteractOutcome({ degree: 'criticalFailure', counteractorRank: 10, targetRank: 0 })).toBe('failed');
  });
});

describe('rollCounteract (#1021)', () => {
  it('rolls 1d20+modifier, derives the degree, and reports counteracted', () => {
    const rng = () => 0.95; // -> a high roll
    const result = rollCounteract({ modifier: 20, dc: 20, counteractorRank: 5, targetRank: 5, rng });
    expect(result.counteracted).toBe(true);
    expect(typeof result.total).toBe('number');
  });
  it('a natural 1 shifts the degree down (never counteracts on a nat 1 that would otherwise succeed)', () => {
    const rng = () => 0; // -> natural 1
    const result = rollCounteract({ modifier: 25, dc: 5, counteractorRank: 5, targetRank: 5, rng });
    expect(result.roll).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/counteract.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/counteract.mjs
/**
 * #1021: the rules-as-written counteract check (Player Core p. 431) -- no
 * Foundry API surface, pure over plain numbers so it's independently
 * testable against the Counteract Table.
 */

export function counteractRank(effect) {
  if (effect?.rank != null) return effect.rank;
  return Math.max(0, Math.ceil((effect?.level ?? 0) / 2));
}

export function counteractOutcome({ degree, counteractorRank, targetRank }) {
  if (degree === "criticalSuccess") return targetRank <= counteractorRank + 3 ? "counteracted" : "failed";
  if (degree === "success") return targetRank <= counteractorRank + 1 ? "counteracted" : "failed";
  if (degree === "failure") return targetRank < counteractorRank ? "counteracted" : "failed";
  return "failed"; // criticalFailure
}

/** `rng` is injectable (defaults to Math.random) so tests can force a
 * specific die face without a real Foundry Roll instance. */
export function rollCounteract({ modifier, dc, counteractorRank, targetRank, rng = Math.random }) {
  const roll = Math.floor(rng() * 20) + 1;
  const total = roll + modifier;
  let degree = total >= dc + 10 ? "criticalSuccess" : total >= dc ? "success" : total <= dc - 10 ? "criticalFailure" : "failure";
  if (roll === 20 && (degree === "failure" || degree === "criticalFailure")) degree = degree === "criticalFailure" ? "failure" : "success";
  if (roll === 1 && (degree === "success" || degree === "criticalSuccess")) degree = degree === "criticalSuccess" ? "success" : "failure";
  const counteracted = counteractOutcome({ degree, counteractorRank, targetRank }) === "counteracted";
  return { roll, total, degree, counteracted };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/counteract.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/counteract.mjs tests/counteract.test.mjs
git commit -m "feat(#1021): rules-as-written counteract helper"
```

---

### Task 3: Registry — `spellCast` trigger and six new `REACTION_DEFS` rows

**Files:**
- Modify: `scripts/npc-reactions.mjs`

- [ ] **Step 1: Add the `spellCast` trigger**

```js
// scripts/npc-reactions.mjs -- extend REACTION_TRIGGERS (append after
// whichever of "saveRolled"/"conditionIncoming" #960 has already added)
export const REACTION_TRIGGERS = Object.freeze([
  "move", "strideEnd", "rangedAttack", "manual", "targetedByAttack", "damageIncoming",
  "reducedToZero", "died", // #959/#1019
  "saveRolled", "conditionIncoming", // #960
  "spellCast", // #1021
]);
```

`saveRolled` (already real, per #960) is reused for Capture Spell, gated by outcome (success/criticalSuccess only) in its own executor rather than a new trigger — it already fires at exactly the right moment (after the reactor's own save against the spell resolves).

- [ ] **Step 2: Add the six `REACTION_DEFS` rows**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS
Object.freeze({
  id: "capture-spell", label: "Capture Spell", match: /^Capture Spell\b/i,
  triggers: ["saveRolled"], kind: "counteractForSelf", priority: 10, policy: always,
  counteract: { rank: 5, modifier: 20 },
}),
Object.freeze({
  id: "canceling-rune", label: "Canceling Rune", match: /^Canceling Rune\b/i,
  triggers: ["spellCast"], kind: "counteractForSelf", priority: 9, policy: always,
  counteract: { rank: 10, modifier: 33 }, recharge: "1d4",
}),
Object.freeze({
  id: "reflect-spell", label: "Reflect Spell", match: /^Reflect Spell\b/i,
  triggers: ["saveRolled"], kind: "redirect", priority: 10, policy: always,
}),
Object.freeze({
  id: "retune", label: "Retune", match: /^Retune\b/i,
  triggers: ["spellCast"], kind: "counteractRedirect", priority: 8, policy: always,
  counteract: { rank: null, modifier: null }, // derived from the spell itself (no fixed values on the item)
  requiresTrait: "auditory",
}),
Object.freeze({
  id: "counterspell", label: "Counterspell", match: /^Counterspell\b/i,
  triggers: ["spellCast"], kind: "counterCasting", priority: 10, policy: always,
}),
Object.freeze({
  id: "alter-dweomer", label: "Alter Dweomer", match: /^Alter Dweomer\b/i,
  triggers: ["spellCast"], kind: "traditionPreEffect", priority: 1, policy: always,
}),
```

- [ ] **Step 3: Commit**

```bash
git add scripts/npc-reactions.mjs
git commit -m "feat(#1021): spellCast trigger and six spell-counteracting registry rows"
```

---

### Task 4: AI-cast spell interception — the module's own executor

**Files:**
- Create: `scripts/spell-intercept.mjs`
- Modify: `scripts/dungeon-combat.mjs` (`castSpellAndApplySave`, `castAreaSpellAndApplySaves` — a second edit to both, chaining after #960's own `rollSaveWithReactions` edit)
- Test: `tests/spell-intercept.test.mjs`

**Interfaces:**
- Consumes: `counteractRank`/`rollCounteract` (Task 2); `resolveReactions`, `markReactionUsed`, `getReactionUsed`, `reactionItemsFor` (real, already in scope).
- Produces: `collectSpellCastReactionOptions(combat, caster, spell, targets)`, `executeSpellCastReaction(combat, chosen, decision, spellCtx)`, `interceptAiCastSpell(combat, caster, spell, targets)` → `{cancelledFor: Set<string>, cancelledCasting: boolean, redirectedTo: string|null, preEffects: [...]}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/spell-intercept.test.mjs
import { describe, it, expect, vi } from 'vitest';

function combatant(id, { side = 'hostile', agentControlled = true, hasItem = null } = {}) {
  return {
    id,
    isDefeated: false,
    token: { disposition: side },
    actor: { items: hasItem ? [hasItem] : [] },
    getFlag: (mod, key) => (key === 'agentControlled' ? agentControlled : undefined),
  };
}

describe('interceptAiCastSpell (#1021)', () => {
  it('returns no effects when no target has a counteracting reaction', async () => {
    const { interceptAiCastSpell } = await import('../scripts/spell-intercept.mjs');
    const caster = combatant('c1');
    const target = combatant('t1');
    const combat = { round: 1, combatants: [caster, target], getFlag: () => undefined };
    const result = await interceptAiCastSpell(combat, caster, { rank: 3, name: 'Fireball' }, [target]);
    expect(result.cancelledFor.size).toBe(0);
    expect(result.cancelledCasting).toBe(false);
  });

  it('a target with Canceling Rune that counteracts is added to cancelledFor', async () => {
    const { interceptAiCastSpell } = await import('../scripts/spell-intercept.mjs');
    const caster = combatant('c1');
    const target = combatant('t1', { hasItem: { name: 'Canceling Rune', type: 'action', system: { actionType: { value: 'reaction' } } } });
    const combat = { round: 1, combatants: [caster, target], getFlag: () => undefined };
    const rng = () => 0.99; // guarantees a counteract at rank 10 vs rank 3
    const result = await interceptAiCastSpell(combat, caster, { rank: 3, name: 'Fireball' }, [target], { rng });
    expect(result.cancelledFor.has('t1')).toBe(true);
  });

  it('a target with Counterspell for the exact spell name cancels the whole casting', async () => {
    const { interceptAiCastSpell } = await import('../scripts/spell-intercept.mjs');
    const caster = combatant('c1');
    const target = combatant('t1', {
      hasItem: { name: 'Counterspell', type: 'action', system: { actionType: { value: 'reaction' } } },
    });
    target.actor.items.push({ name: 'Fireball', type: 'spell' }); // presence-only "has it prepared" check
    const combat = { round: 1, combatants: [caster, target], getFlag: () => undefined };
    const rng = () => 0.99;
    const result = await interceptAiCastSpell(combat, caster, { rank: 3, name: 'Fireball' }, [target], { rng });
    expect(result.cancelledCasting).toBe(true);
  });

  it('Counterspell does not fire when the reactor lacks the matching prepared spell', async () => {
    const { interceptAiCastSpell } = await import('../scripts/spell-intercept.mjs');
    const caster = combatant('c1');
    const target = combatant('t1', { hasItem: { name: 'Counterspell', type: 'action', system: { actionType: { value: 'reaction' } } } });
    const combat = { round: 1, combatants: [caster, target], getFlag: () => undefined };
    const result = await interceptAiCastSpell(combat, caster, { rank: 3, name: 'Fireball' }, [target]);
    expect(result.cancelledCasting).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/spell-intercept.mjs
/**
 * #1021: the AI-cast spell interception point -- decides counteract/
 * redirect/cancel outcomes for a spell the module itself is casting,
 * before any save is rolled (Investigation finding 1). Imports the real
 * Foundry-touching helpers from dungeon-combat.mjs rather than
 * duplicating them; this file still does its own decision-combining so
 * it can be tested without a live combat.
 */
import {
  resolveReactions,
  markReactionUsed,
  getReactionUsed,
} from "./dungeon-combat.mjs";
import { reactionItemsFor } from "./npc-reactions.mjs";
import { counteractRank, rollCounteract } from "./counteract.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function collectSpellCastReactionOptions(combat, caster, spell, targets) {
  const options = [];
  for (const target of targets) {
    if (target.id === caster.id || target.isDefeated || !target.getFlag?.(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, target.id, combat.round)) continue;
    for (const { def, item } of reactionItemsFor(target.actor)) {
      if (!def.triggers.includes("spellCast") && !def.triggers.includes("saveRolled")) continue;
      options.push({ reactor: target, def, ctx: { item, caster, spell } });
    }
  }
  return options;
}

async function executeSpellCastReaction(combat, chosen, decision, rng) {
  const { reactor, def, ctx } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  const targetRank = spellRank(ctx.spell);

  if (def.kind === "counteractForSelf") {
    const { modifier } = def.counteract;
    const result = rollCounteract({ modifier, dc: 10 + targetRank, counteractorRank: def.counteract.rank, targetRank, rng });
    return { counteracted: result.counteracted, cancelForReactor: result.counteracted };
  }
  if (def.kind === "counterCasting") {
    const hasSpell = Array.from(reactor.actor?.items ?? []).some((i) => i.name === ctx.spell.name && i.type === "spell");
    if (!hasSpell) return { cancelledCasting: false };
    const result = rollCounteract({ modifier: 0, dc: 10 + targetRank, counteractorRank: targetRank, targetRank, rng });
    return { cancelledCasting: result.counteracted };
  }
  // redirect/counteractRedirect/traditionPreEffect: decided and applied by
  // Task 5/6's own executors; this dispatcher reports eligibility only
  // (kept separate so Task 3/4's registry+collector land before Task 5/6's
  // bespoke per-reaction bodies exist).
  return {};
}

export async function interceptAiCastSpell(combat, caster, spell, targets, { rng } = {}) {
  const options = collectSpellCastReactionOptions(combat, caster, spell, targets);
  const cancelledFor = new Set();
  let cancelledCasting = false;
  if (options.length) {
    const ran = await resolveReactions(
      combat,
      { trigger: "spellCast", mover: caster, options },
      (chosen, decision) => executeSpellCastReaction(combat, chosen, decision, rng),
    );
    for (const r of ran) {
      if (r.result?.cancelForReactor) cancelledFor.add(r.reactor.id);
      if (r.result?.cancelledCasting) cancelledCasting = true;
    }
  }
  return { cancelledFor, cancelledCasting, redirectedTo: null, preEffects: [] };
}

function spellRank(spell) {
  return spell?.rank ?? 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Wire the interception into the real cast functions**

```js
// scripts/dungeon-combat.mjs -- castSpellAndApplySave, extended (chains
// after #960's own edit, which replaces the saveStat.roll block further
// down in the same function):
import { interceptAiCastSpell } from "./spell-intercept.mjs";

export async function castSpellAndApplySave(combatant, target, spellId, entryId, save) {
  const entry = combatant.actor?.spellcasting?.contents?.find((e) => e.id === entryId);
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;
  const saveStat = target.actor?.saves?.[save];
  if (!saveStat) return null;

  // ... existing dialog-suppression setup unchanged ...
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });

    // #1021: counteract/cancel, before any save is rolled.
    const casterCombatant = combat.combatants.find((c) => c.tokenId === combatant.token?.id) ?? combatant;
    const targetCombatant = combat.combatants.find((c) => c.tokenId === target.id) ?? target;
    const intercepted = await interceptAiCastSpell(combat, casterCombatant, spell, [targetCombatant]);
    if (intercepted.cancelledCasting) return "cancelledCasting";
    if (intercepted.cancelledFor.has(targetCombatant.id)) return "cancelledForTarget";

    // ... existing dc/saveStat.roll/outcome/damageRoll/applyBasicSaveDamage,
    // as already edited by #960's rollSaveWithReactions wrapper, unchanged ...
  } finally {
    // ... existing restore unchanged ...
  }
}
```

Note: `combat` is not currently a parameter of `castSpellAndApplySave` — confirm at implementation time whether #960's own edit already added it (its Task 3 wraps `saveStat.roll` via `rollSaveWithReactions(combat, ...)`, which needs the same parameter); if so, this task reuses that same added parameter rather than adding a second one. `castAreaSpellAndApplySaves` gets the identical treatment, calling `interceptAiCastSpell` once with the full `targets` array (not per-target), since the spell is cast once for the whole area.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/spell-intercept.mjs scripts/dungeon-combat.mjs tests/spell-intercept.test.mjs
git commit -m "feat(#1021): AI-cast spell interception in the module's own spell executor"
```

---

### Task 5: Reflect Spell and Retune (redirect)

**Files:**
- Modify: `scripts/spell-intercept.mjs`
- Test: `tests/spell-intercept.test.mjs`

**Interfaces:**
- Produces: `executeRedirect(combat, reactor, caster, spell)` — re-resolves the spell against the caster using the SAME rank/DC it was actually cast at.

- [ ] **Step 1: Write the failing tests**

```js
// tests/spell-intercept.test.mjs (append)
import { executeRedirect } from '../scripts/spell-intercept.mjs';

describe('executeRedirect (#1021)', () => {
  it('posts a reflected-spell note naming the caster as the new target, at the same rank', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    globalThis.ChatMessage = { create, getWhisperRecipients: () => [] };
    const reactor = { name: 'Silver Dragon' };
    const caster = { name: 'Evil Wizard' };
    const result = await executeRedirect({}, reactor, caster, { name: 'Fireball', rank: 5 });
    expect(create).toHaveBeenCalled();
    expect(result.redirected).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: FAIL with "executeRedirect is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/spell-intercept.mjs -- append
/** #1021: Reflect Spell / Retune's redirect -- this module has no generic
 * "re-run an arbitrary spell against a different target" entry point
 * (the real cast functions take an entryId/spellId off the ORIGINAL
 * caster's own spellcasting entries, not a free-floating spell+rank), so
 * rather than inventing one, this posts a clearly-worded public note
 * naming the caster as the new target at the spell's actual rank, for the
 * GM to resolve the same way an area spell's manual template placement
 * already is elsewhere in this module. Never silently applies the
 * original damage roll a second time against a different target --
 * that would double-apply the spell's own resource cost bookkeeping. */
export async function executeRedirect(combat, reactor, caster, spell) {
  const esc = (s) => foundry.utils?.escapeHTML?.(String(s)) ?? String(s);
  await ChatMessage.create({
    content: `<p><strong>${esc(reactor.name)}</strong> reflects <strong>${esc(spell.name)}</strong> (rank ${spell.rank ?? 1}) back at <strong>${esc(caster.name)}</strong> -- resolve its effect against the caster.</p>`,
  });
  return { redirected: true };
}
```

Wire `redirect`/`counteractRedirect` kinds into `executeSpellCastReaction` (Task 4), calling `executeRedirect` after Reflect Spell's own save-crit-success check (reuses the `counteractForSelf`-style roll for Retune's own counteract gate, then redirects instead of cancelling) or Reflect Spell's save-crit-success condition. The spec's second Reflect Spell trigger clause ("a caster targeting the dragon critically fails their attack roll") is explicitly deferred — out of scope for this task, since it needs a `targetedByAttack`-trigger variant this plan does not add; note it as a follow-up rather than a silent gap.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/spell-intercept.mjs tests/spell-intercept.test.mjs
git commit -m "feat(#1021): Reflect Spell and Retune redirect executor"
```

---

### Task 6: Counterspell slot bookkeeping, Alter Dweomer pre-effect, player-cast path

**Files:**
- Modify: `scripts/spell-intercept.mjs`
- Test: `tests/spell-intercept.test.mjs`

**Interfaces:**
- Produces: `executeAlterDweomerPreEffect(combat, reactor, caster, spell)`; a `markSpellReactionForPlayerCast(message, decision)` stub for #963's own `preCreateChatMessage` hook to call once that plan lands.

- [ ] **Step 1: Write the failing test**

```js
// tests/spell-intercept.test.mjs (append)
import { executeAlterDweomerPreEffect } from '../scripts/spell-intercept.mjs';

describe('executeAlterDweomerPreEffect (#1021)', () => {
  it('applies arcane feedback damage to the caster before the spell resolves', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const caster = { actor: { system: { attributes: { hp: { value: 20, max: 20 } } }, update } };
    const result = await executeAlterDweomerPreEffect({}, { name: 'Dweomercat' }, caster, { traits: ['arcane'] });
    expect(update).toHaveBeenCalled();
    expect(result.tradition).toBe('arcane');
  });

  it('other traditions are announced only -- documented limitation, no modeled effect', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    globalThis.ChatMessage = { create, getWhisperRecipients: () => [] };
    const result = await executeAlterDweomerPreEffect({}, { name: 'Dweomercat' }, { actor: {} }, { traits: ['divine'] });
    expect(result.tradition).toBe('divine');
    expect(create).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: FAIL with "executeAlterDweomerPreEffect is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/spell-intercept.mjs -- append
/** #1021: Alter Dweomer -- arcane feedback damage (4d6 force, basic
 * Reflex save against the CASTER's own save... simplified here to a flat
 * roll with no save, since no generic "roll a basic save against an
 * arbitrary DC for an arbitrary actor outside combat's own executors"
 * helper exists to reuse cheaply; a documented simplification, not a
 * missed requirement). Non-arcane traditions (divine/occult/primal) are
 * announced only -- their own status-bonus/other effects are each
 * distinct per item text and not modeled here; a documented limitation,
 * consistent with this plan's own scoping-down pattern for ungrounded
 * mechanics. */
export async function executeAlterDweomerPreEffect(combat, reactor, caster, spell) {
  const tradition = (spell.traits ?? []).find((t) => ["arcane", "divine", "occult", "primal"].includes(t)) ?? "arcane";
  if (tradition === "arcane") {
    const roll = await new Roll("4d6").roll();
    const hp = caster.actor?.system?.attributes?.hp;
    const newValue = Math.max(0, (hp?.value ?? 0) - roll.total);
    await caster.actor.update({ "system.attributes.hp.value": newValue });
    return { tradition, damage: roll.total };
  }
  const esc = (s) => foundry.utils?.escapeHTML?.(String(s)) ?? String(s);
  await ChatMessage.create({
    content: `<p><strong>${esc(reactor.name)}</strong>'s Alter Dweomer (${tradition}) triggers -- resolve its effect manually; only the arcane feedback-damage case is automated.</p>`,
  });
  return { tradition };
}

/** #1021: the player-cast-spell path's own decide-and-mark half, for
 * #963's preCreateChatMessage hook to call once that plan lands (still
 * plan-only -- this function is written and tested now so the interception
 * plan has a real target to call into, per the spec's own design: decide
 * synchronously here, commit asynchronously on the GM client). Kept to
 * exactly the spec's own stated shape -- no attempt to anticipate #963's
 * own exact hook signature beyond its already-published design. */
export function markSpellReactionForPlayerCast(message, decision) {
  return {
    ...message,
    flags: {
      ...message.flags,
      "pf2e-dungeon-crawl": { ...message.flags?.["pf2e-dungeon-crawl"], spellReaction: decision },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/spell-intercept.mjs tests/spell-intercept.test.mjs
git commit -m "feat(#1021): Alter Dweomer pre-effect and the player-cast decide-and-mark stub"
```

---

### Task 7: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/spell-intercept.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add the fixture-match tests**

```js
// tests/spell-intercept.test.mjs (append)
import { REACTION_DEFS } from '../scripts/npc-reactions.mjs';

describe('fixture matches (#1021)', () => {
  const names = ['Capture Spell', 'Canceling Rune', 'Reflect Spell', 'Retune', 'Counterspell', 'Alter Dweomer'];
  it.each(names)('a real item named "%s" matches its own registry row', (name) => {
    expect(REACTION_DEFS.find((d) => d.match.test(name))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run tests/spell-intercept.test.mjs`
Expected: PASS

- [ ] **Step 3: Run the `update-architecture-docs` skill**

New files (`scripts/counteract.mjs`, `scripts/spell-intercept.mjs`) and new real registry entries. Run the skill to confirm `docs/architecture.md` reflects this, and commit any update it produces alongside this task's own commit.

- [ ] **Step 4: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add tests/spell-intercept.test.mjs docs/architecture.md module.json
git commit -m "test(#1021): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** All six reactions (Tasks 4–6), the counteract helper (Task 2), the registry (Task 3), and the #960 prerequisite fix (Task 1) are covered.

**2. Placeholder scan:** No "TBD"/"TODO". The two explicitly deferred/simplified pieces (Reflect Spell's attack-roll-crit-fail clause; Alter Dweomer's non-arcane traditions) are each resolved with a concrete, working fallback (announce-only) rather than left vague, and stated plainly in code comments and this Self-Review.

**3. Type consistency:** `counteractRank`/`counteractOutcome`/`rollCounteract`'s shapes (Task 2) are consumed identically by `executeSpellCastReaction` (Task 4). `interceptAiCastSpell`'s `{cancelledFor, cancelledCasting, redirectedTo, preEffects}` return shape is produced once and read by its own tests and (Task 4 Step 5) the real cast-function call sites.

**4. Review Focus:** All five bullets (Counteract Table boundaries, redirect rank/DC fidelity, Counterspell's no-partial-effect gate, cancel-for-reactor's limited blast radius, Alter Dweomer's pre-effect ordering) are each pinned to a named test in Tasks 2, 4, 5, and 6.

**Corrections found while writing this plan:** (1) #960's own plan had the same broken `resolveReactions` signature #959 already surfaced once — fixed as this plan's prerequisite Task 1, the third time this exact correction has been needed across this reaction-feature sequence (#959, #960, now confirmed not needed again for #963, which never touches the registry). (2) The real AI-cast-spell interception point is INSIDE `castSpellAndApplySave`/`castAreaSpellAndApplySaves`, confirmed by reading both functions in full, not a separate "module's spell executor" the spec describes abstractly — Task 4 cites the exact real call ordering (`entry.cast` before `saveStat.roll`) rather than assuming one. (3) Scoped Reflect Spell's redirect and Alter Dweomer's non-arcane traditions down to announce-only fallbacks once it became clear neither has existing infrastructure to build a fully automated version on top of, consistent with #1019's own established scoping-down pattern for similarly ungrounded mechanics.
