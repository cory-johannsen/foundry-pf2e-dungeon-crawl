# AI Actor Antagonize (Persistent Frightened Floor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an actor with Antagonize successfully Demoralizes a creature, that creature's Frightened can't decay below 1 (per #943's own end-of-turn decay) until it attacks its antagonizer or loses sense of them for a full round.

**Architecture:** A per-target-actor flag (`flags.pf2e-dungeon-crawl.antagonize`, keyed by antagonizer actor UUID) records each active floor. A `createChatMessage` handler creates an entry when it sees a successful Demoralize skill-check message from an actor with the `antagonize` feat; a second `createChatMessage` handler removes an entry when it sees an attack-roll/spell-attack-roll message where the frightened creature itself attacked its antagonizer; a sweep wired into the existing `updateCombat` turn-change hook removes an entry once the frightened creature hasn't sensed its antagonizer (reusing `detectableOpponents`) for a full round. #943's own `frightenedFloorFor` is widened from always-`0` to read this flag.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-antagonize-design.md`

## Global Constraints

- **Hard dependency: #943's own plan must be fully implemented and merged first** (its `decayFrightenedAtEndOfTurn`/`frightenedFloorFor` are what this plan patches). Also depends on #909's Demoralize executor existing, since this plan's create-handler needs real Demoralize chat messages to exist at all — though it reacts to *any* Demoralize message (player-rolled or AI-rolled), not #909's code directly, so it has no hard ordering dependency on #909 itself landing first, only on Demoralize being rollable at all (already true today via PF2e's own system, independent of this module).
- **This plan patches #943's own planned `frightenedFloorFor` signature**, changing it from `frightenedFloorFor(combat, actorId)` to `frightenedFloorFor(actor)` — simpler, and matches the approved spec's own stated signature exactly. #943 is not yet implemented (plan-only), so this is a direct patch to its own plan's described code, the same pattern #911/#914/#919 already use against #909/#910/#940.
- **Confirmed live by reading this module's own existing code directly (not the installed system's source, which doesn't expose this shape publicly outside a chat message):** a chat message's `flags.pf2e.context` carries `type` (`"skill-check"`, `"attack-roll"`, `"spell-attack-roll"`, ...), `options` (an array including e.g. `"action:demoralize"`), `outcome`, and `target` (`{token: "Scene.<id>.Token.<id>", ...}` — a token UUID whose trailing segment is the token document's own id, matching `Combatant#tokenId`). The roll's own actor ("origin") is resolved via `message.speaker.scene`/`message.speaker.token`, the same convention `handleRangedAttackForReactiveStrike`/`handleManualStrikeDamage` (this file's own existing handlers) already use — reused here, not reinvented.
- **Confirmed live:** `detectableOpponents(combat, combatant)` (module-private, already in `dungeon-combat.mjs`) returns, from `combatant`'s own point of view, which of its opponents it currently detects (alliance plus the stealth/detection matrix) — directly reused for the "senses its antagonizer" check, rather than a raw line-of-sight call, since it already folds in detection/stealth correctly.
- **Scope limit (per the approved spec and this plan both):** the sense check requires the frightened creature and its antagonizer to be on opposing alliances in the same combat (true for every normal Antagonize use — you Demoralize a foe) — `detectableOpponents` only ever considers opponents, so a same-side edge case (not a real RAW scenario for this feat) is out of scope, not silently mishandled.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (minor bump — a new cross-cutting mechanic spanning two chat-message handlers and a sweep, not a one-line fix).

## Review Focus

- A Demoralize that fails or critically fails must never create a floor — only `success`/`criticalSuccess` outcomes.
- An attack by the frightened creature against someone *other* than its antagonizer must never clear that antagonizer's own floor entry — only an attack against the specific antagonizer clears that specific entry.
- The sense-break timer must require a full round (6 seconds of `worldTime`) of *not* sensing, not a single missed check — refreshed every turn change the creature still senses its antagonizer, confirmed by a test that holds the entry alive across several "still sensed" turn changes before finally expiring it.
- Multiple simultaneous antagonizers on the same frightened creature must each track independently — clearing one (by attack or sense-loss) must never clear the others, and the floor must stay at 1 as long as *any* entry remains.
- The floor must disappear cleanly when the frightened creature loses Frightened entirely, is defeated, or the combat ends — a stale `antagonize` flag left on an actor after any of these would misrepresent that creature's state to a later, unrelated combat.

---

### Task 1: Pure helpers, and patching #943's `frightenedFloorFor`

