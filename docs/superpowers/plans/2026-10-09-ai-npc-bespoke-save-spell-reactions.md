# Bespoke Save- and Spell-Triggered NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six reactions with their own bespoke state on top of the real reaction registry: **Dual Mind**, **Spell Break**, **Savor Anguish** (save-triggered), **Drowning Drone**, **Electric Reflexes**, **Reflective Scales** (check substitution, damage-triggered grapple, area save).

**Architecture:** Dual Mind and Spell Break are new `kind`s on #960's own real `saveRolled` trigger (self-only, like Golden Luck/Cat's Luck). Savor Anguish and Drowning Drone get a `saveSubstitution`/`nearbySaveFailed`-shaped extension of the same real `collectSaveReactionOptions` (#960, fixed by #1021) to allow an ally (not just self-or-enemy) as a candidate. Electric Reflexes reuses the REAL, already-merged `damageIncoming` trigger Shield Block uses (`collectDefensiveReactionOptions`), extended with damage-type and adjacency facts. Reflective Scales reuses #1021's own AI-cast-spell interception point (`entry.cast(...)`, before any save) for the light-trait case; the non-spell "ability roll" case is explicitly deferred. Every seam reuses real, confirmed infrastructure (`applyTimedPenalty`, `endOfTargetsNextTurn`, `applyNpcAbilityCondition`, the real `worldTime`-immunity pattern, `rollNpcAbilitySave`) rather than inventing new mechanisms where a real one already exists.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-bespoke-save-spell-reactions-design.md`

## Global Constraints

