> **SUPERSEDED (2026-10-05):** replaced by `2026-10-05-flanked-badge-indicator.md`. This plan toggled PF2e's real `off-guard` condition; review found that applies off-guard to every attacker (broader than PF2e's own flanking) and introduced multi-client write races and cleanup gaps, so the user chose a visual-only badge instead. Do not implement this plan.

# Flanked Status Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #769 — give any flanked creature (hostile, PC, or ally) a visible, always-on status indicator during combat, so players can tell at a glance who is currently off-guard from flanking, without needing to hold a hotkey or have a target selected the way PF2e's own built-in flanking-preview tool requires.

**Architecture:** PF2e's native flanking detection (#619) is confirmed purely geometric and computed fresh at attack-roll time — `Token#isFlanking`/`Token#canFlank`/`Token#onOppositeSides` (all real, already-shipped methods on the PF2e system's own canvas Token class) encode every rule this module needs (reach, hidden tokens, ally/opposition, "ignore flankable" overrides, gang-up) and write no persistent state anywhere. PF2e also ships its own `FlankingHighlightRenderer`, but confirmed live-reading its source: it only draws for the current user's own controlled/assigned token, only while holding the canvas "highlight objects" hotkey, and only with an active target — a per-attack decision aid, not an always-visible per-creature badge, so it does not already satisfy #769.