**Files:**
- Create: `scripts/antagonize.mjs`
- Modify: `scripts/dungeon-combat.mjs` (patches #943's own planned `frightenedFloorFor`/`decayFrightenedAtEndOfTurn`)
- Test: `tests/antagonize.test.mjs`
- Test: `tests/dungeon-combat-frightened-decay.test.mjs` (per #943's plan — update its own `frightenedFloorFor` expectations for the new signature)

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Tasks 2–4): `readAntagonizeMap(actor)` → `Record<string, {sinceWorldTime, lastSensedWorldTime}>`; `frightenedFloorFor(actor)` → `0 | 1`; `evaluateAntagonizeEntry(entry, { sensed, worldTime })` → `{...entry, expired: boolean}` (and, when `sensed`, a refreshed `lastSensedWorldTime`).

- [x] **Step 1: Write the failing tests**

```js
// tests/antagonize.test.mjs
import { describe, it, expect } from 'vitest';
import { readAntagonizeMap, frightenedFloorFor, evaluateAntagonizeEntry } from '../scripts/antagonize.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function actorWithAntagonize(map) {
  return { flags: { [MODULE_ID]: { antagonize: map } } };
}

describe('readAntagonizeMap', () => {
  it('returns the stored map when present', () => {
    const map = { 'Actor.a1': { sinceWorldTime: 100, lastSensedWorldTime: 100 } };
    expect(readAntagonizeMap(actorWithAntagonize(map))).toEqual(map);
  });

  it('returns an empty object when absent or malformed', () => {
    expect(readAntagonizeMap({ flags: {} })).toEqual({});
    expect(readAntagonizeMap(actorWithAntagonize('not-an-object'))).toEqual({});
    expect(readAntagonizeMap(null)).toEqual({});
  });
});

describe('frightenedFloorFor', () => {
  it('is 0 with no antagonize flag at all', () => {
    expect(frightenedFloorFor({ flags: {} })).toBe(0);
  });

  it('is 1 with exactly one entry', () => {
    expect(frightenedFloorFor(actorWithAntagonize({ 'Actor.a1': { sinceWorldTime: 0, lastSensedWorldTime: 0 } }))).toBe(1);
  });

  it('is 1 with several entries (any entry at all floors at 1, never higher)', () => {
    expect(frightenedFloorFor(actorWithAntagonize({
      'Actor.a1': { sinceWorldTime: 0, lastSensedWorldTime: 0 },
      'Actor.a2': { sinceWorldTime: 0, lastSensedWorldTime: 0 },
    }))).toBe(1);
  });

  it('is 0 for a malformed flag value', () => {
    expect(frightenedFloorFor(actorWithAntagonize('not-an-object'))).toBe(0);
  });
});

describe('evaluateAntagonizeEntry', () => {
  const entry = { sinceWorldTime: 100, lastSensedWorldTime: 100 };

  it('refreshes lastSensedWorldTime and never expires when currently sensed', () => {
    const result = evaluateAntagonizeEntry(entry, { sensed: true, worldTime: 130 });
    expect(result).toEqual({ sinceWorldTime: 100, lastSensedWorldTime: 130, expired: false });
  });

  it('does not expire when not sensed but less than a full round (6s) has passed', () => {
    const result = evaluateAntagonizeEntry(entry, { sensed: false, worldTime: 104 });
    expect(result.expired).toBe(false);
    expect(result.lastSensedWorldTime).toBe(100);
  });

  it('expires once a full round (6s) has passed without being sensed', () => {
    const result = evaluateAntagonizeEntry(entry, { sensed: false, worldTime: 106 });
    expect(result.expired).toBe(true);
  });

  it('holds across several consecutive "still sensed" evaluations before finally expiring', () => {
    let current = entry;
    current = evaluateAntagonizeEntry(current, { sensed: true, worldTime: 106 });
    current = evaluateAntagonizeEntry(current, { sensed: true, worldTime: 112 });
    expect(current.expired).toBe(false);
    current = evaluateAntagonizeEntry(current, { sensed: false, worldTime: 118 });
    expect(current.expired).toBe(true);
  });
});
```

Update `tests/dungeon-combat-frightened-decay.test.mjs` (per #943's own plan) — change every `combatantWithCondition` fixture's implicit `combat` reference out of the `frightenedFloorFor` call path, since the function now takes just the actor:

```js
// No fixture change needed for the existing "decreases/does nothing/no
// actor/player-controlled/throws" tests -- they never asserted on
// frightenedFloorFor's own call signature directly, only on
// decreaseCondition being called or not. Add one new test confirming the
// new signature is what's actually used:
it('consults frightenedFloorFor(actor), not frightenedFloorFor(combat, actorId)', async () => {
  const combatant = combatantWithCondition(1);
  combatant.actor.flags = { 'pf2e-dungeon-crawl': { antagonize: { 'Actor.x': { sinceWorldTime: 0, lastSensedWorldTime: 0 } } } };
  await decayFrightenedAtEndOfTurn(combatant);
  // Floor is 1, current value is 1 -- 1 <= 1, so no decrement call at all.
  expect(combatant.actor.decreaseCondition).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/antagonize.test.mjs tests/dungeon-combat-frightened-decay.test.mjs`
Expected: FAIL — `scripts/antagonize.mjs` doesn't exist yet; the new decay test fails since `frightenedFloorFor` is still hardcoded to `0` per #943's own plan.

- [x] **Step 3: Write `scripts/antagonize.mjs`**

```js
/**
 * #920: pure helpers for the Antagonize persistent-Frightened-floor
 * mechanic — no Foundry API surface beyond reading a plain actor-like
 * object's own `.flags` (the real write/read of that flag happens in
 * dungeon-combat.mjs, which has real actor documents).
 */

const MODULE_ID = "pf2e-dungeon-crawl";
const ROUND_SECONDS = 6;

export function readAntagonizeMap(actor) {
  const map = actor?.flags?.[MODULE_ID]?.antagonize;
  return map && typeof map === "object" ? map : {};
}

/** 1 while any antagonizer holds a floor on this actor, else 0 — PF2e
 * RAW: Frightened "can't decrease to less than 1" while the floor
 * lasts, regardless of how many antagonizers hold one. */
export function frightenedFloorFor(actor) {
  return Object.keys(readAntagonizeMap(actor)).length > 0 ? 1 : 0;
}

/** Given one antagonize entry and whether the frightened creature
 * currently senses that antagonizer, either refreshes the entry's own
 * `lastSensedWorldTime` (sensed) or marks it `expired` once a full round
 * (6s of worldTime) has passed without being sensed. Pure — the caller
 * resolves `sensed` via the real Foundry-side detection check and deletes
 * the real flag entry when `expired` comes back true. */
export function evaluateAntagonizeEntry(entry, { sensed, worldTime }) {
  if (sensed) return { ...entry, lastSensedWorldTime: worldTime, expired: false };
  return { ...entry, expired: worldTime - entry.lastSensedWorldTime >= ROUND_SECONDS };
}
```

- [x] **Step 4: Patch #943's own `frightenedFloorFor`/`decayFrightenedAtEndOfTurn` in `scripts/dungeon-combat.mjs`**

Remove #943's own local `frightenedFloorFor(combat, actorId)` function entirely, and import the real one from Task 1 instead:

```js
import { frightenedFloorFor } from "./antagonize.mjs";
```

Update `decayFrightenedAtEndOfTurn` (per #943's plan) to call it with just the actor:

```js
export async function decayFrightenedAtEndOfTurn(combatant) {
  const actor = combatant.actor;
  if (!actor) return;
  const condition = actor.getCondition("frightened");
  if (!condition) return;
  const floor = frightenedFloorFor(actor);
  if (condition.value <= floor) return;
  try {
    await actor.decreaseCondition("frightened");
  } catch (err) {
    console.error(`${MODULE_ID} | failed to decay Frightened at end of turn:`, err.message);
  }
}
```

(Only the `frightenedFloorFor(combatant.combat, actor.id)` call site changes to `frightenedFloorFor(actor)`, and the now-unused local function is deleted — everything else in this function is #943's own existing code, unchanged.)

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/antagonize.test.mjs tests/dungeon-combat-frightened-decay.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 7: Commit**

```bash
git add scripts/antagonize.mjs scripts/dungeon-combat.mjs tests/antagonize.test.mjs tests/dungeon-combat-frightened-decay.test.mjs
git commit -m "feat(#920): add Antagonize pure helpers, wire into #943's Frightened floor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Create the floor on a successful Demoralize

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/module.mjs`
- Test: `tests/dungeon-combat-antagonize-create.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export async function handleDemoralizeForAntagonize(message)`, wired into a new `createChatMessage` hook.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-antagonize-create.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { handleDemoralizeForAntagonize } from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function demoralizeMessage({ outcome = 'success', hasAntagonize = true } = {}) {
  return {
    speaker: { scene: 'scene1', token: 'attackerToken1' },
    flags: { pf2e: { context: { type: 'skill-check', options: ['action:demoralize'], outcome, target: { actor: 'Actor.target1', token: 'Scene.scene1.Token.targetToken1' } } } },
  };
}

function installCombatStub({ attackerHasFeat = true } = {}) {
  const targetActor = { uuid: 'Actor.target1', flags: {}, setFlag: vi.fn(async (_m, k, v) => { targetActor.flags[MODULE_ID] = { ...targetActor.flags[MODULE_ID], [k]: v }; }), getFlag: vi.fn((_m, k) => targetActor.flags[MODULE_ID]?.[k]) };
  const attackerActor = { uuid: 'Actor.attacker1', items: attackerHasFeat ? [{ type: 'feat', slug: 'antagonize' }] : [] };
  const combat = {
    scene: { id: 'scene1' },
    combatants: [
      { tokenId: 'attackerToken1', actor: attackerActor },
      { tokenId: 'targetToken1', actor: targetActor },
    ],
  };
  globalThis.game = { user: { isGM: true }, combats: { contents: [combat] }, time: { worldTime: 500 } };
  return { combat, targetActor, attackerActor };
}

describe('handleDemoralizeForAntagonize', () => {
  it('creates a floor entry on the target when the attacker has Antagonize and the Demoralize succeeds', async () => {
    const { targetActor } = installCombatStub();
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: 'success' }));
    expect(targetActor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {
      'Actor.attacker1': { sinceWorldTime: 500, lastSensedWorldTime: 500 },
    });
  });

  it('creates a floor entry on a critical success too', async () => {
    const { targetActor } = installCombatStub();
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: 'criticalSuccess' }));
    expect(targetActor.setFlag).toHaveBeenCalled();
  });

  it('does not create a floor on a failure or critical failure', async () => {
    const { targetActor } = installCombatStub();
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: 'failure' }));
    expect(targetActor.setFlag).not.toHaveBeenCalled();
  });

  it('does not create a floor when the attacker lacks the Antagonize feat', async () => {
    const { targetActor } = installCombatStub({ attackerHasFeat: false });
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: 'success' }));
    expect(targetActor.setFlag).not.toHaveBeenCalled();
  });

  it('does not act on a non-Demoralize skill check', async () => {
    const { targetActor } = installCombatStub();
    const message = demoralizeMessage({ outcome: 'success' });
    message.flags.pf2e.context.options = ['action:some-other-check'];
    await handleDemoralizeForAntagonize(message);
    expect(targetActor.setFlag).not.toHaveBeenCalled();
  });

  it('preserves an existing entry from a different antagonizer when adding a new one', async () => {
    const { targetActor } = installCombatStub();
    targetActor.flags[MODULE_ID] = { antagonize: { 'Actor.other': { sinceWorldTime: 1, lastSensedWorldTime: 1 } } };
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: 'success' }));
    expect(targetActor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {
      'Actor.other': { sinceWorldTime: 1, lastSensedWorldTime: 1 },
      'Actor.attacker1': { sinceWorldTime: 500, lastSensedWorldTime: 500 },
    });
  });

  it('only the GM client acts on the message', async () => {
    const { targetActor } = installCombatStub();
    globalThis.game.user.isGM = false;
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: 'success' }));
    expect(targetActor.setFlag).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-antagonize-create.test.mjs`
Expected: FAIL — `handleDemoralizeForAntagonize` doesn't exist yet.

- [x] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

```js
import { readAntagonizeMap } from "./antagonize.mjs";
```

(Add `readAntagonizeMap` to the same import line Task 1 already added for `frightenedFloorFor`.)

```js
/** #920: reacts to a successful Demoralize skill-check chat message from
 * any actor (player- or AI-controlled alike) carrying the Antagonize
 * feat, writing a floor entry onto the demoralized target — reusing
 * this file's own existing createChatMessage-handler conventions
 * (handleRangedAttackForReactiveStrike/handleManualStrikeDamage) for
 * resolving the roll's own origin (message.speaker) and target
 * (context.target), rather than inventing a new resolution path. */
