# Resolve Combat on Party Incapacitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Combat resolves as a defeat as soon as every party combatant is incapacitated (dying, unconscious, or actually dead) instead of waiting forever for literal death — which, since #410 stopped hostile AI from ever attacking a downed PC again, can never happen on its own.

**Architecture:** Two independent pieces. (1) `combatSideStatus`'s `partyDefeated` check (`scripts/dungeon-combat.mjs`) starts counting a party *character* as defeated once it's incapacitated (reusing #410's own `isDownedCharacter`), not just once `Combatant#isDefeated` is true. (2) Critically — confirmed live before writing this plan — that logic fix alone would never actually run: PF2e's `actor.increaseCondition("dying")` adds the condition as a new embedded Item on the actor, which fires Foundry's `createItem` hook, not `updateActor` (the hook this module's existing auto-resolve wiring listens to). A new `createItem` hook, filtered to condition items, is added so the fight actually gets re-checked the moment a PC goes down.

**Tech Stack:** Vanilla JS (`scripts/dungeon-combat.mjs`, `scripts/module.mjs`), vitest; one finding in this plan is verified against the live running world (via `foundry-rest`) rather than assumed, since it concerns real Foundry/PF2e hook-firing behavior this codebase has never exercised before.

**Spec:** None — a bounded fix with the one real design/product question (what should "defeat" mean while a PC could still be stabilized?) already resolved directly with the user before writing this plan: defeat resolves immediately once every party combatant is incapacitated, no grace period, no GM prompt — because once every party combatant is down simultaneously, there is by definition no conscious ally left to do any stabilizing, and nothing else in this system can ever change that state once #410's "don't attack downed PCs" behavior is in effect.

## Global Constraints

- Only `combatSideStatus`'s `partyDefeated` computation changes — `hostilesDefeated` and every other part of the existing defeat/victory resolution flow (`autoResolveIfDecided`, `resolveCombat`, XP granting, loot conversion) are unchanged. This issue and fix are specifically about the party side.
- A non-`"character"`-type party combatant (e.g. a summoned ally) still requires the real `isDefeated` flag to count as defeated — the dying/stabilization nuance (and `isDownedCharacter`'s own existing scoping) is specific to PF2e player characters, per #410's own precedent. Don't broaden this.
- The new `createItem` hook must filter to `item.type === "condition"` before doing any combat lookup — `createItem` fires for every item creation in the entire game (loot pickups, granted gear, spell items, etc.), and this module must not pay a combat-lookup cost for all of those.
- Confirmed live (this plan's own verification, not assumed): `actor.increaseCondition("dying")` fires `createItem` (4 events observed: dying, unconscious, blinded, prone condition items), never `updateActor` (0 events observed). Any step in this plan that assumes otherwise is wrong — re-verify live rather than trust prose if this ever seems inconsistent with observed behavior.

## Review Focus

- **A party with one PC still conscious and the rest dying/unconscious.** Must stay `partyDefeated: false` — this is the "could still be stabilized" case the issue itself raises, and it's exactly why the fix checks every party combatant, not any. Task 1's tests cover this explicitly as a negative case, not just the all-down positive case.
- **A non-character party ally (e.g. a summon) that's merely unconscious but not `isDefeated` and not dying**, alongside every actual PC being down. Must stay `partyDefeated: false`, per the Global Constraint above — `isDownedCharacter` only applies to `"character"`-type actors, so an ally in this state doesn't count as incapacitated and correctly blocks resolution until it's genuinely defeated. Task 1's tests cover this as its own explicit case, not left to be inferred from the character-only cases.
- **The hook actually firing in practice**, not just the logic being correct in isolation. This is the central risk this plan exists to address — Task 2 and Task 3 exist specifically because a correct `combatSideStatus` alone was proven (live, before this plan was written) to never be re-invoked at the moment that matters.
- **`createItem` firing for something that isn't a condition at all** (e.g. a players's newly-granted loot, a prepared spell) must not trigger an unnecessary combat-resolution check on every such event across the whole game, every session. Task 2's filter (`item.type !== "condition"`) is checked first, before any `game.combats` lookup.
- **Hostile defeat and NPC auto-defeat (#476) must be completely unaffected.** `hostilesDefeated` and `autoDefeatZeroHpNpcs` aren't touched by this plan at all — Task 1's tests include at least one case asserting `hostilesDefeated` is still computed exactly as before, so a reviewer doesn't have to take "I didn't touch that" on faith.

---

## Task 1: `combatSideStatus` resolves party defeat on incapacitation, not just `isDefeated`

**Files:**
- Modify: `scripts/dungeon-combat.mjs:237-247` (`combatSideStatus`)
- Test: `tests/dungeon-combat-side-status.test.mjs` (new)

**Interfaces:**
- Consumes: the existing, unchanged, module-private `isDownedCharacter(combatant)` (`scripts/dungeon-combat.mjs:681-686`) — `true` when `combatant.actor?.type === "character"` and its conditions include `"unconscious"` or `"dying"`.
- Produces: `combatSideStatus(combat): { hostilesDefeated, partyDefeated }` — same exported signature as today; only the `partyDefeated` computation changes. `autoResolveIfDecided` (the only real caller) needs no changes at all — it already just destructures these two booleans.

- [x] **Step 1: Write the failing tests**

Create `tests/dungeon-combat-side-status.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { combatSideStatus } from "../scripts/dungeon-combat.mjs";

function makeCombatant({
  disposition,
  isDefeated = false,
  actorType = "character",
  conditions = [],
} = {}) {
  return {
    isDefeated,
    token: { disposition },
    actor: { type: actorType, conditions: conditions.map((slug) => ({ slug })) },
  };
}

describe("combatSideStatus", () => {
  it("both false while the fight is still going (everyone up)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1 }),
      ],
    };
    expect(combatSideStatus(combat)).toEqual({
      hostilesDefeated: false,
      partyDefeated: false,
    });
  });

  it("hostilesDefeated is true once every hostile combatant is isDefeated (unchanged behavior)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1, isDefeated: true }),
        makeCombatant({ disposition: -1, isDefeated: true }),
        makeCombatant({ disposition: 1 }),
      ],
    };
    const result = combatSideStatus(combat);
    expect(result.hostilesDefeated).toBe(true);
    expect(result.partyDefeated).toBe(false);
  });

  it("partyDefeated is true once every party combatant is isDefeated (unchanged behavior, no conditions involved)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, isDefeated: true }),
        makeCombatant({ disposition: 1, isDefeated: true }),
      ],
    };
    expect(combatSideStatus(combat).partyDefeated).toBe(true);
  });

  it("#580: partyDefeated is true once every party PC is dying/unconscious, even though none are isDefeated", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, conditions: ["dying", "unconscious"] }),
        makeCombatant({ disposition: 1, conditions: ["unconscious"] }),
      ],
    };
    expect(combatSideStatus(combat).partyDefeated).toBe(true);
  });

  it("#580: partyDefeated stays false when at least one party PC is still conscious (could still stabilize the rest)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, conditions: ["dying", "unconscious"] }),
        makeCombatant({ disposition: 1, conditions: [] }), // conscious
      ],
    };
    expect(combatSideStatus(combat).partyDefeated).toBe(false);
  });

  it("#580: a merely-unconscious, non-character party ally does not count as incapacitated -- only a real character's dying/unconscious condition does", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, conditions: ["dying", "unconscious"] }),
        makeCombatant({
          disposition: 1,
          actorType: "npc", // a summoned ally, not a PF2e "character"
          conditions: ["unconscious"],
        }),
      ],
    };
    // The ally isn't isDefeated and isDownedCharacter doesn't apply to it
    // (not a "character") -- so the party is NOT yet all-incapacitated.
    expect(combatSideStatus(combat).partyDefeated).toBe(false);
  });

  it("stays false for an empty side (no hostiles, or no party, in this combat) -- unchanged behavior", () => {
    const partyOnly = { combatants: [makeCombatant({ disposition: 1, isDefeated: true })] };
    expect(combatSideStatus(partyOnly)).toEqual({ hostilesDefeated: false, partyDefeated: true });

    const hostileOnly = { combatants: [makeCombatant({ disposition: -1, isDefeated: true })] };
    expect(combatSideStatus(hostileOnly)).toEqual({ hostilesDefeated: true, partyDefeated: false });
  });
});
```

- [x] **Step 2: Run test to verify the new cases fail**

Run: `npx vitest run tests/dungeon-combat-side-status.test.mjs`
Expected: FAIL — the two `#580` tests and the non-character-ally test fail (`partyDefeated` is currently `false` whenever no party combatant has `isDefeated: true`, regardless of conditions); the other tests already pass today (they pin pre-existing behavior).

- [x] **Step 3: Update `combatSideStatus`**

In `scripts/dungeon-combat.mjs`, replace:

```js
/** `{ hostilesDefeated, partyDefeated }` — both false while the fight's still going. */
export function combatSideStatus(combat) {
  const groups = { hostile: [], party: [] };
  for (const c of combat.combatants)
    (c.token?.disposition === -1 ? groups.hostile : groups.party).push(c);
  return {
    hostilesDefeated:
      groups.hostile.length > 0 && groups.hostile.every((c) => c.isDefeated),
    partyDefeated:
      groups.party.length > 0 && groups.party.every((c) => c.isDefeated),
  };
}
```

with:

```js
/** `{ hostilesDefeated, partyDefeated }` — both false while the fight's
 * still going. A party combatant counts as defeated here once it's
 * actually `isDefeated` OR (#580) incapacitated via `isDownedCharacter`
 * (dying/unconscious) -- a downed PC deliberately never gets `isDefeated`
 * set (so a GM can still stabilize them), but once #410 stopped hostile
 * AI from ever attacking a downed PC again, waiting for actual death left
 * combat stalled forever the moment every PC went down -- the state is
 * already terminal from there, since nothing else in this module can
 * change it. A non-character party member (e.g. a summoned ally) still
 * needs the real `isDefeated` flag, same as today -- the dying/
 * stabilization nuance is specific to PF2e player characters, same
 * scoping `isDownedCharacter` itself already uses. */
export function combatSideStatus(combat) {
  const groups = { hostile: [], party: [] };
  for (const c of combat.combatants)
    (c.token?.disposition === -1 ? groups.hostile : groups.party).push(c);
  return {
    hostilesDefeated:
      groups.hostile.length > 0 && groups.hostile.every((c) => c.isDefeated),
    partyDefeated:
      groups.party.length > 0 &&
      groups.party.every((c) => c.isDefeated || isDownedCharacter(c)),
  };
}
```

(`isDownedCharacter` is a `function` declaration later in the same file — hoisted, so this call works regardless of declaration order; no import or reordering needed.)

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-combat-side-status.test.mjs`
Expected: PASS (all 7 tests)

- [x] **Step 5: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — no other test imports or asserts on `combatSideStatus` (confirmed via `grep -rln "combatSideStatus" tests/*.test.mjs` returning nothing prior to this task's own new file).

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-side-status.test.mjs
git commit -m "Resolve party defeat on incapacitation, not just isDefeated (#580)"
```

---

## Task 2: Actually re-check combat resolution when a condition is applied

**Files:**
- Modify: `scripts/dungeon-combat.mjs:506-513` (extract a shared lookup helper; add `maybeResolveCombatForCondition`)
- Modify: `scripts/module.mjs` (register the new `createItem` hook)

**Interfaces:**
- Produces: `maybeResolveCombatForCondition(item): Promise<{outcome, dungeonSlot, scene} | null>` (exported) — mirrors `maybeResolveCombatForActor`'s existing contract exactly, but keyed off a created Item rather than an updated Actor. Returns `null` immediately (no combat lookup at all) when `item.type !== "condition"`.
- No test for this task — see Step-by-step note below for why, matching this exact codebase's own existing precedent.

**No unit test for this task.** `maybeResolveCombatForActor` and `maybeResolveCombatForCombatant` — the two existing, already-shipped functions this one is directly modeled on — have zero unit tests today (confirmed: `grep -rln "maybeResolveCombatForActor\|maybeResolveCombatForCombatant" tests/*.test.mjs` finds nothing). This class of thin Foundry-hook-routing glue (look up the combat for a document, call through to `autoResolveIfDecided`, a module-private function with no exported seam to inject) is live-verified in this codebase, not unit-tested — same precedent `module.mjs`'s own Hooks-wired code and `tools/agent-service`'s hosted endpoints already follow throughout this project. Task 3 is where this gets real verification; Task 1's tests already prove the one piece of genuinely new *logic* (the incapacitation check) in isolation.

- [x] **Step 1: Extract the shared combat-lookup helper and add the new function**

In `scripts/dungeon-combat.mjs`, replace:

```js
/** Hook target for `updateActor` — module.mjs registers this. */
export function maybeResolveCombatForActor(actor) {
  const combat = game.combats.find(
    (c) =>
      isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actor.id),
  );
  return combat ? autoResolveIfDecided(combat) : null;
}
```

with:

```js
/** The module's own combat currently involving `actorId`, if any — shared
 * by every hook target below that needs to find "is this actor's combat
 * decided yet" from something other than the Combat/Combatant document
 * itself. */
function findModuleCombatForActor(actorId) {
  return game.combats.find(
    (c) => isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actorId),
  );
}

/** Hook target for `updateActor` — module.mjs registers this. */
export function maybeResolveCombatForActor(actor) {
  const combat = findModuleCombatForActor(actor.id);
  return combat ? autoResolveIfDecided(combat) : null;
}

/** Hook target for `createItem` — module.mjs registers this, for every
 * item creation in the game, not just combat-relevant ones; filtered to
 * condition items before doing anything else. #580: a downed PC's
 * dying/unconscious condition is applied as a brand-new embedded Item on
 * its actor (`actor.increaseCondition`) -- confirmed live that this fires
 * Foundry's `createItem` hook, never `updateActor` (0 events observed for
 * the latter, 4 for the former, in a direct live test before this plan
 * was written). Without this hook, `combatSideStatus`'s Task 1 fix is
 * correct but never actually re-checked at the moment a PC goes down --
 * nothing else in this module calls `autoResolveIfDecided` on a plain
 * condition change. */
export function maybeResolveCombatForCondition(item) {
  if (item.type !== "condition") return null;
  const actor = item.parent;
  if (!actor) return null;
  const combat = findModuleCombatForActor(actor.id);
  return combat ? autoResolveIfDecided(combat) : null;
}
```

- [x] **Step 2: Register the new hook**

In `scripts/module.mjs`, add alongside the existing `updateActor`/`updateCombatant` registrations (~line 401-409):

```js
Hooks.on("createItem", async (item) => {
  onCombatAutoResolved(await maybeResolveCombatForCondition(item));
});
```

Add `maybeResolveCombatForCondition` to the existing import list from `dungeon-combat.mjs` at the top of `module.mjs`, alongside `maybeResolveCombatForActor`/`maybeResolveCombatForCombatant`.

- [x] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS — this task adds no new test file; Task 1's suite (and every other existing test) should be unaffected, since `module.mjs`'s `Hooks.on("init"/"ready", ...)` top-level registration code is never imported by the test suite at all (confirmed by this project's own established precedent for Foundry-wiring code — see the #105/#141 plans' own notes on this).

- [x] **Step 4: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs
git commit -m "Re-check combat resolution when a condition is applied (#580)"
```

---

## Task 3: Live-verify against a real combat

**Files:** None — this task only runs the shipped code against the live world and records the outcome.

**Interfaces:** None.

- [ ] **Step 1: Confirm the change is deployed**

Using the `foundry-rest` skill against the running dev world: confirm `game.modules.get("pf2e-dungeon-crawl").version` reflects this change's own version bump, or directly check that `game.modules.get("pf2e-dungeon-crawl").api` (or the served `dungeon-combat.mjs` source) now contains `maybeResolveCombatForCondition`.

- [ ] **Step 2: Drive a real combat to an all-party-down state**

Either live in the actual running game, or via `foundry-rest` scripting: start (or join) a combat with at least one hostile and the party, then reduce every party combatant to 0 HP via whatever path applies the `dying` condition the same way real play does (`actor.increaseCondition("dying")`, or real damage application if that's more representative) — one at a time if needed, confirming the fight is still ongoing after all but the last PC goes down, and resolves immediately once the last one does.

- [ ] **Step 3: Confirm the fight actually resolves as a defeat**

Confirm the Combat document is deleted (same as any other resolved fight) shortly after the last party combatant becomes incapacitated, and — for a dungeon-run combat specifically — that `resolveCurrentRoom` was invoked with `succeeded: false` (e.g. via the room's own subsequent state, or a captured hook log the way this plan's own pre-write verification did). Confirm it does **not** resolve prematurely while at least one PC is still conscious, by checking that state at an intermediate point before the last PC goes down.

- [ ] **Step 4: Report the outcome on issue #580**

Comment on #580 with what was actually observed (confirmed working live, or a real failure mode found) before removing its `assigned` label. Per this project's own established precedent (#141's "don't close on scripted tests alone" lesson, and this plan's own central finding — a logic fix that looked complete in Tasks 1-2 was proven live, before any code was even written, to depend on a hook that doesn't fire the way a reasonable assumption would expect), this task's live confirmation is what the issue actually needs before being trusted done.
