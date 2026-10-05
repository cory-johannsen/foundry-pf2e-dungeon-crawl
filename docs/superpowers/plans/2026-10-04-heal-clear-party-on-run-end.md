# Heal and Clear Party Conditions on Run End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every party member is fully healed and has every active condition removed when a dungeon run ends, whether by reaching the goal room or by abandoning the run — neither path touches party HP/conditions at all today.

**Architecture:** A new `healAndClearConditions(actorId)` method on `makeFoundryApi()` (`scripts/foundry-api.mjs`) does the actual per-actor work — confirmed live against the running world that PF2e exposes no bulk condition-clear of its own, so this deletes every embedded condition Item directly (the same fallback shape `decreaseCondition` already uses for a single named condition) and sets HP to the actor's own current max. A new shared helper in `scripts/dungeon-scene.mjs` calls it for every current party member, wired into both `teardownDungeonRun` (Abandon) and `sweepCompletedDungeonScene` (goal-room completion) via an injectable-dependency parameter, matching this codebase's own established DI-for-testability pattern (`runAgentDecisionLoop`, `playHeuristicTurn`).

**Tech Stack:** Vanilla JS (`scripts/foundry-api.mjs`, `scripts/dungeon-scene.mjs`), vitest.

**Spec:** None — a bounded fix with no remaining open design question. The issue's own explicit ask ("confirm the exact live API before implementing") is answered below, verified against the real running world before writing this plan, not assumed: PF2e has no bulk condition-clear method (`clearConditions`/`resetConditions`/`removeConditions` all absent on a real Actor document); deleting every `itemTypes.condition` entry via `deleteEmbeddedDocuments` is the real, working mechanism (confirmed live: 5 applied conditions — dying, unconscious, blinded, prone, clumsy — all removed in one call). The issue's other note (this is deliberately a stronger, simpler reset than #613's Rest for the Night, not sharing an implementation) is honored by design: this plan touches neither `restPartyForTheNight` nor anything in #613's own code path.

## Global Constraints

- Only party actors are touched — `sweepLooseNpcActors`'s existing NPC-cleanup behavior at both integration points is completely unchanged by this plan.
- This does **not** share an implementation with #613's `restPartyForTheNight` — confirmed as the issue's own explicit instruction ("don't assume they're the same operation"). This plan's reset is unconditional (every condition removed, full heal, no PF2e Rest for the Night rules about what does/doesn't clear); #613's stays exactly as it already ships.
- `healAndClearConditions` deletes `actor.itemTypes.condition` entries specifically, not `actor.conditions` (confirmed live: the latter is a derived collection that can report a different size than the actual embedded Item count — 7 vs. 5 in the same live test — and isn't the thing that's actually deletable/persisted).
- HP is restored to whatever the actor's own `system.attributes.hp.max` currently is at the moment of the call (not a hardcoded value) — correct for any party member regardless of level/class, and correct even if `max` itself has changed since the run started (e.g. a level-up mid-run).

## Review Focus

- **A party member with zero active conditions.** `healAndClearConditions` must still heal them to max HP, and must not call `deleteEmbeddedDocuments` with an empty id list (a real, if harmless, foot-gun other code in this file already guards against the same way — `decreaseCondition`'s own early-return pattern). Task 1's tests cover this as its own explicit case.
- **An empty party** (no current party members at all, an edge case neither integration point has ever had to consider before since nothing used to iterate the party). `healAndClearPartyConditions` must be a clean no-op, not throw. Task 2's tests cover this explicitly for the shared helper itself.
- **The two integration points' existing behavior (NPC sweep, scene teardown/delete) must be completely unaffected.** A reviewer should be able to see the new call sitting alongside the untouched existing logic, not replacing or reordering anything that matters. Task 2's tests inject a mock for the new call specifically so they verify it fires without needing to re-verify (or risk breaking) the pre-existing, already-shipped teardown mechanics.
- **`healAndClearConditions` called with an actor id that doesn't exist.** `getActor`'s own existing behavior (throw `No actor: <id>`) is inherited unchanged — Task 1's tests confirm this explicitly rather than assuming it transfers.
- **Live mechanical confirmation, not just mocked tests.** Per this project's own repeated precedent (#141, #580, #613) for anything touching real PF2e actor state: the unit tests in Tasks 1-2 prove the new code is wired correctly in isolation; Task 3's live run against the actual running world is what the issue actually needs before being trusted done.

---

## Task 1: `healAndClearConditions` on `makeFoundryApi()`

**Files:**
- Modify: `scripts/foundry-api.mjs` (near `decreaseCondition`, ~line 596)
- Test: `tests/foundry-api-heal-clear-conditions.test.mjs` (new)

**Interfaces:**
- Produces: `api.healAndClearConditions(actorId): Promise<void>` on the object `makeFoundryApi()` returns — looks up the actor via the same `getActor` every other method in this file already uses (throws `No actor: <id>` for an unknown id, inherited unchanged).

- [ ] **Step 1: Write the failing test**

Create `tests/foundry-api-heal-clear-conditions.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import { makeFoundryApi } from "../scripts/foundry-api.mjs";

function makeActor({ id, hpValue = 1, hpMax = 20, conditions = [] } = {}) {
  const conditionItems = conditions.map((slug, i) => ({ id: `cond-${i}`, slug }));
  const actor = {
    id,
    system: { attributes: { hp: { value: hpValue, max: hpMax } } },
    itemTypes: { condition: conditionItems },
  };
  actor.deleteEmbeddedDocuments = vi.fn(async (type, ids) => {
    actor.itemTypes.condition = actor.itemTypes.condition.filter((c) => !ids.includes(c.id));
  });
  actor.update = vi.fn(async (changes) => {
    actor.system.attributes.hp.value = changes["system.attributes.hp.value"];
  });
  return actor;
}

function install(actorsById) {
  globalThis.game = { actors: { get: (id) => actorsById[id] } };
}

describe("healAndClearConditions (#617)", () => {
  it("heals to max HP and deletes every condition item in one call", async () => {
    const actor = makeActor({ id: "pc1", hpValue: 1, hpMax: 20, conditions: ["dying", "unconscious", "clumsy"] });
    install({ pc1: actor });

    await makeFoundryApi().healAndClearConditions("pc1");

    expect(actor.system.attributes.hp.value).toBe(20);
    expect(actor.itemTypes.condition).toHaveLength(0);
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["cond-0", "cond-1", "cond-2"]);
  });

  it("still heals to max HP when there are no conditions, without calling deleteEmbeddedDocuments", async () => {
    const actor = makeActor({ id: "pc1", hpValue: 5, hpMax: 20, conditions: [] });
    install({ pc1: actor });

    await makeFoundryApi().healAndClearConditions("pc1");

    expect(actor.system.attributes.hp.value).toBe(20);
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("heals to whatever max currently is, not a hardcoded value", async () => {
    const actor = makeActor({ id: "pc1", hpValue: 1, hpMax: 47, conditions: [] });
    install({ pc1: actor });

    await makeFoundryApi().healAndClearConditions("pc1");

    expect(actor.system.attributes.hp.value).toBe(47);
  });

  it("throws a clear error for an unknown actor id", async () => {
    install({});
    await expect(makeFoundryApi().healAndClearConditions("missing")).rejects.toThrow(/No actor: missing/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/foundry-api-heal-clear-conditions.test.mjs`
Expected: FAIL with "healAndClearConditions is not a function" (not added yet)

- [ ] **Step 3: Write the implementation**

In `scripts/foundry-api.mjs`, add after `decreaseCondition` (~line 608):

```js
    /**
     * Fully heals `actorId` and removes every active condition (#617) --
     * called at both dungeon-run-ending points so neither leaves the
     * party however battered the run left them. Confirmed live that PF2e
     * exposes no bulk condition-clear of its own (no clearConditions/
     * resetConditions/removeConditions on a real Actor document) --
     * deleting every itemTypes.condition entry directly is the real
     * mechanism, the same fallback shape decreaseCondition already uses
     * for a single named condition. Deliberately reads actor.conditions
     * (the derived getter) nowhere -- it can report a different size
     * than the actual embedded Item count and isn't what's actually
     * deletable.
     */
    async healAndClearConditions(actorId) {
      const actor = getActor(actorId);
      const conditionItemIds = (actor.itemTypes?.condition ?? []).map((c) => c.id);
      if (conditionItemIds.length) {
        await actor.deleteEmbeddedDocuments("Item", conditionItemIds);
      }
      const maxHp = actor.system?.attributes?.hp?.max ?? 0;
      await actor.update({ "system.attributes.hp.value": maxHp });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/foundry-api-heal-clear-conditions.test.mjs`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/foundry-api.mjs tests/foundry-api-heal-clear-conditions.test.mjs
git commit -m "Add healAndClearConditions to the Foundry API (#617)"
```

---

## Task 2: Wire a party-wide heal/clear into both run-ending points

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`teardownDungeonRun` ~line 1321, `sweepCompletedDungeonScene` ~line 1309)
- Test: `tests/dungeon-scene-heal-party-on-run-end.test.mjs` (new)

**Interfaces:**
- Consumes: `makeFoundryApi` (already imported in `dungeon-scene.mjs`, line 84); `healAndClearConditions(actorId)` from Task 1.
- Produces: `healAndClearPartyConditions(api?): Promise<void>` (exported) — calls `api.healAndClearConditions(member.id)` for every current party member. `teardownDungeonRun`'s and `sweepCompletedDungeonScene`'s existing signatures both gain an optional `healAndClearParty` dependency (defaulting to this real function) in their existing options object — test-only injection, production callers never pass it, same idiom as `runAgentDecisionLoop`'s `deps`.

- [ ] **Step 1: Write the failing tests**

Create `tests/dungeon-scene-heal-party-on-run-end.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import {
  healAndClearPartyConditions,
  teardownDungeonRun,
  sweepCompletedDungeonScene,
} from "../scripts/dungeon-scene.mjs";

function installGame(partyMembers) {
  globalThis.game = {
    actors: { party: { members: partyMembers } },
    scenes: { get: () => null, find: () => null },
  };
}

function makeFakeScene() {
  return {
    tokens: [],
    deleteEmbeddedDocuments: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

describe("healAndClearPartyConditions (#617)", () => {
  it("calls healAndClearConditions for every current party member", async () => {
    installGame([{ id: "pc1" }, { id: "pc2" }]);
    const healAndClearConditions = vi.fn();

    await healAndClearPartyConditions({ healAndClearConditions });

    expect(healAndClearConditions).toHaveBeenCalledTimes(2);
    expect(healAndClearConditions).toHaveBeenCalledWith("pc1");
    expect(healAndClearConditions).toHaveBeenCalledWith("pc2");
  });

  it("is a no-op, not a throw, with no current party members", async () => {
    installGame([]);
    const healAndClearConditions = vi.fn();

    await expect(healAndClearPartyConditions({ healAndClearConditions })).resolves.toBeUndefined();
    expect(healAndClearConditions).not.toHaveBeenCalled();
  });
});

describe("sweepCompletedDungeonScene calls the party heal/clear (#617)", () => {
  it("calls the injected healAndClearParty alongside the existing NPC sweep", async () => {
    installGame([]);
    const scene = makeFakeScene();
    const healAndClearParty = vi.fn();

    await sweepCompletedDungeonScene(scene, { healAndClearParty });

    expect(healAndClearParty).toHaveBeenCalledTimes(1);
  });
});

describe("teardownDungeonRun calls the party heal/clear (#617)", () => {
  it("calls the injected healAndClearParty alongside the existing teardown", async () => {
    installGame([]); // empty party -- skips the scene-placement branch entirely
    const scene = makeFakeScene();
    const healAndClearParty = vi.fn();

    const result = await teardownDungeonRun(scene, { healAndClearParty });

    expect(healAndClearParty).toHaveBeenCalledTimes(1);
    expect(scene.delete).toHaveBeenCalledTimes(1);
    expect(result.deletedNpcActorCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-scene-heal-party-on-run-end.test.mjs`
Expected: FAIL — `healAndClearPartyConditions` isn't exported yet; `sweepCompletedDungeonScene`/`teardownDungeonRun` don't accept or call a `healAndClearParty` option yet.

- [ ] **Step 3: Add the shared helper**

In `scripts/dungeon-scene.mjs`, add near `sweepLooseNpcActors` (~line 1283):

```js
/** #617: fully heals and clears every active condition from every current
 * party member -- called at both dungeon-run-ending points
 * (teardownDungeonRun's Abandon path, sweepCompletedDungeonScene's
 * goal-room-completion path) so neither leaves the party however
 * battered the run left them. Deliberately a stronger, simpler reset
 * than #613's restPartyForTheNight -- unconditional, not bound by PF2e's
 * own Rest for the Night rules about what does/doesn't clear; the two
 * don't share an implementation. `api` is test-only dependency
 * injection, same idiom as runAgentDecisionLoop's deps -- production
 * callers never pass it. */
export async function healAndClearPartyConditions(api = makeFoundryApi()) {
  const partyIds = partyActorIds();
  const partyMembers = (game.actors?.party?.members ?? []).filter((m) =>
    partyIds.has(m.id),
  );
  for (const member of partyMembers) {
    await api.healAndClearConditions(member.id);
  }
}
```

- [ ] **Step 4: Wire it into `sweepCompletedDungeonScene`**

Change:

```js
export async function sweepCompletedDungeonScene(scene) {
  return sweepLooseNpcActors(scene);
}
```

to:

```js
export async function sweepCompletedDungeonScene(
  scene,
  { healAndClearParty = healAndClearPartyConditions } = {},
) {
  await healAndClearParty();
  return sweepLooseNpcActors(scene);
}
```

- [ ] **Step 5: Wire it into `teardownDungeonRun`**

Change the signature and add the call:

```js
export async function teardownDungeonRun(
  scene,
  { previousSceneId = null } = {},
) {
```

to:

```js
export async function teardownDungeonRun(
  scene,
  { previousSceneId = null, healAndClearParty = healAndClearPartyConditions } = {},
) {
```

and add `await healAndClearParty();` right before the existing `const deletedNpcActorCount = await sweepLooseNpcActors(scene);` line.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-scene-heal-party-on-run-end.test.mjs`
Expected: PASS (all 4 tests)

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — no existing test called `teardownDungeonRun`/`sweepCompletedDungeonScene` before this task (confirmed: `grep -rln "teardownDungeonRun\|sweepCompletedDungeonScene" tests/*.test.mjs` found nothing prior to this task's own new file), so there's no pre-existing call site whose behavior this new optional parameter could change.

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-heal-party-on-run-end.test.mjs
git commit -m "Heal and clear party conditions at both dungeon-run-ending points (#617)"
```

---

## Task 3: Live-verify against a real dungeon run

**Files:** None — this task only runs the shipped code against the live world and records the outcome.

**Interfaces:** None.

- [ ] **Step 1: Confirm the change is deployed**

Using the `foundry-rest` skill against the running dev world: confirm `game.modules.get("pf2e-dungeon-crawl").version` reflects this change's own version bump, or that the deployed `dungeon-scene.mjs`/`foundry-api.mjs` contain `healAndClearPartyConditions`/`healAndClearConditions`.

- [ ] **Step 2: Drive a real run to completion (or abandon one) with a damaged, conditioned party**

Either live in the actual running game, or via `foundry-rest` scripting: reduce at least one real party member's HP and apply at least one real condition (e.g. `actor.increaseCondition("clumsy", {value: 1})`), then either reach the goal room or abandon the run.

- [ ] **Step 3: Confirm every party member is fully healed and condition-free afterward**

Check each party actor's `system.attributes.hp.value` equals its own `system.attributes.hp.max`, and `actor.itemTypes.condition` is empty, for every party member — not just the one that was damaged/conditioned going in, confirming the loop covers the whole party.

- [ ] **Step 4: Report the outcome on issue #617**

Comment on #617 with what was actually observed (confirmed working live, or a real failure mode found) before removing its `assigned` label.
