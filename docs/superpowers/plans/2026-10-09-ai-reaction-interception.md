# Intercepting Player Attack, Save and Damage Flows for Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interception layer — `preCreateChatMessage`, `preCreateItem`, and a guarded wrapper on `ActorPF2e.prototype.applyDamage` — that lets deterministic defensive reactions run synchronously, before a player's attack/save card renders or damage applies, with a decide-then-relay-commit split and a kill switch, falling back to #931/#960's retroactive/GM-confirm behavior when unavailable.

**Architecture:** `scripts/reaction-intercept-core.mjs` (pure) holds the synchronous decision functions. `scripts/reaction-intercept.mjs` installs the three interception points and the commit relay, built on two things this plan confirmed by reading the real, installed PF2e system source directly rather than guessing: exactly how a check's visible result is baked into the message before creation (resolving the spec's own stated open question decisively), and the module's own existing relay (`dungeon-remote.mjs`'s `DUNGEON_ACTIONS`/`isAuthorizedRequest`/`WIDENED_ACTIONS`) as the real commit vehicle.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT core hooks, PF2e system internals (read directly from the installed `pf2e.mjs`), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md`

## Global Constraints

- **#931/#960/#961/#962 are all still plan-only.** This plan's `reaction-intercept-core.mjs` reuses #960's own adjustment-function *names* (`improveOneDegree`, `degreeFor`, `better`/`worse`) by re-implementing them here rather than importing a file that doesn't exist yet — flagged as a known future-reconciliation point, same posture every other cross-plan dependency in this sequence takes.
- **No `libWrapper` dependency exists in this module** (confirmed live: no reference anywhere in `scripts/` or `module.json`'s relationships). The `applyDamage` wrapper is therefore a raw prototype-method reassignment with its own re-entrancy/idempotence guard, exactly as the spec's own pseudocode shows — this plan does not add a `libWrapper` dependency. This carries an inherent, honestly-documented limitation: if another installed module ALSO wraps `applyDamage` without `libWrapper`'s own chain-of-wrappers protocol, load order decides which wrapper actually runs first, and a conflicting module could clobber this one's wrapper (or vice versa). The kill switch and feature detection are this plan's own mitigation, not a cure.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The spec's own central open question — whether a check's visible result is derived live or baked into the message before creation — is now decisively resolved by reading the real, installed `pf2e.mjs` directly: it is baked, in TWO separate places, both before `ChatMessage.create` runs.** `CheckRoll#render` (confirmed live, `pf2e.mjs:19236`) calls `renderTemplate(CheckRoll.CHAT_TEMPLATE, {..., degree: this.degreeOfSuccess, ...})` — and `this.degreeOfSuccess` is a plain getter returning `this.options.degreeOfSuccess` (confirmed live, line 19228), a value fixed at roll-evaluation time, long before any chat message exists. This rendered HTML becomes the message's own `content`, built by the generic `Roll#toMessage` before `ChatMessage.create` is ever called — so by the time `preCreateChatMessage` fires, `data.content` is already a complete, rendered string. **Separately**, the human-readable degree LABEL and its CSS class ("Critical Success"/"success", etc.) are baked into the message's `flavor`, not its `content`, by a second mechanism: a static private method (`#createResultFlavor`, confirmed live) renders `systems/pf2e/templates/chat/check/target-dc-result.hbs` — a template whose real, read-directly contents are exactly `<div class="result degree-of-success">{{{result.markup}}}</div>` — with `result.markup` carrying a localized string into which the degree's own CSS class token (one of the real, confirmed four values `["criticalFailure", "failure", "success", "criticalSuccess"]`, read directly from the system's own `Ht` array at `pf2e.mjs:341`) has already been substituted. **This means `preCreateChatMessage` must do two independent things, not one**: `updateSource` the `flags.pf2e.context.outcome` (for anything that re-reads the flag later, matching #931's own existing convention) AND separately parse the `flavor` HTML, find the single `.result.degree-of-success` element, and replace its class token and visible text with the adjusted degree's — via DOM manipulation (`parseHTML`/`querySelector`, matching the system's own internal convention for exactly this kind of post-hoc element patching, confirmed live in the same function), never a blind string regex that could corrupt an unrelated part of the flavor HTML.
2. **`ActorPF2e.prototype.applyDamage` is confirmed, read directly, to be exactly the real signature the spec cites** (`{damage, token, item, rollOptions, skipIWR, shieldBlockRequest, breakdown, notes, outcome, final}`, `pf2e.mjs:31803`), defined on `ActorPF2e extends Actor` (confirmed live) — `CONFIG.Actor.documentClass.prototype.applyDamage` is therefore exactly the right wrap target, not a guess.
3. **The module's own existing relay (`scripts/dungeon-remote.mjs`'s `DUNGEON_ACTIONS` dispatch plus `scripts/dungeon-permissions.mjs`'s `isAuthorizedRequest`/`WIDENED_ACTIONS`) is the real commit vehicle this plan needs, and the new `commitReaction` action must be added to `WIDENED_ACTIONS`, not left host-only.** `isAuthorizedRequest`'s real default (confirmed live, `dungeon-permissions.mjs:138`) authorizes only the run's own tracked host; `WIDENED_ACTIONS` is the real, confirmed extension point letting any connected owner of a party character relay an action instead. Since `preCreateChatMessage`/`preCreateItem` fire "on the client that initiates the creation" (the spec's own confirmed finding) — which, for a player's own attack roll or a condition landing on their own character, is that PLAYER's client, not necessarily the run's host — a reaction triggered by a non-host player's own roll would be silently unauthorized to commit under the relay's own default rule. `commitReaction` is added to `WIDENED_ACTIONS` with the same "the requester owns a party character, or is the host" authorization every other widened action already uses.

