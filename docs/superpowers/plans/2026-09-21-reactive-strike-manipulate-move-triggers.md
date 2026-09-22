# Reactive Strike manipulate/move triggers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two Reactive Strike triggers deferred from foundry-deck-of-many-things#202 (a manipulate action and a move action within reach) without any heuristic/guessing detection.

**Architecture:** Extract the existing ranged-attack trigger's per-reactor eligibility logic into a shared `offerReactiveStrikesAgainst(combat, mover)`, then call it from three places: the existing `createChatMessage` hook (unchanged behavior), a new hook on the module's own `strideByPosture()` (exact, automatic — the module always knows when it moves an agent-controlled combatant itself), and a new GM-facing "Reactive Strike Check" combat-tracker menu action (manual — for the two cases with no reliable hook: a player character's manipulate action or their own Stride).

**Tech Stack:** Vanilla JS (ESM), Foundry VTT + PF2e system APIs, Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-09-21-reactive-strike-manipulate-move-triggers-design.md`

## Global Constraints

- No heuristic detection anywhere (no position-delta guessing, no chat-message pattern-matching) — the spec's Decision section rules this out explicitly; automate only what's exactly detectable, otherwise require a manual GM action.
- Every merge to `main` bumps `module.json`'s `version` (project `CLAUDE.md`). This item is a minor bump (`0.2.0` → `0.3.0`): it adds new trigger mechanisms, not a routine fix.
- New i18n keys go in `lang/en.json` under the `PF2EDC.Dungeon.Combat.*` prefix, alphabetically sorted among existing keys (see `PF2EDC.Dungeon.Combat.ReactiveStrikeChat` for the existing sibling).
- All new/extracted logic lives in `scripts/dungeon-combat.mjs`; `scripts/module.mjs` only ever gets thin Hook-wiring, matching this repo's existing split (compare `toggleAgentControlled`, the logic, vs. its `Hooks.on("getCombatTrackerEntryContext", ...)` wiring).

---

## Context for every task

`scripts/dungeon-combat.mjs` (4020 lines) currently has **zero** test coverage — no test file imports it. `scripts/module.mjs` is Hook-registration glue that executes `Hooks.once(...)` at module-load time and has never been imported by a test either (it would throw immediately without a full Foundry global stub, which doesn't exist in this repo). Both of these are pre-existing gaps, not something this plan tries to fully close — it adds real coverage only for the new/changed logic, following the repo's existing pattern of exporting business logic from `dungeon-combat.mjs` for testing (e.g. `parseReactiveStrikeWeaponRestriction` in `agent-candidates.mjs`) while leaving `module.mjs`'s Hook wiring itself untested.

Because nothing in this repo mocks Foundry's runtime globals yet, Task 2 builds a small, purpose-local set of stubs (`installFoundryStubs`, `makeCombat`, `makeReactor`, `makeStrike`) directly inside the new test file — not a shared `tests/helpers/` module, since nothing else needs them yet (YAGNI). `playStrikeSound`/`playCreatureDeathSound` (from `scripts/audio.mjs` via `scripts/dungeon-sound.mjs`) already fail silently when `foundry.audio` is undefined (wrapped in try/catch, confirmed by reading `scripts/audio.mjs`), so they need no stubbing at all.

The exact code currently at `scripts/dungeon-combat.mjs:1306-1365` (referenced by every task below):

```js
export async function handleRangedAttackForReactiveStrike(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll") return;
  if (!context.options?.includes("ranged")) return;

  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  if (!sceneId || !attackerTokenId) return;
  const combat = game.combats.contents.find(
    (c) => c.scene?.id === sceneId && isModuleCombat(c),
  );
  if (!combat) return;
  const attacker = combat.combatants.find(
    (c) => c.tokenId === attackerTokenId,
  );
  if (!attacker || attacker.isDefeated) return;

  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;

  for (const reactor of combatantOpponents(combat, attacker)) {
    if (!reactor.getFlag(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    const item = (reactor.actor?.items ?? []).find(isReactiveStrikeInScope);
    if (!item) continue;

    const readyActions = (reactor.actor?.system?.actions ?? [])
      .filter((a) => a.type === "strike" && a.ready !== false)
      .map((a) => ({
        slug: a.item?.slug ?? a.slug ?? a.label,
        label: a.label,
        reachSquares: actionReachSquares(a, gridDistanceFt),
      }));
    const distanceSquares = chebyshevSquares(
      reactor.token,
      attacker.token,
      gridSize,
    );
    const inReachActions = readyActions.filter(
      (a) => distanceSquares <= a.reachSquares,
    );
    if (!inReachActions.length) continue;
    const restriction = parseReactiveStrikeWeaponRestriction(item.name);
    const matched = restriction
      ? matchMultiStrikeActionSlug(restriction, inReachActions)
      : inReachActions[0];
    if (!matched) continue;

    await markReactionUsed(combat, reactor.id, combat.round);
    await rollAndApplyStrikeAtVariant(
      combat,
      reactor,
      attacker,
      matched.slug,
      0,
    );
    await postReactiveStrikeChat(reactor, attacker);
  }
}
```

---

### Task 1: Extract `findReactiveStrikeOpportunities` (pure detection logic)

**Files:**
- Modify: `scripts/dungeon-combat.mjs:1306-1365` (extraction only in this task — `handleRangedAttackForReactiveStrike` itself is not yet rewired; that happens in Task 2 alongside `offerReactiveStrikesAgainst`)
- Test: `tests/dungeon-combat-reactive-strike.test.mjs` (new file, created in this task)

**Interfaces:**
- Produces: `export function findReactiveStrikeOpportunities(combat, mover, gridSize, gridDistanceFt) → Array<{ reactor, actionSlug }>` — every reactor (and which of their ready Strikes) is currently eligible to react against `mover`. No side effects; safe to call repeatedly.
- Consumes: nothing new — reuses `combatantOpponents`, `getReactionUsed`, `isReactiveStrikeInScope`, `actionReachSquares`, `chebyshevSquares`, `parseReactiveStrikeWeaponRestriction`, `matchMultiStrikeActionSlug`, all already private to `dungeon-combat.mjs`.

- [ ] **Step 1: Write the failing tests**

Create `tests/dungeon-combat-reactive-strike.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { findReactiveStrikeOpportunities } from "../scripts/dungeon-combat.mjs";

function makeStrike({ slug = "claw", label = "Claw", reach = null } = {}) {
  return {
    type: "strike",
    ready: true,
    slug,
    label,
    traits: reach ? [{ name: `reach-${reach}` }] : [],
    item: { slug },
  };
}

function makeReactor({
  id,
  x,
  y,
  disposition = 1,
  agentControlled = true,
  itemName = "Reactive Strike",
  strikes = [makeStrike()],
} = {}) {
  const flags = { agentControlled };
  return {
    id,
    isDefeated: false,
    token: { x, y, disposition },
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      items: [
        {
          type: "action",
          system: { actionType: { value: "reaction" } },
          name: itemName,
        },
      ],
      system: { actions: strikes },
    },
  };
}

function makeMover({ id = "mover1", x = 0, y = 0, disposition = -1 } = {}) {
  return { id, isDefeated: false, token: { x, y, disposition } };
}

function makeCombat({ round = 1, combatants = [], reactionUsed = {} } = {}) {
  const flags = { reactionUsed: { ...reactionUsed } };
  return {
    round,
    combatants,
    getFlag: (_moduleId, key) => flags[key],
  };
}

const GRID_SIZE = 100;
const GRID_DISTANCE_FT = 5;

describe("findReactiveStrikeOpportunities", () => {
  it("finds an eligible reactor with a ready Strike in reach", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([{ reactor, actionSlug: "claw" }]);
  });

  it("excludes a reactor that isn't agent-controlled", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0, agentControlled: false });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("excludes a reactor that already used its reaction this round", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeCombat({
      combatants: [mover, reactor],
      round: 2,
      reactionUsed: { r1: 2 },
    });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("excludes a reactor with no in-scope Reactive Strike item", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0, itemName: "Aid" });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("excludes a reactor with no ready Strike within reach", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 1000, y: 0 });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("matches the weapon-restricted Strike among several ready actions", () => {
    const mover = makeMover();
    const reactor = makeReactor({
      id: "r1",
      x: 100,
      y: 0,
      itemName: "Attack of Opportunity (Claw Only)",
      strikes: [makeStrike({ slug: "claw" }), makeStrike({ slug: "bite" })],
    });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([{ reactor, actionSlug: "claw" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- dungeon-combat-reactive-strike`
Expected: FAIL — `findReactiveStrikeOpportunities is not a function` (it doesn't exist in `dungeon-combat.mjs` yet).

- [ ] **Step 3: Extract the function**

In `scripts/dungeon-combat.mjs`, immediately above `handleRangedAttackForReactiveStrike` (line 1306), add:

```js
/**
 * Every currently-eligible Reactive Strike opportunity against `mover` —
 * one entry per agent-controlled opponent with an unused reaction this
 * round, an in-scope Reactive Strike/Attack of Opportunity item, and a
 * ready Strike action that reaches `mover`'s current position. Pure
 * detection: takes no action itself, so every trigger source (a ranged
 * attack-roll chat message, an agent's own Stride, a GM's manual check)
 * shares one answer to "who gets to react right now."
 */
export function findReactiveStrikeOpportunities(
  combat,
  mover,
  gridSize,
  gridDistanceFt,
) {
  const opportunities = [];
  for (const reactor of combatantOpponents(combat, mover)) {
    if (!reactor.getFlag(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    const item = (reactor.actor?.items ?? []).find(isReactiveStrikeInScope);
    if (!item) continue;

    const readyActions = (reactor.actor?.system?.actions ?? [])
      .filter((a) => a.type === "strike" && a.ready !== false)
      .map((a) => ({
        slug: a.item?.slug ?? a.slug ?? a.label,
        label: a.label,
        reachSquares: actionReachSquares(a, gridDistanceFt),
      }));
    const distanceSquares = chebyshevSquares(
      reactor.token,
      mover.token,
      gridSize,
    );
    const inReachActions = readyActions.filter(
      (a) => distanceSquares <= a.reachSquares,
    );
    if (!inReachActions.length) continue;
    const restriction = parseReactiveStrikeWeaponRestriction(item.name);
    const matched = restriction
      ? matchMultiStrikeActionSlug(restriction, inReachActions)
      : inReachActions[0];
    if (!matched) continue;

    opportunities.push({ reactor, actionSlug: matched.slug });
  }
  return opportunities;
}
```

Leave `handleRangedAttackForReactiveStrike` exactly as-is for now — it still has its own inline loop, so this new function is not yet called from production code. That rewiring is Task 2's job, alongside `offerReactiveStrikesAgainst`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- dungeon-combat-reactive-strike`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-reactive-strike.test.mjs
git commit -m "Extract findReactiveStrikeOpportunities from handleRangedAttackForReactiveStrike (#13)"
```

---

### Task 2: `offerReactiveStrikesAgainst` — shared execution, rewire the ranged trigger

**Files:**
- Modify: `scripts/dungeon-combat.mjs:1306-1365` (add `offerReactiveStrikesAgainst`, rewrite `handleRangedAttackForReactiveStrike` to use it)
- Test: `tests/dungeon-combat-reactive-strike.test.mjs`

**Interfaces:**
- Consumes: `findReactiveStrikeOpportunities` (Task 1), `markReactionUsed`, `rollAndApplyStrikeAtVariant`, `postReactiveStrikeChat` (all pre-existing, private to `dungeon-combat.mjs`).
- Produces: `export async function offerReactiveStrikesAgainst(combat, mover) → Promise<void>` — executes every opportunity `findReactiveStrikeOpportunities` reports. This is the function Task 3 (Stride) and Task 4 (manual trigger) both call.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-combat-reactive-strike.test.mjs` (new imports and a new `describe` block):

```js
import {
  findReactiveStrikeOpportunities,
  offerReactiveStrikesAgainst,
  handleRangedAttackForReactiveStrike,
} from "../scripts/dungeon-combat.mjs";
```

(replacing the existing single-name import from Task 1)

```js
function installFoundryStubs() {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: async () => {} };
  globalThis.game = {
    user: {
      isGM: true,
      flags: { pf2e: { settings: {} } },
      update: async () => {},
    },
    i18n: { format: (key) => key },
    messages: { contents: [] },
    combats: { contents: [] },
  };
}

function makeStrikeAction({ slug = "claw", label = "Claw", outcome = "success" } = {}) {
  return {
    type: "strike",
    ready: true,
    slug,
    label,
    traits: [],
    item: { slug, isRanged: false, system: {} },
    variants: [
      {
        roll: async () => {
          game.messages.contents.push({
            flags: { pf2e: { context: { outcome } } },
          });
        },
      },
    ],
    damage: async () => ({ total: 4 }),
  };
}

function makeFullReactor({
  id,
  x,
  y,
  disposition = 1,
  itemName = "Reactive Strike",
  strike = makeStrikeAction(),
} = {}) {
  const flags = { agentControlled: true };
  return {
    id,
    tokenId: `${id}-token`,
    isDefeated: false,
    token: { x, y, disposition },
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      type: "npc",
      items: [
        {
          type: "action",
          system: { actionType: { value: "reaction" } },
          name: itemName,
        },
      ],
      system: { actions: [strike] },
    },
  };
}

function makeFullCombat({ round = 1, combatants = [], sceneId = "scene1" } = {}) {
  const flags = { dungeonSlot: 1 };
  return {
    round,
    combatants,
    scene: { id: sceneId, grid: { size: 100, distance: 5 }, tokens: [] },
    getFlag: (_moduleId, key) => flags[key],
    setFlag: async (_moduleId, key, value) => {
      flags[key] = value;
    },
  };
}

// The struck target (not the reactor) is who rollAndApplyStrikeAtVariant's
// `target.actor.applyDamage` and `applyDefeatIfReducedToZero` read — this
// double stands in for the mover/attacker being reacted against.
function makeMoverTarget({ id = "mover1", x = 0, y = 0, disposition = -1 } = {}) {
  const applyDamageCalls = [];
  return {
    id,
    isDefeated: false,
    token: { x, y, disposition },
    actor: {
      type: "character",
      applyDamage: async (args) => {
        applyDamageCalls.push(args);
      },
      system: { attributes: { hp: { value: 10 } } },
    },
    applyDamageCalls,
  };
}

describe("offerReactiveStrikesAgainst", () => {
  it("marks the reaction used, rolls the Strike, applies damage, and posts a chat message", async () => {
    installFoundryStubs();
    const mover = makeMoverTarget();
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await offerReactiveStrikesAgainst(combat, mover);

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
    expect(mover.applyDamageCalls).toHaveLength(1);
  });

  it("does nothing when no reactor is eligible", async () => {
    installFoundryStubs();
    const mover = makeMoverTarget();
    const combat = makeFullCombat({ combatants: [mover] });

    await expect(offerReactiveStrikesAgainst(combat, mover)).resolves.toBeUndefined();
  });
});

describe("handleRangedAttackForReactiveStrike", () => {
  it("resolves the combat and attacker from the chat message and delegates to offerReactiveStrikesAgainst", async () => {
    installFoundryStubs();
    const attacker = { ...makeMoverTarget({ id: "mover1" }), tokenId: "attacker-token" };
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeFullCombat({ combatants: [attacker, reactor] });
    game.combats.contents.push(combat);

    const message = {
      flags: { pf2e: { context: { type: "attack-roll", options: ["ranged"] } } },
      speaker: { scene: "scene1", token: "attacker-token" },
    };

    await handleRangedAttackForReactiveStrike(message);

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- dungeon-combat-reactive-strike`
Expected: FAIL — `offerReactiveStrikesAgainst is not a function`.

- [ ] **Step 3: Add `offerReactiveStrikesAgainst` and rewire `handleRangedAttackForReactiveStrike`**

Replace lines 1306-1365 of `scripts/dungeon-combat.mjs` (the `handleRangedAttackForReactiveStrike` function shown in full under "Context for every task" above) with:

```js
/**
 * Executes every current Reactive Strike opportunity against `mover` — the
 * single entry point every trigger (ranged-attack chat message,
 * agent-controlled Stride, GM manual check) calls into, so reaction
 * economy, weapon restrictions, and the chat announcement stay identical
 * regardless of what provoked the reaction.
 */
export async function offerReactiveStrikesAgainst(combat, mover) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const opportunities = findReactiveStrikeOpportunities(
    combat,
    mover,
    gridSize,
    gridDistanceFt,
  );
  for (const { reactor, actionSlug } of opportunities) {
    await markReactionUsed(combat, reactor.id, combat.round);
    await rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0);
    await postReactiveStrikeChat(reactor, mover);
  }
}

/**
 * #202: reacts to a real ranged-Strike attack-roll chat message by offering
 * every eligible agent-controlled reactor a Reactive Strike against the
 * attacker, via `offerReactiveStrikesAgainst` — shared with #13's
 * agent-Stride and manual-check triggers.
 *
 * Fires globally regardless of whose turn it is (the whole point of a
 * reaction), including a player character's own ranged attack against an
 * agent-controlled monster within its reach. GM-gated (only the GM's own
 * client should ever mutate combat state from a global hook like this) and
 * scoped to this module's own managed combats (`isModuleCombat`). Registered
 * against `createChatMessage` in module.mjs.
 */
export async function handleRangedAttackForReactiveStrike(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll") return;
  if (!context.options?.includes("ranged")) return;

  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  if (!sceneId || !attackerTokenId) return;
  const combat = game.combats.contents.find(
    (c) => c.scene?.id === sceneId && isModuleCombat(c),
  );
  if (!combat) return;
  const attacker = combat.combatants.find(
    (c) => c.tokenId === attackerTokenId,
  );
  if (!attacker || attacker.isDefeated) return;

  await offerReactiveStrikesAgainst(combat, attacker);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- dungeon-combat-reactive-strike`
Expected: PASS (9 tests total: 6 from Task 1 + 3 new)

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: PASS, all files including the pre-existing 28 (now 29 with the new file), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-reactive-strike.test.mjs
git commit -m "Add offerReactiveStrikesAgainst, shared by all Reactive Strike triggers (#13)"
```

---

### Task 3: Automatic trigger for agent-controlled Strides

**Files:**
- Modify: `scripts/dungeon-combat.mjs:2676-2703` (`strideByPosture`)
- Test: `tests/dungeon-combat-reactive-strike.test.mjs`

**Interfaces:**
- Consumes: `offerReactiveStrikesAgainst` (Task 2).
- Produces: `strideByPosture` becomes exported (it stays otherwise unchanged in signature — `strideByPosture(combat, combatant, posture, target)`) so it's directly testable; still only called internally by `applyAgentDecision`, unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-combat-reactive-strike.test.mjs`:

```js
import {
  findReactiveStrikeOpportunities,
  offerReactiveStrikesAgainst,
  handleRangedAttackForReactiveStrike,
  strideByPosture,
} from "../scripts/dungeon-combat.mjs";
```

(replacing the previous import list)

Note: `findPath` doesn't necessarily return a straight-line path even with no obstacles (its A* search can return an equal-Chebyshev-cost path that zigzags diagonally) — confirmed by running this exact scenario. `mover.token.x` still lands on `300` (verified below), and the reactor is still in reach regardless of the exact `y`, since `chebyshevSquares` takes the max of the two axis deltas.

```js
describe("strideByPosture (Reactive Strike wiring)", () => {
  it("offers a Reactive Strike after a real move ends within a reactor's reach", async () => {
    installFoundryStubs();
    const reactor = makeFullReactor({ id: "r1", x: 400, y: 0 });
    const mover = makeMoverTarget();
    mover.token.update = async function (changes) {
      Object.assign(this, changes);
    };
    mover.actor.system.movement = { speeds: { land: { value: 30 } } };
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await strideByPosture(combat, mover, "approach", { token: { x: 400, y: 0 } });

    expect(mover.token.x).toBe(300);
    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
  });

  it("does not trigger a Reactive Strike on a no-op move (no speed)", async () => {
    installFoundryStubs();
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const mover = {
      id: "mover1",
      isDefeated: false,
      token: {
        x: 0,
        y: 0,
        disposition: -1,
        update: async () => {
          throw new Error("should not move: speed is 0");
        },
      },
      actor: { system: { movement: { speeds: { land: { value: 0 } } } } },
    };
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await strideByPosture(combat, mover, "approach", { token: { x: 100, y: 0 } });

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- dungeon-combat-reactive-strike`
Expected: FAIL — `strideByPosture is not a function` (not exported yet).

- [ ] **Step 3: Export `strideByPosture` and call `offerReactiveStrikesAgainst` after a real move**

In `scripts/dungeon-combat.mjs`, change the function declaration at line 2676 from:

```js
async function strideByPosture(combat, combatant, posture, target) {
```

to:

```js
export async function strideByPosture(combat, combatant, posture, target) {
```

Then, at the end of the same function (replacing the final line, currently `await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });`), add the new call:

```js
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
  await offerReactiveStrikesAgainst(combat, combatant);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- dungeon-combat-reactive-strike`
Expected: PASS (11 tests total)

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-reactive-strike.test.mjs
git commit -m "Auto-trigger Reactive Strike after an agent-controlled Stride (#13)"
```

---

### Task 4: Manual GM trigger for PC manipulate/move actions

**Files:**
- Modify: `scripts/module.mjs:20-33` (import list), `scripts/module.mjs:366-382` (`getCombatTrackerEntryContext` hook)
- Modify: `lang/en.json` (new i18n key)

**Interfaces:**
- Consumes: `offerReactiveStrikesAgainst` (Task 2).
- Produces: nothing new for other tasks — this is the last of the three trigger wiring points.

No new automated test in this task: `scripts/module.mjs` executes `Hooks.once(...)` at module-load time and has never been imported by any test in this repo (it throws immediately without a full `Hooks`/`game` global stub, which doesn't exist here). This matches the existing, already-untested `ToggleAgentControlLabel` entry in the same hook. Verification for this task is a manual read-through (Step 2 below) plus, optionally, a live smoke test if a `FOUNDRY_REST_API_KEY` is available (see `.claude/skills/foundry-rest/`) — not required to complete this task.

- [ ] **Step 1: Add the i18n key**

In `lang/en.json`, insert a new line immediately before the existing `"PF2EDC.Dungeon.Combat.ReactiveStrikeChat"` line (alphabetically, "Check" sorts before "Chat"):

```json
  "PF2EDC.Dungeon.Combat.ReactiveStrikeCheckLabel": "Reactive Strike Check",
```

- [ ] **Step 2: Add the menu entry and wire it to `offerReactiveStrikesAgainst`**

In `scripts/module.mjs`, add `offerReactiveStrikesAgainst` to the existing import from `./dungeon-combat.mjs` (the block starting at line 20):

```js
import {
  maybeResolveCombatForActor,
  maybeResolveCombatForCombatant,
  autoPlayCombatantTurnIfDue,
  getPendingAgentTurn,
  applyAgentDecision,
  toggleAgentControlled,
  agentLoopStatus,
  handleRangedAttackForReactiveStrike,
  offerReactiveStrikesAgainst,
} from "./dungeon-combat.mjs";
```

Then, in the existing `Hooks.on("getCombatTrackerEntryContext", ...)` registration (lines 366-382), add a second `menuItems.push(...)` call right after the existing `ToggleAgentControlLabel` one:

```js
Hooks.on("getCombatTrackerEntryContext", (html, menuItems) => {
  menuItems.push({
    name: "PF2EDC.Dungeon.Combat.ToggleAgentControlLabel",
    icon: '<i class="fa-solid fa-robot"></i>',
    condition: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      return (
        !!combatant &&
        !game.actors?.party?.members?.some((m) => m.id === combatant.actor?.id)
      );
    },
    callback: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      if (combatant) toggleAgentControlled(combatant);
    },
  });
  menuItems.push({
    name: "PF2EDC.Dungeon.Combat.ReactiveStrikeCheckLabel",
    icon: '<i class="fa-solid fa-bolt"></i>',
    condition: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      return !!combatant && !combatant.isDefeated;
    },
    callback: (li) => {
      if (!game.user.isGM) return;
      const combat = game.combat;
      const combatant = combat?.combatants.get(li.dataset.combatantId);
      if (combatant) offerReactiveStrikesAgainst(combat, combatant);
    },
  });
});
```

- [ ] **Step 3: Manual verification (read-through)**

Confirm by inspection:
- The new `menuItems.push` call is inside the same `Hooks.on("getCombatTrackerEntryContext", ...)` callback as the existing one, not a duplicate hook registration.
- `offerReactiveStrikesAgainst` is imported and spelled identically to its export in `dungeon-combat.mjs`.
- The new i18n key exists in `lang/en.json` and is spelled identically to its use in `module.mjs`.

Run: `npm test`
Expected: PASS, 0 failures (this task touches no code any existing or new test imports, so this just confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add scripts/module.mjs lang/en.json
git commit -m "Add manual GM Reactive Strike Check for PC manipulate/move actions (#13)"
```

---

### Task 5: Version bump and final verification

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Bump the version**

In `module.json`, change:

```json
  "version": "0.2.0",
```

to:

```json
  "version": "0.3.0",
```

(Minor bump per project `CLAUDE.md` — this adds new trigger mechanisms across three code paths, not a routine fix.)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures, including the new `tests/dungeon-combat-reactive-strike.test.mjs` (11 tests) alongside all pre-existing suites.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "Bump version to 0.3.0 for Reactive Strike manipulate/move triggers (#13)"
```

---

## Self-Review Notes

- **Spec coverage:** every architecture bullet in the spec maps to a task — shared extraction (Task 1+2), auto agent-Stride trigger (Task 3), manual GM trigger (Task 4), final-position-only reach check (inherited unchanged from the existing `chebyshevSquares` call, exercised by every test). The spec's "Out of scope" items (full-path reach, automatic PC detection) are deliberately not tasked.
- **Type/name consistency:** `findReactiveStrikeOpportunities(combat, mover, gridSize, gridDistanceFt)` and `offerReactiveStrikesAgainst(combat, mover)` use the same parameter names and shapes (`{ reactor, actionSlug }`) across Tasks 1-4; `strideByPosture`'s exported signature is unchanged from its current private one, so `applyAgentDecision`'s existing call site needs no edits.
- **No placeholders:** every step above has literal, complete code — no "add tests for the above" or "similar to Task N" shorthand.