export async function handleDemoralizeForAntagonize(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "skill-check") return;
  if (!context.options?.includes("action:demoralize")) return;
  if (context.outcome !== "success" && context.outcome !== "criticalSuccess") return;

  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  if (!sceneId || !attackerTokenId) return;
  const combat = game.combats.contents.find((c) => c.scene?.id === sceneId);
  if (!combat) return;
  const attacker = combat.combatants.find((c) => c.tokenId === attackerTokenId);
  if (!attacker?.actor) return;
  const hasAntagonize = attacker.actor.items?.some((i) => i.type === "feat" && i.slug === "antagonize");
  if (!hasAntagonize) return;

  const targetActorUuid = context.target?.actor;
  const targetTokenUuid = context.target?.token;
  if (!targetActorUuid || !targetTokenUuid) return;
  const targetTokenId = targetTokenUuid.split(".").pop();
  const target = combat.combatants.find((c) => c.tokenId === targetTokenId);
  if (!target?.actor) return;

  const current = readAntagonizeMap(target.actor);
  const worldTime = game.time.worldTime;
  await target.actor.setFlag(MODULE_ID, "antagonize", {
    ...current,
    [attacker.actor.uuid]: { sinceWorldTime: worldTime, lastSensedWorldTime: worldTime },
  });
}
```

- [x] **Step 4: Wire the hook in `scripts/module.mjs`**

```js
import { handleDemoralizeForAntagonize } from "./dungeon-combat.mjs";
```

```js
/** #920: Antagonize's floor-creation half — the clear half (attack-roll
 * detection) is a separate hook, Task 3. */