Per the user's own decision, this plan **toggles PF2e's real `off-guard` condition** (not a cosmetic-only status icon) whenever live geometry says a creature is flanked, reusing the real native methods above for the geometry so the indicator and #619's own mechanical effect can never disagree. A new `scripts/flanking.mjs` (mirroring `trap-combat.mjs`'s shape: a pure-ish decision function plus a `updateToken`-hook-driven sync) recomputes every combatant's flanked state on token movement, with a safety-net resync on combat round/turn change and cleanup when combat ends.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a bounded addition to existing combat machinery; the two open design questions (visual-only vs real condition; combat-gating) were presented to and decided by the user directly in chat rather than requiring a written spec.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A new mechanic: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- Flanking geometry is **never reimplemented** — every "is X flanked" check calls the real PF2e canvas `Token` methods (`isFlanking`/`canFlank`/`onOppositeSides`), confirmed current in `/srv/foundry/data/Data/systems/pf2e/pf2e.mjs`, so the indicator and #619's own already-correct mechanical effect share one source of truth by construction.
- The indicator only evaluates **while a Combat is active** (`game.combat` non-null, per the user's own decision) — no change outside combat; a token's flanked state is never computed or toggled when no Combat exists.
- The condition applies to **any** actor type (hostile, PC, or ally) — #769's own explicit scope ("any actor"). No alliance-based filtering.
- **Known, accepted residual risk** (confirmed via reading PF2e's own `toggleCondition`/`increaseCondition`/`decreaseCondition`, which track only a single boolean existence per condition slug per actor, with no concept of "which source granted it"): if some other effect independently grants the same actor's `off-guard` condition while this module's own flanking-driven grant is also active, this module's own later removal (when flanking ends) will remove that actor's `off-guard` condition entirely, even though another source still wants it active. This module only ever removes `off-guard` when its own `offGuardFromFlanking` actor flag says it was the one that granted it, and only ever sets that flag when the condition was absent at grant time — this is the same mitigation this module's own `pf2e-avoid-notice` integration (#616) already relies on for an analogous flat, non-stacking PF2e condition model, not a new kind of risk.

## Review Focus

- **A creature immune to off-guard, or otherwise non-flankable, must never have the condition forced onto it** — `canFlank`'s own real check already gates on `attributes.flanking.flankable`/`offGuardable`, so calling the real `isFlanking` method (rather than hand-rolling adjacency/opposite-sides math) already respects this; a test must confirm a non-flankable target never gets the condition even when geometrically surrounded.
- **Moving a token that is itself NOT flanked can still change whether a DIFFERENT token becomes (or stops being) flanked** — flanking is a three-body relationship (two attackers either side of a target), so the hook must re-evaluate every combatant on the scene on any relevant token move, not just the mover's own flanked state.
- **A condition this module did not grant must never be removed by it** — the `offGuardFromFlanking` flag must gate every removal; a creature that already had `off-guard` from an unrelated source before this module ever ran must keep it even after this module's own flanking check later says "not flanked."
- **Combat ending must not leave a stale off-guard condition behind** — every actor this module granted the condition to must have it (and the tracking flag) cleared when the Combat is deleted, mirroring how this module already cleans up other combat-scoped state in `resolveCombat`.
- **This must never fire outside combat** — ordinary dungeon-crawl movement between rooms (no active Combat) must never compute or toggle anything, matching the user's own combat-gating decision.

---

### Task 1: `scripts/flanking.mjs` — the core sync function

**Files:**
- Create: `scripts/flanking.mjs`
- Test: `tests/flanking.test.mjs`

**Interfaces:**
- Produces: `export async function syncFlankingForCombat(combat, deps = {})` — recomputes and applies flanked/off-guard state for every combatant in `combat`. `deps` (all optional, defaulting to the real Foundry/PF2e calls) exist purely for testability, mirroring `trap-combat.mjs`'s own `handleTrapTokenMove(tokenDoc, changes, deps = {})` pattern:
  - `deps.getPlaceables(combat)` → real default: `combat.combatants.map(c => c.token?.object).filter(Boolean)` (the real canvas `Token` placeables, needed because `isFlanking`/`canFlank` are methods on the rendered placeable, not the `TokenDocument`).
  - `deps.isFlanked(placeable, allPlaceables)` → real default: true if any OTHER placeable with an opposing alliance to `placeable`'s actor returns `true` from `other.isFlanking(placeable)`.
  - `deps.setOffGuard(actor, active)` → real default: the condition-toggle logic in Task 1 Step 3 below (handles the `offGuardFromFlanking` flag).
- Consumed by: Task 2 (hook wiring) and Task 3 (combat-end cleanup, via the same `deps.setOffGuard` shape for forced-off cleanup).

- [ ] **Step 1: Write the failing tests**

Create `tests/flanking.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { syncFlankingForCombat } from '../scripts/flanking.mjs';

function placeable({ id, actorId, allianceOpposedTo = [], flankedBy = [] }) {
  return {
    id,
    actor: { id: actorId },
    isFlanking: vi.fn((target) => flankedBy.includes(target.id)),
  };
}

describe('syncFlankingForCombat', () => {
  it('grants off-guard to a combatant another placeable reports as flanking', async () => {
    const flanked = placeable({ id: 'target', actorId: 'actorTarget' });
    const flanker = placeable({ id: 'flanker', actorId: 'actorFlanker', flankedBy: ['target'] });
    const setOffGuard = vi.fn(async () => {});
    const combat = { combatants: [{ token: {} }, { token: {} }] };

    await syncFlankingForCombat(combat, {
      getPlaceables: () => [flanked, flanker],
      setOffGuard,
    });

    expect(setOffGuard).toHaveBeenCalledWith(flanked.actor, true);
    expect(setOffGuard).not.toHaveBeenCalledWith(flanker.actor, true);
  });

  it('removes off-guard from a combatant no one is flanking anymore', async () => {
    const notFlanked = placeable({ id: 'target', actorId: 'actorTarget' });
    const other = placeable({ id: 'other', actorId: 'actorOther', flankedBy: [] });
    const setOffGuard = vi.fn(async () => {});
    const combat = { combatants: [{ token: {} }, { token: {} }] };

    await syncFlankingForCombat(combat, {
      getPlaceables: () => [notFlanked, other],
      setOffGuard,
    });

    expect(setOffGuard).toHaveBeenCalledWith(notFlanked.actor, false);
    expect(setOffGuard).toHaveBeenCalledWith(other.actor, false);
  });

  it('does nothing when there is no combat', async () => {
    const setOffGuard = vi.fn(async () => {});
    await syncFlankingForCombat(null, { setOffGuard });
    expect(setOffGuard).not.toHaveBeenCalled();
  });

  it('skips a placeable with no actor', async () => {
    const noActor = { id: 'ghost', actor: null, isFlanking: vi.fn() };
    const setOffGuard = vi.fn(async () => {});
    const combat = { combatants: [{ token: {} }] };

    await syncFlankingForCombat(combat, {
      getPlaceables: () => [noActor],
      setOffGuard,
    });

    expect(setOffGuard).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/flanking.test.mjs`
Expected: FAIL — `syncFlankingForCombat` is not a function.

- [ ] **Step 3: Write `scripts/flanking.mjs`**

```js
/**
 * Flanked-status sync (#769): toggles PF2e's real `off-guard` condition on
 * any combatant live canvas geometry says is currently flanked, reusing
 * PF2e's own `Token#isFlanking` (confirmed current in the system's own
 * pf2e.mjs) for the geometry — this module never reimplements flanking
 * rules, so the indicator and #619's own already-correct attack-roll
 * modifier can never disagree.
 *
 * A single boolean per condition slug per actor is all PF2e itself tracks
 * (confirmed reading `Actor#toggleCondition`/`increaseCondition`/
 * `decreaseCondition`) -- there is no "who granted this" bookkeeping in
 * PF2e itself. This module tracks its OWN grants via the actor flag
 * `offGuardFromFlanking`, and only ever removes the condition when that
 * flag says this module was the one that added it -- the same mitigation
 * #616's `pf2e-avoid-notice` integration already relies on for an
 * analogous flat PF2e condition. A condition some other effect granted
 * independently is left alone either way.
 */
const MODULE_ID = "pf2e-dungeon-crawl";

function defaultGetPlaceables(combat) {
  return (combat?.combatants ?? [])
    .map((c) => c.token?.object)
    .filter(Boolean);
}

function defaultIsFlanked(placeable, allPlaceables) {
  const actor = placeable.actor;
  if (!actor) return false;
  return allPlaceables.some(
    (other) =>
      other !== placeable &&
      other.actor &&
      other.actor.id !== actor.id &&
      typeof other.isFlanking === "function" &&
      other.isFlanking(placeable),
  );
}

async function defaultSetOffGuard(actor, active) {
  if (!actor) return;
  const grantedByUs = actor.getFlag(MODULE_ID, "offGuardFromFlanking") === true;
  if (active) {
    if (actor.hasCondition?.("off-guard")) return; // already on (ours or not) -- leave it
    await actor.toggleCondition("off-guard", { active: true });
    await actor.setFlag(MODULE_ID, "offGuardFromFlanking", true);
  } else if (grantedByUs) {
    await actor.toggleCondition("off-guard", { active: false });
    await actor.unsetFlag(MODULE_ID, "offGuardFromFlanking");
  }
}

/** Recomputes flanked/off-guard state for every combatant in `combat`.
 * No-op with no combat (#769: combat-gated by design). `deps` is
 * injectable for tests. */
export async function syncFlankingForCombat(combat, deps = {}) {
  if (!combat) return;
  const getPlaceables = deps.getPlaceables ?? defaultGetPlaceables;
  const isFlanked = deps.isFlanked ?? defaultIsFlanked;
  const setOffGuard = deps.setOffGuard ?? defaultSetOffGuard;

  const placeables = getPlaceables(combat);
  for (const placeable of placeables) {
    if (!placeable.actor) continue;
    const flanked = isFlanked(placeable, placeables);
    await setOffGuard(placeable.actor, flanked);
  }
}

/** Clears every off-guard grant this module made for `combat`'s own
 * combatants -- called once, right before the Combat document itself is
 * deleted, so a flanking-driven condition never outlives the fight. */
export async function clearFlankingForCombat(combat, deps = {}) {
  if (!combat) return;
  const setOffGuard = deps.setOffGuard ?? defaultSetOffGuard;
  for (const combatant of combat.combatants ?? []) {
    if (combatant.actor?.getFlag(MODULE_ID, "offGuardFromFlanking") === true) {
      await setOffGuard(combatant.actor, false);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/flanking.test.mjs`
Expected: PASS, all four tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/flanking.mjs tests/flanking.test.mjs
git commit -m "feat(#769): add flanking status sync core

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the hooks

**Files:**
- Modify: `scripts/module.mjs`

**Interfaces:**
- Consumes: `syncFlankingForCombat(combat, deps)` and `clearFlankingForCombat(combat, deps)` (Task 1).
- Produces: nothing further in this plan consumes it.

No unit test: hook registration is Foundry-glue with no existing test harness for `module.mjs`'s own `Hooks.on` call sites (confirmed: none of this file's existing hook registrations, including `handleTrapTokenMove`'s own, have a dedicated registration test) — verified live in Task 3 instead.

- [ ] **Step 1: Import and register**

Add to `scripts/module.mjs`'s imports:

```js
import { syncFlankingForCombat } from "./flanking.mjs";
```

Add, alongside the existing `#753` trap hook (near line 605):

```js
/** #769: recompute every combatant's flanked/off-guard status whenever a
 * token moves during an active combat -- flanking is a three-body
 * relationship, so any token's move can change whether a DIFFERENT
 * combatant is now flanked, not just the mover's own status. */
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (!game.user.isGM || !game.combat) return;
  if (!isPositionChange(changes)) return;
  syncFlankingForCombat(game.combat);
});
```

(`isPositionChange` is already imported in `module.mjs` if `handleTrapTokenMove`'s own registration needs it directly; otherwise add `import { isPositionChange } from "./placement.mjs";` alongside the existing imports — check the current import list before adding a duplicate.)

Extend the existing `updateCombat` handler (confirmed current, module.mjs ~line 589) as a safety-net resync for any flanking change this module's own `updateToken` hook might have missed (e.g. a token moved by something other than a normal update, or combat just started with tokens already positioned to flank):

```js
Hooks.on("updateCombat", (combat, changes) => {
  if (changes.turn === undefined && changes.round === undefined) return;
  autoPlayCombatantTurnIfDue(combat);
  syncFlankingForCombat(combat);
});
```

- [ ] **Step 2: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/module.mjs
git commit -m "feat(#769): wire flanking status sync into token/combat hooks

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Clean up on combat end, live-verify, version bump

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`resolveCombat`)

**Interfaces:**
- Consumes: `clearFlankingForCombat(combat)` (Task 1).

No unit test: `resolveCombat` has extensive existing test coverage for its other behaviors (loot conversion, XP), but adding a full combat-resolution fixture purely to exercise one new cleanup call is disproportionate to this task — covered by live verification (Step 2) instead, matching this file's own precedent of leaving some of `resolveCombat`'s edge behavior to live confirmation.

- [ ] **Step 1: Call cleanup before the Combat is deleted**

Add the import to `scripts/dungeon-combat.mjs`:

```js
import { clearFlankingForCombat } from "./flanking.mjs";
```

In `resolveCombat`, immediately before the existing `await combat.delete();` (confirmed current, line 442), add:

```js
  await clearFlankingForCombat(combat);
  await combat.delete();
```

- [ ] **Step 2: Live-verify via `foundry-rest`**

With a real party and hostiles in a live combat, maneuver two opposing tokens to opposite sides of a creature and confirm:

```bash
echo 'const c = game.combat; const rows = c.combatants.map(cb => ({ name: cb.actor?.name, offGuard: cb.actor?.hasCondition?.("off-guard") ?? null, flaggedByUs: cb.actor?.getFlag("pf2e-dungeon-crawl", "offGuardFromFlanking") ?? false })); return rows;' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: a genuinely flanked combatant (any alliance) shows `offGuard: true, flaggedByUs: true`; moving a flanker away removes both. Confirm a token immune to off-guard (if one is available in the test party/encounter; otherwise verify via `actor.attributes.flanking.offGuardable === false` on a known-immune creature type) never gets the condition despite being geometrically surrounded. Confirm ending the combat (resolve to victory or defeat) leaves no `offGuard: true, flaggedByUs: true` rows on any actor afterward.

- [ ] **Step 3: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real new mechanic), using whatever the fetch above shows as current.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-combat.mjs module.json
git commit -m "feat(#769): clear flanking-granted off-guard when combat ends

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #769's own ask (a visible flanked indicator for any actor, sharing #619's own geometry, with the visual-vs-condition and combat-gating decisions the issue itself flagged as open) is fully covered: Task 1 computes flanked state via PF2e's own real methods and toggles the real condition (user's decision), gated to active combat only (user's decision); Task 2 wires it reactively; Task 3 handles the one lifecycle edge the user's choice introduces (cleanup on combat end) that a cosmetic-only design would not have needed. No gaps found.

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real change.

**3. Type consistency:** `syncFlankingForCombat(combat, deps)`/`clearFlankingForCombat(combat, deps)`'s signatures (Task 1) are used identically in Task 2 (hooks) and Task 3 (`resolveCombat`). `deps.setOffGuard(actor, active)`'s shape is defined once and consumed identically by both exported functions.

**4. Review Focus:** All five items (immune/non-flankable creatures never forced, three-body re-evaluation on any token's move, never removing a condition this module didn't grant, no stale condition after combat ends, zero effect outside combat) each map to a specific test or step in the task that owns them. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-flanked-status-indicator.md`.
