# Offline-Player AI Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a dungeon crawl starts, party actors whose owning player isn't currently logged in get AI-controlled combat turns (reusing the existing combat agent engine) and automatically follow the party leader while exploring.

**Architecture:** A single `aiControlledActorIds` list is computed once at run start and stored on the run record. Combat consumes it to widen the existing `agentControlled` flag/turn-engine to cover these party actors. A new `dungeon-follow` module consumes it to move these actors' tokens toward the run's host (the "leader") whenever the leader's token moves, using the existing `pathfinding.mjs` A* search.

**Tech Stack:** Vanilla JS (`.mjs`), Foundry VTT v14 API, PF2e system, Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-09-21-offline-player-ai-control-design.md`

## Global Constraints

- Module id / flag namespace: `"pf2e-dungeon-crawl"` (the `MODULE_ID` constant each file redefines locally — follow this file's own existing convention, don't import it across files).
- Test runner: Vitest (`npm test` = `vitest run`). New pure-logic files pair with a `tests/<name>.test.mjs` file, matching the existing `pathfinding.mjs`/`tests/pathfinding.test.mjs`, `skill-challenge-mechanics.mjs`/`tests/skill-challenge-mechanics.test.mjs` split.
- Foundry-glue code (touches `game`/`canvas`/live documents) is not unit tested in this codebase — it's verified manually against the live world via the `foundry-rest` skill, matching the existing precedent for `dungeon-combat.mjs`'s `startCombat`/`autoPlayCombatantTurnIfDue`/`getPendingAgentTurn`. Only extract and unit-test the pure computation underneath it.
- Per this repo's `CLAUDE.md`: every merge to `main` bumps `module.json`'s `version`. This is an architecture-level change, so the final task bumps the minor version.

---

### Task 1: Compute `aiControlledActorIds` at run start

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (`createRun`, around lines 49–106)
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Consumes: nothing new — `game.actors`/`game.users` via a new injectable `partyOwnershipRef`, same injection pattern as `createRun`'s existing `settingsRef`.
- Produces: `state.aiControlledActorIds` (`string[]`, actor ids) on every run record returned by `createRun`/`getRunState`. Task 2 and Task 4 both read this field via `getRunState(sceneId).aiControlledActorIds`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-runner.test.mjs`, right after the existing `describe("createRun / getRunState", ...)` block:

```js
describe("createRun / aiControlledActorIds (#20)", () => {
  function makePartyOwnershipStub({
    actors = [],
    activeUserIds = new Set(),
    gmUserIds = new Set(),
  } = {}) {
    return {
      partyActors: () => actors,
      isUserActive: (userId) => activeUserIds.has(userId),
      isUserGm: (userId) => gmUserIds.has(userId),
    };
  }

  it("flags a party actor whose non-GM owner is offline", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [{ id: "actor-1", ownership: { "gm-1": 3, "user-1": 3 } }],
      activeUserIds: new Set(),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual(["actor-1"]);
  });

  it("leaves a party actor alone when its non-GM owner is online", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [{ id: "actor-1", ownership: { "gm-1": 3, "user-1": 3 } }],
      activeUserIds: new Set(["user-1"]),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual([]);
  });

  it("leaves an actor off the list when only the GM owns it", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [{ id: "actor-1", ownership: { "gm-1": 3 } }],
      activeUserIds: new Set(),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual([]);
  });

  it("handles a run with multiple party actors independently", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [
        { id: "actor-1", ownership: { "gm-1": 3, "user-1": 3 } },
        { id: "actor-2", ownership: { "gm-1": 3, "user-2": 3 } },
      ],
      activeUserIds: new Set(["user-2"]),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual(["actor-1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL — `state.aiControlledActorIds` is `undefined`, not the expected array.

- [ ] **Step 3: Implement `computeAiControlledActorIds` and wire it into `createRun`**

In `scripts/dungeon-runner.mjs`, add near the top (after `defaultSettingsRef`, before `persist`):

```js
function defaultPartyOwnershipRef() {
  return {
    partyActors: () => game.actors?.party?.members ?? [],
    isUserActive: (userId) => !!game.users?.get(userId)?.active,
    isUserGm: (userId) => !!game.users?.get(userId)?.isGM,
  };
}

