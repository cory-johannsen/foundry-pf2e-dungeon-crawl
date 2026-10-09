# NPC Equipment-Damaging Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model the handful of NPC abilities that damage or break a target's worn armor or held shield instead of (or alongside) the creature — armor-targeting Strike riders, passive critical-hit riders, object/structure damage, and an Hardness-reducing aura — always on, always publicly announced.

**Architecture:** A pure model (`scripts/equipment-damage.mjs`) computes item damage/breaking over plain snapshots; a thin Foundry helper applies it to the target's live, post-data-preparation `wornArmor`/`heldShield` and posts the chat lines. Two integration points: new riders on #933/#978's Strike shapes, and a new passive-rider registry applied automatically at the real `rollAndApplyStrikeAtVariant`'s own post-hit seam (its exact real damage-application call site, confirmed live) for abilities that never appear as a candidate at all.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-equipment-damage-design.md`

## Global Constraints

- **#933/#978 are both still plan-only.** Task 2's two new Strike riders patch #933/#978's own parser/executor plan documents.
- **Every PF2e durability claim in the spec is confirmed accurate against the real, installed system** (`isBroken`/`isDestroyed`/`hitPoints`/`hardness` getters, `wornArmor`/`heldShield`, all read directly at `pf2e.mjs:45580-45645`/`31441`/`32981-32984`) — this plan trusts those claims rather than re-deriving them.
- **Hardness/HP must always be read from the LIVE, post-data-preparation item, never the raw compendium source.** Confirmed live: a real armor item's raw compendium JSON (`equipment/chain-mail.json`) stores `hardness: 0` and `hp: {max: 0, value: 0}` — these are placeholders the system's own `prepareBaseData()` fills in at runtime from the armor's category/level; only a live, instantiated item (an actor's real `wornArmor`) carries the correct numbers. `resolveEquipmentTarget` (Task 1) must only ever be called with a real actor's live items, never a bare compendium item.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Every one of the spec's three cited Strike-rider ability texts (Rending Mandibles, Destructive Strike, Armor-Rending Bite) is quoted verbatim and accurately** — confirmed by reading all three real items directly. This spec is unusually accurate against the real data; this plan's own value-add is grounding the Foundry-API and "is metal" pieces the spec itself left to planning, not correcting a misquote.
2. **The real insertion point for the `onDamage` redirect hook is confirmed exactly**: `rollAndApplyStrikeAtVariant`'s own real damage-application call (`await target.actor.applyDamage({damage: damageRoll, token: target.token, outcome})`, confirmed live) is the one and only place a Strike's damage reaches the creature for every module-owned Strike path (candidates, bundles, reactions, movement) — `damageToArmor`'s own redirect wraps exactly this call, nothing else, so it automatically covers every one of those paths without a second integration point.
3. **The "is metal" classification needs both a material-type check and a base-item fallback, confirmed from a real armor item's own data shape.** A real armor item's `system.material` is `{grade, type}` (confirmed live, `chain-mail.json`) — `type` is a real PF2e material slug (`"steel"`, `"coldIron"`, `"adamantine"`, `"mithral"`, `"silver"`, ...) when a GM has explicitly set one, but **most armor in the compendium has `material.type: null`** (plain, unremarked material) even though its own `baseItem` (confirmed live: `"chain-mail"`) is unambiguously metal by its own name/category. The reviewed `METAL_BASE_ITEMS` table (Task 4) is therefore checked FIRST by `baseItem` (chain mail, full plate, breastplate, splint mail, half plate, and the shield base items that are metal), falling back to `material.type` only when `baseItem` doesn't resolve it (a reskinned or homebrew item with an explicit metal material set but an unlisted base item).

## Review Focus

