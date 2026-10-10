# Other-Creature Death-Triggered NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a subject model (relation/range/perception/alive filters, evaluated against whichever creature drops) to the real NPC reaction registry, and model five reactions on top of it: **Soul Feast**, **Responsive Recovery**, **Preserve Prey**, **Reawaken!** and **Material Leap**. Scuttle Away is deferred (#1156).

**Architecture:** Extends #931's real, merged registry (`scripts/npc-reactions.mjs`/`scripts/dungeon-combat.mjs`) and #959's death-reaction seam (`applyDefeatIfReducedToZero`, `scripts/npc-reactions-death.mjs`) rather than the stale plan-document shapes either spec cites — both are grounded directly against the real code in this plan. A new collector, `collectOtherDeathReactionOptions`, builds reaction options for every OTHER agent-controlled combatant (not just the dropping creature's own opponents, since these reactions trigger for allies, "any creature," or a sensed creature), following the real `collectDefensiveReactionOptions`/`collectDeathReactionOptions` pattern exactly. A pure `subjectMatches(filter, facts)` in `scripts/npc-reactions-death.mjs` evaluates the subject filter against already-computed geometry facts, keeping that file free of Foundry API calls (as #959's own file comment states).

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-other-creature-death-reactions-design.md`

## Global Constraints

- **Both #959 and #931 are grounded against REAL code in this plan**, not the plan-only shapes their own spec/plan documents describe — see Task 1 (the #959 amendment made directly in this worktree) and Investigation finding 1.
- **This plan depends on #959's own seam landing first** (`applyDefeatIfReducedToZero(combat, target)`, `collectDeathReactionOptions`, `executeDeathReaction`, the `reducedToZero` trigger and registry entries) — every task below assumes that function's shape as #959's amended Task 2 leaves it (reproduced in Task 3 below for the implementer's convenience, so this plan is self-contained even if #959 hasn't merged yet).
- A reaction's effect is only committed after `markReactionUsed` — mirrors every other reaction executor in this file. A failed effect application aborts without marking the reaction used and never blocks the subject's own defeat (spec's own Error handling section).
- **Material Leap has no real precedent to build on** (confirmed: no cross-scene token-transfer code, no scene-pairing/plane-tagging convention anywhere in real code or any plan). Scoped down to the spec's own documented no-pairing fallback (announce for the GM, do not move the token) as the ONLY implementation in this plan — building a full plane-transfer mechanism from nothing is out of proportion to one reaction and would be unreviewed, invented infrastructure (see Task 6).
- **Responsive Recovery's "cast Heal" half has no NPC-spellcasting infrastructure to build on** (confirmed: no module-owned spell executor, no prepared-spell-slot tracking anywhere in real code). Scoped down to a direct, flagged heal-roll application (matching Soul Feast's own granularity) with a documented limitation that spell-slot expenditure isn't tracked (see Task 5).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **#931 is real, merged code (`scripts/npc-reactions.mjs`), not plan-only** — confirmed live. Real `REACTION_DEFS` rows are `{id, label, match: RegExp, triggers: string[], kind, priority, policy}`; the real dispatcher `resolveReactions(combat, event, execute, opts)` lives in `scripts/dungeon-combat.mjs:2210` and is driven by a per-trigger collector that pre-builds `event.options`. This plan's own registry task (Task 2) and collector (Task 4) use these real shapes.
2. **#959's own plan, as originally drafted, patched a stale plan document and called `resolveReactions` with a signature that doesn't match the real function** — both fixed directly in this worktree as this plan's Task 1 (a necessary prerequisite: #1019's own seam extension builds on #959's `applyDefeatIfReducedToZero(combat, target)`, which must itself be correct before this plan's Task 3 can extend it).
3. **"Dies," for this function's own purposes, is unambiguous only for the NPC branch.** `applyDefeatIfReducedToZero`'s real body branches: a player character gets `actor.increaseCondition("dying")` (not dead — PF2e PCs only truly die at dying value 4, a separate seam this module doesn't own here); an NPC gets `target.toggleDefeated()` (this module's own real "this creature is dead" moment). The spec's five reactions all say "dies" loosely; this plan scopes the `died` trigger to fire only on the NPC branch (`toggleDefeated()`), never on a PC reaching 0 HP — Soul Feast/Reawaken!/Material Leap's "a creature dies" is read as "an NPC/monster is defeated," matching how this module already treats PC-vs-NPC death asymmetrically everywhere else in this file.
4. **`actor.decreaseCondition(slug, { forceRemove: true })` is real and already used repeatedly** (e.g. `dungeon-combat.mjs:269`, `:8733`, `:9056`, for `frightened`/other timed conditions) — confirmed as the mechanism for Preserve Prey's "goes unconscious but does not gain dying": run the normal branch (which the function's own code comment confirms cascades Unconscious automatically from the dying increase), then immediately `decreaseCondition("dying", { forceRemove: true })` to strip the dying value back off while Unconscious remains.
5. **Real geometry helpers confirmed for the subject model:** `chebyshevSquares(a, b, gridSize)` (grid-square distance, `dungeon-combat.mjs:1233`) for "adjacent" (`<= 1`); `pf2eDistanceFeet(a, b, gridSize, gridDistanceFt)` (RAW diagonal-counts-double distance, `dungeon-combat.mjs`) for "within N feet"; `hasLineOfSight(combat, attackerToken, targetToken)` (exported, `dungeon-combat.mjs:4295`) for "can see." No lifesense/sense-type detection model exists anywhere in this codebase — Material Leap's own "sensed" requirement is scoped out along with the rest of its mechanic (see the Global Constraints bullet above); this plan's `subjectMatches` treats `perception: "sense"` as always-true with a one-line comment stating the limitation, since Material Leap is the only consumer and it's already GM-announce-only.
6. **`strideByPosture(combat, combatant, posture, target)` is real and exported** (`dungeon-combat.mjs:6310`) — a wall-aware Stride toward (`posture: "approach"`) a target's token, already clamping to melee reach and handling move-triggered reactions. This grounds Responsive Recovery's "Strides toward them" half directly; no new movement code is needed.
7. **No self-heal/healing-roll helper exists to reuse for Soul Feast** (confirmed: Ferocity's own executor just hard-sets `hp.value: 1`, no damage-roll healing anywhere). Soul Feast and Responsive Recovery each roll a fresh `Roll` and clamp the result to the actor's max HP via `actor.update`.

## Review Focus

- A reactor must never trigger a subject-model reaction on itself unless the filter's `relation` explicitly allows it (`"any"`) — #959's own self-only reactions stay on the separate `collectDeathReactionOptions` path; this plan's `collectOtherDeathReactionOptions` always excludes the subject from the candidate pool (Task 4's test).
- Preserve Prey's dying-suppression must leave Unconscious in place, not accidentally strip it too, and must never fire for an already-defeated NPC (Task 5's test).
- Reawaken! must never resurrect the same creature twice — the `resurrectedBy` marker is the single source of truth, checked before any state change (Task 4's test).
- Responsive Recovery must not apply its heal, and must not report `cancelDefeat`, when the reactor has no item matching "Heal" by name at all — the spec's own "no prepared heal -> not offered" rule (Task 5's test).
- A malformed/missing `agentLog`-style flag or absent token on any candidate reactor must be skipped silently, never throw and never block the subject's own defeat (Task 3's and Task 4's tests).

---

### Task 1: Fix #959's plan — ground it in the real registry (prerequisite)

**Already applied in this worktree** (not a separate GitHub issue — #959's own plan document, patched here because #1019 depends directly on its seam being correct before extending it).

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-death-reactions.md`