/** Party actor ids whose non-GM owner isn't currently connected (#20),
 * computed once at run start. Each Trusted-User player owns exactly one
 * party actor at OWNER level (ownership level 3, same literal
 * foundry-api.mjs's partyLevel() already uses); the GM/Agent account owns
 * everything too but is explicitly excluded. An actor with no non-GM owner
 * at all (misconfigured ownership) is left off the list — it stays
 * human/GM-controlled rather than guessed at. */
function computeAiControlledActorIds(partyOwnershipRef) {
  const result = [];
  for (const actor of partyOwnershipRef.partyActors()) {
    const ownerId = Object.entries(actor.ownership ?? {}).find(
      ([userId, level]) => level === 3 && !partyOwnershipRef.isUserGm(userId),
    )?.[0];
    if (ownerId && !partyOwnershipRef.isUserActive(ownerId)) {
      result.push(actor.id);
    }
  }
  return result;
}
```

Then modify `createRun`'s signature and body:

```js
export async function createRun(
  {
    sceneId,
    roomCount,
    traits = [],
    excludeTraits = [],
    seed = null,
    previousSceneId = null,
    hostUserId = null,
  },
  {
    settingsRef = defaultSettingsRef(),
    partyOwnershipRef = defaultPartyOwnershipRef(),
    setpieceIds = [],
    narrativeSetpieceIds = [],
  } = {},
) {
```

(unchanged body until the `state` object) then add the new field to `state`:

```js
    hostUserId,
    // #20: party actor ids whose owning player isn't logged in at run
    // start — see dungeon-combat.mjs (combat turns) and dungeon-follow.mjs
    // (exploration following) for what reads this.
    aiControlledActorIds: computeAiControlledActorIds(partyOwnershipRef),
  };
  return persist(sceneId, state, settingsRef);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS (all tests in the file, including the pre-existing ones — confirm nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "Compute aiControlledActorIds for offline players at run start (#20)"
```

---

### Task 2: Extend the combat agent engine to cover AI-controlled party actors

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`startCombat` ~line 99, `toggleAgentControlled` ~line 128, `autoPlayCombatantTurnIfDue` ~line 1984)
- Test: `tests/dungeon-combat-offline-player-ai.test.mjs` (new)

**Interfaces:**
- Consumes: `getRunState(sceneId).aiControlledActorIds` (Task 1).
- Produces: `isAgentEligible(actorId, partyIds, aiControlledIds) -> boolean`, exported from `dungeon-combat.mjs` for the new test file.

- [ ] **Step 1: Write the failing test**

Create `tests/dungeon-combat-offline-player-ai.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { isAgentEligible } from "../scripts/dungeon-combat.mjs";

describe("isAgentEligible (#20)", () => {
  it("is eligible for a non-party actor regardless of aiControlledIds", () => {
    expect(isAgentEligible("npc-1", new Set(["party-1"]), new Set())).toBe(
      true,
    );
  });

  it("is not eligible for a party actor absent from aiControlledIds", () => {
    expect(isAgentEligible("party-1", new Set(["party-1"]), new Set())).toBe(
      false,
    );
  });

  it("is eligible for a party actor present in aiControlledIds", () => {
    expect(
      isAgentEligible("party-1", new Set(["party-1"]), new Set(["party-1"])),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-combat-offline-player-ai.test.mjs`
Expected: FAIL — `isAgentEligible` is not exported from `dungeon-combat.mjs`.

- [ ] **Step 3: Add `isAgentEligible` and wire it into `startCombat`/`toggleAgentControlled`, and fix `autoPlayCombatantTurnIfDue`'s guard**

In `scripts/dungeon-combat.mjs`, add right after `partyActorIds()` (after line 62):

```js
/** Whether a combatant with this actor id should default to
 * agent-controlled: every non-party actor always does (unchanged NPC
 * behavior); a party actor only does when this run flagged it AI-controlled
 * at start (#20 — its owning player isn't logged in). */
export function isAgentEligible(actorId, partyIds, aiControlledIds) {
  return !partyIds.has(actorId) || aiControlledIds.has(actorId);
}
```

Modify `startCombat` (currently lines 99–122) — replace the combatant-flagging block:

```js
async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const partyIds = partyActorIds();
  const aiControlledIds = new Set(
    getRunState(scene.id)?.aiControlledActorIds ?? [],
  );
  const combatants = await combat.createEmbeddedDocuments(
    "Combatant",
    tokens.map((t) => ({
      tokenId: t.id,
      sceneId: scene.id,
      ...(isAgentEligible(t.actor?.id, partyIds, aiControlledIds)
        ? { flags: { [MODULE_ID]: { agentControlled: true } } }
        : {}),
    })),
  );
  await combat.rollInitiative(
    combatants.map((c) => c.id),
    { skipDialog: true },
  );
  await combat.startCombat();
  unpauseIfGmLessRun(scene.id);
  return combat;
}
```

Modify `toggleAgentControlled` (currently lines 128–132):

```js
export async function toggleAgentControlled(combatant) {
  const aiControlledIds = new Set(
    getRunState(combatant.parent?.scene?.id)?.aiControlledActorIds ?? [],
  );
  if (!isAgentEligible(combatant.actor?.id, partyActorIds(), aiControlledIds))
    return;
  const current = combatant.getFlag(MODULE_ID, "agentControlled") ?? false;
  await combatant.setFlag(MODULE_ID, "agentControlled", !current);
}
```

Modify `autoPlayCombatantTurnIfDue`'s guard (currently lines 1987–1993) — replace:

```js
  const combatant = combat.combatant;
  if (
    !combatant ||
    partyActorIds().has(combatant.actor?.id) ||
    combatant.actor?.hasPlayerOwner
  )
    return;
```

with:

```js
  const combatant = combat.combatant;
  if (!combatant) return;
  // #20: check the already-authoritative flag before re-deriving party
  // membership — a real party actor's own hasPlayerOwner is true under
  // this deployment's actual ownership model (each Trusted-User player
  // OWNERs their own actor), so re-deriving eligibility here instead of
  // trusting the flag startCombat already set would let this exclusion
  // fire even for a run's AI-controlled party actor. Leaves the
  // pre-existing exclusion of a manually-added, player-summoned ally
  // (which never receives this flag) completely unchanged.
  if (
    !combatant.getFlag(MODULE_ID, "agentControlled") &&
    (partyActorIds().has(combatant.actor?.id) ||
      combatant.actor?.hasPlayerOwner)
  )
    return;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/dungeon-combat-offline-player-ai.test.mjs tests/dungeon-combat-reactive-strike.test.mjs`
Expected: PASS — the new eligibility tests pass, and the pre-existing reactive-strike tests (which import other exports from the same file) still pass unchanged.

Then run the full suite to catch any other regression:

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-offline-player-ai.test.mjs
git commit -m "Extend combat agent engine to AI-controlled party actors (#20)"
```

- [ ] **Step 6: Live-verify against a real world**

Using the `foundry-rest` skill against a live test world: create a dungeon run where one party actor's non-GM owner is not connected, confirm `getRunState(sceneId).aiControlledActorIds` includes that actor, start a combat room, and confirm that actor's `Combatant` has `flags["pf2e-dungeon-crawl"].agentControlled === true` and that its turn auto-plays (heuristic move + strike) the same way an NPC's does. Confirm a genuinely human-controlled party actor's turn is still left alone.

---

### Task 3: Pure follow-the-leader movement computation

**Files:**
- Create: `scripts/dungeon-follow-mechanics.mjs`
- Test: `tests/dungeon-follow-mechanics.test.mjs`

**Interfaces:**
- Consumes: `findPath` from `scripts/pathfinding.mjs` (`findPath(start, goal, isBlocked, bounds, maxExpansions?) -> {gx,gy}[] | null`).
- Produces: `findFollowMove(fromCell, leaderCell, occupiedCells, isBlocked, bounds) -> {status: "already-near"} | {status: "no-route"} | {status: "move", to: {gx, gy}}`. Task 4's Foundry-glue layer is the only consumer.

- [ ] **Step 1: Write the failing tests**

Create `tests/dungeon-follow-mechanics.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { findFollowMove } from "../scripts/dungeon-follow-mechanics.mjs";

function noWalls() {
  return () => false;
}

describe("findFollowMove", () => {
  it("returns already-near when within one tile of the leader", () => {
    const result = findFollowMove(
      { gx: 5, gy: 5 },
      { gx: 5, gy: 6 },
      new Set(),
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "already-near" });
  });

  it("paths to a free tile adjacent to the leader when far away", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      new Set(),
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
    expect(
      Math.max(
        Math.abs(result.to.gx - 5),
        Math.abs(result.to.gy - 5),
      ),
    ).toBe(1);
  });

  it("avoids an already-occupied adjacent cell", () => {
    const occupied = new Set([
      "4,5",
      "4,4",
      "5,4",
      "6,4",
      "6,5",
      "6,6",
      "5,6",
    ]);
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "move", to: { gx: 4, gy: 6 } });
  });

  it("returns no-route when every adjacent cell is occupied", () => {
    const occupied = new Set([
      "4,4",
      "4,5",
      "4,6",
      "5,4",
      "5,6",
      "6,4",
      "6,5",
      "6,6",
    ]);
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "no-route" });
  });

  it("returns no-route when every path is wall-blocked", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      new Set(),
      () => true,
      null,
    );
    expect(result).toEqual({ status: "no-route" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `scripts/dungeon-follow-mechanics.mjs`**

```js
/**
 * Pure follow-the-leader movement computation for AI-controlled party
 * actors (#20) — see docs/superpowers/specs/
 * 2026-09-21-offline-player-ai-control-design.md. Operates entirely on
 * plain {gx, gy} grid coordinates and caller-supplied predicates, exactly
 * like pathfinding.mjs itself; scripts/dungeon-follow.mjs is the only
 * caller and the one place that translates real Foundry state into these
 * plain shapes.
 */
import { findPath } from "./pathfinding.mjs";

function cellKey(cell) {
  return `${cell.gx},${cell.gy}`;
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));
}

/** A free grid cell adjacent (incl. diagonally) to `leaderCell`, not present
 * in `occupiedCells` — preferring whichever is closest to `fromCell` so
 * multiple AI-controlled tokens spread out around the leader instead of
 * all aiming for the same cell. `null` if all 8 are occupied. */
function freeAdjacentCell(leaderCell, fromCell, occupiedCells) {
  const candidates = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const cell = { gx: leaderCell.gx + dx, gy: leaderCell.gy + dy };
      if (!occupiedCells.has(cellKey(cell))) candidates.push(cell);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => chebyshev(a, fromCell) - chebyshev(b, fromCell));
  return candidates[0];
}

/**
 * The follow-move an AI-controlled token at `fromCell` should make toward
 * `leaderCell`:
 * - `{status: "already-near"}` — within one tile already, nothing to do.
 * - `{status: "no-route"}` — every adjacent cell is occupied, or no path
 *   exists to the one free adjacent cell found (a wall in the way).
 * - `{status: "move", to: {gx, gy}}` — the destination cell to move to.
 *
 * `occupiedCells` is a `Set` of `"gx,gy"` keys the destination must avoid.
 * `isBlocked`/`bounds` are passed straight through to `findPath`.
 */
export function findFollowMove(
  fromCell,
  leaderCell,
  occupiedCells,
  isBlocked,
  bounds,
) {
  if (chebyshev(fromCell, leaderCell) <= 1) return { status: "already-near" };

  const target = freeAdjacentCell(leaderCell, fromCell, occupiedCells);
  if (!target) return { status: "no-route" };

  const path = findPath(fromCell, target, isBlocked, bounds);
  if (!path || path.length <= 1) return { status: "no-route" };

  return { status: "move", to: path[path.length - 1] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-follow-mechanics.mjs tests/dungeon-follow-mechanics.test.mjs
git commit -m "Add pure follow-the-leader movement computation (#20)"
```

---

### Task 4: Wire follow-the-leader into the live game

**Files:**
- Create: `scripts/dungeon-follow.mjs`
- Modify: `scripts/module.mjs` (imports + a new `Hooks.on("updateToken", ...)`)

**Interfaces:**
- Consumes: `findFollowMove` (Task 3), `getRunState` (`dungeon-runner.mjs`), `blockedEdgesFromWalls` (`pathfinding.mjs`).
- Produces: `followLeaderIfDue(tokenDoc, changes)`, the `updateToken` hook target `module.mjs` registers.

- [ ] **Step 1: Implement `scripts/dungeon-follow.mjs`**

No unit test for this step — it's Foundry-glue (touches `game`, `scene.tokens`, live `TokenDocument#update`), matching this codebase's existing precedent (Global Constraints). It's covered by Step 3's live verification instead.

```js
/**
 * Foundry glue for follow-the-leader movement (#20) — see
 * docs/superpowers/specs/2026-09-21-offline-player-ai-control-design.md.
 * Combat has its own, separate turn-based movement (dungeon-combat.mjs);
 * this only runs between fights, whenever the run's host moves their own
 * token, and only on a genuinely GM-privileged client (mirrors
 * dungeon-combat.mjs's autoPlayCombatantTurnIfDue: every mutating action in
 * this module runs only on a human GM or the world's Agent-GM account).
 */
import { getRunState } from "./dungeon-runner.mjs";
import { blockedEdgesFromWalls } from "./pathfinding.mjs";
import { findFollowMove } from "./dungeon-follow-mechanics.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const FOLLOW_DEBOUNCE_MS = 250;

const pendingByScene = new Map(); // sceneId -> setTimeout handle
const warnedNoLeaderForScene = new Set();

function tokenCell(token, gridSize) {
  return {
    gx: Math.round(token.x / gridSize),
    gy: Math.round(token.y / gridSize),
  };
}

function sceneBounds(scene, gridSize) {
  if (!scene?.width || !scene?.height) return null;
  return {
    gx0: 0,
    gy0: 0,
    gx1: Math.ceil(scene.width / gridSize) - 1,
    gy1: Math.ceil(scene.height / gridSize) - 1,
  };
}

/** Mirrors dungeon-combat.mjs's own wallBlocksMovement: a wall blocks
 * movement unless it's a door currently standing open. */
function wallBlocksMovement(wall) {
  if (wall.move === CONST.WALL_MOVEMENT_TYPES.NONE) return false;
  if (
    wall.door !== CONST.WALL_DOOR_TYPES.NONE &&
    wall.ds === CONST.WALL_DOOR_STATES.OPEN
  )
    return false;
  return true;
}

function movementBlockedEdges(scene, gridSize) {
  const walls = (scene.walls?.contents ?? [])
    .filter(wallBlocksMovement)
    .map((w) => ({ x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] }));
  return blockedEdgesFromWalls(walls, gridSize);
}

/** The party actor owned (OWNER level) by the run's host user, if any —
 * "the leader" a run's AI-controlled actors follow. */
function resolveLeaderToken(scene, hostUserId) {
  if (!hostUserId) return null;
  const leaderActor = (game.actors?.party?.members ?? []).find(
    (a) => (a.ownership?.[hostUserId] ?? 0) >= 3,
  );
  if (!leaderActor) return null;
  return scene.tokens.find((t) => t.actor?.id === leaderActor.id) ?? null;
}

async function moveFollowersToward(scene, leaderToken, aiControlledIds) {
  const gridSize = scene.grid?.size ?? 100;
  const bounds = sceneBounds(scene, gridSize);
  const isBlocked = movementBlockedEdges(scene, gridSize);
  const leaderCell = tokenCell(leaderToken, gridSize);
  const occupied = new Set(
    scene.tokens.map((t) => {
      const cell = tokenCell(t, gridSize);
      return `${cell.gx},${cell.gy}`;
    }),
  );

  for (const actorId of aiControlledIds) {
    const token = scene.tokens.find((t) => t.actor?.id === actorId);
    if (!token) continue;
    const fromCell = tokenCell(token, gridSize);
    const result = findFollowMove(
      fromCell,
      leaderCell,
      occupied,
      isBlocked,
      bounds,
    );
    if (result.status === "already-near") continue;
    if (result.status === "no-route") {
      console.warn(
        `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach the leader.`,
      );
      continue;
    }
    occupied.delete(`${fromCell.gx},${fromCell.gy}`);
    occupied.add(`${result.to.gx},${result.to.gy}`);
    await token.update({
      x: result.to.gx * gridSize,
      y: result.to.gy * gridSize,
    });
  }
}

/** Hook target for `updateToken` (module.mjs). Debounced per scene so a
 * drag's many intermediate position updates trigger at most one recompute
 * every FOLLOW_DEBOUNCE_MS. */
export function followLeaderIfDue(tokenDoc, changes) {
  if (!game.user.isGM) return;
  if (changes.x === undefined && changes.y === undefined) return;
  const scene = tokenDoc.parent;
  if (!scene) return;

  const run = getRunState(scene.id);
  const aiControlledIds = run?.aiControlledActorIds ?? [];
  if (!aiControlledIds.length) return;

  const leaderToken = resolveLeaderToken(scene, run.hostUserId);
  if (!leaderToken) {
    if (!warnedNoLeaderForScene.has(scene.id)) {
      warnedNoLeaderForScene.add(scene.id);
      console.warn(
        `${MODULE_ID} | dungeon-follow: no leader token found for scene ${scene.id}; AI-controlled party actors won't follow.`,
      );
    }
    return;
  }
  if (leaderToken.id !== tokenDoc.id) return;

  clearTimeout(pendingByScene.get(scene.id));
  pendingByScene.set(
    scene.id,
    setTimeout(
      () => moveFollowersToward(scene, leaderToken, aiControlledIds),
      FOLLOW_DEBOUNCE_MS,
    ),
  );
}
```

- [ ] **Step 2: Wire the hook into `module.mjs`**

Add to the import block from `dungeon-runner.mjs`'s neighbors — a new standalone import line (after the `dungeon-combat.mjs` import block, currently ending at line 35):

```js
import { followLeaderIfDue } from "./dungeon-follow.mjs";
```

Add a new hook registration near the existing `updateCombat` hook (after line 362's closing `});`):

```js
/** #20: moves AI-controlled party actors' tokens toward the run's leader
 * as the party explores between fights. */