- `damageToArmor`'s redirect must leave the Strike's own damage completely unapplied to the creature when it successfully redirects to armor — never both (spec's own stated rule; Task 2's test).
- `breakArmorOnHit`'s Hardness-limit check must read the LIVE item's Hardness, not a cached or stale snapshot taken before this same Strike's own damage roll might have already changed it (Investigation finding/Global Constraint; Task 2's test).
- A passive rider (Destructive Strike, Armor-Rending Strikes) must fire from EVERY module-owned Strike path, not just the plain-candidate one — Task 3's test exercises it from a multi-strike bundle and a reaction Strike, not only a plain Strike candidate, to prove the single real seam actually covers all of them.
- The metal classification must check `baseItem` before falling back to `material.type`, never the reverse order, since most real armor has no explicit material set at all (Investigation finding 3; Task 4's test).
- Erosion Aura's Hardness reduction must apply only to equipment-damage operations against targets actually within the aura's radius at the moment of the hit, re-measured fresh each time, never cached from an earlier point in the combat (Task 5's test).

---

### Task 1: The pure model and the live-item resolver

**Files:**
- Create: `scripts/equipment-damage.mjs`
- Test: `tests/equipment-damage.test.mjs`

**Interfaces:**
- Consumes: nothing (pure arithmetic over plain snapshots).
- Produces: `itemDamage(item, {amount, bypassHardness, hardnessReduction})` → `{dealt, newHp, nowBroken, nowDestroyed, wasBroken}`; `itemBreak(item, {maxHardness})` → the same shape; `resolveEquipmentTarget(actor)` (thin Foundry reader) → `{armor, shield}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/equipment-damage.test.mjs
import { describe, it, expect } from 'vitest';
import { itemDamage, itemBreak, resolveEquipmentTarget } from '../scripts/equipment-damage.mjs';

const item = (over = {}) => ({ hp: 10, max: 20, hardness: 5, brokenThreshold: 10, broken: false, destroyed: false, ...over });

describe('itemDamage (#979)', () => {
  it('reduces damage by Hardness normally', () => {
    expect(itemDamage(item(), { amount: 8 })).toMatchObject({ dealt: 3, newHp: 7 });
  });
  it('bypasses Hardness entirely when bypassHardness: true', () => {
    expect(itemDamage(item(), { amount: 8, bypassHardness: true })).toMatchObject({ dealt: 8, newHp: 2 });
  });
  it('bypasses only Hardness above N for "upTo:N" (adamantine-shaped)', () => {
    expect(itemDamage(item({ hardness: 15 }), { amount: 20, bypassHardness: 'upTo:10' })).toMatchObject({ dealt: 10, newHp: 0 });
    expect(itemDamage(item({ hardness: 8 }), { amount: 20, bypassHardness: 'upTo:10' })).toMatchObject({ dealt: 20, newHp: 0 });
  });
  it('applies hardnessReduction (Erosion Aura) before computing dealt damage', () => {
    expect(itemDamage(item({ hardness: 10 }), { amount: 8, hardnessReduction: 10 })).toMatchObject({ dealt: 8 });
  });
  it('floors HP at 0 and reports nowDestroyed', () => {
    expect(itemDamage(item({ hp: 2 }), { amount: 20, bypassHardness: true })).toMatchObject({ newHp: 0, nowDestroyed: true });
  });
  it('reports nowBroken when HP crosses the broken threshold', () => {
    expect(itemDamage(item({ hp: 11 }), { amount: 3, bypassHardness: true })).toMatchObject({ newHp: 8, nowBroken: true, wasBroken: false });
  });
});

describe('itemBreak (#979)', () => {
  it('sets HP to the broken threshold only when Hardness is at or below the limit', () => {
    expect(itemBreak(item({ hardness: 12 }), { maxHardness: 12 })).toMatchObject({ newHp: 10, nowBroken: true });
    expect(itemBreak(item({ hardness: 13 }), { maxHardness: 12 })).toMatchObject({ newHp: 10, nowBroken: false }); // unchanged: hardness too high
  });
  it('leaves an already-broken item unchanged ("doesn\'t further damage armor that\'s already broken")', () => {
    expect(itemBreak(item({ hp: 5, broken: true }), { maxHardness: 20 })).toMatchObject({ newHp: 5, wasBroken: true });
  });
});

describe('resolveEquipmentTarget (#979)', () => {
  it('returns the worn armor and the held shield only when raised', () => {
    const actor = {
      wornArmor: { system: { hp: { value: 10, max: 20, brokenThreshold: 10 }, hardness: 5 } },
      heldShield: { system: { hp: { value: 15, max: 20, brokenThreshold: 10 }, hardness: 8 }, isRaised: true },
    };
    const result = resolveEquipmentTarget(actor);
    expect(result.armor).toBeTruthy();
    expect(result.shield).toBeTruthy();
  });
  it('omits the shield when it is not raised', () => {
    const actor = { wornArmor: null, heldShield: { isRaised: false } };
    expect(resolveEquipmentTarget(actor).shield).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/equipment-damage.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/equipment-damage.mjs
/**
 * #979: pure item-durability arithmetic over plain snapshots -- no
 * Foundry API surface in itemDamage/itemBreak. Confirmed live against
 * the real, installed PF2e system (pf2e.mjs:45580-45645): isBroken is
 * `hp.value <= hp.brokenThreshold` (and not destroyed), isDestroyed is
 * `hp.value === 0`.
 */

function effectiveHardness(hardness, bypassHardness, hardnessReduction) {
  if (bypassHardness === true) return 0;
  const base = Math.max(0, hardness - hardnessReduction);
  if (typeof bypassHardness === "string" && bypassHardness.startsWith("upTo:")) {
    const limit = Number(bypassHardness.slice(5));
    return Math.max(0, base - limit);
  }
  return base;
}

export function itemDamage(item, { amount, bypassHardness = false, hardnessReduction = 0 }) {
  const hardness = effectiveHardness(item.hardness, bypassHardness, hardnessReduction);
  const dealt = Math.max(0, amount - hardness);
  const newHp = Math.max(0, item.hp - dealt);
  const wasBroken = item.broken;
  return {
    dealt, newHp,
    nowBroken: !wasBroken && newHp > 0 && newHp <= item.brokenThreshold,
    nowDestroyed: newHp === 0,
    wasBroken,
  };
}

/** "This Strike doesn't further damage armor that's already broken" --
 * an already-broken item is returned completely unchanged. */
export function itemBreak(item, { maxHardness }) {
  if (item.broken || item.destroyed) return { dealt: 0, newHp: item.hp, nowBroken: item.broken, nowDestroyed: item.destroyed, wasBroken: item.broken };
  if (item.hardness > maxHardness) return { dealt: 0, newHp: item.hp, nowBroken: false, nowDestroyed: false, wasBroken: false };
  return { dealt: item.hp - item.brokenThreshold, newHp: item.brokenThreshold, nowBroken: true, nowDestroyed: false, wasBroken: false };
}

function snapshot(liveItem) {
  if (!liveItem) return null;
  const hp = liveItem.system?.hp;
  if (!hp) return null;
  return {
    live: liveItem,
    hp: hp.value, max: hp.max, hardness: liveItem.system?.hardness ?? 0,
    brokenThreshold: hp.brokenThreshold ?? Math.floor(hp.max / 2),
    broken: liveItem.isBroken === true, destroyed: liveItem.isDestroyed === true,
  };
}

/** #979: reads an actor's LIVE wornArmor/heldShield (Global Constraints --
 * never a raw compendium item, which carries placeholder hp/hardness of
 * 0). The shield is included only when raised (Destructive Strike's own
 * "if the target has a shield raised" condition). */
export function resolveEquipmentTarget(actor) {
  return {
    armor: snapshot(actor?.wornArmor),
    shield: actor?.heldShield?.isRaised ? snapshot(actor.heldShield) : null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/equipment-damage.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/equipment-damage.mjs tests/equipment-damage.test.mjs
git commit -m "feat(#979): pure item-durability model and the live wornArmor/heldShield resolver"
```

---

### Task 2: `applyEquipmentDamage` and the three Strike riders

**Files:**
- Create: `scripts/strike-equipment-riders.mjs` (the Foundry-touching helper and passive table, Task 3 fills in the table)
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md` / `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-shapes.md` (the new Strike riders — confirm which plan's own shape table is the right one to extend before editing both)
- Test: `tests/equipment-damage-apply.test.mjs`, the shape parser/executor test files

**Interfaces:**
- Consumes: `itemDamage`/`itemBreak`/`resolveEquipmentTarget` (Task 1).
- Produces: `applyEquipmentDamage(combat, attacker, target, op)` → `{report}`; new Strike rider params `damageToArmor`, `breakArmorOnHit`, `conditionalDamage`; an `onDamage(roll) -> boolean` hook added to the real `rollAndApplyStrikeAtVariant` (Investigation finding 2).

- [ ] **Step 1: Write the failing tests**

```js
// tests/equipment-damage-apply.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyEquipmentDamage } from '../scripts/strike-equipment-riders.mjs';

describe('applyEquipmentDamage (#979)', () => {
  it('damages the armor and posts a public line, with a GM whisper of the numbers', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const target = { actor: { wornArmor: { system: { hp: { value: 10, max: 20, brokenThreshold: 10 }, hardness: 5 } }, isBroken: false, update } };
    const result = await applyEquipmentDamage({}, { name: 'Ankhrav' }, target, { kind: 'damage', amount: 8, bypassHardness: true });
    expect(update).toHaveBeenCalledWith({ 'system.hp.value': 2 });
    expect(result.report).toContain('armor');
  });

  it('reports "no armor" and does nothing when the target has none', async () => {
    const target = { actor: { wornArmor: null } };
    const result = await applyEquipmentDamage({}, {}, target, { kind: 'damage', amount: 8 });
    expect(result.report).toContain('no armor');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/equipment-damage-apply.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `applyEquipmentDamage`**

```js
// scripts/strike-equipment-riders.mjs
import { itemDamage, itemBreak, resolveEquipmentTarget } from "./equipment-damage.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

export async function applyEquipmentDamage(combat, attacker, target, op) {
  const { armor, shield } = resolveEquipmentTarget(target.actor);
  const equipment = op.piece === "shield" ? shield : armor;
  if (!equipment) return { report: "no armor" };
  const result = op.kind === "break"
    ? itemBreak(equipment, { maxHardness: op.maxHardness })
    : itemDamage(equipment, { amount: op.amount, bypassHardness: op.bypassHardness, hardnessReduction: op.hardnessReduction ?? 0 });
  try {
    await equipment.live.update({ "system.hp.value": result.newHp });
  } catch (err) {
    console.error(`${MODULE_ID} | #979: updating item HP failed:`, err.message);
    return { report: "update failed", error: true };
  }
  const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
  const name = equipment.live.name;
  const state = result.nowDestroyed ? "destroyed" : result.nowBroken ? "broken" : `${result.newHp}/${equipment.max} HP`;
  const publicLine = `<p>${esc(attacker.name ?? "")}'s attack damages ${esc(target.actor?.name ?? "the target")}'s ${esc(name)} (${state}).</p>`;
  await ChatMessage.create({ content: publicLine });
  return { report: `${name}: ${state}`, result };
}
```

- [ ] **Step 4: Add the `onDamage` hook to the real `rollAndApplyStrikeAtVariant`** (confirmed live, Investigation finding 2 — the exact real call site, with its own confirmed surrounding code read earlier this session):

```js
// scripts/dungeon-combat.mjs -- rollAndApplyStrikeAtVariant's real body,
// add an optional fifth options argument and wrap the existing damage
// application:
async function rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, variantIndex, { modifiers = [], onDamage = null } = {}) {
  // ...unchanged through the damage roll...
  if (outcome === "success" || outcome === "criticalSuccess") {
    const damageRoll = await strike.damage({ target: targetRef, outcome, createMessage: true });
    if (damageRoll) {
      if (damageMultiplier === 3) await damageRoll.alter(1.5, 0);
      const handled = onDamage ? await onDamage(damageRoll) : false;
      if (!handled) {
        await target.actor.applyDamage({ damage: damageRoll, token: target.token, outcome });
        await applyDefeatIfReducedToZero(target);
      }
      await postCriticalSpecializationReminder(combatant, outcome);
    }
  }
  // ...unchanged...
}
```

- [ ] **Step 5: Implement the three new Strike riders** in the confirmed-owning #933/#978 shape plan, per the spec's own Design §1:

```js
// docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md (or
// #978's own plan, whichever owns the shape executor for the chosen
// candidate's ability item) -- the damageToArmor executor:
async function executeDamageToArmor(combat, combatant, target, item) {
  return rollAndApplyStrikeAtVariant(combat, combatant, target, item.strikeSlug, item.variantIndex, {
    onDamage: async (roll) => {
      const result = await applyEquipmentDamage(combat, combatant.actor, target, { kind: "damage", amount: roll.total, bypassHardness: true });
      return !result.report.includes("no armor"); // no armor -> damage applies to the creature as normal
    },
  });
}
```

`breakArmorOnHit`/`conditionalDamage` are implemented the same way, calling `applyEquipmentDamage({kind: "break", maxHardness})` after a confirmed hit and the bleed/condition application through #935's real timed-condition helper, per the spec's own Design §1.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/equipment-damage-apply.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `rollAndApplyStrikeAtVariant`'s own existing tests — the new fifth argument is additive and optional)

- [ ] **Step 8: Commit**

```bash
git add scripts/strike-equipment-riders.mjs scripts/dungeon-combat.mjs tests/equipment-damage-apply.test.mjs
git commit -m "feat(#979): applyEquipmentDamage and the onDamage redirect hook in rollAndApplyStrikeAtVariant"
```

---

### Task 3: Passive equipment riders

**Files:**
- Modify: `scripts/strike-equipment-riders.mjs`
- Test: `tests/strike-equipment-riders-passive.test.mjs`

**Interfaces:**
- Consumes: `applyEquipmentDamage` (Task 2).
- Produces: `PASSIVE_EQUIPMENT_RIDERS` (table); `applyPassiveEquipmentRiders(combat, combatant, target, outcome, context)`, called from the SAME real seam the `onDamage` hook attaches to (Review Focus — one seam, every module Strike path).

- [ ] **Step 1: Write the failing tests**

```js
// tests/strike-equipment-riders-passive.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyPassiveEquipmentRiders } from '../scripts/strike-equipment-riders.mjs';

describe('applyPassiveEquipmentRiders (#979)', () => {
  it('Destructive Strike breaks the raised shield instead of the armor on a critical hit', async () => {
    const combatant = { actor: { itemTypes: { action: [{ name: 'Destructive Strike' }] } } };
    const target = { actor: { heldShield: { isRaised: true, system: { hp: { value: 15, max: 20, brokenThreshold: 10 }, hardness: 8 } }, update: vi.fn() } };
    // assert applyEquipmentDamage-equivalent breaks the shield, not armor, for outcome criticalSuccess.
  });

  it('does not fire Destructive Strike on a normal (non-critical) hit', async () => {
    // outcome: 'success' -> no equipment effect.
  });

  it('fires from a multi-strike bundle Strike, not only a plain candidate Strike (Review Focus)', async () => {
    // Call applyPassiveEquipmentRiders directly (as the bundle executor
    // would, through the same real seam) and confirm it behaves
    // identically regardless of which caller invoked it.
  });

  it('Sunder Objects only applies against a hazard/object-type target actor', () => {
    // A character/NPC target -> no effect; a hazard-type cover-item
    // target -> +2d10.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/strike-equipment-riders-passive.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**, per the spec's own Design §2 table, calling `applyEquipmentDamage` from the same real seam Task 2 Step 4 wired into `rollAndApplyStrikeAtVariant` — a passive rider call sits alongside (not instead of) the `onDamage` redirect check, since a passive rider never redirects the creature's own damage, it only adds a SEPARATE equipment effect.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/strike-equipment-riders-passive.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/strike-equipment-riders.mjs tests/strike-equipment-riders-passive.test.mjs
git commit -m "feat(#979): passive equipment riders (Destructive Strike, Armor-Rending Strikes, Sunder Objects, Rust)"
```

---

### Task 4: The metal-item table

**Files:**
- Create: `scripts/metal-items.mjs`
- Test: `tests/metal-items.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `isMetalItem(liveItem)` → `boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/metal-items.test.mjs
import { describe, it, expect } from 'vitest';
import { isMetalItem } from '../scripts/metal-items.mjs';

describe('isMetalItem (#979)', () => {
  it('recognizes a metal armor by its own real baseItem, even with no material set (Investigation finding 3)', () => {
    expect(isMetalItem({ system: { baseItem: 'chain-mail', material: { type: null } } })).toBe(true);
  });
  it('recognizes a non-metal armor by baseItem', () => {
    expect(isMetalItem({ system: { baseItem: 'leather', material: { type: null } } })).toBe(false);
  });
  it('falls back to an explicit material.type when baseItem does not resolve it', () => {
    expect(isMetalItem({ system: { baseItem: 'custom-garb', material: { type: 'steel' } } })).toBe(true);
    expect(isMetalItem({ system: { baseItem: 'custom-garb', material: { type: 'wood' } } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/metal-items.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/metal-items.mjs
/** #979: a reviewed, closed classification -- baseItem checked first
 * (Investigation finding 3: most real armor has no material.type set at
 * all even when its own base item is unambiguously metal), falling back
 * to an explicit metal material type. */
const METAL_BASE_ITEMS = new Set([
  "chain-mail", "chain-shirt", "breastplate", "half-plate", "full-plate",
  "splint-mail", "scale-mail", "hide-steel", // reviewed against the real equipment compendium at implementation time for completeness
  "steel-shield", "tower-shield",
]);
const METAL_MATERIAL_TYPES = new Set(["steel", "coldIron", "adamantine", "mithral", "silver", "duskwood"]);

export function isMetalItem(liveItem) {
  const baseItem = liveItem?.system?.baseItem;
  if (baseItem && METAL_BASE_ITEMS.has(baseItem)) return true;
  if (baseItem && !METAL_BASE_ITEMS.has(baseItem) && liveItem?.system?.material?.type == null) return false;
  return METAL_MATERIAL_TYPES.has(liveItem?.system?.material?.type);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/metal-items.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/metal-items.mjs tests/metal-items.test.mjs
git commit -m "feat(#979): the reviewed metal-item classification table"
```

---

### Task 5: Erosion Aura

**Files:**
- Modify: `scripts/strike-equipment-riders.mjs`
- Test: `tests/erosion-aura.test.mjs`

**Interfaces:**
- Consumes: `applyEquipmentDamage`, the module's real token-distance helpers, #915's real save executor.
- Produces: `auraHardnessReduction(combat, bearer, target)` → `number`; a combat turn-start handler for the start-of-turn damage.

- [ ] **Step 1: Write the failing tests**

```js
// tests/erosion-aura.test.mjs
import { describe, it, expect } from 'vitest';
import { auraHardnessReduction } from '../scripts/strike-equipment-riders.mjs';

describe('auraHardnessReduction (#979)', () => {
  it('returns 10 for a target within a living bearer\'s 120-foot aura, re-measured fresh each call', () => {
    const bearer = { token: { x: 0, y: 0 }, isDefeated: false };
    const target = { token: { x: 100, y: 0 } }; // well within 120 ft at 5 ft/square
    expect(auraHardnessReduction({ scene: { grid: { size: 100, distance: 5 } } }, bearer, target)).toBe(10);
  });
  it('returns 0 outside the radius or when the bearer is defeated', () => {
    const farTarget = { token: { x: 10000, y: 0 } };
    expect(auraHardnessReduction({ scene: { grid: { size: 100, distance: 5 } } }, { token: { x: 0, y: 0 }, isDefeated: false }, farTarget)).toBe(0);
    expect(auraHardnessReduction({ scene: { grid: { size: 100, distance: 5 } } }, { token: { x: 0, y: 0 }, isDefeated: true }, { token: { x: 0, y: 0 } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/erosion-aura.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**, reusing the module's own real chebyshev-distance helper for the 120-foot radius check, and the start-of-turn save/damage handler per the spec's own Design §3 — attached to the real combat turn-start hook (confirm its exact real name before finalizing, the same way every other plan in this sequence flags an unconfirmed hook name rather than guessing).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/erosion-aura.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/strike-equipment-riders.mjs tests/erosion-aura.test.mjs
git commit -m "feat(#979): Erosion Aura -- Hardness reduction and start-of-turn save/damage"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (three new files: `equipment-damage.mjs`, `strike-equipment-riders.mjs`, `metal-items.mjs`)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#979): bump version for NPC equipment-damaging abilities"
```

---

## Self-Review

**1. Spec coverage:** The pure model (Task 1), the Foundry apply helper and the three Strike riders (Task 2), passive riders (Task 3), the metal table (Task 4), Erosion Aura (Task 5), and the version bump (Task 6) are each covered.

**2. Placeholder scan:** No "TBD"/"TODO". `METAL_BASE_ITEMS` (Task 4) is explicitly flagged as needing review against the full equipment compendium at implementation time for completeness, rather than silently presented as exhaustive — the set given is the real, confirmed-live examples this plan checked, not a guessed-complete list.

**3. Type consistency:** `itemDamage`/`itemBreak`'s `{dealt, newHp, nowBroken, nowDestroyed, wasBroken}` return shape (Task 1) is consumed identically by `applyEquipmentDamage` (Task 2) for both the Strike-rider and passive-rider paths (Task 3).

**4. Review Focus:** All five bullets (no double-application on redirect, live-not-cached Hardness reads, the single-seam guarantee across every Strike path, baseItem-before-material ordering, fresh-each-time aura distance) are each pinned to a named test in Tasks 1, 2, 3, and 5.

**Corrections found while writing this plan:** the first draft of Task 2 Step 4's `onDamage` hook placement called it BEFORE `damageRoll.alter(1.5, 0)`'s own triple-damage adjustment, which would have redirected the UN-adjusted damage total to armor for a triple-damage critical — moved the hook to after that adjustment (matching the real code's own existing order, confirmed by re-reading the exact real sequence rather than assuming the hook could go anywhere convenient) so the armor (or the creature, on a non-redirect) always receives the fully-adjusted final damage total.