Hooks.on("createChatMessage", handleDemoralizeForAntagonize);
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-antagonize-create.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs tests/dungeon-combat-antagonize-create.test.mjs
git commit -m "feat(#920): create the Antagonize floor on a successful Demoralize

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Clear the floor when the frightened creature attacks its antagonizer

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/module.mjs`
- Test: `tests/dungeon-combat-antagonize-clear-attack.test.mjs`

**Interfaces:**
- Consumes: `readAntagonizeMap` (Task 1).
- Produces: `export async function handleAntagonizeAttackClear(message)`, wired into the same `createChatMessage` hook list.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-antagonize-clear-attack.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { handleAntagonizeAttackClear } from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function attackMessage({ type = 'attack-roll', targetActorUuid = 'Actor.antagonizer1' } = {}) {
  return {
    speaker: { scene: 'scene1', token: 'frightenedToken1' },
    flags: { pf2e: { context: { type, target: { actor: targetActorUuid, token: 'Scene.scene1.Token.antagonizerToken1' } } } },
  };
}

function installCombatStub() {
  const frightenedActor = {
    flags: { [MODULE_ID]: { antagonize: { 'Actor.antagonizer1': { sinceWorldTime: 0, lastSensedWorldTime: 0 } } } },
    setFlag: vi.fn(async (_m, k, v) => { frightenedActor.flags[MODULE_ID][k] = v; }),
  };
  const antagonizerActor = { uuid: 'Actor.antagonizer1' };
  const combat = {
    scene: { id: 'scene1' },
    combatants: [
      { tokenId: 'frightenedToken1', actor: frightenedActor },
      { tokenId: 'antagonizerToken1', actor: antagonizerActor },
    ],
  };
  globalThis.game = { user: { isGM: true }, combats: { contents: [combat] } };
  return { combat, frightenedActor };
}

describe('handleAntagonizeAttackClear', () => {
  it('removes the floor entry when the frightened creature makes an attack-roll against its antagonizer', async () => {
    const { frightenedActor } = installCombatStub();
    await handleAntagonizeAttackClear(attackMessage({ type: 'attack-roll' }));
    expect(frightenedActor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {});
  });

  it('removes the floor entry on a spell-attack-roll too', async () => {
    const { frightenedActor } = installCombatStub();
    await handleAntagonizeAttackClear(attackMessage({ type: 'spell-attack-roll' }));
    expect(frightenedActor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {});
  });

  it('does not clear anything when the attack targets someone other than the antagonizer', async () => {
    const { frightenedActor } = installCombatStub();
    await handleAntagonizeAttackClear(attackMessage({ targetActorUuid: 'Actor.someoneElse' }));
    expect(frightenedActor.setFlag).not.toHaveBeenCalled();
  });

  it('does not act on a non-attack roll type (e.g. a damage-roll or skill-check)', async () => {
    const { frightenedActor } = installCombatStub();
    await handleAntagonizeAttackClear(attackMessage({ type: 'damage-roll' }));
    expect(frightenedActor.setFlag).not.toHaveBeenCalled();
  });

  it('preserves any other antagonizer entry when clearing just this one', async () => {
    const { frightenedActor } = installCombatStub();
    frightenedActor.flags[MODULE_ID].antagonize['Actor.other'] = { sinceWorldTime: 1, lastSensedWorldTime: 1 };
    await handleAntagonizeAttackClear(attackMessage());
    expect(frightenedActor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {
      'Actor.other': { sinceWorldTime: 1, lastSensedWorldTime: 1 },
    });
  });

  it('does nothing when the attacker has no antagonize entries at all', async () => {
    const { frightenedActor } = installCombatStub();
    frightenedActor.flags[MODULE_ID] = {};
    await handleAntagonizeAttackClear(attackMessage());
    expect(frightenedActor.setFlag).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-antagonize-clear-attack.test.mjs`