Hooks.on("updateToken", followLeaderIfDue);
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — this task adds no new unit-testable logic (Task 3 already covered the pure computation), so this just confirms nothing else broke.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-follow.mjs scripts/module.mjs
git commit -m "Wire follow-the-leader movement into the live game (#20)"
```

- [ ] **Step 5: Live-verify against a real world**

Using the `foundry-rest` skill against a live test world: start a dungeon run with at least one AI-controlled party actor (its owning player disconnected) and the host's own leader token on the same scene. Move the leader's token across the scene (simulating a drag via a token update) and confirm the AI-controlled actor's token moves to stay within one tile of the leader afterward. Confirm it doesn't move through a closed, non-door wall, and does move through an opened door. Confirm nothing moves when the leader's token updates something other than position (e.g. a name change).

---

### Task 5: Version bump and final verification

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — this is the closing task for the whole plan.

- [ ] **Step 1: Bump the module version**

In `module.json`, change `"version": "0.3.1"` to `"version": "0.4.0"` (minor bump — this is an architecture-level change per `CLAUDE.md`: new AI-control concept spanning run lifecycle, combat, and a new exploration-movement subsystem).

- [ ] **Step 2: Run the full test suite one last time**

Run: `npm test`
Expected: PASS — every test file in the repo, including all tests added in Tasks 1–3.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "Bump module version to 0.4.0"
```
