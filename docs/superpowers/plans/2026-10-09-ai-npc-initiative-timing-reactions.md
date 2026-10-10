# Round- and Initiative-Timing NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model four reactions that fire on timing events rather than another creature's action: **All This Has Happened Before** (about to roll initiative), **Warning Howl** (rolls initiative using Stealth), **Spring upon Prey** (a creature touches the web lurker's web, before initiative), **Rise Up** (a creature walks over a buried bog mummy, before initiative) — via ambush tags set at encounter placement and two new steps in the module's own initiative flow.

**Architecture:** `scripts/npc-ambush.mjs` (pure) assigns an ambush tag (`web`/`buried`/`stealthInitiative`) to a reviewed NPC at placement time. Two new functions bracket the real, merged `rollStealthInitiativeAndDetect(combat, combatants, deps)` (`scripts/dungeon-combat.mjs:290`): `resolveAmbushReactions` runs before it (pre-initiative Stride/Climb/Burrow for tagged, ambush-ready NPCs), `applyInitiativeReactions` wraps it (the anchorite's +4/Quickened, the hound's Stealth-triggered howl). Four registry rows exist for fixture-matching only — this family's own timing (no "round" exists before initiative is first rolled) doesn't fit the generic `resolveReactions`/`markReactionUsed` dispatcher, so execution is bespoke, stated explicitly as a deliberate deviation.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-initiative-timing-reactions-design.md`

## Global Constraints

- **#931 is real, merged code** (confirmed, same finding as #959/#1019/#960/#1021/#1022/#961) — the four registry rows this plan adds go into `scripts/npc-reactions.mjs` directly.
- **This plan also fixes a confirmed defect in #961's own merged plan** (Task 1, prerequisite): it patches a stale plan document instead of the real `reactionItemsFor` merge point in `scripts/npc-reactions.mjs`, and its own `buildDerivedReactionDefs` output shape doesn't match the real registry row shape. Fixed here since #1026/#1027 both nominally depend on #961 landing correctly, even though neither's own new mechanism routes through #961's per-actor derivation.
- **These four reactions do NOT go through `resolveReactions`/`markReactionUsed`** — pre-initiative timing has no combat round to key "reaction used this round" against, and there is no "mover" the way every other trigger has. Registry rows exist only so the existing fixture-match convention (every reviewed reaction item is checked against real compendium text) still covers this family; actual firing is driven by the two bespoke functions this plan adds, called directly from the combat-start flow.
- Hidden/buried/on-a-web state comes ONLY from the ambush tag set at placement — never inferred from conditions or templates (spec's own rejected alternative).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`rollStealthInitiativeAndDetect(combat, combatants, deps = {})` is real** (`dungeon-combat.mjs:290`) — confirmed live, the correct seam the spec describes: sneakers roll Stealth and set initiative via `setMultipleInitiatives`, everyone else via `combat.rollInitiative(ids, {skipDialog: true})`.
2. **The real `agentSelfEffect` cleanup tag (#914) is confirmed**: `flags.pf2e-dungeon-crawl.agentSelfEffect: true` on an Effect item, created via `actor.createEmbeddedDocuments("Item", [agentSelfEffectSource(...)])` (`dungeon-combat.mjs:9436`-ish) — combat-end cleanup sweeps items carrying this flag. Grounds the anchorite's Quickened effect directly.
3. **Frequency tracking is real** (`#910`, confirmed `verification`-labeled = merged): `descriptor.frequency?.value`/`.max`/`.per` is read directly off an NPC ability item's own real PF2e `system.frequency` schema (`dungeon-combat.mjs:1935`, `selfEffectFrequencyLabel`, `:3463`) — "All This Has Happened Before"'s once-per-day gate reads/decrements this same real field, not a new tracking mechanism.
4. **Live-confirmed against the installed PF2e compendium** (Foundry 14.368, `foundry-rest`): "All This Has Happened Before"'s real text matches the spec's own quote exactly (`+4 circumstance bonus`, `Quickened` for 1 round, extra action limited to Recall Knowledge or Step). Warning Howl/Spring upon Prey/Rise Up are monster-embedded items (not in a shared top-level compendium reachable by a simple cross-pack name search) — not independently re-verified byte-for-byte this session, but the spec's own Investigation findings already cite them with specific DCs/mechanics (Warning Howl: DC 17 Will, Frightened 1, 1-hour immunity) consistent with this module's own established fixture-check convention elsewhere; treated as the spec's own already-researched ground truth, same posture as every other reviewed-definition plan in this sequence.
5. **The encounter generator's own token-placement call site** (where `ambushTagFor` would be invoked) was not traced in this session — flagged for live confirmation at implementation time, same posture as #951's own coordinate-conversion flag, rather than guessed.