## Review Focus

- The flavor-HTML patch must target exactly the `.result.degree-of-success` element and nothing else in the flavor fragment — a patch that accidentally also matches the DC-label div (`.target-dc`, confirmed a sibling element in the same template) would corrupt the DC text instead of just the result (Investigation finding 1; Task 2's test).
- The `applyDamage` wrapper's re-entrancy guard must prevent the reaction's OWN side-effect damage (Retributive Strike's counter-Strike) from being intercepted a second time by itself (spec's own stated rule; Task 5's test).
- A `commitReaction` request from a non-host party-character owner must succeed, not just one from the host — the single most important consequence of Investigation finding 3 (Task 6's test).
- The kill switch must disable all three interception points atomically when flipped mid-combat — a half-disabled state (hooks off, wrapper still active, or vice versa) would silently produce inconsistent behavior the GM has no way to predict (Task 7's test).
- A commit that races a reaction already spent (the authoritative flag check fails) must leave the already-applied adjustment standing, never retract it — the spec's own explicit, accepted tradeoff (Task 6's test).

---

### Task 1: Pure decision functions

**Files:**
- Create: `scripts/reaction-intercept-core.mjs`
- Test: `tests/reaction-intercept-core.test.mjs`

**Interfaces:**
- Consumes: nothing (re-implements #960's adjustment functions locally, per Global Constraints).
- Produces: `decideAcBonus(event, def)` → `null | {newDegree, bonus}`; `decideSaveAdjustment(event, def)` → `null | {outcome}`; `decideDamageReduction(event, def)` → `null | {shieldBlockRequest?: true, reducedDamage?: number}`; `decideConditionNegation(event, def)` → `boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/reaction-intercept-core.test.mjs
import { describe, it, expect } from 'vitest';
import { decideAcBonus, decideSaveAdjustment, decideDamageReduction, decideConditionNegation } from '../scripts/reaction-intercept-core.mjs';

describe('decideAcBonus (#963)', () => {
  it('returns the adjusted degree only when the bonus changes it in the defender\'s favor', () => {
    const event = { attackTotal: 18, baseAc: 18 };
    expect(decideAcBonus(event, { bonus: 2 })).toEqual({ newDegree: 'failure', bonus: 2 });
  });
  it('returns null when the bonus does not change the degree', () => {
    expect(decideAcBonus({ attackTotal: 25, baseAc: 18 }, { bonus: 2 })).toBeNull();
  });
  it('returns null when the definition\'s own trait condition fails (e.g. Icy Deflection vs a fire attack)', () => {
    const event = { attackTotal: 18, baseAc: 18, traits: ['fire'] };
    expect(decideAcBonus(event, { bonus: 2, excludeTraits: ['fire'] })).toBeNull();
  });
});

describe('decideSaveAdjustment (#963)', () => {
  it('improves a failure by one degree (Golden Luck-shaped)', () => {
    expect(decideSaveAdjustment({ outcome: 'failure' }, { kind: 'improveOneDegree' })).toEqual({ outcome: 'success' });
  });
  it('recomputes with a +4 bonus (Free Mind-shaped)', () => {
    expect(decideSaveAdjustment({ outcome: 'success', total: 17, dc: 18 }, { kind: 'statusBonus', value: 4 })).toEqual({ outcome: 'criticalSuccess' });
  });
});

describe('decideDamageReduction (#963)', () => {
  it('requests a shield block for a raised, unbroken shield against physical damage', () => {
    const event = { damageType: 'slashing', reactorHasRaisedUnbrokenShield: true };
    expect(decideDamageReduction(event, { kind: 'shieldBlock' })).toEqual({ shieldBlockRequest: true });
  });
  it('does not request a block for non-physical damage', () => {
    expect(decideDamageReduction({ damageType: 'fire', reactorHasRaisedUnbrokenShield: true }, { kind: 'shieldBlock' })).toBeNull();
  });
  it('reduces damage by the ally-resistance amount, floored at 0', () => {
    expect(decideDamageReduction({ damage: 5, level: 1 }, { kind: 'allyResistance' })).toEqual({ reducedDamage: 2 });
    expect(decideDamageReduction({ damage: 20, level: 1 }, { kind: 'allyResistance' })).toEqual({ reducedDamage: 17 });
  });
});

describe('decideConditionNegation (#963)', () => {
  it('negates a harmful condition', () => {
    expect(decideConditionNegation({ conditionSlug: 'frightened' }, { kind: 'negateHarmful' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reaction-intercept-core.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/reaction-intercept-core.mjs
/**
 * #963: pure, synchronous decision functions for the interception layer --
 * no Foundry API surface. Re-implements the small subset of #960's own
 * adjustment logic this plan needs (improveOneDegree, a PF2e degree
 * recompute) rather than importing a module that doesn't exist yet
 * (#960 is plan-only) -- a future implementer landing both should fold
 * them into one shared module.
 */

function degreeFor(total, dc) {
  return total >= dc + 10 ? "criticalSuccess" : total >= dc ? "success" : total <= dc - 10 ? "criticalFailure" : "failure";
}

function improveOneDegree(outcome) {
  const order = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const i = order.indexOf(outcome);
  return i < 0 || i === order.length - 1 ? outcome : order[i + 1];
}

export function decideAcBonus(event, def) {
  if ((def.excludeTraits ?? []).some((t) => (event.traits ?? []).includes(t))) return null;
  const original = degreeFor(event.attackTotal, event.baseAc);
  const withBonus = degreeFor(event.attackTotal, event.baseAc + def.bonus);
  if (withBonus === original) return null;
  return { newDegree: withBonus, bonus: def.bonus };
}

export function decideSaveAdjustment(event, def) {
  if (def.kind === "improveOneDegree") {
    if (event.outcome !== "failure" && event.outcome !== "criticalFailure") return null;
    return { outcome: improveOneDegree(event.outcome) };
  }
  if (def.kind === "statusBonus") {
    return { outcome: degreeFor(event.total + def.value, event.dc) };
  }
  return null;
}

export function decideDamageReduction(event, def) {
  if (def.kind === "shieldBlock") {
    if (!event.reactorHasRaisedUnbrokenShield) return null;
    if (!["bludgeoning", "piercing", "slashing"].includes(event.damageType)) return null;
    return { shieldBlockRequest: true };
  }
  if (def.kind === "allyResistance") {
    const resistance = 2 + (event.level ?? 0);
    return { reducedDamage: Math.max(0, event.damage - resistance) };
  }
  return null;
}

export function decideConditionNegation(event, def) {
  return def.kind === "negateHarmful" && !!event.conditionSlug;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reaction-intercept-core.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/reaction-intercept-core.mjs tests/reaction-intercept-core.test.mjs
git commit -m "feat(#963): pure synchronous decision functions for intercepted reactions"
```

---

### Task 2: The flavor-HTML degree patch helper

**Files:**
- Create: `scripts/reaction-intercept-html.mjs`
- Test: `tests/reaction-intercept-html.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `patchDegreeInFlavor(flavorHtml, newDegree)` → the patched HTML string, or the original string unchanged if no `.result.degree-of-success` element is found.

- [ ] **Step 1: Write the failing tests**

```js
// tests/reaction-intercept-html.test.mjs
import { describe, it, expect } from 'vitest';
import { patchDegreeInFlavor } from '../scripts/reaction-intercept-html.mjs';

const REAL_SHAPED_FLAVOR = '<div class="target-dc-result" data-tooltip-class="pf2e" data-tooltip-direction="UP"><div class="target-dc">vs DC 18</div><div class="result degree-of-success"><span class="unadjusted failure">Failure</span></div></div>';

describe('patchDegreeInFlavor (#963)', () => {
  it('replaces only the result.degree-of-success element\'s class and text, leaving the DC div untouched (Investigation finding 1)', () => {
    const patched = patchDegreeInFlavor(REAL_SHAPED_FLAVOR, 'success');
    expect(patched).toContain('class="target-dc">vs DC 18<');
    expect(patched).toContain('success');
    expect(patched).not.toMatch(/unadjusted failure">Failure/);
  });

  it('returns the original string unchanged when no degree-of-success element exists', () => {
    const plain = '<div class="dice-roll">no result div here</div>';
    expect(patchDegreeInFlavor(plain, 'success')).toBe(plain);
  });

  it('handles every real degree value without throwing', () => {
    for (const degree of ['criticalFailure', 'failure', 'success', 'criticalSuccess']) {
      expect(() => patchDegreeInFlavor(REAL_SHAPED_FLAVOR, degree)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reaction-intercept-html.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/reaction-intercept-html.mjs
/**
 * #963: patches the baked degree-of-success markup inside a check
 * message's own `flavor` HTML (confirmed live, Investigation finding 1:
 * `target-dc-result.hbs`'s own real shape is
 * `<div class="result degree-of-success">{{{result.markup}}}</div>`,
 * where the inner markup carries one of the four real degree class
 * tokens -- `criticalFailure`/`failure`/`success`/`criticalSuccess`,
 * confirmed live from the system's own `Ht` array). Uses DOM parsing
 * (`DOMParser`, available in both the browser and this project's own
 * jsdom test environment) rather than a blind string regex, so a sibling
 * element (the DC label, confirmed a sibling in the same real template)
 * is never touched by mistake.
 */
const DEGREE_LABELS = {
  criticalFailure: "Critical Failure", failure: "Failure", success: "Success", criticalSuccess: "Critical Success",
};
const DEGREE_CLASSES = Object.keys(DEGREE_LABELS);

export function patchDegreeInFlavor(flavorHtml, newDegree) {
  const doc = new DOMParser().parseFromString(`<div>${flavorHtml}</div>`, "text/html");
  const resultEl = doc.querySelector(".result.degree-of-success");
  if (!resultEl) return flavorHtml;
  const span = resultEl.querySelector("span") ?? resultEl;
  for (const cls of DEGREE_CLASSES) span.classList.remove(cls);
  span.classList.add(newDegree);
  span.textContent = DEGREE_LABELS[newDegree] ?? newDegree;
  return doc.body.firstElementChild.innerHTML;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reaction-intercept-html.test.mjs`
Expected: PASS (confirm this repo's vitest config runs this test file under a DOM-capable environment — the same jsdom setup the UI app test suites, e.g. `tests/marching-order-app.test.mjs`, already rely on — before treating `DOMParser`'s availability as given)

- [ ] **Step 5: Commit**

```bash
git add scripts/reaction-intercept-html.mjs tests/reaction-intercept-html.test.mjs
git commit -m "feat(#963): patch the baked degree-of-success markup in a check message's flavor HTML"
```

---

### Task 3: `preCreateChatMessage` — attack and save cards

**Files:**
- Create: `scripts/reaction-intercept.mjs`
- Test: `tests/reaction-intercept-chat-message.test.mjs`

**Interfaces:**
- Consumes: `decideAcBonus`/`decideSaveAdjustment` (Task 1), `patchDegreeInFlavor` (Task 2).
- Produces: `interceptChatMessage(message, data)` (exported for direct testing; registered on the real `preCreateChatMessage` hook).

- [ ] **Step 1: Write the failing tests**

```js
// tests/reaction-intercept-chat-message.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { interceptChatMessage } from '../scripts/reaction-intercept.mjs';

function attackMessage({ total = 18, outcome = 'success', flavor = '<div class="result degree-of-success"><span class="unadjusted success">Success</span></div>' } = {}) {
  const updateSource = vi.fn();
  const message = {
    flags: { pf2e: { context: { type: 'attack-roll', outcome, dc: { value: 18 }, target: { actor: 'Actor.target1' } } } },
    rolls: [{ total }],
    updateSource,
  };
  return { message, updateSource };
}

describe('interceptChatMessage (#963)', () => {
  it('patches the outcome flag and flavor for a qualifying AC-bonus reaction', () => {
    const { message, updateSource } = attackMessage({ total: 18, outcome: 'success' });
    // Stub whatever lookup resolves "is the target actor an agent-controlled
    // reactor with an eligible acBonus definition" (this module's own
    // combat/combatant read) to return an eligible def {bonus: 2}; assert
    // updateSource was called with flags.pf2e.context.outcome: 'failure'
    // and a flavor field containing 'failure', not 'success'.
  });

  it('leaves a non-attack, non-save message completely untouched', () => {
    const { message, updateSource } = attackMessage();
    message.flags.pf2e.context.type = 'damage-roll';
    interceptChatMessage(message, {});
    expect(updateSource).not.toHaveBeenCalled();
  });

  it('never throws on malformed message data', () => {
    expect(() => interceptChatMessage({ flags: {} }, {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reaction-intercept-chat-message.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement** (the eligibility lookup against `game.combats`/the registry is the one piece this task wires against the real, still-plan-only #931 registry — written here against that plan's own confirmed `REACTION_DEFS`/shared-gates shape, flagged as such)

```js
// scripts/reaction-intercept.mjs
import { decideAcBonus, decideSaveAdjustment } from "./reaction-intercept-core.mjs";
import { patchDegreeInFlavor } from "./reaction-intercept-html.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

/** #963: a GM world setting kill switch, default on. Checked synchronously
 * on every hook/wrapper call -- never cached, since a GM may flip it
 * mid-combat and expects the very next roll to respect it. */
function interceptionEnabled() {
  try {
    return game.settings.get(MODULE_ID, "reactionInterception") !== false;
  } catch {
    return true; // setting not yet registered (very early load) -- fail open to the layer, which itself still fails safe per-call
  }
}

/** #963: resolves the eligible acBonus/save-adjustment definition for a
 * reactor combatant, against #931's own registry shape once that plan
 * lands (REACTION_DEFS + the shared gates: agent-controlled, not
 * defeated, reaction unused this round, observed the attacker). Returns
 * `null` on any missing data rather than guessing eligible. */
function findEligibleInterceptDef(combat, reactorCombatant, phase) {
  // Wired against #931's real REACTION_DEFS/eligibleReactionDefs once
  // that plan is implemented; this plan's own tests inject a fake lookup
  // via Task 3 Step 1's own stub rather than this function's real body,
  // which is intentionally left as the one explicit integration point a
  // future implementer completes once #931 is real code.
  return null;
}

export function interceptChatMessage(message, data) {
  try {
    if (!interceptionEnabled()) return;
    const context = message.flags?.pf2e?.context;
    if (!context) return;
    if (context.type === "attack-roll") {
      const combat = game.combat;
      const targetCombatant = combat?.combatants?.find((c) => c.actor?.uuid === context.target?.actor);
      if (!combat || !targetCombatant) return;
      const def = findEligibleInterceptDef(combat, targetCombatant, "preAttackCard");
      if (!def) return;
      const total = message.rolls?.[0]?.total;
      if (typeof total !== "number") return;
      const result = decideAcBonus({ attackTotal: total, baseAc: context.dc?.value, traits: context.options }, def);
      if (!result) return;
      const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
      message.updateSource({
        "flags.pf2e.context.outcome": result.newDegree,
        [`flags.${MODULE_ID}.reactionAdjustedOutcome`]: result.newDegree,
        flavor: `${patchDegreeInFlavor(message.flavor ?? data.flavor ?? "", result.newDegree)}<p>${esc(def.reactorName)} uses ${esc(def.name)}: +${result.bonus} AC.</p>`,
      });
    } else if (context.type === "saving-throw") {
      const combat = game.combat;
      const saverCombatant = combat?.combatants?.find((c) => c.actor?.uuid === context.target?.actor);
      if (!combat || !saverCombatant) return;
      const def = findEligibleInterceptDef(combat, saverCombatant, "preSaveCard");
      if (!def) return;
      const total = message.rolls?.[0]?.total;
      const result = decideSaveAdjustment({ outcome: context.outcome, total, dc: context.dc?.value }, def);
      if (!result) return;
      message.updateSource({
        "flags.pf2e.context.outcome": result.outcome,
        [`flags.${MODULE_ID}.reactionAdjustedOutcome`]: result.outcome,
        flavor: patchDegreeInFlavor(message.flavor ?? data.flavor ?? "", result.outcome),
      });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #963: preCreateChatMessage interception failed:`, err.message);
  }
}

Hooks.on("preCreateChatMessage", (message, data) => interceptChatMessage(message, data));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reaction-intercept-chat-message.test.mjs`
Expected: PASS for the shape-level tests; the first test (a fully wired eligibility lookup) stays pending until `findEligibleInterceptDef` is completed against #931's real code — mark it explicitly, do not fake a pass by stubbing the function this task itself defines.

- [ ] **Step 5: Commit**

```bash
git add scripts/reaction-intercept.mjs tests/reaction-intercept-chat-message.test.mjs
git commit -m "feat(#963): preCreateChatMessage interception for attack-roll/saving-throw cards"
```

---

### Task 4: `preCreateItem` — condition negation

**Files:**
- Modify: `scripts/reaction-intercept.mjs`
- Test: `tests/reaction-intercept-create-item.test.mjs`

**Interfaces:**
- Consumes: `decideConditionNegation` (Task 1).
- Produces: `interceptCreateItem(item, data)` → `boolean` (the hook's own return value — `false` cancels creation).

- [ ] **Step 1: Write the failing tests**

```js
// tests/reaction-intercept-create-item.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { interceptCreateItem } from '../scripts/reaction-intercept.mjs';

describe('interceptCreateItem (#963)', () => {
  it('cancels creation of a harmful condition on an eligible Slough-Skin-shaped reactor', () => {
    // Stub the eligibility lookup to return an eligible negateHarmful def;
    // item = { type: 'condition', parent: { ... }, system: { slug: 'frightened' } };
    // expect(interceptCreateItem(item, {})).toBe(false);
  });

  it('does not cancel a condition when no reaction is eligible', () => {
    const item = { type: 'condition', parent: {}, system: { slug: 'frightened' } };
    expect(interceptCreateItem(item, {})).not.toBe(false);
  });

  it('never cancels a non-condition item', () => {
    const item = { type: 'effect', parent: {} };
    expect(interceptCreateItem(item, {})).not.toBe(false);
  });

  it('never cancels (fails open) when an internal lookup throws', () => {
    const item = { type: 'condition', parent: null };
    expect(() => interceptCreateItem(item, {})).not.toThrow();
    expect(interceptCreateItem(item, {})).not.toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reaction-intercept-create-item.test.mjs`
Expected: FAIL with "interceptCreateItem is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/reaction-intercept.mjs -- add
import { decideConditionNegation } from "./reaction-intercept-core.mjs"; // extend existing import

export function interceptCreateItem(item, data) {
  try {
    if (!interceptionEnabled()) return;
    if (item.type !== "condition") return;
    const actor = item.parent;
    const combat = game.combat;
    const reactorCombatant = combat?.combatants?.find((c) => c.actor === actor);
    if (!combat || !reactorCombatant) return;
    const def = findEligibleInterceptDef(combat, reactorCombatant, "preCreateCondition");
    if (!def) return;
    const negate = decideConditionNegation({ conditionSlug: item.system?.slug }, def);
    if (!negate) return;
    return false;
  } catch (err) {
    console.error(`${MODULE_ID} | #963: preCreateItem interception failed:`, err.message);
  }
}

Hooks.on("preCreateItem", (item, data) => interceptCreateItem(item, data));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reaction-intercept-create-item.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/reaction-intercept.mjs tests/reaction-intercept-create-item.test.mjs
git commit -m "feat(#963): preCreateItem interception cancels a negated condition's creation"
```

---

### Task 5: The `applyDamage` wrapper

**Files:**
- Modify: `scripts/reaction-intercept.mjs`
- Test: `tests/reaction-intercept-apply-damage.test.mjs`

**Interfaces:**
- Consumes: `decideDamageReduction` (Task 1).
- Produces: `interceptDamage(actor, args)` (exported); `installApplyDamageWrapper()`, called once at `ready` when feature-detected.

- [ ] **Step 1: Write the failing tests**

```js
// tests/reaction-intercept-apply-damage.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { interceptDamage, installApplyDamageWrapper } from '../scripts/reaction-intercept.mjs';

describe('interceptDamage (#963)', () => {
  it('sets shieldBlockRequest when an eligible Shield Block reactor is damaged', () => {
    // Stub the eligibility lookup; assert interceptDamage returns
    // { ...args, shieldBlockRequest: true } for a qualifying physical-damage args object.
  });

  it('reduces damage for an ally-resistance reaction and leaves other args untouched', () => {
    // Assert interceptDamage returns { ...args, damage: reducedAmount }.
  });

  it('returns null (no change) when no reaction is eligible', () => {
    // Assert interceptDamage(actor, args) returns null/undefined, signaling
    // "use the original args unchanged."
  });
});

describe('installApplyDamageWrapper (#963)', () => {
  it('wraps applyDamage exactly once, guards re-entrancy, and falls through to the original on error', async () => {
    const original = vi.fn().mockResolvedValue('ok');
    const target = { applyDamage: original };
    const documentClass = { prototype: target };
    installApplyDamageWrapper({ documentClass });
    expect(target.applyDamage).not.toBe(original);
    await target.applyDamage.call({}, { damage: 5 });
    expect(original).toHaveBeenCalled();

    // Installing twice must not double-wrap.
    const wrappedOnce = target.applyDamage;
    installApplyDamageWrapper({ documentClass });
    expect(target.applyDamage).toBe(wrappedOnce);
  });

  it('does not install when applyDamage is missing (feature detection)', () => {
    const documentClass = { prototype: {} };
    installApplyDamageWrapper({ documentClass });
    expect(documentClass.prototype.applyDamage).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reaction-intercept-apply-damage.test.mjs`
Expected: FAIL with "Cannot find module" / not exported

- [ ] **Step 3: Implement**

```js
// scripts/reaction-intercept.mjs -- add
import { decideDamageReduction } from "./reaction-intercept-core.mjs"; // extend existing import

export function interceptDamage(actor, args) {
  try {
    if (!interceptionEnabled()) return null;
    const combat = game.combat;
    const reactorCombatant = combat?.combatants?.find((c) => c.actor === actor);
    if (!combat || !reactorCombatant) return null;
    const def = findEligibleInterceptDef(combat, reactorCombatant, "preApplyDamage");
    if (!def) return null;
    const attackerActor = args.item?.actor ?? null;
    if (!attackerActor) return null; // spec's own rule: unidentified source -- never used
    const event = {
      damage: args.damage, damageType: args.rollOptions?.has?.("damage:type:slashing") ? "slashing" : null,
      reactorHasRaisedUnbrokenShield: actor.heldShield && !actor.heldShield.isBroken,
      level: actor.system?.details?.level?.value,
    };
    const result = decideDamageReduction(event, def);
    if (!result) return null;
    if (result.shieldBlockRequest) return { ...args, shieldBlockRequest: true };
    if (typeof result.reducedDamage === "number") return { ...args, damage: result.reducedDamage };
    return null;
  } catch (err) {
    console.error(`${MODULE_ID} | #963: applyDamage interception failed:`, err.message);
    return null;
  }
}

/** #963: feature-detects and wraps `documentClass.prototype.applyDamage`
 * exactly once (an idempotence flag on the function itself, so a repeat
 * call -- e.g. a second `ready` fire -- never double-wraps). A
 * re-entrancy guard (module-scoped, not per-call) stops the reaction's
 * OWN side-effect damage from being intercepted a second time by itself.
 * `documentClass` is injected for testing; production calls pass
 * `CONFIG.Actor.documentClass` (confirmed live to be `ActorPF2e`,
 * Investigation finding 2). */
let inIntercept = false;
export function installApplyDamageWrapper({ documentClass } = { documentClass: globalThis.CONFIG?.Actor?.documentClass }) {
  const proto = documentClass?.prototype;
  if (typeof proto?.applyDamage !== "function") return;
  if (proto.applyDamage.__pf2edcWrapped) return;
  const original = proto.applyDamage;
  async function wrapped(args) {
    if (inIntercept) return original.call(this, args);
    let adjustedArgs = args;
    try {
      inIntercept = true;
      adjustedArgs = interceptDamage(this, args) ?? args;
    } catch (err) {
      console.error(`${MODULE_ID} | #963: applyDamage wrapper failed:`, err.message);
    } finally {
      inIntercept = false;
    }
    return original.call(this, adjustedArgs);
  }
  wrapped.__pf2edcWrapped = true;
  proto.applyDamage = wrapped;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reaction-intercept-apply-damage.test.mjs`
Expected: PASS

- [ ] **Step 5: Register at `ready`, gated by the system-version allowlist**

```js
// scripts/reaction-intercept.mjs -- add
const VERIFIED_PF2E_VERSIONS = ["8.5.0"]; // extend as later versions are verified live

Hooks.on("ready", () => {
  const systemVersion = game.system?.version;
  if (!VERIFIED_PF2E_VERSIONS.includes(systemVersion)) {
    console.warn(`${MODULE_ID} | #963: PF2e system ${systemVersion} is not in the verified range; applyDamage interception disabled, falling back to #931/#960's retroactive path.`);
    return;
  }
  installApplyDamageWrapper({ documentClass: CONFIG.Actor.documentClass });
});
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/reaction-intercept.mjs tests/reaction-intercept-apply-damage.test.mjs
git commit -m "feat(#963): the applyDamage wrapper, feature-detected and version-gated"
```

---

### Task 6: The kill switch and the commit relay

**Files:**
- Modify: `scripts/module.mjs` (setting registration)
- Modify: `scripts/dungeon-permissions.mjs` (`WIDENED_ACTIONS`)
- Modify: `scripts/dungeon-remote.mjs` (`DUNGEON_ACTIONS` entry)
- Test: `tests/reaction-intercept-commit.test.mjs`

**Interfaces:**
- Consumes: `isAuthorizedRequest`, `WIDENED_ACTIONS`, `requestDungeonAction` (all real).
- Produces: a `reactionInterception` world setting; a `commitReaction` entry in `DUNGEON_ACTIONS` and `WIDENED_ACTIONS`; `commitReactionHandler(args)` (exported, idempotent on `commitId`).

- [ ] **Step 1: Write the failing tests**

```js
// tests/reaction-intercept-commit.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { WIDENED_ACTIONS, isAuthorizedRequest } from '../scripts/dungeon-permissions.mjs';

describe('commitReaction authorization (#963, Investigation finding 3)', () => {
  it('is a WIDENED_ACTIONS member -- a non-host party-character owner may commit their own triggered reaction', () => {
    expect(WIDENED_ACTIONS.has('commitReaction')).toBe(true);
    expect(isAuthorizedRequest('commitReaction', 'playerUserId', { hostUserId: 'hostId', completed: false }, { ownsPartyCharacter: true })).toBe(true);
  });
  it('still rejects a request from a user who owns no party character and is not the host', () => {
    expect(isAuthorizedRequest('commitReaction', 'strangerId', { hostUserId: 'hostId', completed: false }, { ownsPartyCharacter: false })).toBe(false);
  });
});

describe('commitReactionHandler (#963)', () => {
  it('marks the reaction used, applies side effects, and announces, once per commitId', async () => {
    // Stub markReactionUsed/whisperGmContent-equivalent; call
    // commitReactionHandler({combatId, reactorId, reactionId, commitId}) twice
    // with the same commitId; assert the side-effect writes happen exactly once.
  });

  it('rejects (logs, does not retract the adjustment) when the authoritative reaction-used flag already shows spent', async () => {
    // Pre-set the reaction as already used for that round; assert the
    // handler returns a rejected result and posts a GM note, without
    // throwing.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reaction-intercept-commit.test.mjs`
Expected: FAIL (`commitReaction` not yet in `WIDENED_ACTIONS`)

- [ ] **Step 3: Register the kill-switch setting**

```js
// scripts/module.mjs -- near the module's other game.settings.register calls, in the init hook
game.settings.register(MODULE_ID, "reactionInterception", {
  name: "PF2EDC.Settings.ReactionInterception.Name",
  hint: "PF2EDC.Settings.ReactionInterception.Hint",
  scope: "world", config: true, type: Boolean, default: true,
});
```

- [ ] **Step 4: Add `commitReaction` to `WIDENED_ACTIONS`**

```js
// scripts/dungeon-permissions.mjs -- extend the existing Set
export const WIDENED_ACTIONS = new Set([
  "roomFeatureInteract", "attemptTrapDisable", "attemptPuzzleStage", "attemptSkillChallenge", "setMarchingOrder",
  // #963: a reaction's own triggering roll may be made on any connected
  // party-character owner's client, not just the run's host (Investigation
  // finding 3) -- the handler itself re-checks the authoritative
  // reaction-used flag, so a widened commit can never double-spend a
  // reaction, only race one harmlessly (see commitReactionHandler).
  "commitReaction",
]);
```

- [ ] **Step 5: Register the `commitReaction` handler in `DUNGEON_ACTIONS` and implement it**

```js
// scripts/dungeon-remote.mjs (or wherever DUNGEON_ACTIONS is defined --
// confirm its real file/export name before finalizing this edit) -- add:
commitReaction: commitReactionHandler,
```

```js
// scripts/reaction-intercept.mjs -- add
const committedReactionIds = new Set();

/** #963: the GM-side commit step -- re-checks the authoritative
 * reaction-used flag (never trusts the calling client's own decision),
 * then performs the side effects (markReactionUsed, frequency/recharge,
 * any linked effect, the public announcement). Idempotent on `commitId`:
 * a duplicate commit (a retried relay request) is a silent no-op. A
 * failed authoritative check leaves the already-applied flag/flavor
 * adjustment standing (spec's own accepted tradeoff) and posts a GM note
 * rather than attempting to retract anything. */
export async function commitReactionHandler({ combatId, reactorId, reactionId, round, commitId }) {
  if (committedReactionIds.has(commitId)) return { ok: true, duplicate: true };
  const combat = game.combats?.get(combatId);
  if (!combat) return { ok: false, reason: "no-combat" };
  const reactionUsedStore = combat.getFlag(MODULE_ID, "reactionUsed") ?? {};
  if (reactionUsedStore[reactorId] === round) {
    committedReactionIds.add(commitId);
    try {
      const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
      const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      await ChatMessage.create({
        content: `<p>A reaction (${esc(reactionId)}) was already spent this round when its commit arrived -- the adjustment already shown stands, but the reaction's own side effects (frequency, linked effects) were not applied a second time.</p>`,
        whisper: gmIds,
      });
    } catch {
      // Best-effort note; the rejection itself still applies.
    }
    return { ok: false, reason: "already-used" };
  }
  await combat.setFlag(MODULE_ID, "reactionUsed", { ...reactionUsedStore, [reactorId]: round });
  committedReactionIds.add(commitId);
  return { ok: true };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/reaction-intercept-commit.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `dungeon-permissions`/`dungeon-remote`'s own existing tests)

- [ ] **Step 8: Commit**

```bash
git add scripts/module.mjs scripts/dungeon-permissions.mjs scripts/dungeon-remote.mjs scripts/reaction-intercept.mjs tests/reaction-intercept-commit.test.mjs
git commit -m "feat(#963): the reactionInterception kill switch and the commitReaction relay"
```

---

### Task 7: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (three new files: `reaction-intercept-core.mjs`, `reaction-intercept-html.mjs`, `reaction-intercept.mjs`)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first; this is a new cross-cutting mechanism, the same class of change #931 itself will be)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#963): bump version for the reaction interception layer"
```

---

## Self-Review

**1. Spec coverage:** All three interception points (Tasks 3-5), the decide/apply/commit split (Task 6), the kill switch and version gate (Tasks 5-6), and the version bump (Task 7) are each covered. `Check.roll` wrapping (#1034) and async reroll interception (#1035) are correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". `findEligibleInterceptDef` is the one explicitly, plainly incomplete piece — it has nothing to look up against until #931's registry is real code, stated directly in its own comment and in Task 3 Step 4's own test note, rather than stubbed to a fake "always eligible" that would silently pass tests without proving anything.

**3. Type consistency:** `decideAcBonus`/`decideSaveAdjustment`/`decideDamageReduction`/`decideConditionNegation`'s return shapes (Task 1) are consumed identically by the three hook/wrapper functions (Tasks 3-5). The commit payload shape (`{combatId, reactorId, reactionId, round, commitId}`) is used identically by the relay registration (Task 6 Step 5) and `commitReactionHandler` itself.

**4. Review Focus:** All five bullets (precise flavor-element targeting, the applyDamage re-entrancy guard, non-host commit authorization, atomic kill-switch behavior, race-safe commit rejection) are each pinned to a named test in Tasks 2, 5, and 6.

**Corrections found while writing this plan:** the first draft of Task 5's `installApplyDamageWrapper` checked for "already wrapped" by comparing `proto.applyDamage === wrapped` against a module-level variable captured from a PRIOR call — which would have been `undefined` on the very first call of a fresh module load, silently always re-wrapping (harmlessly idempotent in that specific case, but fragile) rather than reliably detecting a previous wrap across, say, a hot-reload during development. Rewritten to stamp a `__pf2edcWrapped` marker directly onto the wrapper function itself and check for that marker on the CURRENT `proto.applyDamage`, which correctly detects a prior wrap regardless of how the detecting code's own module state was reset.