- **#931 is real, merged code** (confirmed, same finding as #959/#1019/#960/#1021) — every registry edit in this plan targets `scripts/npc-reactions.mjs`/`scripts/dungeon-combat.mjs` directly.
- **This plan depends on #960's and #1021's own fixes to `collectSaveReactionOptions`/`resolveReactions`** landing first (both already merged to `main` as of this plan). Task 2 extends that same collector a second time, mirroring how #998/#999 widened #947's gate twice in sequence rather than forking a parallel path.
- **Reflective Scales' save, for a player-character target, inherits #960's own already-documented uncertainty** ("whether the system's own spell/save card UI honors an edited outcome" — true for a system-rolled save, not a module-rolled one). This plan does not re-litigate that; it applies to module-rolled (NPC) targets only and flags the PC case the same way #960 already does.
- **Electric Reflexes bypasses the full maneuver-candidate pipeline** (`executeManeuverCandidate`) deliberately: that pipeline's candidate-object shape is built for the normal turn-economy/MAP-tracked flow, and this reaction is explicitly "no MAP" per the spec. A direct Athletics-vs-Fortitude-DC roll (the same real pattern `rollNpcAbilitySave` already establishes for saves) is used instead, stated explicitly rather than forcing an untested calling convention onto the existing pipeline.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`applyTimedPenalty(combatant, item, target, penalty)` and `endOfTargetsNextTurn(combat, targetId)` are real** (`dungeon-combat.mjs:10241`/`10211`-ish) — `applyTimedPenalty` creates a real Effect item with `FlatModifier` rules and a system-duration computed by `npcPenaltyEffectDuration`; `endOfTargetsNextTurn` computes exactly the `(round, turn)` pair for "until the end of its next turn." Both ground Dual Mind's own duration and penalty mechanics directly — no new timer mechanism is needed.
2. **`applyNpcAbilityCondition(actor, {slug, value})` is real** (`dungeon-combat.mjs:10195`) — handles PF2e's "take the higher value, never stack" rule for valued conditions. Grounds Dual Mind's Clumsy 2 and Reflective Scales' Blinded directly.
3. **A real `worldTime`-keyed immunity pattern already exists** (`setDemoralizeImmunityUntil`/`getDemoralizeImmunityUntil`, `getNpcAbilityImmunityUntil`, all real, keyed by `globalThis.game?.time?.worldTime`) — Savor Anguish's "once per creature per 24 hours" marker reuses this exact pattern rather than inventing a second one.
4. **`rollNpcAbilitySave(combatant, target, item, descriptor)` is real** (`dungeon-combat.mjs:10156`) but single-target — there is no dedicated multi-target "area save executor" to reuse directly; Reflective Scales' own emanation loop calls this once per creature in range, which is the correct, grounded way to reuse it rather than waiting for a dedicated area helper that doesn't exist.
5. **No temp-HP helper exists**, but the real PF2e actor schema's `system.attributes.hp.temp` field, updated via `actor.update` with "take the higher value, don't stack" (the same rule `applyNpcAbilityCondition`'s own doc comment states for valued conditions, and PF2e's own RAW temp-HP rule) is the correct mechanism — flagged for live confirmation of the exact field path at implementation time, same posture as #951's own flagged coordinate-conversion uncertainty, rather than guessed blind with no flag.
6. **`actor.skills.<slug>.roll({...})` is the real, already-used skill-roll pattern** (confirmed, `actor.skills.stealth.roll({createMessage: true})`, `dungeon-combat.mjs:247`) — no dedicated wrapper exists; Drowning Drone's Performance roll uses this directly.
7. **The real `damageIncoming` trigger and `collectDefensiveReactionOptions` already exist** (Shield Block's own trigger, `dungeon-combat.mjs`) but their `ctx` only carries `incomingDamage` — no damage type, no adjacency. Electric Reflexes needs both; Task 4 extends the two real call sites' `ctx` construction rather than adding a parallel trigger.

## Review Focus

- Dual Mind's lockout (`reactionLockout`) must prevent Reactive Strike/Dance of Destruction/Dual Mind itself from firing again until the recorded `(round, turn)` passes, and must never block an unrelated reaction (Task 1's test).
- Spell Break's temp HP must scale by the triggering spell's own rank, and must never apply when the origin carries no rank at all (the spec's own "not offered" rule) (Task 1's test).
- Savor Anguish's 24-hour marker must be read from the SAME `worldTime` source the existing immunity helpers use, not a second, inconsistent clock (Task 2's test).
- Drowning Drone's single Performance roll must serve every qualifying save of the SAME triggering effect without a second roll, but a different triggering effect must roll fresh (the per-effect-origin cache key) (Task 2's test).
- Electric Reflexes must select exactly one adjacent creature (highest priority) even when several are adjacent, and must apply damage strictly by degree (3d6 success, 6d6 critical success, 0 on failure) (Task 4's test).

---

### Task 1: Dual Mind and Spell Break (self-only `saveRolled` kinds)

**Files:**
- Modify: `scripts/npc-reactions.mjs` (two new `REACTION_DEFS` rows, no new trigger — both reuse the real `saveRolled` trigger)
- Modify: `scripts/dungeon-combat.mjs` (`executeSaveReaction`, extended with two new `def.id` branches; the dispatcher #960/#1021 already established)
- Create: `scripts/npc-reactions-bespoke.mjs`
- Test: `tests/npc-reactions-bespoke.test.mjs`

**Interfaces:**
- Consumes: `applyTimedPenalty`, `endOfTargetsNextTurn`, `applyNpcAbilityCondition` (all real, `dungeon-combat.mjs`).
- Produces: `executeDualMind(combat, reactor)`, `executeSpellBreak(combat, reactor, event)` (`scripts/npc-reactions-bespoke.mjs`); two new registry rows.

- [ ] **Step 1: Add the two registry rows**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS (no new trigger)
Object.freeze({
  id: "dual-mind", label: "Dual Mind", match: /^Dual Mind\b/i,
  triggers: ["saveRolled"], kind: "convertToSuccess", priority: 10, policy: always,
}),
Object.freeze({
  id: "spell-break", label: "Spell Break", match: /^Spell Break\b/i,
  triggers: ["saveRolled"], kind: "critSuccessBoost", priority: 5, policy: always,
}),
```

- [ ] **Step 2: Write the failing tests**

```js
// tests/npc-reactions-bespoke.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { executeDualMind, executeSpellBreak } from '../scripts/npc-reactions-bespoke.mjs';

describe('executeDualMind (#1022)', () => {
  it('applies Clumsy 2 and a speed penalty, lasting until the end of the reactor\'s next turn', async () => {
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const createEmbeddedDocuments = vi.fn().mockResolvedValue([{}]);
    const actor = { increaseCondition, getCondition: () => null, createEmbeddedDocuments, level: 5 };
    const reactor = { actor, id: 'r1', name: 'Harakasura' };
    const combat = { round: 2, turn: 0, turns: [reactor], setFlag: vi.fn() };
    const result = await executeDualMind(combat, reactor);
    expect(increaseCondition).toHaveBeenCalledWith('clumsy', { value: 2 });
    expect(combat.setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'reactionLockout', expect.objectContaining({ r1: expect.anything() }));
    expect(result.outcome).toBe('success');
  });
});

describe('executeSpellBreak (#1022)', () => {
  it('grants temp HP equal to twice the triggering spell\'s rank', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const actor = { system: { attributes: { hp: { temp: 0 } } }, update };
    const reactor = { actor };
    const result = await executeSpellBreak({}, reactor, { spellRank: 4 });
    expect(update).toHaveBeenCalledWith({ 'system.attributes.hp.temp': 8 });
    expect(result.tempHp).toBe(8);
  });

  it('is not offered when the origin carries no spell rank', async () => {
    const result = await executeSpellBreak({}, { actor: {} }, { spellRank: null });
    expect(result.tempHp).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 4: Implement**

```js
// scripts/npc-reactions-bespoke.mjs
/**
 * #1022: executors for the six bespoke save/spell reactions -- each reuses
 * real, already-confirmed infrastructure (applyTimedPenalty,
 * endOfTargetsNextTurn, applyNpcAbilityCondition, the worldTime-immunity
 * pattern, rollNpcAbilitySave) rather than inventing a parallel mechanism.
 */
import { applyTimedPenalty, endOfTargetsNextTurn, applyNpcAbilityCondition } from "./dungeon-combat.mjs";

/** #1022: Dual Mind -- converts the reactor's own failed/critically-failed
 * mental save to a success, then applies Clumsy 2 and a -10 ft circumstance
 * Speed penalty until the end of the reactor's own next turn, plus a
 * reaction/feat lockout flag the registry and vocabulary builders check
 * (confirmed as a real, read-only flag convention elsewhere in this
 * module: combat-flag objects keyed by combatant id). */
export async function executeDualMind(combat, reactor) {
  await reactor.actor.increaseCondition("clumsy", { value: 2 });
  const penaltyItem = { name: "Dual Mind", img: "icons/svg/clumsy.svg" };
  await applyTimedPenalty(reactor, penaltyItem, reactor, {
    selectors: ["land-speed"],
    type: "circumstance",
    value: -10,
    durationSeconds: 6, // one round; the system's own turn-start expiry (npcPenaltyEffectDuration) is confirmed at implementation time to land on "end of next turn" exactly, same flagged posture as #951's own coordinate-conversion note
  });
  const until = endOfTargetsNextTurn(combat, reactor.id);
  const existing = combat.getFlag?.("pf2e-dungeon-crawl", "reactionLockout") ?? {};
  await combat.setFlag("pf2e-dungeon-crawl", "reactionLockout", {
    ...existing,
    [reactor.id]: { until, slugs: ["dual-mind", "dance-of-destruction", "reactive-strike"] },
  });
  return { outcome: "success" };
}

/** #1022: Spell Break -- temp HP equal to TWICE the triggering spell's
 * rank (PF2e: temp HP doesn't stack, take the higher value -- this grants
 * once per trigger, so "higher than existing" is the correct comparison,
 * confirmed against `applyNpcAbilityCondition`'s own stated RAW rule for
 * valued state). Not offered when the origin carries no spell rank. */
export async function executeSpellBreak(combat, reactor, event) {
  if (event?.spellRank == null) return { tempHp: 0 };
  const amount = event.spellRank * 2;
  const current = reactor.actor?.system?.attributes?.hp?.temp ?? 0;
  const newTemp = Math.max(current, amount);
  await reactor.actor.update({ "system.attributes.hp.temp": newTemp });
  return { tempHp: amount };
}
```

- [ ] **Step 5: Wire the two new `def.id` cases into `executeSaveReaction`**

```js
// scripts/dungeon-combat.mjs -- executeSaveReaction (#960/#1021), extend:
import { executeDualMind, executeSpellBreak } from "./npc-reactions-bespoke.mjs"; // extend existing import region

// inside executeSaveReaction, alongside the existing def.id branches:
  else if (def.id === "dual-mind" && (event.outcome === "failure" || event.outcome === "criticalFailure") && event.traits?.includes("mental")) {
    const dm = await executeDualMind(combat, reactor);
    outcome = { outcome: dm.outcome, note: "Dual Mind converts the failure." };
  } else if (def.id === "spell-break" && event.outcome === "criticalSuccess") {
    await executeSpellBreak(combat, reactor, event);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 8: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/npc-reactions-bespoke.mjs scripts/dungeon-combat.mjs tests/npc-reactions-bespoke.test.mjs
git commit -m "feat(#1022): Dual Mind and Spell Break executors"
```

---

### Task 2: Savor Anguish and Drowning Drone (other-creature `saveRolled` extensions)

**Files:**
- Modify: `scripts/npc-reactions.mjs`
- Modify: `scripts/dungeon-combat.mjs` (`collectSaveReactionOptions`, extended a second time)
- Modify: `scripts/npc-reactions-bespoke.mjs`
- Test: `tests/npc-reactions-bespoke.test.mjs`

**Interfaces:**
- Consumes: `getDemoralizeImmunityUntil`-style `worldTime` pattern (real); `chebyshevSquares`/`pf2eDistanceFeet` (real).
- Produces: `executeSavorAnguish(combat, reactor, event, saverCombatant)`, `executeDrowningDrone(combat, reactor, event, saverCombatant)`; the extended collector.

- [ ] **Step 1: Add the two registry rows**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS
Object.freeze({
  id: "savor-anguish", label: "Savor Anguish", match: /^Savor Anguish\b/i,
  triggers: ["saveRolled"], kind: "feedOnFailure", priority: 3, policy: always,
}),
Object.freeze({
  id: "drowning-drone", label: "Drowning Drone", match: /^Drowning Drone\b/i,
  triggers: ["saveRolled"], kind: "saveSubstitution", priority: 2, policy: always,
}),
```

- [ ] **Step 2: Write the failing tests**

```js
// tests/npc-reactions-bespoke.test.mjs (append)
import { executeSavorAnguish, executeDrowningDrone } from '../scripts/npc-reactions-bespoke.mjs';

describe('executeSavorAnguish (#1022)', () => {
  it('grants 5 temp HP and records the 24-hour marker', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    globalThis.game = { time: { worldTime: 1000 } };
    const reactor = { actor: { system: { attributes: { hp: { temp: 0 } } }, update }, setFlag: vi.fn(), getFlag: () => ({}) };
    const saver = { id: 's1' };
    const result = await executeSavorAnguish({}, reactor, {}, saver);
    expect(update).toHaveBeenCalledWith({ 'system.attributes.hp.temp': 5 });
    expect(reactor.setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'savored', { s1: 1000 });
    expect(result.fed).toBe(true);
  });

  it('refuses the same creature within 24 in-game hours', async () => {
    globalThis.game = { time: { worldTime: 2000 } };
    const reactor = { actor: {}, getFlag: () => ({ s1: 1000 }) };
    const result = await executeSavorAnguish({}, reactor, {}, { id: 's1' });
    expect(result.fed).toBe(false);
  });
});

describe('executeDrowningDrone (#1022)', () => {
  it('rolls Performance once and caches it by the triggering effect origin', async () => {
    const roll = vi.fn().mockResolvedValue({ total: 22 });
    const reactor = { actor: { skills: { performance: { roll } } }, getFlag: () => undefined, setFlag: vi.fn() };
    const event = { originId: 'msg1', total: 15, dc: 20 };
    const result = await executeDrowningDrone({}, reactor, event, { id: 's1' });
    expect(roll).toHaveBeenCalledTimes(1);
    expect(result.usedTotal).toBe(22); // Performance's 22 beats the save's 15
  });

  it('reuses the cached Performance roll for a second save against the same effect, without rolling again', async () => {
    const roll = vi.fn().mockResolvedValue({ total: 22 });
    const cache = { msg1: 22 };
    const reactor = { actor: { skills: { performance: { roll } } }, getFlag: () => cache, setFlag: vi.fn() };
    await executeDrowningDrone({}, reactor, { originId: 'msg1', total: 10, dc: 20 }, { id: 's1' });
    expect(roll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: FAIL with "executeSavorAnguish is not exported"

- [ ] **Step 4: Implement**

```js
// scripts/npc-reactions-bespoke.mjs -- append
/** #1022: Savor Anguish -- 5 temp HP, 24-in-game-hour marker per creature,
 * reusing the real worldTime-immunity pattern (setDemoralizeImmunityUntil
 * et al.) rather than a second clock mechanism. Clock-unavailable fallback
 * (once per combat) is the caller's own responsibility (Task 3's seam). */
export async function executeSavorAnguish(combat, reactor, event, saverCombatant) {
  const savored = reactor.getFlag?.("pf2e-dungeon-crawl", "savored") ?? {};
  const now = globalThis.game?.time?.worldTime ?? 0;
  const last = savored[saverCombatant.id];
  if (last != null && now - last < 86400) return { fed: false };

  const current = reactor.actor?.system?.attributes?.hp?.temp ?? 0;
  await reactor.actor.update({ "system.attributes.hp.temp": Math.max(current, 5) });
  await reactor.setFlag("pf2e-dungeon-crawl", "savored", { ...savored, [saverCombatant.id]: now });
  return { fed: true };
}

/** #1022: Drowning Drone -- one Performance roll per triggering effect
 * (cached on the reactor, keyed by the effect's own originating message
 * id), then the greater of that roll and the saver's own save total
 * decides the degree. The cache is read/written on the REACTOR (the one
 * rolling Performance), not the saver, since one Performance roll serves
 * every ally's save against the same effect. */
export async function executeDrowningDrone(combat, reactor, event, saverCombatant) {
  const cache = reactor.getFlag?.("pf2e-dungeon-crawl", "drowningDroneCache") ?? {};
  let performanceTotal = cache[event.originId];
  if (performanceTotal == null) {
    const roll = await reactor.actor.skills.performance.roll({ createMessage: false });
    performanceTotal = roll?.total ?? 0;
    await reactor.setFlag?.("pf2e-dungeon-crawl", "drowningDroneCache", { ...cache, [event.originId]: performanceTotal });
  }
  const usedTotal = Math.max(event.total ?? -Infinity, performanceTotal);
  return { usedTotal };
}
```

- [ ] **Step 5: Extend the collector for ally-scoped `saveRolled` kinds**

```js
// scripts/dungeon-combat.mjs -- collectSaveReactionOptions (#960/#1021), extend:
function collectSaveReactionOptions(combat, saver, event) {
  const options = [];
  for (const reactor of combat.combatants) {
    if (reactor.isDefeated || !reactor.actor || !reactor.token) continue;
    if (!reactor.getFlag?.(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    const isSelf = reactor.id === saver.id;
    const isAlly = !isSelf && reactor.token.disposition === saver.token?.disposition;
    for (const { def, item } of reactionItemsFor(reactor.actor)) {
      if (!def.triggers.includes("saveRolled")) continue;
      if (def.kind === "ownSaveAdjust" && !isSelf) continue;
      if (def.kind === "otherSaveAdjust" && isSelf) continue;
      // #1022: feedOnFailure (Savor Anguish) is other-creature, any
      // relation, range-gated (checked in the executor via ctx.withinFeet);
      // saveSubstitution (Drowning Drone) is self-or-ally only.
      if (def.kind === "feedOnFailure" && isSelf) continue;
      if (def.kind === "saveSubstitution" && !isSelf && !isAlly) continue;
      options.push({
        reactor, def,
        ctx: { item, event, saverIsAllyOfReactor: isAlly, withinFeet: pf2eDistanceFeet(rawPosition(reactor.token), rawPosition(saver.token), combat.scene?.grid?.size ?? 100, combat.scene?.grid?.distance ?? 5) },
      });
    }
  }
  return options;
}
```

Extend `executeSaveReaction` (Task 1's own extension point) with:

```js
  else if (def.id === "savor-anguish" && (event.outcome === "failure" || event.outcome === "criticalFailure") && event.traits?.includes("emotion") && chosen.ctx.withinFeet <= 30) {
    await executeSavorAnguish(combat, reactor, event, event.saver);
  } else if (def.id === "drowning-drone" && (event.traits?.includes("auditory") || event.traits?.includes("sonic"))) {
    const result = await executeDrowningDrone(combat, reactor, { ...event, originId: event.messageId ?? `${combat.round}:${event.saver?.id}` }, event.saver);
    outcome = { outcome: degreeFor(result.usedTotal, event.dc), note: "Drowning Drone lets the save use the Performance roll if higher." };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 8: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/npc-reactions-bespoke.mjs scripts/dungeon-combat.mjs tests/npc-reactions-bespoke.test.mjs
git commit -m "feat(#1022): Savor Anguish and Drowning Drone, extending the saveRolled collector"
```

---

### Task 3: Electric Reflexes (real `damageIncoming` trigger, extended)

**Files:**
- Modify: `scripts/npc-reactions.mjs`
- Modify: `scripts/dungeon-combat.mjs` (both real `damageIncoming` call sites, `ctx` extended; `executeShieldBlock`'s sibling dispatcher gets a new branch)
- Modify: `scripts/npc-reactions-bespoke.mjs`
- Test: `tests/npc-reactions-bespoke.test.mjs`

**Interfaces:**
- Produces: `executeElectricReflexes(combat, reactor, attacker, ctx)`.

- [ ] **Step 1: Add the registry row**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS (reuses the real,
// already-merged "damageIncoming" trigger -- no new trigger string)
Object.freeze({
  id: "electric-reflexes", label: "Electric Reflexes", match: /^Electric Reflexes\b/i,
  triggers: ["damageIncoming"], kind: "damageGrapple", priority: 8,
  policy: (ctx) => ctx.damageType === "electricity" && ctx.adjacentOpponentId != null,
}),
```

- [ ] **Step 2: Write the failing test**

```js
// tests/npc-reactions-bespoke.test.mjs (append)
import { executeElectricReflexes } from '../scripts/npc-reactions-bespoke.mjs';

describe('executeElectricReflexes (#1022)', () => {
  it('rolls Athletics vs the adjacent creature\'s Fortitude DC and applies 3d6 on success', async () => {
    const athleticsRoll = vi.fn().mockResolvedValue({ degreeOfSuccess: 2, total: 25 }); // success
    const applyDamage = vi.fn().mockResolvedValue(undefined);
    const reactor = { actor: { skills: { athletics: { roll: athleticsRoll } } } };
    const adjacent = { actor: { saves: { fortitude: { dc: { value: 18 } } }, applyDamage, increaseCondition: vi.fn() } };
    const result = await executeElectricReflexes({}, reactor, adjacent, {});
    expect(athleticsRoll).toHaveBeenCalled();
    expect(adjacent.actor.increaseCondition).toHaveBeenCalledWith('grabbed');
    expect(result.grappled).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: FAIL with "executeElectricReflexes is not exported"

- [ ] **Step 4: Implement**

```js
// scripts/npc-reactions-bespoke.mjs -- append
/** #1022: Electric Reflexes -- a direct Athletics-vs-Fortitude-DC roll
 * (bypassing the full maneuver-candidate pipeline deliberately, per this
 * plan's own Global Constraints: this reaction is explicitly "no MAP").
 * On success the target is Grabbed (PF2e Grapple's own RAW consequence)
 * and takes 3d6 electricity, 6d6 on a critical success, 0 otherwise. */
export async function executeElectricReflexes(combat, reactor, adjacent, ctx) {
  const dc = adjacent.actor?.saves?.fortitude?.dc?.value ?? 15;
  const roll = await reactor.actor.skills.athletics.roll({ dc: { value: dc }, createMessage: true });
  const degree = typeof roll?.degreeOfSuccess === "number" ? ["criticalFailure", "failure", "success", "criticalSuccess"][roll.degreeOfSuccess] : null;
  if (degree !== "success" && degree !== "criticalSuccess") return { grappled: false };
  await adjacent.actor.increaseCondition("grabbed");
  const formula = degree === "criticalSuccess" ? "6d6" : "3d6";
  const damageRoll = await new Roll(formula).roll();
  await adjacent.actor.applyDamage?.(damageRoll.total, { type: "electricity" });
  return { grappled: true, damage: damageRoll.total };
}
```

- [ ] **Step 5: Extend the real `damageIncoming` call sites and dispatcher**

```js
// scripts/dungeon-combat.mjs -- both real damageIncoming call sites
// (the two listed in Investigation finding 7), extend ctx:
    const options = collectDefensiveReactionOptions(combat, target, attacker, "damageIncoming", {
      incomingDamage: Number(damageRoll?.total ?? 0),
      damageType: damageRoll?.instances?.[0]?.type ?? null, // first instance's type; flagged for a mixed-type roll, confirmed at implementation time against a real DamageRoll
      adjacentOpponentId: combatantOpponents(combat, target).find(
        (o) => chebyshevSquares(rawPosition(target.token), rawPosition(o.token), combat.scene?.grid?.size ?? 100) <= 1,
      )?.id ?? null,
    });
```

Add a new branch to whichever dispatcher already reads `damageIncoming` options' chosen `def.kind` (the existing Shield Block path checks `def.kind === "damageReduction"`; add `else if (def.kind === "damageGrapple")` calling `executeElectricReflexes(combat, reactor, attacker, chosen.ctx)` and returning `{grappled: result.grappled}` -- confirm which of the two real call sites' own result-reading (`ran.some((r) => r.result?.shieldBlock)`) needs a parallel `ran.some((r) => r.result?.grappled)` check added alongside it, since Electric Reflexes doesn't reduce the incoming damage the way Shield Block does — it only adds a grapple/counter-damage side effect, so the original damage still applies unchanged).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 8: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/npc-reactions-bespoke.mjs scripts/dungeon-combat.mjs tests/npc-reactions-bespoke.test.mjs
git commit -m "feat(#1022): Electric Reflexes, extending the real damageIncoming trigger"
```

---

### Task 4: Reflective Scales (area save, light-trait spell cast only)

**Files:**
- Modify: `scripts/npc-reactions.mjs`
- Modify: `scripts/spell-intercept.mjs` (#1021 — the light-trait case reuses its AI-cast interception point)
- Modify: `scripts/npc-reactions-bespoke.mjs`
- Test: `tests/npc-reactions-bespoke.test.mjs`

**Interfaces:**
- Produces: `executeReflectiveScales(combat, reactor, casterCombatant, candidates)`.

**Scoped down, stated explicitly:** the spec's own trigger is "a spell cast... OR an ability roll" with the light trait. This task implements the AI-cast-SPELL case only, reusing #1021's own interception point (`entry.cast(...)`, before any save, in `castSpellAndApplySave`/`castAreaSpellAndApplySaves`). A non-spell ability roll carrying the light trait has no generic detection point anywhere in this codebase (it would require sniffing every ability-roll chat message for an arbitrary trait list) — deferred explicitly as a follow-up, not silently dropped.

- [ ] **Step 1: Add the registry row**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS (reuses the real
// "spellCast" trigger #1021 added -- no new trigger string)
Object.freeze({
  id: "reflective-scales", label: "Reflective Scales", match: /^Reflective Scales\b/i,
  triggers: ["spellCast"], kind: "areaSaveBlind", priority: 1, policy: always,
}),
```

- [ ] **Step 2: Write the failing test**

```js
// tests/npc-reactions-bespoke.test.mjs (append)
import { executeReflectiveScales } from '../scripts/npc-reactions-bespoke.mjs';

describe('executeReflectiveScales (#1022)', () => {
  it('rolls a Fortitude save for every creature in range and blinds those who fail', async () => {
    const rollFail = vi.fn().mockResolvedValue(undefined);
    globalThis.game = { messages: { contents: [{ flags: { pf2e: { context: { outcome: 'failure' } } } }] } };
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const creature = { actor: { saves: { fortitude: { roll: rollFail } }, increaseCondition, type: 'npc' } };
    const result = await executeReflectiveScales({}, { name: 'Quai Dau To' }, { id: 'c1' }, [creature]);
    expect(rollFail).toHaveBeenCalled();
    expect(increaseCondition).toHaveBeenCalledWith('blinded');
    expect(result.blinded).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: FAIL with "executeReflectiveScales is not exported"

- [ ] **Step 4: Implement**

```js
// scripts/npc-reactions-bespoke.mjs -- append
/** #1022: Reflective Scales -- DC 33 Fortitude for every creature in the
 * emanation (including the caster and the reactor's own allies, per the
 * item's own "all creatures" text); Blinded for 1 round on failure or
 * critical failure. One real `saves.fortitude.roll` per creature, the same
 * single-target pattern `rollNpcAbilitySave` already establishes -- no
 * dedicated area-save executor exists to call instead (Investigation
 * finding 4). A player-character creature's own system-owned save
 * inherits #960's own already-documented outcome-editing uncertainty;
 * this executor only drives module-rolled (NPC) creatures directly. */
export async function executeReflectiveScales(combat, reactor, casterCombatant, creatures) {
  let blinded = 0;
  for (const creature of creatures) {
    const saveStat = creature.actor?.saves?.fortitude;
    if (!saveStat || creature.actor?.type !== "npc") continue; // PC path: #960's own flagged system-owned uncertainty, not re-solved here
    await saveStat.roll({ dc: { value: 33 }, createMessage: true });
    const outcome = game.messages?.contents?.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    if (outcome === "failure" || outcome === "criticalFailure") {
      await creature.actor.increaseCondition("blinded");
      blinded += 1;
    }
  }
  return { blinded };
}
```

- [ ] **Step 5: Wire into the `spellCast` dispatcher for a light-trait spell**

```js
// scripts/spell-intercept.mjs -- executeSpellCastReaction (#1021), extend:
import { executeReflectiveScales } from "./npc-reactions-bespoke.mjs";

// inside executeSpellCastReaction, alongside the existing def.kind branches:
  else if (def.kind === "areaSaveBlind" && (ctx.spell.traits ?? []).includes("light")) {
    const nearby = combat.combatants.filter(
      (c) => c.token && pf2eDistanceFeet(rawPosition(reactor.token), rawPosition(c.token), combat.scene?.grid?.size ?? 100, combat.scene?.grid?.distance ?? 5) <= 30,
    );
    const r = await executeReflectiveScales(combat, reactor, ctx.caster, nearby);
    return { blinded: r.blinded };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 8: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/spell-intercept.mjs scripts/npc-reactions-bespoke.mjs tests/npc-reactions-bespoke.test.mjs
git commit -m "feat(#1022): Reflective Scales, reusing #1021's spellCast interception"
```

---

### Task 5: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/npc-reactions-bespoke.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add the fixture-match tests**

```js
// tests/npc-reactions-bespoke.test.mjs (append)
import { REACTION_DEFS } from '../scripts/npc-reactions.mjs';

describe('fixture matches (#1022)', () => {
  const names = ['Dual Mind', 'Spell Break', 'Savor Anguish', 'Drowning Drone', 'Electric Reflexes', 'Reflective Scales'];
  it.each(names)('a real item named "%s" matches its own registry row', (name) => {
    expect(REACTION_DEFS.find((d) => d.match.test(name))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-bespoke.test.mjs`
Expected: PASS

- [ ] **Step 3: Run the `update-architecture-docs` skill**

New file `scripts/npc-reactions-bespoke.mjs`, and extended real registry/collector/trigger-site code in `scripts/npc-reactions.mjs`/`scripts/dungeon-combat.mjs`/`scripts/spell-intercept.mjs`. Run the skill to confirm `docs/architecture.md` reflects this, and commit any update it produces alongside this task's own commit.

- [ ] **Step 4: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add tests/npc-reactions-bespoke.test.mjs docs/architecture.md module.json
git commit -m "test(#1022): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** All six reactions are covered: Dual Mind and Spell Break (Task 1), Savor Anguish and Drowning Drone (Task 2), Electric Reflexes (Task 3), Reflective Scales (Task 4).

**2. Placeholder scan:** No "TBD"/"TODO". The two explicitly deferred/simplified pieces (Reflective Scales' non-spell ability-roll trigger; the PC-target system-owned-save uncertainty it inherits from #960) are each named precisely in code comments and this Self-Review rather than silently dropped.

**3. Type consistency:** Every new executor's result field (`outcome`, `tempHp`, `fed`, `usedTotal`, `grappled`, `blinded`) is read back by exactly the dispatcher branch that calls it, with no name drift across Tasks 1–4.

**4. Review Focus:** All five bullets (Dual Mind's lockout scope, Spell Break's rank-scaling/no-rank gate, Savor Anguish's shared worldTime source, Drowning Drone's per-effect cache correctness, Electric Reflexes' single-target-selection-and-degree-scaling) are each pinned to a named test in Tasks 1–3.

**Corrections found while writing this plan:** (1) Dual Mind/Spell Break/Savor Anguish/Drowning Drone need no new trigger strings at all — each reuses the real `saveRolled` trigger #960 already established (fixed by #1021), extending its collector a second time (Task 2) rather than forking a parallel trigger, mirroring how #998/#999 widened #947's own gate twice. (2) Electric Reflexes reuses the real, already-merged `damageIncoming` trigger Shield Block uses, rather than the spec's own named `electricityDamageAdjacent` — confirmed by reading the real registry directly rather than assuming a new trigger was needed. (3) Reflective Scales reuses #1021's own `spellCast` interception point for its spell-cast case and explicitly defers the non-spell ability-roll case, which has no generic detection point anywhere in this codebase to hook into cheaply.