Expected: FAIL — `handleAntagonizeAttackClear` doesn't exist yet.

- [x] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

```js
/** #920: reacts to an attack-roll/spell-attack-roll chat message where
 * the ROLLING actor (the frightened creature) targets its own
 * antagonizer, removing that one floor entry — a RAW "hostile action
 * against the antagonizer" clear. Only ever removes the specific entry
 * keyed by the attack's own target actor uuid, never every entry. */
export async function handleAntagonizeAttackClear(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll" && context?.type !== "spell-attack-roll") return;

  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  if (!sceneId || !attackerTokenId) return;
  const combat = game.combats.contents.find((c) => c.scene?.id === sceneId);
  if (!combat) return;
  const frightenedCombatant = combat.combatants.find((c) => c.tokenId === attackerTokenId);
  if (!frightenedCombatant?.actor) return;

  const current = readAntagonizeMap(frightenedCombatant.actor);
  const targetActorUuid = context.target?.actor;
  if (!targetActorUuid || !(targetActorUuid in current)) return;

  const { [targetActorUuid]: _removed, ...rest } = current;
  await frightenedCombatant.actor.setFlag(MODULE_ID, "antagonize", rest);
}
```

- [x] **Step 4: Wire the hook in `scripts/module.mjs`**

```js
import { handleDemoralizeForAntagonize, handleAntagonizeAttackClear } from "./dungeon-combat.mjs";
```

