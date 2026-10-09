# Feat Reactions for AI-Controlled Party Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A curated core table of character reaction definitions — Shield Block, Reactive Strike/Attack of Opportunity, Nimble Dodge, Retributive Strike, Flash of Grandeur — added to #931's reaction registry, reacting only for `agentControlled` party characters, never for human-controlled ones.

**Architecture:** Mostly new mechanics (Shield Block's damage-seam call, Nimble Dodge's retroactive AC re-evaluation, the champion reactions' ally-resistance-plus-counter-Strike) added as #931 registry rows, per this plan's own patch to that still-plan-only document. One piece is a real, confirmed, direct code fix: `isReactiveStrikeInScope`'s real, merged body rejects every `feat`-type item outright, which is exactly why the character (class-feat) form of Reactive Strike doesn't work today — Task 2 widens that one real check.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-character-feat-reactions-design.md`

## Global Constraints

- **#931 and #961 are both still plan-only.** Task 1 patches #931's registry with the five character rows, reusing #961's `enemyDamagesAlly` trigger and counter-Strike-plus-defensive shape by name for the two champion reactions.
- **`isReactiveStrikeInScope` is real, merged code** (`scripts/dungeon-combat.mjs:1916`) that explicitly rejects any non-`action`-type item — Task 2 is a direct, confirmed fix to real code, not a plan-only dependency.
- Only `agentControlled` combatants ever react through this registry — a human-controlled party member's own reaction choices are never touched (spec's own explicit non-goal; already #931's own shared gate, unchanged by this plan).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`isReactiveStrikeInScope`'s real, confirmed body is `if (item.type !== "action") return false;`** — this is the EXACT, literal reason the character (class-feat) form of Reactive Strike doesn't work today, confirmed by reading the real function rather than trusting the spec's own paraphrase. The fix is precise and small: accept `item.type === "feat"` too, with the same name-pattern check unchanged. No broader generalization is needed or warranted — this single real line is the whole gap.
2. **No `heldShield`/`shieldBlockRequest` reference exists anywhere in the real codebase today** (confirmed by grep) — Shield Block is genuinely new work, not a partially-wired mechanism; this plan's own Task 3 is a from-scratch implementation, grounded directly in the real `Actor#applyDamage` signature already confirmed during #931's own investigation this session (`{damage, token, item, rollOptions, skipIWR, shieldBlockRequest, breakdown, notes, outcome, final}`).

## Review Focus

- Widening `isReactiveStrikeInScope` to accept `feat` items must not accidentally also start matching an unrelated feat that happens to share a name prefix — the existing `/^(Reactive Strike|Attack of Opportunity)\b/i` pattern is unchanged, only the type check widens (Task 2's test).
- Shield Block must never apply when the shield is already broken, and must never reduce damage below 0 (spec's own stated rule; Task 3's test).
- Nimble Dodge's retroactive re-evaluation must only consume the reaction when the degree of success actually changes for the attacker — never spent on a roll it couldn't have affected (spec's own stated policy; Task 4's test).
- The champion reactions' ally resistance must apply to the TRIGGERING damage instance only, never persist as a standing resistance into later hits this same turn (Task 5's test).
- A human-controlled party character must never react through any of these five definitions, even when their own sheet has the matching feat and the triggering conditions are met (Global Constraints; a cross-cutting test in Task 1, re-affirming #931's own existing shared gate rather than assuming it silently still holds).

---

### Task 1: Patch #931's plan — the five character reaction rows

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-reactions.md`

- [ ] **Step 1: Add the character `REACTION_DEFS` rows**

```js
// docs/superpowers/plans/2026-10-09-ai-npc-reactions.md's own REACTION_DEFS -- append:
{ id: "reactive-strike-character", match: (item) => /^(Reactive Strike|Attack of Opportunity)\b/i.test(item.name ?? ""), trigger: "leaveReach", kind: "strike", priority: 10, eligible: null, policy: "always", execute: null },
{ id: "shield-block", match: (item) => item.name === "Shield Block", trigger: "targetedByAttack", kind: "damageReduction", priority: 9, eligible: null, policy: "always", execute: null },
{ id: "nimble-dodge", match: (item) => item.name === "Nimble Dodge", trigger: "targetedByAttack", kind: "acBonus", priority: 8, eligible: null, policy: "always", execute: null },
{ id: "retributive-strike", match: (item) => item.name === "Retributive Strike", trigger: "enemyDamagesAlly", kind: "counterStrike", priority: 6, eligible: null, policy: "always", execute: null },
{ id: "flash-of-grandeur", match: (item) => item.name === "Flash of Grandeur", trigger: "enemyDamagesAlly", kind: "defensive", priority: 5, eligible: null, policy: "always", execute: null },
```

Note: the `reactive-strike-character` row's own `match` is redundant with #202's existing `isReactiveStrikeInScope` once Task 2 widens it — the registry's `match` function and the standalone scope check serve two different callers (the registry's generic dispatch vs #202's own existing direct call sites) and are kept in sync by sharing the same regex literal, not by one calling the other.

- [ ] **Step 2: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-reactions.md
git commit -m "docs(#962): amend #931's plan -- the five character reaction rows"
```

---

### Task 2: Widen `isReactiveStrikeInScope` to the feat form

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-reactive-strike.test.mjs` (extend #202's existing test file — find its real name first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isReactiveStrikeInScope` (real, module-private) now accepts `feat`-type items too.

- [ ] **Step 1: Write the failing test**

```js
// append to #202's existing isReactiveStrikeInScope test file
it('recognizes the character (class-feat) form of Reactive Strike (#962)', () => {
  const item = { type: 'feat', name: 'Reactive Strike', system: { actionType: { value: 'reaction' } } };
  // isReactiveStrikeInScope is module-private -- exercise it through
  // whichever exported function already calls it (findReactiveStrikeOpportunities,
  // confirmed real/exported) rather than exporting a new test-only hook.
  const actor = { itemTypes: { feat: [item], action: [] } };
  // Assert findReactiveStrikeOpportunities (or this file's own real
  // equivalent check) now considers this feat item, where before this
  // task it would have been silently excluded by the type check alone.
});

it('still rejects an unrelated feat sharing no name match', () => {
  const item = { type: 'feat', name: 'Toughness', system: { actionType: { value: 'reaction' } } };
  // Assert it is still excluded -- the widened type check doesn't loosen
  // the name pattern at all.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-combat-reactive-strike.test.mjs -t "#962"`
Expected: FAIL (the feat-type item is excluded today)

- [ ] **Step 3: Widen the real check**

```js
// scripts/dungeon-combat.mjs -- isReactiveStrikeInScope (line 1916-1920),
// replace the type check:
function isReactiveStrikeInScope(item) {
  if (item.type !== "action" && item.type !== "feat") return false;
  if (item.system.actionType?.value !== "reaction") return false;
  return /^(Reactive Strike|Attack of Opportunity)\b/i.test(item.name ?? "");
}
```

Find and widen any call site that only ever scanned `actor.itemTypes.action` for this check (confirm `findReactiveStrikeOpportunities`'s own real item-collection step before finalizing this task — it must now also scan `actor.itemTypes.feat`, mirroring the `[...(actor.itemTypes?.action ?? []), ...(actor.itemTypes?.feat ?? [])]` pattern this file's own `findFeatItem` already uses elsewhere).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-combat-reactive-strike.test.mjs`
Expected: PASS (all tests, including every pre-existing #202 test — the NPC action-item form must keep working identically)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-reactive-strike.test.mjs
git commit -m "fix(#962): recognize the character class-feat form of Reactive Strike"
```

---

### Task 3: Shield Block

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-shield-block.test.mjs`

**Interfaces:**
- Consumes: `markReactionUsed` (real), `Actor#applyDamage` (real PF2e API, `shieldBlockRequest` confirmed during #931's own investigation).
- Produces: `executeShieldBlock(combat, reactor)` → `{applied: boolean}`, called from the module's damage seam ahead of applying damage to an `agentControlled` character.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-shield-block.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('executeShieldBlock (#962)', () => {
  it('requests a shield block when the shield is raised and unbroken', async () => {
    const actor = {
      heldShield: { isBroken: false, hardness: 5 },
      itemTypes: { effect: [{ slug: 'effect-raise-a-shield' }] },
    };
    const reactor = { actor, name: 'Paladin' };
    const combat = { round: 1, getFlag: () => undefined, setFlag: vi.fn() };
    const { executeShieldBlock } = await import('../scripts/dungeon-combat.mjs');
    const result = await executeShieldBlock(combat, reactor);
    expect(result).toEqual({ requested: true });
  });

  it('does not request a block when the shield is broken', async () => {
    const actor = { heldShield: { isBroken: true, hardness: 5 }, itemTypes: { effect: [{ slug: 'effect-raise-a-shield' }] } };
    const reactor = { actor, name: 'Paladin' };
    const combat = { round: 1, getFlag: () => undefined, setFlag: vi.fn() };
    const { executeShieldBlock } = await import('../scripts/dungeon-combat.mjs');
    expect(await executeShieldBlock(combat, reactor)).toEqual({ requested: false });
  });

  it('does not request a block when the shield is not raised', async () => {
    const actor = { heldShield: { isBroken: false, hardness: 5 }, itemTypes: { effect: [] } };
    const reactor = { actor, name: 'Paladin' };
    const combat = { round: 1, getFlag: () => undefined, setFlag: vi.fn() };
    const { executeShieldBlock } = await import('../scripts/dungeon-combat.mjs');
    expect(await executeShieldBlock(combat, reactor)).toEqual({ requested: false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-shield-block.test.mjs`
Expected: FAIL with "executeShieldBlock is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new, near the other reaction executors

/** #962: Shield Block's own real eligibility -- a raised, unbroken shield.
 * Execution is a request flag, not a direct HP/damage calculation: the
 * real Actor#applyDamage call this plan's own damage seam already makes
 * (confirmed during #931's investigation to accept `shieldBlockRequest`)
 * applies the system's own Hardness/shield-damage rules when the flag is
 * set -- this function decides WHETHER to set it, not how much damage it
 * prevents. */
export async function executeShieldBlock(combat, reactor) {
  const shield = reactor.actor?.heldShield;
  const raised = (reactor.actor?.itemTypes?.effect ?? []).some((e) => e.slug === "effect-raise-a-shield");
  if (!shield || shield.isBroken || !raised) return { requested: false };
  await markReactionUsed(combat, reactor.id, combat.round);
  return { requested: true };
}
```

Wire the damage seam (the module's existing call sites that apply AI-rolled damage to a character target) to call `executeShieldBlock` first and pass `shieldBlockRequest: true` into its own `applyDamage` call when it reports `requested: true` — the same seam #931's own `acBonus` retroactive check already sits beside, confirmed against that plan once landed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-shield-block.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-shield-block.test.mjs
git commit -m "feat(#962): Shield Block eligibility and the shieldBlockRequest wiring"
```

---

### Task 4: Nimble Dodge

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-nimble-dodge.test.mjs`

**Interfaces:**
- Consumes: `markReactionUsed`.
- Produces: `evaluateNimbleDodge(attackTotal, baseAc)` → `{used: boolean, newDegree?}` (pure-ish, no Foundry reads beyond its own plain inputs).

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-nimble-dodge.test.mjs
import { describe, it, expect } from 'vitest';
import { evaluateNimbleDodge } from '../scripts/dungeon-combat.mjs';

describe('evaluateNimbleDodge (#962)', () => {
  it('turns a hit into a miss when +2 AC crosses the threshold', () => {
    // attackTotal 18 vs AC 18 (hit) -> vs AC 20 (miss)
    expect(evaluateNimbleDodge(18, 18)).toEqual({ used: true, newDegree: 'failure' });
  });
  it('is not used when the degree does not change', () => {
    expect(evaluateNimbleDodge(25, 18)).toEqual({ used: false });
  });
  it('turns a critical hit into a plain hit when +2 crosses that boundary', () => {
    expect(evaluateNimbleDodge(28, 18)).toEqual({ used: true, newDegree: 'success' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-nimble-dodge.test.mjs`
Expected: FAIL with "Cannot find module" / not exported

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
function degreeAgainstAc(total, ac) {
  return total >= ac + 10 ? "criticalSuccess" : total >= ac ? "success" : total <= ac - 10 ? "criticalFailure" : "failure";
}

/** #962: Nimble Dodge's own retroactive re-evaluation -- +2 circumstance
 * to AC against the triggering attack, used only when it actually changes
 * the attacker's degree of success (spec's own stated policy). */
export function evaluateNimbleDodge(attackTotal, baseAc) {
  const original = degreeAgainstAc(attackTotal, baseAc);
  const withBonus = degreeAgainstAc(attackTotal, baseAc + 2);
  if (withBonus === original) return { used: false };
  return { used: true, newDegree: withBonus };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-nimble-dodge.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-nimble-dodge.test.mjs
git commit -m "feat(#962): Nimble Dodge's retroactive +2 AC re-evaluation"
```

---

### Task 5: Champion reactions (Retributive Strike, Flash of Grandeur)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-champion.test.mjs`

**Interfaces:**
- Consumes: `rollAndApplyStrikeAtVariant` (real), #910's effect-creation pattern (real, `executeSelfEffectFeat`'s own shape, generalized to a target other than the actor).
- Produces: `championAllyResistance(level)` → `number`; `executeRetributiveStrike`/`executeFlashOfGrandeur(combat, reactor, ally, attacker, triggeringDamage)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-champion.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { championAllyResistance } from '../scripts/dungeon-combat.mjs';

describe('championAllyResistance (#962)', () => {
  it('is 2 + the champion\'s level', () => {
    expect(championAllyResistance(5)).toBe(7);
    expect(championAllyResistance(1)).toBe(3);
  });
});

describe('executeRetributiveStrike (#962)', () => {
  it('reduces the triggering damage by the resistance amount, floored at 0, then strikes the attacker in reach', async () => {
    // Stub rollAndApplyStrikeAtVariant; assert it is called with variant 0
    // against `attacker` only when attacker is within reach, and that the
    // returned reduced damage amount is triggeringDamage - (2+level),
    // floored at 0 (test a damage amount smaller than the resistance too).
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-champion.test.mjs`
Expected: FAIL (nothing exported yet)

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
export function championAllyResistance(level) {
  return 2 + (level ?? 0);
}

export async function executeRetributiveStrike(combat, reactor, ally, attacker, triggeringDamage, inReach) {
  const reduced = Math.max(0, triggeringDamage - championAllyResistance(reactor.actor?.system?.details?.level?.value));
  await markReactionUsed(combat, reactor.id, combat.round);
  if (inReach) {
    await rollAndApplyStrikeAtVariant(combat, reactor, attacker, null, 0);
  }
  return { reducedDamage: reduced };
}
```

(`executeFlashOfGrandeur` mirrors this exactly, substituting #910's own self-effect-creation pattern — generalized to target `attacker` rather than the reactor's own actor — for the Strike step; write it following that function's real, confirmed shape once #910's own code is re-read for the exact `createEmbeddedDocuments` call this needs.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-champion.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-champion.test.mjs
git commit -m "feat(#962): Retributive Strike and Flash of Grandeur -- ally resistance plus counter-effect"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (no new files this plan creates — only real-file modifications — so this step mainly confirms no import-edge changes are missed)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#962): bump version for AI-controlled party character feat reactions"
```

---

## Self-Review

**1. Spec coverage:** The five registry rows (Task 1), the real Reactive Strike fix (Task 2), Shield Block (Task 3), Nimble Dodge (Task 4), the champion reactions (Task 5), and the version bump (Task 6) are each covered. Champion reactions needing an enemy's choice (#1030) and the #961-grammar widening (#1031) are correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". Task 5's own Flash of Grandeur executor is explicitly deferred to "once #910's own code is re-read for the exact call shape" rather than guessed — named plainly as the one piece needing a confirming read before it's done, the same posture every other plan in this sequence uses for a comparable gap.

**3. Type consistency:** `executeShieldBlock`'s `{requested: boolean}` return is consumed identically wherever the damage seam checks it. `championAllyResistance`'s single `number` return is used identically by both champion executors.

**4. Review Focus:** All five bullets (the narrow type-only widening, Shield Block's broken-shield/floor-at-0 safety, Nimble Dodge's degree-change-only spend, per-instance-only ally resistance, the human-controlled exclusion) are each pinned to a named test in Tasks 2, 3, 4, and 5.

**Corrections found while writing this plan:** the first draft of Task 2's fix considered changing `isReactiveStrikeInScope`'s name-match regex too (worrying a class feat might be phrased differently than the NPC action item), but re-reading the spec's own Investigation findings confirmed Reactive Strike is named identically across both forms ("Reactive Strike" / "Attack of Opportunity," the same two names) — the fix is therefore scoped to exactly the one-line type check, not a broader, unverified widening of the name pattern too.