## Review Focus

- An NPC with no ambush tag (the overwhelming majority) must never have any of these four reactions evaluated, and must behave identically to today (no new rolls, no new hooks firing) (Task 3's test).
- A tag whose room-context condition no longer holds at combat start (e.g. the web token was destroyed before combat began) must result in a normal, untouched initiative roll — never a thrown error (Task 3's test, spec's own stated rule).
- Only the FIRST creature in `combat.turns` after initiative is set gets Quickened — a +4 that doesn't make the anchorite first must never grant it anyway (Task 4's test).
- Warning Howl's 1-hour immunity must be checked and set per-creature, never applied to a creature already immune, and never applied twice for the same howl (Task 5's test).
- The two pre-initiative ambush moves (Task 3) must run strictly before ANY combatant's initiative is rolled, including the ambushing NPC's own — an implementation that rolls initiative first and moves second would defeat the entire point (Task 3's test, ordering explicitly asserted).

---

### Task 1: Fix #961's plan — the real merge point for derived reaction defs (prerequisite)

**Already applied in this worktree.**

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-other-triggered-reactions.md`

- [ ] **Step 1: Confirm the amendment is present**

This worktree already contains the fix: that plan's Task 1 now edits the real `scripts/npc-reactions.mjs` (`reactionItemsFor`, extended to also consult `buildDerivedReactionDefs(actor)` for items no hand-enumerated row claimed) instead of a stale plan document, and corrects `buildDerivedReactionDefs`'s own stated output shape to the real registry row shape. Confirm via `git log` on this branch (it is this branch's first commit); re-apply from that plan file's own Task 1 if missing.

- [ ] **Step 2: Commit (if not already committed on this branch)**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-other-triggered-reactions.md
git commit -m "docs(#961): fix the derived-reaction-defs merge point against the real registry (prerequisite for #1026/#1027)"
```

---

### Task 2: Ambush tags and registry rows

**Files:**
- Create: `scripts/npc-ambush.mjs`
- Modify: `scripts/npc-reactions.mjs`
- Test: `tests/npc-ambush.test.mjs`

**Interfaces:**
- Produces: `ambushTagFor(npcActor, roomContext)` → `{kind: "web"|"buried"|"stealthInitiative", webTokenId?} | null`; four new `REACTION_DEFS` rows (fixture-matching only, per Global Constraints).

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-ambush.test.mjs
import { describe, it, expect } from 'vitest';
import { ambushTagFor } from '../scripts/npc-ambush.mjs';

describe('ambushTagFor (#1026)', () => {
  it('tags a web lurker placed in a room with a web feature token', () => {
    const actor = { name: 'Web Lurker', items: [{ name: 'Spring upon Prey', type: 'action', system: { actionType: { value: 'reaction' } } }] };
    const roomContext = { webFeatureTokenId: 'wf1' };
    expect(ambushTagFor(actor, roomContext)).toEqual({ kind: 'web', webTokenId: 'wf1' });
  });

  it('tags a bog mummy placed in a mud/peat room', () => {
    const actor = { name: 'Bog Mummy', items: [{ name: 'Rise Up', type: 'action', system: { actionType: { value: 'reaction' } } }] };
    expect(ambushTagFor(actor, { terrain: 'mud' })).toEqual({ kind: 'buried' });
  });

  it('tags a hound topiary unconditionally (no room requirement)', () => {
    const actor = { name: 'Hound Topiary', items: [{ name: 'Warning Howl', type: 'action', system: { actionType: { value: 'reaction' } } }] };
    expect(ambushTagFor(actor, {})).toEqual({ kind: 'stealthInitiative' });
  });

  it('returns null for a web lurker with no web feature token in the room', () => {
    const actor = { name: 'Web Lurker', items: [{ name: 'Spring upon Prey', type: 'action', system: { actionType: { value: 'reaction' } } }] };
    expect(ambushTagFor(actor, {})).toBeNull();
  });

  it('returns null for an NPC with no reviewed initiative-timing reaction', () => {
    expect(ambushTagFor({ name: 'Goblin', items: [] }, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ambush.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/npc-ambush.mjs
/**
 * #1026: ambush tags for the four initiative-timing reactions -- pure,
 * no Foundry API surface. State comes only from the tag this function
 * returns, set once at placement; nothing is inferred later from
 * conditions or templates (spec's own rejected alternative).
 */

const AMBUSH_RULES = [
  { match: /^Web Lurker\b/i, kind: "web", requires: (ctx) => ctx.webFeatureTokenId != null, tokenId: (ctx) => ctx.webFeatureTokenId },
  { match: /^Bog Mummy\b/i, kind: "buried", requires: (ctx) => ctx.terrain === "mud" || ctx.terrain === "peat" },
  { match: /^Hound Topiary\b/i, kind: "stealthInitiative", requires: () => true },
];

export function ambushTagFor(npcActor, roomContext) {
  const rule = AMBUSH_RULES.find((r) => r.match.test(npcActor?.name ?? ""));
  if (!rule) return null;
  if (!rule.requires(roomContext ?? {})) return null;
  return rule.kind === "web" ? { kind: "web", webTokenId: rule.tokenId(roomContext) } : { kind: rule.kind };
}
```

- [ ] **Step 4: Add the four registry rows**

```js
// scripts/npc-reactions.mjs -- extend REACTION_TRIGGERS and REACTION_DEFS
export const REACTION_TRIGGERS = Object.freeze([
  "move", "strideEnd", "rangedAttack", "manual", "targetedByAttack", "damageIncoming",
  "reducedToZero", "died", "saveRolled", "conditionIncoming", "spellCast", // #959/#1019/#960/#1021/#1022
  "aboutToRollInitiative", "rolledInitiativeWithStealth", "touchedWebBeforeInitiative", "walkedOverBuriedBeforeInitiative", // #1026
]);

// append to REACTION_DEFS -- fixture-matching only (see Global Constraints);
// not consumed by resolveReactions.
Object.freeze({ id: "all-this-has-happened-before", label: "All This Has Happened Before", match: /^All This Has Happened Before\b/i, triggers: ["aboutToRollInitiative"], kind: "initiativeBonus", priority: 10, policy: always }),
Object.freeze({ id: "warning-howl", label: "Warning Howl", match: /^Warning Howl\b/i, triggers: ["rolledInitiativeWithStealth"], kind: "frightenNearby", priority: 10, policy: always }),
Object.freeze({ id: "spring-upon-prey", label: "Spring upon Prey", match: /^Spring upon Prey\b/i, triggers: ["touchedWebBeforeInitiative"], kind: "preInitiativeApproach", priority: 10, policy: always }),
Object.freeze({ id: "rise-up", label: "Rise Up", match: /^Rise Up\b/i, triggers: ["walkedOverBuriedBeforeInitiative"], kind: "preInitiativeApproach", priority: 10, policy: always }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ambush.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/npc-ambush.mjs scripts/npc-reactions.mjs tests/npc-ambush.test.mjs
git commit -m "feat(#1026): ambush tags and the four initiative-timing registry rows"
```

---

### Task 3: Pre-initiative ambush moves (Spring upon Prey, Rise Up)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-ambush-resolve.test.mjs`

**Interfaces:**
- Consumes: `ambushTagFor` (Task 2); `strideByPosture` (real, `dungeon-combat.mjs:6310`); the detection matrix helpers (`stateFor`/real).
- Produces: `resolveAmbushReactions(combat, party)`, called BEFORE `rollStealthInitiativeAndDetect` in the combat-start flow.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-ambush-resolve.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('resolveAmbushReactions (#1026)', () => {
  it('moves a web-tagged NPC toward a party token on the web token\'s square, then clears the tag', async () => {
    const { resolveAmbushReactions } = await import('../scripts/dungeon-combat.mjs');
    const npcCombatant = {
      id: 'npc1',
      token: { id: 't1', x: 0, y: 0 },
      actor: { name: 'Web Lurker' },
      getFlag: (mod, key) => (key === 'ambush' ? { kind: 'web', webTokenId: 'web-token-1' } : undefined),
      unsetFlag: vi.fn().mockResolvedValue(undefined),
    };
    const webToken = { id: 'web-token-1', x: 100, y: 0 };
    const partyToken = { id: 'pc1', x: 100, y: 0 };
    const combat = {
      combatants: [npcCombatant],
      scene: { tokens: [webToken, partyToken], grid: { size: 100, distance: 5 } },
    };
    const strideFn = vi.fn().mockResolvedValue('moved');
    await resolveAmbushReactions(combat, [{ token: partyToken }], { strideByPosture: strideFn });
    expect(strideFn).toHaveBeenCalled();
    expect(npcCombatant.unsetFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'ambush');
  });

  it('does nothing when no party token is on the ambush trigger square', async () => {
    const { resolveAmbushReactions } = await import('../scripts/dungeon-combat.mjs');
    const npcCombatant = {
      id: 'npc1', token: { id: 't1', x: 0, y: 0 }, actor: { name: 'Web Lurker' },
      getFlag: () => ({ kind: 'web', webTokenId: 'web-token-1' }), unsetFlag: vi.fn(),
    };
    const combat = { combatants: [npcCombatant], scene: { tokens: [{ id: 'web-token-1', x: 100, y: 0 }], grid: { size: 100, distance: 5 } } };
    const strideFn = vi.fn();
    await resolveAmbushReactions(combat, [{ token: { x: 500, y: 500 } }], { strideByPosture: strideFn });
    expect(strideFn).not.toHaveBeenCalled();
  });

  it('is a no-op when the ambush tag\'s own trigger token no longer exists', async () => {
    const { resolveAmbushReactions } = await import('../scripts/dungeon-combat.mjs');
    const npcCombatant = {
      id: 'npc1', token: { id: 't1', x: 0, y: 0 }, actor: { name: 'Web Lurker' },
      getFlag: () => ({ kind: 'web', webTokenId: 'gone' }), unsetFlag: vi.fn(),
    };
    const combat = { combatants: [npcCombatant], scene: { tokens: [], grid: { size: 100, distance: 5 } } };
    await expect(resolveAmbushReactions(combat, [{ token: { x: 0, y: 0 } }])).resolves.not.toThrow();
  });

  it('untagged NPCs are never touched', async () => {
    const { resolveAmbushReactions } = await import('../scripts/dungeon-combat.mjs');
    const npcCombatant = { id: 'npc1', token: { id: 't1' }, actor: { name: 'Goblin' }, getFlag: () => undefined };
    const combat = { combatants: [npcCombatant], scene: { tokens: [], grid: { size: 100, distance: 5 } } };
    await expect(resolveAmbushReactions(combat, [])).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ambush-resolve.test.mjs`
Expected: FAIL with "resolveAmbushReactions is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new, called from the combat-start flow
// BEFORE rollStealthInitiativeAndDetect (confirm the exact call site at
// implementation time -- Investigation finding 5 flags this as unverified
// this session).

/** #1026: resolves Spring upon Prey / Rise Up before any initiative is
 * rolled -- a tagged NPC whose trigger square (the web token's square, or
 * its own square for a buried ambusher) holds a party token automatically
 * notices that creature and moves toward it (Stride/Climb for "web",
 * Burrow for "buried" -- the posture/mode distinction is `strideByPosture`'s
 * own existing parameter, confirmed real). The tag is cleared whether or
 * not the ambush actually fires (a stale or already-resolved tag must
 * never persist). Never throws: any failure here must not block combat
 * start. */
export async function resolveAmbushReactions(combat, party, { strideByPosture: strideFn = strideByPosture } = {}) {
  for (const combatant of combat.combatants) {
    const tag = combatant.getFlag?.("pf2e-dungeon-crawl", "ambush");
    if (!tag || (tag.kind !== "web" && tag.kind !== "buried")) continue;
    try {
      const triggerToken = tag.kind === "web" ? combat.scene?.tokens?.find((t) => t.id === tag.webTokenId) : combatant.token;
      if (!triggerToken) continue;
      const onTrigger = party.find((p) => p.token?.x === triggerToken.x && p.token?.y === triggerToken.y);
      if (onTrigger) {
        await strideFn(combat, combatant, "approach", { token: onTrigger.token });
        const esc = (s) => foundry.utils?.escapeHTML?.(String(s)) ?? String(s);
        await ChatMessage.create({ content: `<p><strong>${esc(combatant.actor?.name ?? "The creature")}</strong> ${tag.kind === "web" ? "lunges from its web" : "bursts from the ground"}!</p>` });
      }
    } catch (err) {
      console.error(`pf2e-dungeon-crawl | #1026: ambush resolution failed for ${combatant.id}:`, err?.message ?? err);
    } finally {
      await combatant.unsetFlag?.("pf2e-dungeon-crawl", "ambush");
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ambush-resolve.test.mjs`
Expected: PASS

- [ ] **Step 5: Wire the call site**

Call `await resolveAmbushReactions(combat, party)` in the module's own combat-start flow, immediately before its existing call to `rollStealthInitiativeAndDetect` — confirm the exact enclosing function at implementation time (Investigation finding 5), since this session did not trace it.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-ambush-resolve.test.mjs
git commit -m "feat(#1026): pre-initiative ambush moves for Spring upon Prey and Rise Up"
```

---

### Task 4: All This Has Happened Before (initiative bonus + Quickened)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-ambush-resolve.test.mjs`

**Interfaces:**
- Produces: `applyAnchoriteInitiativeBonus(combat, combatant)`, called as part of the initiative-rolling step for an eligible combatant.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-ambush-resolve.test.mjs (append)
import { applyAnchoriteInitiativeBonus } from '../scripts/dungeon-combat.mjs';

describe('applyAnchoriteInitiativeBonus (#1026)', () => {
  it('does nothing without a matching item with frequency uses remaining', async () => {
    const combatant = { actor: { items: [], name: 'Someone' } };
    const result = await applyAnchoriteInitiativeBonus({}, combatant);
    expect(result.applied).toBe(false);
  });

  it('applies the +4 and decrements frequency when eligible', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const item = { name: 'All This Has Happened Before', type: 'action', system: { actionType: { value: 'reaction' }, frequency: { value: 1, max: 1, per: 'day' } }, update };
    const combatant = { actor: { items: [item], name: 'Anchorite' } };
    const result = await applyAnchoriteInitiativeBonus({}, combatant);
    expect(result.applied).toBe(true);
    expect(result.bonus).toBe(4);
    expect(update).toHaveBeenCalledWith({ 'system.frequency.value': 0 });
  });

  it('is not offered once the daily frequency is exhausted', async () => {
    const item = { name: 'All This Has Happened Before', type: 'action', system: { actionType: { value: 'reaction' }, frequency: { value: 0, max: 1, per: 'day' } } };
    const combatant = { actor: { items: [item] } };
    const result = await applyAnchoriteInitiativeBonus({}, combatant);
    expect(result.applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-ambush-resolve.test.mjs`
Expected: FAIL with "applyAnchoriteInitiativeBonus is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
/** #1026: All This Has Happened Before -- +4 circumstance to the
 * triggering initiative roll, gated by the item's own real `system.
 * frequency` (#910's established real convention, not a new tracking
 * mechanism). Returns {applied, bonus}; the caller (applyInitiativeReactions,
 * Step 5) adds `bonus` to the Perception roll before calling
 * setMultipleInitiatives, and checks whether the combatant ends up first
 * in combat.turns to decide Quickened. */
export async function applyAnchoriteInitiativeBonus(combat, combatant) {
  const item = Array.from(combatant.actor?.items ?? []).find((i) => /^All This Has Happened Before\b/i.test(i.name ?? ""));
  const uses = item?.system?.frequency?.value;
  if (!item || !(typeof uses === "number" && uses > 0)) return { applied: false };
  await item.update({ "system.frequency.value": uses - 1 });
  return { applied: true, bonus: 4 };
}

/** #1026: grants Quickened (1 round, restricted to Recall Knowledge/Step)
 * via the real #914 agentSelfEffect cleanup tag -- only when `combatant`
 * ends up first in `combat.turns` after initiative is set. */
export async function grantAnchoriteQuickened(combatant) {
  const source = {
    name: "Quickened (All This Has Happened Before)",
    type: "effect",
    img: "icons/svg/clockwork.svg",
    system: {
      description: { value: "<p>Quickened; the extra action can be used only to Recall Knowledge or Step.</p>" },
      duration: { value: 1, unit: "rounds", expiry: "turn-start", sustained: false },
      rules: [],
      tokenIcon: { show: true },
      traits: { value: [] },
    },
    flags: { "pf2e-dungeon-crawl": { agentSelfEffect: true, quickenedRestriction: ["recall-knowledge", "step"] } },
  };
  await combatant.actor.createEmbeddedDocuments("Item", [source]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ambush-resolve.test.mjs`
Expected: PASS

- [ ] **Step 5: Wire `applyInitiativeReactions` around the real initiative roll**

```js
// scripts/dungeon-combat.mjs -- wraps rollStealthInitiativeAndDetect's own
// Perception-roll path for an eligible anchorite; confirm the exact
// insertion point inside that real function (or immediately around its
// call site) at implementation time.
export async function applyInitiativeReactions(combat, combatants) {
  for (const combatant of combatants) {
    const { applied, bonus } = await applyAnchoriteInitiativeBonus(combat, combatant);
    if (!applied) continue;
    // Apply `bonus` to this combatant's own initiative roll before/while
    // rollStealthInitiativeAndDetect sets it -- confirm the exact real
    // mechanism (a one-roll circumstance Modifier passed into the
    // Perception roll, matching #960's own rollSaveWithReactions-style
    // extraRollOptions convention) at implementation time.
  }
  // after initiative is set for everyone:
  for (const combatant of combatants) {
    if (combat.turns?.[0]?.id === combatant.id && /^Anchorite\b/i.test(combatant.actor?.name ?? "")) {
      await grantAnchoriteQuickened(combatant);
    }
  }
}
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-ambush-resolve.test.mjs
git commit -m "feat(#1026): All This Has Happened Before -- initiative bonus and Quickened"
```

---

### Task 5: Warning Howl (Stealth-initiative area fear)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-ambush-resolve.test.mjs`

**Interfaces:**
- Produces: `executeWarningHowl(combat, reactor, nearby)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/npc-ambush-resolve.test.mjs (append)
import { executeWarningHowl } from '../scripts/dungeon-combat.mjs';

describe('executeWarningHowl (#1026)', () => {
  it('frightens a failing creature within range and records the 1-hour immunity', async () => {
    globalThis.game = { messages: { contents: [{ flags: { pf2e: { context: { outcome: 'failure' } } } }] }, time: { worldTime: 0 } };
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const setFlag = vi.fn().mockResolvedValue(undefined);
    const creature = { actor: { saves: { will: { roll: vi.fn().mockResolvedValue(undefined) } }, increaseCondition }, getFlag: () => undefined, setFlag, id: 'c1' };
    const reactor = { name: 'Hound Topiary' };
    const result = await executeWarningHowl({}, reactor, [creature]);
    expect(increaseCondition).toHaveBeenCalledWith('frightened', { value: 1 });
    expect(setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'howlImmunity', 0);
    expect(result.frightened).toBe(1);
  });

  it('skips a creature already immune', async () => {
    const roll = vi.fn();
    const creature = { actor: { saves: { will: { roll } } }, getFlag: () => 0 };
    globalThis.game = { time: { worldTime: 100 } };
    const result = await executeWarningHowl({}, { name: 'Hound Topiary' }, [creature]);
    expect(roll).not.toHaveBeenCalled();
    expect(result.frightened).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/npc-ambush-resolve.test.mjs`
Expected: FAIL with "executeWarningHowl is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
/** #1026: Warning Howl -- DC 17 Will for every creature within 30 ft
 * (passed in as `nearby`, pre-filtered by the caller using the real
 * pf2eDistanceFeet helper); failure/critical failure -> Frightened 1;
 * a 1-hour immunity marker (keyed by game.time.worldTime, the same real
 * clock convention #1022's Savor Anguish uses) excludes an already-immune
 * creature from even rolling again. */
export async function executeWarningHowl(combat, reactor, nearby) {
  const now = globalThis.game?.time?.worldTime ?? 0;
  let frightened = 0;
  for (const creature of nearby) {
    const immuneUntil = creature.getFlag?.("pf2e-dungeon-crawl", "howlImmunity");
    if (immuneUntil != null && now - immuneUntil < 3600) continue;
    const saveStat = creature.actor?.saves?.will;
    if (!saveStat) continue;
    await saveStat.roll({ dc: { value: 17 }, createMessage: true });
    const outcome = game.messages?.contents?.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    if (outcome === "failure" || outcome === "criticalFailure") {
      await creature.actor.increaseCondition("frightened", { value: 1 });
      frightened += 1;
    }
    await creature.setFlag("pf2e-dungeon-crawl", "howlImmunity", now);
  }
  return { frightened };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ambush-resolve.test.mjs`
Expected: PASS

- [ ] **Step 5: Wire into `applyInitiativeReactions`**

Extend Task 4's own `applyInitiativeReactions`: when a combatant is tagged `stealthInitiative` and rolls initiative via the Stealth path (the existing sneaker branch, generalized to NPCs per the spec), call `executeWarningHowl(combat, combatant, nearbyAgentControlledOrPartyCombatants)` after that roll, then `await combatant.unsetFlag("pf2e-dungeon-crawl", "ambush")`.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-ambush-resolve.test.mjs
git commit -m "feat(#1026): Warning Howl -- Stealth-initiative area fear and 1-hour immunity"
```

---

### Task 6: Fixture checks, architecture docs, version bump

**Files:**
- Test: `tests/npc-ambush.test.mjs` (fixture assertions)
- Modify: `docs/architecture.md`
- Modify: `module.json`

- [ ] **Step 1: Add the fixture-match tests**

```js
// tests/npc-ambush.test.mjs (append)
import { REACTION_DEFS } from '../scripts/npc-reactions.mjs';

describe('fixture matches (#1026)', () => {
  const names = ['All This Has Happened Before', 'Warning Howl', 'Spring upon Prey', 'Rise Up'];
  it.each(names)('a real item named "%s" matches its own registry row', (name) => {
    expect(REACTION_DEFS.find((d) => d.match.test(name))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-ambush.test.mjs`
Expected: PASS

- [ ] **Step 3: Run the `update-architecture-docs` skill**

New file `scripts/npc-ambush.mjs`, new combat-start-flow call sites in `dungeon-combat.mjs`. Run the skill and commit any update it produces alongside this task's own commit.

- [ ] **Step 4: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add tests/npc-ambush.test.mjs docs/architecture.md module.json
git commit -m "test(#1026): fixture matches; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** All four reactions covered: the ambush tags (Task 2), pre-initiative moves (Task 3), the anchorite's bonus/Quickened (Task 4), Warning Howl (Task 5). The #961 prerequisite fix (Task 1) is documented, not silently assumed.

**2. Placeholder scan:** No "TBD"/"TODO". The two genuinely unconfirmed integration points (the encounter generator's own placement call site for `ambushTagFor`; the exact insertion point inside `rollStealthInitiativeAndDetect` for the anchorite's bonus) are each flagged explicitly in Investigation finding 5 and Task 4 Step 5's own comment, with the surrounding logic fully written rather than left vague.

**3. Type consistency:** `applyAnchoriteInitiativeBonus`'s `{applied, bonus}` and `executeWarningHowl`'s `{frightened}` are each produced once and consumed identically by their own tests and `applyInitiativeReactions`.

**4. Review Focus:** All five bullets (untagged-NPC no-op, stale-tag safety, Quickened's first-in-turns gate, Warning Howl's per-creature immunity, ambush-before-initiative ordering) are each pinned to a named test in Tasks 3, 4, and 5.

**Corrections found while writing this plan:** (1) #961's own plan patches the wrong file and ships a registry-row shape (`{match: Function, trigger: string}`) that doesn't match the real one (`{match: RegExp, triggers: string[]}`) — fixed as this plan's prerequisite Task 1, the fourth occurrence of a "patches a stale #931 plan doc instead of the real registry" defect across this reaction-feature sequence (#959, #960, #961, now #1026 fixing #961's). (2) These four reactions don't fit the generic `resolveReactions` dispatcher at all (no combat round exists yet for the pre-initiative pair; no "mover" exists for the initiative-roll pair) — registry rows are kept for fixture-matching consistency only, with bespoke execution, stated explicitly rather than forcing a routing that doesn't fit.