```js
Hooks.on("createChatMessage", handleDemoralizeForAntagonize);
Hooks.on("createChatMessage", handleAntagonizeAttackClear);
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-antagonize-clear-attack.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs tests/dungeon-combat-antagonize-clear-attack.test.mjs
git commit -m "feat(#920): clear the Antagonize floor when the target attacks its antagonizer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Clear the floor on sense-loss, and lifecycle cleanup

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/module.mjs`
- Test: `tests/dungeon-combat-antagonize-sense-sweep.test.mjs`

**Interfaces:**
- Consumes: `evaluateAntagonizeEntry` (Task 1), `detectableOpponents` (existing, module-private).
- Produces: `export async function sweepAntagonizeFloors(combat)`, wired into the existing `updateCombat` hook alongside #911/#915's own sweeps; `export async function clearAntagonizeOnDefeatOrFrightenedLoss(combatant)` and cleanup on `deleteCombat`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-antagonize-sense-sweep.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { sweepAntagonizeFloors, clearAntagonizeOnDefeatOrFrightenedLoss } from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function combatantFixture({ antagonize = {}, detected = [] } = {}) {
  const actor = {
    flags: { [MODULE_ID]: { antagonize } },
    setFlag: vi.fn(async (_m, k, v) => { actor.flags[MODULE_ID][k] = v; }),
    getCondition: vi.fn(() => null),
  };
  return { id: 'c1', actor, detected };
}

describe('sweepAntagonizeFloors', () => {
  it('refreshes lastSensedWorldTime for an entry whose antagonizer is still detected', async () => {
    const antagonizer = { id: 'ant1', actor: { uuid: 'Actor.ant1' } };
    const frightened = combatantFixture({ antagonize: { 'Actor.ant1': { sinceWorldTime: 0, lastSensedWorldTime: 0 } } });
    const combat = { combatants: [frightened, antagonizer], getFlag: () => undefined };
    globalThis.game = { time: { worldTime: 100 } };
    // Stub this file's own module-private detectableOpponents via the
    // combat's own stealth-detection flag absence (no matrix -> every
    // opponent is detectable) -- confirmed detectableOpponents' own
    // behavior from #616 reading combatantOpponents directly; since this
    // test's frightened/antagonizer pair must be real "opponents" of
    // each other for that path to apply, give them opposing
    // alliances/dispositions matching whatever real combatantOpponents
    // checks (confirm its exact field before writing this fixture, rather
    // than guessing one here).
    await sweepAntagonizeFloors(combat);
    expect(frightened.actor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {
      'Actor.ant1': { sinceWorldTime: 0, lastSensedWorldTime: 100 },
    });
  });

  it('removes an entry once a full round has passed with the antagonizer undetected', async () => {
    // Same shape, but the antagonizer combatant is excluded from
    // whatever detectableOpponents would return (e.g. hidden/undetected
    // per the stealth matrix) and lastSensedWorldTime is already >= 6s
    // in the past relative to game.time.worldTime.
    // expect setFlag called with antagonize: {} (entry removed).
  });

  it('does nothing for a combatant with no antagonize entries at all', async () => {
    const frightened = combatantFixture();
    const combat = { combatants: [frightened], getFlag: () => undefined };
    await sweepAntagonizeFloors(combat);
    expect(frightened.actor.setFlag).not.toHaveBeenCalled();
  });
});