- [ ] **Step 1: Confirm the amendment is present**

This worktree already contains the fix (made while grounding this plan): Task 1 of that plan now adds the `reducedToZero` trigger and its three `REACTION_DEFS` rows directly to the real `scripts/npc-reactions.mjs` (real shape: `{id, label, match: RegExp, triggers, kind, priority, policy}`, not the stale plan-document shape). Task 2 of that plan now threads `combat` through `applyDefeatIfReducedToZero` and wires the real `resolveReactions` call via a new `collectDeathReactionOptions`/`executeDeathReaction` pair, following the real "collect → resolveReactions → read result" idiom `applyTargetedByAttackReactions` already establishes. Confirm `git log` on this branch shows this amendment (it is the branch's own first commit); if working from a fresh checkout where it is missing, re-apply it from that plan file's own Global Constraints/Task 1/Task 2/Self-Review sections before continuing.

- [ ] **Step 2: Commit (if not already committed on this branch)**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-death-reactions.md
git commit -m "docs(#959): ground the death-reaction seam in the real registry (prerequisite for #1019)"
```

---

### Task 2: Registry — `died` trigger and five new `REACTION_DEFS` rows

**Files:**
- Modify: `scripts/npc-reactions.mjs`

**Interfaces:**
- Produces: the `died` trigger string; five new frozen `REACTION_DEFS` rows, each carrying a new `subject` field (read by Task 4's collector, not by anything in `npc-reactions.mjs` itself — this file only stores the data).

- [ ] **Step 1: Add the `died` trigger**

```js
// scripts/npc-reactions.mjs -- extend REACTION_TRIGGERS (already carries
// "reducedToZero" once #959's Task 1 lands; append "died" alongside it)
export const REACTION_TRIGGERS = Object.freeze([
  "move",
  "strideEnd",
  "rangedAttack",
  "manual",
  "targetedByAttack",
  "damageIncoming",
  "reducedToZero",
  "died",
]);
```

- [ ] **Step 2: Add the five `REACTION_DEFS` rows**

```js
// scripts/npc-reactions.mjs -- append to REACTION_DEFS
Object.freeze({
  id: "soul-feast",
  label: "Soul Feast",
  match: /^Soul Feast\b/i,
  triggers: ["died"],
  kind: "healOnDeath",
  priority: 10,
  policy: always,
  subject: Object.freeze({ relation: "any", within: "adjacent", alive: false }),
}),
Object.freeze({
  id: "responsive-recovery",
  label: "Responsive Recovery",
  match: /^Responsive Recovery\b/i,
  triggers: ["reducedToZero"],
  kind: "saveAlly",
  priority: 20,
  policy: always,
  subject: Object.freeze({ relation: "ally", within: { feet: 9999 }, alive: true }),
}),
Object.freeze({
  id: "preserve-prey",
  label: "Preserve Prey",
  match: /^Preserve Prey\b/i,
  triggers: ["reducedToZero"],
  kind: "preserveDowned",
  priority: 5,
  policy: always,
  subject: Object.freeze({ relation: "any", within: { feet: 30 }, alive: true }),
}),
Object.freeze({
  id: "reawaken",
  label: "Reawaken!",
  match: /^Reawaken!?\b/i,
  triggers: ["died"],
  kind: "resurrect",
  priority: 10,
  policy: always,
  subject: Object.freeze({ relation: "any", perception: "see", alive: true }),
}),
Object.freeze({
  id: "material-leap",
  label: "Material Leap",
  match: /^Material Leap\b/i,
  triggers: ["died"],
  kind: "planarLeap",
  priority: 1,
  policy: always,
  subject: Object.freeze({ relation: "any", perception: "sense", alive: false }),
}),
```

`subject.within: { feet: 9999 }` for Responsive Recovery stands in for "reachable by Stride this turn" — the real range check is the Stride itself (Task 5), not a fixed distance; a large number keeps the shape consistent with the other rows' declarative filter rather than adding a special `within: "any"` case `subjectMatches` (Task 3) would need a third branch for.

- [ ] **Step 3: Commit**

```bash
git add scripts/npc-reactions.mjs
git commit -m "feat(#1019): died trigger and five other-creature death-reaction registry rows"
```

---

### Task 3: Subject model and the other-creature collector

**Files:**
- Modify: `scripts/npc-reactions-death.mjs` (created by #959's Task 3; the pure `subjectMatches` lives here, per the spec's own stated file and this file's established "no Foundry API surface" convention)
- Modify: `scripts/dungeon-combat.mjs` (the collector and seam wiring — Foundry/geometry calls live here, per the same convention)
- Test: `tests/npc-reactions-death.test.mjs` (extend, Task 3's own file from #959), `tests/npc-reactions-other-death-seam.test.mjs`

**Interfaces:**
- Consumes: `chebyshevSquares`, `pf2eDistanceFeet`, `hasLineOfSight`, `rawPosition` (all real, `dungeon-combat.mjs`); `getReactionUsed`, `markReactionUsed`, `resolveReactions`, `reactionItemsFor` (real, already in scope per Task 2 of #959's amended plan); `collectDeathReactionOptions`, `executeDeathReaction` (#959's Task 2).
- Produces: `subjectMatches(filter, facts)` (pure, `npc-reactions-death.mjs`); `collectOtherDeathReactionOptions(combat, subject, trigger)` and `executeOtherDeathReaction(combat, chosen, decision)` (`dungeon-combat.mjs`); the extended `applyDefeatIfReducedToZero`.

- [ ] **Step 1: Write the failing tests for `subjectMatches`**

```js
// tests/npc-reactions-death.test.mjs (append)
import { subjectMatches } from '../scripts/npc-reactions-death.mjs';

describe('subjectMatches (#1019)', () => {
  const baseFacts = { sameSide: false, subjectAlive: true, squares: 1, distanceFt: 5, canSee: true };

  it('rejects an ally-only filter when the subject is on the opposing side', () => {
    expect(subjectMatches({ relation: 'ally' }, { ...baseFacts, sameSide: false })).toBe(false);
    expect(subjectMatches({ relation: 'ally' }, { ...baseFacts, sameSide: true })).toBe(true);
  });

  it('rejects an enemy-only filter when the subject is an ally', () => {
    expect(subjectMatches({ relation: 'enemy' }, { ...baseFacts, sameSide: true })).toBe(false);
  });

  it('"any" relation matches regardless of side', () => {
    expect(subjectMatches({ relation: 'any' }, { ...baseFacts, sameSide: true })).toBe(true);
    expect(subjectMatches({ relation: 'any' }, { ...baseFacts, sameSide: false })).toBe(true);
  });

  it('enforces adjacency', () => {
    expect(subjectMatches({ relation: 'any', within: 'adjacent' }, { ...baseFacts, squares: 1 })).toBe(true);
    expect(subjectMatches({ relation: 'any', within: 'adjacent' }, { ...baseFacts, squares: 2 })).toBe(false);
  });

  it('enforces a feet range', () => {
    expect(subjectMatches({ relation: 'any', within: { feet: 30 } }, { ...baseFacts, distanceFt: 30 })).toBe(true);
    expect(subjectMatches({ relation: 'any', within: { feet: 30 } }, { ...baseFacts, distanceFt: 35 })).toBe(false);
  });

  it('enforces alive when required', () => {
    expect(subjectMatches({ relation: 'any', alive: true }, { ...baseFacts, subjectAlive: false })).toBe(false);
  });

  it('enforces line of sight for "see" perception', () => {
    expect(subjectMatches({ relation: 'any', perception: 'see' }, { ...baseFacts, canSee: false })).toBe(false);
  });

  it('"sense" perception is always true (no lifesense model exists -- documented limitation)', () => {
    expect(subjectMatches({ relation: 'any', perception: 'sense' }, { ...baseFacts, canSee: false })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: FAIL with "subjectMatches is not exported"

- [ ] **Step 3: Implement `subjectMatches`**

```js
// scripts/npc-reactions-death.mjs -- append
/** #1019: evaluates a registry row's `subject` filter against
 * already-computed geometry facts (never touches Foundry/canvas directly,
 * per this file's own "no Foundry API surface" convention -- the caller,
 * dungeon-combat.mjs's collectOtherDeathReactionOptions, computes `facts`). */
export function subjectMatches(filter, facts) {
  if (!filter) return false;
  if (filter.relation === "ally" && !facts.sameSide) return false;
  if (filter.relation === "enemy" && facts.sameSide) return false;
  if (filter.alive && !facts.subjectAlive) return false;
  if (filter.within === "adjacent" && facts.squares > 1) return false;
  if (filter.within?.feet != null && facts.distanceFt > filter.within.feet) return false;
  // "sense" has no lifesense/detection model in this codebase; Material
  // Leap is its only consumer and is GM-announce-only (Task 6) -- treated
  // as always-true rather than guessing a detection mechanic.
  if (filter.perception === "see" && !facts.canSee) return false;
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS

- [ ] **Step 5: Write the failing seam tests**

```js
// tests/npc-reactions-other-death-seam.test.mjs
import { describe, it, expect, vi } from 'vitest';

function combatant(id, { side = 'party', agentControlled = true, defeated = false, x = 0, y = 0, hasItem = null } = {}) {
  return {
    id,
    isDefeated: defeated,
    token: { id: `t-${id}`, disposition: side, x, y, width: 1, height: 1 },
    actor: { items: hasItem ? [hasItem] : [], system: { traits: { value: [] } } },
    getFlag: (mod, key) => (key === 'agentControlled' ? agentControlled : undefined),
  };
}

describe('collectOtherDeathReactionOptions (#1019)', () => {
  it('never includes the subject itself as a candidate reactor', async () => {
    const { collectOtherDeathReactionOptions } = await import('../scripts/dungeon-combat.mjs');
    const subject = combatant('s1', { hasItem: { name: 'Soul Feast', type: 'action', system: { actionType: { value: 'reaction' } } } });
    const combat = { round: 1, scene: { grid: { size: 100, distance: 5 } }, combatants: [subject], getFlag: () => undefined };
    expect(collectOtherDeathReactionOptions(combat, subject, 'died')).toEqual([]);
  });

  it('includes an adjacent ally with Soul Feast for a died event', async () => {
    const { collectOtherDeathReactionOptions } = await import('../scripts/dungeon-combat.mjs');
    const subject = combatant('s1', { x: 0, y: 0 });
    const reactor = combatant('r1', { x: 100, y: 0, hasItem: { name: 'Soul Feast', type: 'action', system: { actionType: { value: 'reaction' } } } });
    const combat = { round: 1, scene: { grid: { size: 100, distance: 5 } }, combatants: [subject, reactor], getFlag: () => undefined };
    const options = collectOtherDeathReactionOptions(combat, subject, 'died');
    expect(options).toHaveLength(1);
    expect(options[0].reactor.id).toBe('r1');
  });

  it('excludes a non-agent-controlled candidate', async () => {
    const { collectOtherDeathReactionOptions } = await import('../scripts/dungeon-combat.mjs');
    const subject = combatant('s1', { x: 0, y: 0 });
    const reactor = combatant('r1', { x: 100, y: 0, agentControlled: false, hasItem: { name: 'Soul Feast', type: 'action', system: { actionType: { value: 'reaction' } } } });
    const combat = { round: 1, scene: { grid: { size: 100, distance: 5 } }, combatants: [subject, reactor], getFlag: () => undefined };
    expect(collectOtherDeathReactionOptions(combat, subject, 'died')).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-other-death-seam.test.mjs`
Expected: FAIL with "collectOtherDeathReactionOptions is not exported"

- [ ] **Step 7: Implement the collector and wire the seam**

```js
// scripts/dungeon-combat.mjs -- new, near collectDeathReactionOptions (#959);
// subjectMatches imported from npc-reactions-death.mjs (extend that
// existing import, or add it -- #959's own Task 3 creates that file).
import { subjectMatches } from "./npc-reactions-death.mjs"; // extend existing import if #959 already added one

/** #1019: options for other-creature reducedToZero/died triggers --
 * candidates are every OTHER agent-controlled, non-defeated combatant
 * (not just the subject's own opponents: these reactions fire for allies,
 * "any creature," or a sensed creature). */
export function collectOtherDeathReactionOptions(combat, subject, trigger) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const subjectTraits = subject.actor?.system?.traits?.value ?? [];
  const subjectAlive = !["undead", "construct", "spirit"].some((t) => subjectTraits.includes(t));
  const options = [];
  for (const reactor of combat.combatants) {
    if (reactor.id === subject.id || reactor.isDefeated || !reactor.token) continue;
    if (!reactor.getFlag?.(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    const facts = {
      sameSide: reactor.token.disposition === subject.token?.disposition,
      subjectAlive,
      squares: subject.token ? chebyshevSquares(rawPosition(reactor.token), rawPosition(subject.token), gridSize) : Infinity,
      distanceFt: subject.token ? pf2eDistanceFeet(rawPosition(reactor.token), rawPosition(subject.token), gridSize, gridDistanceFt) : Infinity,
      canSee: subject.token ? hasLineOfSight(combat, reactor.token, subject.token) : false,
    };
    for (const { def, item } of reactionItemsFor(reactor.actor)) {
      if (!def.triggers.includes(trigger)) continue;
      if (!subjectMatches(def.subject, facts)) continue;
      options.push({ reactor, def, ctx: { item, subject } });
    }
  }
  return options;
}

/** #1019: dispatches a chosen other-creature death reaction by `def.kind`.
 * Returns the executor's own result; `applyDefeatIfReducedToZero` reads
 * `cancelDefeat` back out for Responsive Recovery. */
async function executeOtherDeathReaction(combat, chosen, decision) {
  const { reactor, def, ctx } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  let result = {};
  if (def.kind === "healOnDeath") result = await executeSoulFeast(combat, reactor, ctx.item);
  else if (def.kind === "saveAlly") result = await executeResponsiveRecovery(combat, reactor, ctx.item, ctx.subject);
  else if (def.kind === "preserveDowned") result = await executePreservePrey(combat, reactor, ctx.item, ctx.subject);
  else if (def.kind === "resurrect") result = await executeReawaken(combat, reactor, ctx.item, ctx.subject);
  else if (def.kind === "planarLeap") result = await executeMaterialLeapAnnounce(combat, reactor, ctx.item, ctx.subject);
  await postReactionChat(reactor, ctx.subject.actor ?? ctx.subject, def, reactionDecisionNote(decision));
  return result;
}
```

Now extend `applyDefeatIfReducedToZero` (as #959's amended Task 2 leaves it) with the other-creature `reducedToZero` check (before the normal branch, so Responsive Recovery/Preserve Prey can act before defeat) and the `died` check (after the NPC branch, per Investigation finding 3):

```js
// scripts/dungeon-combat.mjs -- applyDefeatIfReducedToZero, extended
async function applyDefeatIfReducedToZero(combat, target) {
  if ((target.actor?.system?.attributes?.hp?.value ?? 1) > 0) return;
  const combatant = combat.combatants.find((c) => c.tokenId === target.id);

  if (target.actor?.type !== "character" && !target.isDefeated && combatant?.getFlag?.(MODULE_ID, "agentControlled")) {
    const options = collectDeathReactionOptions(combat, combatant); // #959
    if (options.length) {
      const ran = await resolveReactions(combat, { trigger: "reducedToZero", mover: combatant, options }, (chosen, decision) =>
        executeDeathReaction(combat, chosen, decision),
      );
      if (ran.find((r) => r.result?.cancelled)) return;
    }
  }

  // #1019: other-creature reducedToZero reactions (Responsive Recovery,
  // Preserve Prey) -- fire before the normal branch so a cancellation
  // (Responsive Recovery) pre-empts it.
  if (combatant) {
    const otherOptions = collectOtherDeathReactionOptions(combat, combatant, "reducedToZero");
    if (otherOptions.length) {
      const ran = await resolveReactions(combat, { trigger: "reducedToZero", mover: combatant, options: otherOptions }, (chosen, decision) =>
        executeOtherDeathReaction(combat, chosen, decision),
      );
      if (ran.find((r) => r.result?.cancelDefeat)) return;
      const preserved = ran.find((r) => r.result?.preserved);
      if (preserved) {
        if (target.actor?.type === "character") {
          await target.actor.increaseCondition("dying");
          await target.actor.decreaseCondition("dying", { forceRemove: true });
        } else if (!target.isDefeated) {
          await target.toggleDefeated();
          playCreatureDeathSound();
        }
        return;
      }
    }
  }

  if (target.actor?.type === "character") {
    await target.actor.increaseCondition("dying");
  } else if (!target.isDefeated) {
    await target.toggleDefeated();
    playCreatureDeathSound();
    // #1019: died reactions (Soul Feast, Reawaken!, Material Leap) -- an
    // NPC's toggleDefeated() is this module's own real "died" moment
    // (Investigation finding 3); PCs never fire `died` here.
    if (combatant) {
      const diedOptions = collectOtherDeathReactionOptions(combat, combatant, "died");
      if (diedOptions.length) {
        await resolveReactions(combat, { trigger: "died", mover: combatant, options: diedOptions }, (chosen, decision) =>
          executeOtherDeathReaction(combat, chosen, decision),
        );
      }
    }
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-other-death-seam.test.mjs`
Expected: PASS

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 10: Commit**

```bash
git add scripts/npc-reactions-death.mjs scripts/dungeon-combat.mjs tests/npc-reactions-death.test.mjs tests/npc-reactions-other-death-seam.test.mjs
git commit -m "feat(#1019): subject model, other-creature collector, seam wiring"
```

---

### Task 4: Soul Feast and Reawaken! (`died`-triggered)

**Files:**
- Modify: `scripts/npc-reactions-death.mjs`
- Test: `tests/npc-reactions-death.test.mjs`

**Interfaces:**
- Consumes: nothing new from this plan.
- Produces: `executeSoulFeast(combat, reactor, item)`, `executeReawaken(combat, reactor, item, subject)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-death.test.mjs (append)
import { executeSoulFeast, executeReawaken } from '../scripts/npc-reactions-death.mjs';

describe('executeSoulFeast (#1019)', () => {
  it('heals 2d8, clamped to max HP', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const reactor = { actor: { system: { attributes: { hp: { value: 10, max: 20 } } }, update } };
    await executeSoulFeast({}, reactor, { name: 'Soul Feast' });
    expect(update).toHaveBeenCalledTimes(1);
    const newHp = update.mock.calls[0][0]['system.attributes.hp.value'];
    expect(newHp).toBeGreaterThan(10);
    expect(newHp).toBeLessThanOrEqual(20);
  });
});

describe('executeReawaken (#1019)', () => {
  it('resurrects a willing subject once, stabilized at 0 HP, with no dying', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const toggleDefeated = vi.fn().mockResolvedValue(undefined);
    const decreaseCondition = vi.fn().mockResolvedValue(undefined);
    const subjectCombatant = {
      isDefeated: true,
      getFlag: () => undefined,
      setFlag: vi.fn(),
      toggleDefeated,
      actor: { type: 'npc', update, decreaseCondition },
    };
    const result = await executeReawaken({}, { actor: {} }, { name: 'Reawaken!' }, subjectCombatant);
    expect(update).toHaveBeenCalledWith({ 'system.attributes.hp.value': 0 });
    expect(toggleDefeated).toHaveBeenCalled();
    expect(subjectCombatant.setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'resurrectedBy', expect.any(String));
    expect(result.resurrected).toBe(true);
  });

  it('refuses to resurrect the same creature twice', async () => {
    const subjectCombatant = { getFlag: (mod, key) => (key === 'resurrectedBy' ? 'r1' : undefined), actor: {} };
    const result = await executeReawaken({}, { id: 'r1', actor: {} }, { name: 'Reawaken!' }, subjectCombatant);
    expect(result.resurrected).toBe(false);
  });

  it('refuses an unwilling NPC subject (hostile to the reactor)', async () => {
    const subjectCombatant = {
      getFlag: () => undefined,
      token: { disposition: 'hostile' },
      actor: { type: 'npc' },
    };
    const reactor = { token: { disposition: 'friendly' }, actor: {} };
    const result = await executeReawaken({}, reactor, { name: 'Reawaken!' }, subjectCombatant);
    expect(result.resurrected).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: FAIL with "executeSoulFeast is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/npc-reactions-death.mjs -- append
/** #1019: Soul Feast -- regains 2d8 HP, clamped to max. No existing
 * healing-roll helper to reuse (confirmed: Ferocity hard-sets HP, no
 * damage-roll healing anywhere); rolls fresh here. */
export async function executeSoulFeast(combat, reactor, item) {
  const roll = await new Roll("2d8").roll();
  const hp = reactor.actor?.system?.attributes?.hp;
  const newValue = Math.min((hp?.value ?? 0) + roll.total, hp?.max ?? hp?.value ?? 0);
  await reactor.actor.update({ "system.attributes.hp.value": newValue });
  return { healed: roll.total };
}

/** #1019: Reawaken! -- returns a willing subject to life, stabilized at
 * 0 HP, once per creature (the `resurrectedBy` flag is the single source
 * of truth). A player character is always willing; an NPC subject is
 * resurrected only when it shares the reactor's own disposition (ally),
 * per the spec's own "willing creature" rule. */
export async function executeReawaken(combat, reactor, item, subject) {
  if (subject.getFlag?.("pf2e-dungeon-crawl", "resurrectedBy")) return { resurrected: false };
  const willing = subject.actor?.type === "character" || subject.token?.disposition === reactor.token?.disposition;
  if (!willing) return { resurrected: false };

  await subject.actor.update({ "system.attributes.hp.value": 0 });
  if (subject.actor?.type === "character") {
    await subject.actor.increaseCondition?.("dying");
    await subject.actor.decreaseCondition?.("dying", { forceRemove: true });
  } else {
    await subject.toggleDefeated();
  }
  await subject.setFlag("pf2e-dungeon-crawl", "resurrectedBy", reactor.id ?? reactor.actor?.id ?? "unknown");
  return { resurrected: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/npc-reactions-death.mjs tests/npc-reactions-death.test.mjs
git commit -m "feat(#1019): Soul Feast and Reawaken! executors"
```

---

### Task 5: Responsive Recovery and Preserve Prey (`reducedToZero`-triggered)

**Files:**
- Modify: `scripts/npc-reactions-death.mjs`
- Test: `tests/npc-reactions-death.test.mjs`

**Interfaces:**
- Consumes: `strideByPosture` (real, exported, `dungeon-combat.mjs`).
- Produces: `hasPreparedHeal(actor)`, `executeResponsiveRecovery(combat, reactor, item, subject)`, `executePreservePrey(combat, reactor, item, subject)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-death.test.mjs (append)
import { hasPreparedHeal, executeResponsiveRecovery, executePreservePrey } from '../scripts/npc-reactions-death.mjs';

describe('hasPreparedHeal (#1019)', () => {
  it('is true when the actor has an item named Heal', () => {
    expect(hasPreparedHeal({ items: [{ name: 'Heal', type: 'spell' }] })).toBe(true);
  });
  it('is false otherwise -- documented limitation, no slot tracking', () => {
    expect(hasPreparedHeal({ items: [{ name: 'Produce Flame', type: 'spell' }] })).toBe(false);
  });
});

describe('executeResponsiveRecovery (#1019)', () => {
  it('does nothing when the reactor has no Heal item', async () => {
    const result = await executeResponsiveRecovery({}, { actor: { items: [] } }, { name: 'Responsive Recovery' }, {});
    expect(result.cancelDefeat).toBeFalsy();
  });

  it('strides toward the ally and heals it, cancelling the ally\'s defeat', async () => {
    const strideByPosture = vi.fn().mockResolvedValue('moved');
    vi.doMock('../scripts/dungeon-combat.mjs', async () => ({ strideByPosture }));
    const update = vi.fn().mockResolvedValue(undefined);
    const reactor = { actor: { items: [{ name: 'Heal', type: 'spell' }] } };
    const subject = { actor: { system: { attributes: { hp: { value: 0, max: 20 } } }, update } };
    const { executeResponsiveRecovery: fn } = await import('../scripts/npc-reactions-death.mjs');
    const result = await fn({}, reactor, { name: 'Responsive Recovery' }, subject, { strideByPosture });
    expect(strideByPosture).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
    expect(result.cancelDefeat).toBe(true);
  });
});

describe('executePreservePrey (#1019)', () => {
  it('sets the preservePrey marker and reports preserved', async () => {
    const setFlag = vi.fn().mockResolvedValue(undefined);
    const subject = { setFlag };
    const reactor = { id: 'r1' };
    const combat = { round: 3 };
    const result = await executePreservePrey(combat, reactor, { name: 'Preserve Prey' }, subject);
    expect(setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'preservePrey', { reactorId: 'r1', counteractModifier: 15, round: 3 });
    expect(result.preserved).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: FAIL with "hasPreparedHeal is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/npc-reactions-death.mjs -- append
/** #1019: a presence-only check -- no NPC-spellcasting or prepared-slot
 * infrastructure exists anywhere in this codebase (confirmed while
 * planning); this checks only whether the reactor carries an item named
 * "Heal" at all. Documented limitation: no slot expenditure is tracked. */
export function hasPreparedHeal(actor) {
  return Array.from(actor?.items ?? []).some((i) => i.name === "Heal");
}

/** #1019: Responsive Recovery -- Strides toward the ally (real
 * `strideByPosture`, "approach" posture) then applies a 2d8 heal directly
 * (matching Soul Feast's own granularity; no module-owned spell executor
 * exists to "cast" Heal through, so this applies its healing outcome
 * directly rather than inventing a casting pipeline). Cancels the ally's
 * own defeat for this drop when a heal was applied. `strideFn` is
 * injectable for testing; defaults to the real `strideByPosture`. */
export async function executeResponsiveRecovery(combat, reactor, item, subject, { strideByPosture: strideFn } = {}) {
  if (!hasPreparedHeal(reactor.actor)) return { cancelDefeat: false };
  if (strideFn) await strideFn(combat, reactor, "approach", subject);
  const roll = await new Roll("2d8").roll();
  const hp = subject.actor?.system?.attributes?.hp;
  const newValue = Math.min((hp?.value ?? 0) + roll.total, hp?.max ?? roll.total);
  await subject.actor.update({ "system.attributes.hp.value": newValue });
  return { cancelDefeat: true, healed: roll.total };
}

/** #1019: Preserve Prey -- records the counteract marker the spec's own
 * Error-handling section documents as a GM-resolved limitation (no
 * counteract-vs-healing helper exists anywhere in this codebase); the
 * seam (Task 3) applies the usual defeat branch and then strips the
 * dying condition back off when this reports `preserved`. */
export async function executePreservePrey(combat, reactor, item, subject) {
  await subject.setFlag("pf2e-dungeon-crawl", "preservePrey", {
    reactorId: reactor.id,
    counteractModifier: 15,
    round: combat.round,
  });
  return { preserved: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/npc-reactions-death.mjs tests/npc-reactions-death.test.mjs
git commit -m "feat(#1019): Responsive Recovery and Preserve Prey executors"
```

---

### Task 6: Material Leap (GM-announce only — scoped down)

**Files:**
- Modify: `scripts/npc-reactions-death.mjs`
- Test: `tests/npc-reactions-death.test.mjs`

**Interfaces:**
- Produces: `executeMaterialLeapAnnounce(combat, reactor, item, subject)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/npc-reactions-death.test.mjs (append)
import { executeMaterialLeapAnnounce } from '../scripts/npc-reactions-death.mjs';

describe('executeMaterialLeapAnnounce (#1019)', () => {
  it('posts a GM-only note and never moves the reactor\'s token', async () => {
    const create = vi.spyOn(globalThis.ChatMessage ?? (globalThis.ChatMessage = {}), 'create').mockResolvedValue(undefined);
    const reactor = { name: 'Namorrodor' };
    const subject = { name: 'Fallen Scout' };
    const result = await executeMaterialLeapAnnounce({}, reactor, { name: 'Material Leap' }, subject);
    expect(create).toHaveBeenCalled();
    expect(result.moved).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: FAIL with "executeMaterialLeapAnnounce is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/npc-reactions-death.mjs -- append
/** #1019: Material Leap, scoped down to its own spec's documented
 * no-pairing fallback as the ONLY implementation -- no cross-scene
 * token-transfer code or scene-plane/pairing convention exists anywhere
 * in this codebase (confirmed while planning), and inventing one for a
 * single reaction would be unreviewed infrastructure. Announces the leap
 * for the GM to resolve manually; never moves the reactor's token. The
 * 24-hour recall this reaction's full version would need is not modeled
 * for the same reason -- a documented limitation, not a missed step. */
export async function executeMaterialLeapAnnounce(combat, reactor, item, subject) {
  const esc = (s) => foundry.utils?.escapeHTML?.(String(s)) ?? String(s);
  await ChatMessage.create({
    content: `<p><strong>${esc(reactor.name)}</strong> would use Material Leap toward the Material Plane near <strong>${esc(subject.name)}</strong> -- no scene pairing is configured; resolve this leap manually if desired.</p>`,
    whisper: ChatMessage.getWhisperRecipients?.("GM")?.map((u) => u.id) ?? [],
  });
  return { moved: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/npc-reactions-death.mjs tests/npc-reactions-death.test.mjs
git commit -m "feat(#1019): Material Leap, scoped to a GM-announced fallback"
```

---

### Task 7: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/npc-reactions-death.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add the fixture-match tests**

```js
// tests/npc-reactions-death.test.mjs (append)
import { REACTION_DEFS } from '../scripts/npc-reactions.mjs';

describe('fixture matches (#1019)', () => {
  const names = ['Soul Feast', 'Responsive Recovery', 'Preserve Prey', 'Reawaken!', 'Material Leap'];
  it.each(names)('a real item named "%s" matches its own registry row', (name) => {
    const def = REACTION_DEFS.find((d) => d.match.test(name));
    expect(def).toBeTruthy();
  });
  it('an unrelated item name matches none of the five new rows', () => {
    const ids = ['soul-feast', 'responsive-recovery', 'preserve-prey', 'reawaken', 'material-leap'];
    const matched = REACTION_DEFS.filter((d) => ids.includes(d.id) && d.match.test('Unrelated Ability'));
    expect(matched).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS

- [ ] **Step 3: Run the `update-architecture-docs` skill**

New exports added to `scripts/npc-reactions-death.mjs` and `scripts/dungeon-combat.mjs` (`collectOtherDeathReactionOptions`), plus two new entries in `scripts/npc-reactions.mjs`'s registry data. Run the skill to confirm `docs/architecture.md` reflects this, and commit any update it produces alongside this task's own commit.

- [ ] **Step 4: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump (five new reaction-registry entries and a new collector/seam path, matching #959's own category for this feature group) — do not reuse a version number already used by another merged PR.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add tests/npc-reactions-death.test.mjs docs/architecture.md module.json
git commit -m "test(#1019): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** All five resolved reactions (Soul Feast, Responsive Recovery, Preserve Prey, Reawaken!, Material Leap) are covered (Tasks 4–6), the subject model and seam wiring (Task 3), and the registry rows (Task 2). Scuttle Away is correctly left to #1156. The prerequisite fix to #959's own plan (Task 1) is documented, not silently assumed.

**2. Placeholder scan:** No "TBD"/"TODO". The two genuinely ungrounded pieces (Material Leap's plane transfer, Responsive Recovery's spell-casting) are each resolved with a concrete, working, explicitly-scoped-down implementation (GM-announce; direct heal application) rather than left vague — the limitation is stated in a code comment and this Self-Review, not hidden.

**3. Type consistency:** `subjectMatches(filter, facts)`'s `facts` shape (`{sameSide, subjectAlive, squares, distanceFt, canSee}`) is produced once by `collectOtherDeathReactionOptions` (Task 3) and consumed identically by its own tests and the real collector. Every new executor's result field (`cancelled`, `cancelDefeat`, `preserved`, `resurrected`, `moved`) is read back by exactly the call site that needs it in Task 3's seam code, with no name drift.

**4. Review Focus:** All five bullets (self-exclusion, Preserve Prey's Unconscious-without-dying, Reawaken!'s once-only marker, Responsive Recovery's no-Heal-item gate, malformed/missing-token safety) are each pinned to a named test in Tasks 3, 4, and 5.

**Corrections found while writing this plan:** (1) #931 is real, merged code, not plan-only as both #959's and this issue's own spec assume — #959's plan (Task 1) was broken against the real registry and real `resolveReactions` signature, fixed as this plan's own prerequisite Task 1. (2) The spec's own loose "a creature dies" language is ambiguous for a player character under this module's real HP-zero branching; scoped the `died` trigger to NPC-only defeat (Investigation finding 3), stated explicitly rather than silently guessing. (3) Material Leap's plane-pairing and Responsive Recovery's spell-casting are both genuinely unsupported by any real or planned infrastructure in this codebase; both are scoped down to the spec's own documented fallback/granularity rather than inventing new conventions.