describe('clearAntagonizeOnDefeatOrFrightenedLoss', () => {
  it('clears the antagonize flag entirely once the actor no longer has Frightened', async () => {
    const combatant = combatantFixture({ antagonize: { 'Actor.ant1': { sinceWorldTime: 0, lastSensedWorldTime: 0 } } });
    combatant.actor.getCondition.mockReturnValue(null);
    await clearAntagonizeOnDefeatOrFrightenedLoss(combatant);
    expect(combatant.actor.setFlag).toHaveBeenCalledWith(MODULE_ID, 'antagonize', {});
  });

  it('leaves the flag alone while the actor still has Frightened', async () => {
    const combatant = combatantFixture({ antagonize: { 'Actor.ant1': { sinceWorldTime: 0, lastSensedWorldTime: 0 } } });
    combatant.actor.getCondition.mockReturnValue({ value: 1 });
    await clearAntagonizeOnDefeatOrFrightenedLoss(combatant);
    expect(combatant.actor.setFlag).not.toHaveBeenCalled();
  });
});
```

(As with earlier plans in this session, the first test's own exact "opposing alliance" fixture shape is deliberately left for the implementer to confirm against `combatantOpponents`'s real field checks before writing it, rather than guessed here — find and read that function's body first.)

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-antagonize-sense-sweep.test.mjs`
Expected: FAIL — neither function exists yet.

- [x] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

```js
import { readAntagonizeMap, evaluateAntagonizeEntry } from "./antagonize.mjs";
```

```js
/** #920: the sense-loss half of clearing an Antagonize floor — sampled
 * at every turn change (per the approved spec's own documented
 * approximation of "continuously"), reusing this file's own existing
 * detectableOpponents (alliance + stealth-matrix aware) from the
 * frightened creature's own point of view. */
export async function sweepAntagonizeFloors(combat) {
  for (const combatant of combat.combatants ?? []) {
    const current = readAntagonizeMap(combatant.actor);
    const antagonizerUuids = Object.keys(current);
    if (!antagonizerUuids.length) continue;
    const detected = detectableOpponents(combat, combatant);
    const next = { ...current };
    let changed = false;
    for (const uuid of antagonizerUuids) {
      const antagonizerCombatant = combat.combatants.find((c) => c.actor?.uuid === uuid);
      const sensed = !!antagonizerCombatant && detected.some((o) => o.id === antagonizerCombatant.id);
      const result = evaluateAntagonizeEntry(current[uuid], { sensed, worldTime: game.time.worldTime });
      changed = true;
      if (result.expired) delete next[uuid];
      else next[uuid] = { sinceWorldTime: result.sinceWorldTime, lastSensedWorldTime: result.lastSensedWorldTime };
    }
    if (changed) await combatant.actor.setFlag(MODULE_ID, "antagonize", next);
  }
}

/** #920: clears a combatant's own antagonize flag entirely once it no
 * longer has Frightened at all (RAW: the floor is a property of the
 * Frightened condition itself, not independent of it) — called on
 * defeat and whenever Frightened is removed by any means. */
export async function clearAntagonizeOnDefeatOrFrightenedLoss(combatant) {
  const actor = combatant.actor;
  if (!actor) return;
  const current = readAntagonizeMap(actor);
  if (!Object.keys(current).length) return;
  if (actor.getCondition("frightened")) return;
  await actor.setFlag(MODULE_ID, "antagonize", {});
}
```

- [x] **Step 4: Wire into the existing hooks in `scripts/module.mjs`**

Add `sweepAntagonizeFloors`/`clearAntagonizeOnDefeatOrFrightenedLoss` to the existing import from `dungeon-combat.mjs`, and call `sweepAntagonizeFloors` alongside #911/#915's own sweeps in the existing `updateCombat` hook:

```js
Hooks.on("updateCombat", (combat, changes) => {
  if (changes.turn === undefined && changes.round === undefined) return;
  autoPlayCombatantTurnIfDue(combat);
  sweepExpiredManeuverRiders(combat);
  sweepExpiredNpcAbilityConditions(combat);
  sweepAntagonizeFloors(combat);
});
```

Call `clearAntagonizeOnDefeatOrFrightenedLoss` from the `decayFrightenedAtEndOfTurn` sequence, right after the decrement (per Task 1's own patched version — this covers "Frightened removed naturally at end of turn"; defeat is covered separately below):

```js
export async function decayFrightenedAtEndOfTurn(combatant) {
  const actor = combatant.actor;
  if (!actor) return;
  const condition = actor.getCondition("frightened");
  if (!condition) return;
  const floor = frightenedFloorFor(actor);
  if (condition.value <= floor) return;
  try {
    await actor.decreaseCondition("frightened");
  } catch (err) {
    console.error(`${MODULE_ID} | failed to decay Frightened at end of turn:`, err.message);
  }
  await clearAntagonizeOnDefeatOrFrightenedLoss(combatant);
}
```

For defeat, find this file's own existing `applyDefeatIfReducedToZero` (or equivalent defeat-marking function) and add a call to `clearAntagonizeOnDefeatOrFrightenedLoss(combatant)` there too — read that function first to confirm its real combatant/actor argument shape before adding the call, rather than assuming its signature here.

For combat deletion, add to the existing `Hooks.on("deleteCombat", ...)` handler in `module.mjs` (alongside `clearDetection`/`cleanupAgentSelfEffects`):

```js
Hooks.on("deleteCombat", async (combat) => {
  if (!(game.users?.activeGM?.isSelf ?? game.user?.isGM)) return;
  await clearDetection(combat);
  await cleanupAgentSelfEffects(combat);
  for (const combatant of combat.combatants ?? []) {
    await clearAntagonizeOnDefeatOrFrightenedLoss(combatant);
  }
});
```

(This last loop only clears an antagonize flag whose actor no longer has Frightened at the moment combat ends — per RAW the floor is tied to the condition, not to the combat's own lifetime; if Frightened is somehow still active when combat ends, per this plan's own design that's an existing-Frightened-persists-after-combat scenario already handled elsewhere in this codebase, not something this task needs to force-clear.)

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-antagonize-sense-sweep.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs tests/dungeon-combat-antagonize-sense-sweep.test.mjs
git commit -m "feat(#920): clear the Antagonize floor on sense-loss, defeat, and combat end

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Version bump

> Implementation note (#920): the version bump is done by whoever merges the PR, not on the feature branch.

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [x] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

A **minor** bump per `CLAUDE.md`'s versioning rule — a new cross-cutting mechanic (two chat-message handlers plus a sweep), not a one-line fix.

- [x] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [x] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#920): bump version for Antagonize support

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (foundation-first, #943) — this plan only patches #943's own `frightenedFloorFor` signature (Task 1), touching nothing else in its decay logic.
- Decision 2 (RAW sense-break via a per-target last-sensed timestamp, not a simplified instant check) — Task 1's `evaluateAntagonizeEntry` plus Task 4's sweep, with a dedicated "holds across several consecutive sensed evaluations" test.
- Decision 3 (hostile action = attack-roll/spell-attack-roll against the antagonizer specifically) — Task 3, with dedicated "wrong target" and "wrong message type" tests.
- Decision 4 (any actor, PC or AI) — Task 2's create-handler reacts to any Demoralize chat message regardless of who controls the roller; no AI-only gating anywhere in this plan.
- The Design section's own data shape (`flags.pf2e-dungeon-crawl.antagonize`, keyed by antagonizer actor UUID, `{sinceWorldTime, lastSensedWorldTime}`) — implemented exactly in Tasks 1/2/3/4.
- The Design section's "creating/enforcing/clearing the floor" subsections — Task 2 (creating), Task 1 (enforcing, via the patched `frightenedFloorFor`), Tasks 3/4 (clearing, both halves).
- Error handling section (unreadable context → no floor created, never a throw; a failing sense evaluation leaves the entry untouched and logs) — Task 2/3's own guard clauses (`if (!...) return;` throughout, never throwing on missing data) and Task 1's `evaluateAntagonizeEntry` being pure (cannot itself fail) with the real Foundry-side detection call wrapped by the caller.
- Testing section's own enumerated cases — pure helpers (Task 1), create handler (Task 2), clear handler (Task 3), sense-sweep and lifecycle (Task 4); "Live verification" is the one bullet this plan cannot itself automate, named here rather than silently dropped, matching every prior plan in this session's own sequence.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 4's first sweep test and its own defeat-wiring step both explicitly name a real function (`combatantOpponents`, the real defeat-marking function) the implementer must read first rather than guess the shape of — the same deliberate, flagged exception every prior plan in this session uses for the same reason.

**3. Type consistency:** `readAntagonizeMap`'s return shape (`Record<string, {sinceWorldTime, lastSensedWorldTime}>`) is produced once (Task 1) and consumed identically in Tasks 2/3/4's own read-modify-write sequences. `evaluateAntagonizeEntry`'s `{...entry, expired}` return shape is destructured identically in Task 4's sweep (`result.expired`, `result.sinceWorldTime`, `result.lastSensedWorldTime`). The antagonize flag's own key (an antagonizer's real `actor.uuid`) is written identically in Task 2 and read identically in Tasks 3/4.

**4. Review Focus:** all five items have a direct test — a failed Demoralize never creating a floor (Task 2's dedicated test), an attack against the wrong target never clearing the wrong entry (Task 3's dedicated test), the full-round sense-break timer holding across multiple sensed checks before expiring (Task 1's dedicated multi-step test), multiple independent antagonizers (Task 2's "preserves an existing entry from a different antagonizer" test and Task 3's symmetric "preserves any other antagonizer entry" test), and clean lifecycle teardown on Frightened-loss/defeat/combat-end (Task 4's dedicated tests plus the `deleteCombat` wiring).
