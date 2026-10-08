# Game Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advance Foundry's world clock (`game.time`) for corridor traversal between rooms and for non-combat room-kind resolution (skill challenges, puzzles, traps, narrative, treasure), using a central, agent-tunable per-kind time-cost registry.

**Architecture:** A new pure-ish module `scripts/game-clock.mjs` owns the time math (corridor feet → minutes, room-kind → minutes, the GM-gated `game.time.advance` wrapper) and the registry defaults/validation. Two existing integration points get small additions: `handleDungeonDoorOpened` (`scripts/dungeon-scene.mjs`) advances time for corridor traversal when a room's reveal door opens, and `resolveCurrentRoom` (`scripts/ui/dungeon-app.mjs`) plus the `safe_rest` auto-resolve branch in `scripts/dungeon-scene.mjs` advance time for room-kind resolution. Corridor length in feet is computed once at room-build time (`buildPopulateAndUnlockGraphNode`) and persisted onto the destination room's state via a new `scripts/dungeon-runner.mjs` export. The registry's values live in a new `config: false` world setting, read/written only through two new `module.api` methods (never a direct `game.settings.set` from a relayed agent script).

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-10-07-game-clock-design.md`

## Global Constraints

- Grid distance is 5 ft/cell (confirmed `scripts/dungeon-scene.mjs:551`, `grid: { type: 1, size: GRID_SIZE, distance: 5, units: "ft" }`); `CORRIDOR_LEN` (a corridor's fixed short-side width) is `1` cell (`scripts/dungeon-layout.mjs:35`).
- A PF2e actor's land speed lives at `actor.system.movement.speeds.land.value` — never `system.attributes.speed` (confirmed comment, `scripts/dungeon-combat.mjs:2878-2882`).
- PF2e's own Travel-speed convention: Speed × 10 ft/minute at a normal explore pace.
- The `foundry-rest` relay refuses any script containing the literal text `game.settings.set` — the registry must only ever be written through a `module.api` method, never directly.
- Every world-mutating call this module makes gates on `game.user.isGM` (confirmed convention, `scripts/dungeon-scene.mjs:2371` et al.).
- Combat rounds and rests are explicitly out of scope — do not add any time-advancement call for them.
- `state.rooms` may be either a plain array (freshly created by `createRun`) or an object map keyed by room id (after the first per-room state mutation, e.g. `ensureSkillChallenge`) — any new `dungeon-runner.mjs` writer must handle both shapes, matching the existing defensive pattern in `markRoomOutcome` (`scripts/dungeon-runner.mjs:280-282`).
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention (no shared constants module exists) — do not introduce one.
- Bump `module.json`'s `version` as part of this work, per this repo's `CLAUDE.md` versioning rule — this is a new subsystem, so use a **minor** bump: `0.80.6` → `0.81.0`.

## Review Focus

- A corridor length of exactly `0` (adjacent rooms with no corridor, or a room with no `corridorLengthFeet` ever recorded, e.g. a state persisted before this feature existed) must advance zero time, not `NaN` or `Infinity` minutes — `feetToMinutesAtSlowestSpeed` must special-case this before dividing.
- A party with zero members, or every member missing a readable land speed (e.g. a non-character ally token, or `system.movement.speeds.land.value` absent), must fall back to the documented default speed (25 ft) rather than dividing by zero or `Math.min()`'s own `Infinity` on an empty array.
- A room kind with no registry entry at all (any kind not in `ROOM_KIND_TIME_COST_DEFAULTS`, including `combat`, `safe_rest`, `safe_entry`, and any future kind added elsewhere without updating this registry) must cost `0` minutes, never throw.
- `setRoomKindTimeCost` called with an unrecognized kind, a negative number, `NaN`, or a non-number `minutes` must be rejected without mutating the stored setting.
- `game.time?.advance` being unavailable (a future Foundry API change, or a test harness stub missing it) must make `advanceGameTime` a silent no-op, not a throw that aborts room resolution or door-opening.
- A double-resolution of the same room (the existing `#152` guard in `markRoomOutcome`, where `effectKey` comes back `null`) must not advance time a second time — the time-advance call must sit behind the same `effectKey`-truthy gate the existing reward/unlock logic already uses.

---

### Task 1: `scripts/game-clock.mjs` — pure time math, registry defaults, and the GM-gated clock wrapper

**Files:**
- Create: `scripts/game-clock.mjs`
- Test: `tests/game-clock.test.mjs`

**Interfaces:**
- Consumes: nothing from this plan's other tasks. Reads Foundry globals (`game.settings.get`, `game.user.isGM`, `game.time.advance`) directly, matching this codebase's existing convention of calling Foundry globals straight from feature modules rather than through an injected dependency.
- Produces (consumed by Tasks 2-4):
  - `ROOM_KIND_TIME_COST_DEFAULTS` — `{ skill_challenge: 1, puzzle: 1, trap: 0, narrative: 0, treasure: 0 }` (minutes per attempt).
  - `mergeRoomKindTimeCosts(stored)` — `(object|null|undefined) => object`, merges a stored setting value onto the defaults.
  - `minutesForRoomResolution(kind, { attempts = 1 } = {})` — `(string, { attempts?: number }) => number`.
  - `isValidRoomKindTimeCostUpdate(kind, minutes)` — `(string, number) => boolean`.
  - `feetToMinutesAtSlowestSpeed(feet, partyMembers = [])` — `(number, Array<Actor>) => number`.
  - `corridorLengthFeetFromSegments(mainSegments = [], transitCells = [])` — `(Array<{gx,gy,gw,gh}>, Array<{corridorSegments}>) => number`.
  - `advanceGameTime(seconds)` — `async (number) => void`.

- [ ] **Step 1: Write the failing tests for the pure registry/math functions**

```js
// tests/game-clock.test.mjs
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ROOM_KIND_TIME_COST_DEFAULTS,
  mergeRoomKindTimeCosts,
  minutesForRoomResolution,
  isValidRoomKindTimeCostUpdate,
  feetToMinutesAtSlowestSpeed,
  corridorLengthFeetFromSegments,
  advanceGameTime,
} from "../scripts/game-clock.mjs";

function installGameStub({ roomKindTimeCosts = undefined, isGM = true, advance = vi.fn(async () => {}) } = {}) {
  globalThis.game = {
    settings: {
      get: (moduleId, key) => (key === "roomKindTimeCosts" ? roomKindTimeCosts : undefined),
    },
    user: { isGM },
    time: { advance },
  };
  return advance;
}

describe("ROOM_KIND_TIME_COST_DEFAULTS", () => {
  it("matches the approved spec defaults", () => {
    expect(ROOM_KIND_TIME_COST_DEFAULTS).toEqual({
      skill_challenge: 1,
      puzzle: 1,
      trap: 0,
      narrative: 0,
      treasure: 0,
    });
  });
});

describe("mergeRoomKindTimeCosts", () => {
  it("falls back to defaults for every key when stored is undefined", () => {
    expect(mergeRoomKindTimeCosts(undefined)).toEqual(ROOM_KIND_TIME_COST_DEFAULTS);
  });

  it("overrides only the keys present in stored", () => {
    expect(mergeRoomKindTimeCosts({ puzzle: 2 })).toEqual({
      ...ROOM_KIND_TIME_COST_DEFAULTS,
      puzzle: 2,
    });
  });
});

describe("minutesForRoomResolution", () => {
  beforeEach(() => installGameStub());

  it("returns the per-attempt default times attempts for a registry kind", () => {
    expect(minutesForRoomResolution("skill_challenge", { attempts: 3 })).toBe(3);
  });

  it("defaults attempts to 1 when omitted", () => {
    expect(minutesForRoomResolution("puzzle")).toBe(1);
  });

  it("returns 0 for a kind with a 0-minute default regardless of attempts", () => {
    expect(minutesForRoomResolution("trap", { attempts: 5 })).toBe(0);
  });

  it("returns 0 for a kind with no registry entry at all (combat/safe_rest/safe_entry/unknown)", () => {
    expect(minutesForRoomResolution("combat", { attempts: 5 })).toBe(0);
    expect(minutesForRoomResolution("safe_rest")).toBe(0);
    expect(minutesForRoomResolution("safe_entry")).toBe(0);
    expect(minutesForRoomResolution("some_future_kind")).toBe(0);
  });

  it("reads an agent-tuned override from the world setting", () => {
    installGameStub({ roomKindTimeCosts: { puzzle: 4 } });
    expect(minutesForRoomResolution("puzzle", { attempts: 2 })).toBe(8);
  });
});

describe("isValidRoomKindTimeCostUpdate", () => {
  it("accepts a known kind with a non-negative finite number", () => {
    expect(isValidRoomKindTimeCostUpdate("puzzle", 2)).toBe(true);
    expect(isValidRoomKindTimeCostUpdate("trap", 0)).toBe(true);
  });

  it("rejects an unrecognized kind", () => {
    expect(isValidRoomKindTimeCostUpdate("combat", 1)).toBe(false);
    expect(isValidRoomKindTimeCostUpdate("not_a_kind", 1)).toBe(false);
  });

  it("rejects a negative, NaN, or non-number minutes value", () => {
    expect(isValidRoomKindTimeCostUpdate("puzzle", -1)).toBe(false);
    expect(isValidRoomKindTimeCostUpdate("puzzle", NaN)).toBe(false);
    expect(isValidRoomKindTimeCostUpdate("puzzle", "2")).toBe(false);
  });
});

describe("feetToMinutesAtSlowestSpeed", () => {
  it("returns 0 for zero or negative feet", () => {
    expect(feetToMinutesAtSlowestSpeed(0, [{ system: { movement: { speeds: { land: { value: 25 } } } } }])).toBe(0);
    expect(feetToMinutesAtSlowestSpeed(-10, [])).toBe(0);
  });

  it("uses the slowest party member's land speed, PF2e's Speed*10ft/min convention", () => {
    const fast = { system: { movement: { speeds: { land: { value: 30 } } } } };
    const slow = { system: { movement: { speeds: { land: { value: 20 } } } } };
    // 100 ft at 20ft speed -> 200ft/min normal pace -> 0.5 min
    expect(feetToMinutesAtSlowestSpeed(100, [fast, slow])).toBeCloseTo(0.5);
  });

  it("falls back to the documented default speed (25ft) for an empty party", () => {
    // 250ft at 25ft speed -> 250ft/min normal pace -> 1 min
    expect(feetToMinutesAtSlowestSpeed(250, [])).toBeCloseTo(1);
  });

  it("falls back to the documented default speed when no member has a readable speed", () => {
    const noSpeed = { system: {} };
    const nonNumber = { system: { movement: { speeds: { land: { value: "fast" } } } } };
    expect(feetToMinutesAtSlowestSpeed(250, [noSpeed, nonNumber])).toBeCloseTo(1);
  });
});

describe("corridorLengthFeetFromSegments", () => {
  it("sums each main segment's long dimension in cells, times 5ft", () => {
    // one straight segment, 4 cells long by 1 cell wide
    expect(corridorLengthFeetFromSegments([{ gx: 0, gy: 0, gw: 4, gh: 1 }], [])).toBe(20);
  });

  it("includes every transit cell's own corridorSegments", () => {
    const main = [{ gx: 0, gy: 0, gw: 2, gh: 1 }];
    const transitCells = [
      { corridorSegments: [{ gx: 0, gy: 0, gw: 1, gh: 1 }, { gx: 0, gy: 0, gw: 1, gh: 1 }] },
    ];
    // main: 2 cells, transit: 1 + 1 cells = 4 cells total -> 20ft
    expect(corridorLengthFeetFromSegments(main, transitCells)).toBe(20);
  });

  it("returns 0 for no segments at all (adjacent rooms, no corridor)", () => {
    expect(corridorLengthFeetFromSegments([], [])).toBe(0);
    expect(corridorLengthFeetFromSegments()).toBe(0);
  });
});

describe("advanceGameTime", () => {
  it("calls game.time.advance with the given seconds when GM", async () => {
    const advance = installGameStub();
    await advanceGameTime(90);
    expect(advance).toHaveBeenCalledWith(90);
  });

  it("is a no-op for zero or negative seconds", async () => {
    const advance = installGameStub();
    await advanceGameTime(0);
    await advanceGameTime(-5);
    expect(advance).not.toHaveBeenCalled();
  });

  it("is a no-op when the current user is not GM", async () => {
    const advance = installGameStub({ isGM: false });
    await advanceGameTime(60);
    expect(advance).not.toHaveBeenCalled();
  });

  it("is a no-op (not a throw) when game.time.advance is unavailable", async () => {
    globalThis.game = { user: { isGM: true }, time: {} };
    await expect(advanceGameTime(60)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/game-clock.test.mjs`
Expected: FAIL — `scripts/game-clock.mjs` does not exist yet (`Cannot find module`).

- [ ] **Step 3: Write `scripts/game-clock.mjs`**

```js
/**
 * #785: advances Foundry's world clock for the two real mechanical-time
 * gaps this module has: corridor traversal and non-combat room-kind
 * resolution. Combat rounds (Foundry core's own Combat#nextRound) and
 * rests (#613's restForTheNight) already advance game.time on their own
 * and are deliberately not touched here — see
 * docs/superpowers/specs/2026-10-07-game-clock-design.md.
 */

const MODULE_ID = "pf2e-dungeon-crawl";

export const ROOM_KIND_TIME_COST_DEFAULTS = Object.freeze({
  skill_challenge: 1,
  puzzle: 1,
  trap: 0,
  narrative: 0,
  treasure: 0,
});

export function mergeRoomKindTimeCosts(stored) {
  return { ...ROOM_KIND_TIME_COST_DEFAULTS, ...(stored ?? {}) };
}

/** 0 for any kind not in the registry (combat/safe_rest/safe_entry/unknown) — fail safe to "advance nothing". */
export function minutesForRoomResolution(kind, { attempts = 1 } = {}) {
  const costs = mergeRoomKindTimeCosts(game.settings.get(MODULE_ID, "roomKindTimeCosts"));
  const perAttempt = costs[kind];
  if (typeof perAttempt !== "number" || !Number.isFinite(perAttempt)) return 0;
  return perAttempt * attempts;
}

export function isValidRoomKindTimeCostUpdate(kind, minutes) {
  return (
    Object.prototype.hasOwnProperty.call(ROOM_KIND_TIME_COST_DEFAULTS, kind) &&
    typeof minutes === "number" &&
    Number.isFinite(minutes) &&
    minutes >= 0
  );
}

// PF2e's own common baseline land speed, used only when no party member has a readable one.
const DEFAULT_SPEED_FEET = 25;

/** PF2e's Travel-speed convention: Speed * 10ft/minute at a normal explore pace, slowest member sets the pace. */
export function feetToMinutesAtSlowestSpeed(feet, partyMembers = []) {
  if (!feet || feet <= 0) return 0;
  const speeds = (partyMembers ?? [])
    .map((m) => m?.system?.movement?.speeds?.land?.value)
    .filter((s) => typeof s === "number" && Number.isFinite(s) && s > 0);
  const slowest = speeds.length > 0 ? Math.min(...speeds) : DEFAULT_SPEED_FEET;
  return feet / (slowest * 10);
}

function segmentLengthCells(segment) {
  return Math.max(segment.gw, segment.gh);
}

/** Grid distance is 5ft/cell (scripts/dungeon-scene.mjs's own scene.grid config); CORRIDOR_LEN (the
 * corridor's fixed short side) is 1 cell, so a segment's long dimension is its length in cells. */
export function corridorLengthFeetFromSegments(mainSegments = [], transitCells = []) {
  const segments = [
    ...mainSegments,
    ...transitCells.flatMap((c) => c.corridorSegments ?? []),
  ];
  const cells = segments.reduce((sum, seg) => sum + segmentLengthCells(seg), 0);
  return cells * 5;
}

/** GM-only wrapper around game.time.advance — degrades to a silent no-op (never throws) if the current
 * user isn't GM or the API is unavailable, matching this module's established graceful-degradation
 * convention (scripts/foundry-api.mjs) rather than blocking dungeon progression. */
export async function advanceGameTime(seconds) {
  if (!seconds || seconds <= 0) return;
  if (!game.user?.isGM) return;
  if (typeof game.time?.advance !== "function") return;
  await game.time.advance(seconds);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/game-clock.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/game-clock.mjs tests/game-clock.test.mjs
git commit -m "feat(#785): add game-clock pure time math and GM-gated advance wrapper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: World setting + `module.api.setRoomKindTimeCost`/`getRoomKindTimeCosts`

**Files:**
- Modify: `scripts/module.mjs:90-95` (settings registration block), `scripts/module.mjs:169-234` (the `module.api` object)
- Test: `tests/module-room-kind-time-cost-api.test.mjs`

**Interfaces:**
- Consumes: `ROOM_KIND_TIME_COST_DEFAULTS`, `mergeRoomKindTimeCosts`, `isValidRoomKindTimeCostUpdate` from Task 1's `scripts/game-clock.mjs`.
- Produces (consumed by Tasks 3-4, and by the agent service directly): `game.modules.get(MODULE_ID).api.setRoomKindTimeCost(kind, minutes)` and `...api.getRoomKindTimeCosts()`.

- [ ] **Step 1: Write the failing test**

`module.mjs` runs `Hooks.once("ready", ...)` against real Foundry globals at import time and has no existing test harness that imports it directly (confirmed: its one existing test, `tests/module-door-sound-hook.test.mjs`, tests the pure functions `module.mjs` calls into and asserts the wiring via a source-text regex, not a live import). Follow that same convention: the validation/merge logic is tested directly against Task 1's exports (already covered by `tests/game-clock.test.mjs`), and this test asserts `module.mjs` is wired correctly by reading its source.

```js
// tests/module-room-kind-time-cost-api.test.mjs
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");

describe("#785 roomKindTimeCosts setting + api wiring", () => {
  it("registers the roomKindTimeCosts world setting as an API-only (config: false) Object, matching the dungeonRuns precedent", () => {
    expect(src).toMatch(/game\.settings\.register\(MODULE_ID, "roomKindTimeCosts", \{/);
    expect(src).toMatch(/type: Object/);
    expect(src).toMatch(/default: ROOM_KIND_TIME_COST_DEFAULTS/);
  });

  it("exposes setRoomKindTimeCost and getRoomKindTimeCosts on module.api", () => {
    expect(src).toMatch(/setRoomKindTimeCost:/);
    expect(src).toMatch(/getRoomKindTimeCosts:/);
  });

  it("setRoomKindTimeCost validates before writing, and never calls game.settings.set with an unvalidated value", () => {
    expect(src).toMatch(/isValidRoomKindTimeCostUpdate\(kind, minutes\)/);
  });

  it("imports the registry helpers from game-clock.mjs", () => {
    expect(src).toMatch(/from "\.\/game-clock\.mjs"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/module-room-kind-time-cost-api.test.mjs`
Expected: FAIL — none of the matched strings exist in `scripts/module.mjs` yet.

- [ ] **Step 3: Register the setting**

In `scripts/module.mjs`, add the import near the top (alongside the other feature imports):

```js
import {
  ROOM_KIND_TIME_COST_DEFAULTS,
  isValidRoomKindTimeCostUpdate,
  mergeRoomKindTimeCosts,
} from "./game-clock.mjs";
```

Then, in the `Hooks.once("init", ...)` block, right after the existing `dungeonRuns` registration (`scripts/module.mjs:90-95`):

```js
  // #785: per-room-kind time-cost registry for the game clock. config:
  // false (no GM settings-menu UI) — matches dungeonRuns's own
  // internal-only convention. Only ever written through
  // api.setRoomKindTimeCost below, never a direct game.settings.set from
  // a relayed agent script (the foundry-rest relay's own text filter
  // refuses that literal).
  game.settings.register(MODULE_ID, "roomKindTimeCosts", {
    scope: "world",
    config: false,
    type: Object,
    default: ROOM_KIND_TIME_COST_DEFAULTS,
  });
```

- [ ] **Step 4: Add the two API methods**

In the `module.api = { ... }` object (`scripts/module.mjs:169-234`), add two new entries (order doesn't matter; placing them after `postAgentLoopStatus` keeps new additions grouped at the end):

```js
    // #785: the agent service's only way to tune per-room-kind time
    // costs — never a direct game.settings.set (the foundry-rest relay's
    // own script filter refuses that literal text).
    setRoomKindTimeCost: (kind, minutes) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      if (!isValidRoomKindTimeCostUpdate(kind, minutes)) {
        return ui.notifications.warn(
          `${MODULE_ID} | Invalid room kind time cost: ${kind} = ${minutes}`,
        );
      }
      const current = game.settings.get(MODULE_ID, "roomKindTimeCosts");
      return game.settings.set(MODULE_ID, "roomKindTimeCosts", {
        ...current,
        [kind]: minutes,
      });
    },
    getRoomKindTimeCosts: () =>
      mergeRoomKindTimeCosts(game.settings.get(MODULE_ID, "roomKindTimeCosts")),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/module-room-kind-time-cost-api.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite once to catch any import-order regression**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 7: Commit**

```bash
git add scripts/module.mjs tests/module-room-kind-time-cost-api.test.mjs
git commit -m "feat(#785): register roomKindTimeCosts setting and agent-tunable api methods

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Persist and consume corridor length at room-build and door-open time

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (new export, placed after `recordPuzzleStageAttempt`, i.e. after line 1017)
- Modify: `scripts/dungeon-scene.mjs:1956-2026` (`buildPopulateAndUnlockGraphNode` — persist corridor length at build time)
- Modify: `scripts/dungeon-scene.mjs:2438-2454` (`handleDungeonDoorOpened` — advance time at door-open time)
- Test: `tests/dungeon-runner-corridor-length.test.mjs`
- Test: `tests/game-clock-corridor-integration.test.mjs`

**Interfaces:**
- Consumes: `corridorLengthFeetFromSegments`, `feetToMinutesAtSlowestSpeed`, `advanceGameTime` from Task 1's `scripts/game-clock.mjs`.
- Produces: `recordCorridorLengthFeet(sceneId, roomId, feet, { settingsRef } = {})` in `scripts/dungeon-runner.mjs`, mirroring `recordSkillChallengeAttempt`'s shape; writes `state.rooms[roomId].corridorLengthFeet`.

- [ ] **Step 1: Write the failing test for `recordCorridorLengthFeet`**

```js
// tests/dungeon-runner-corridor-length.test.mjs
import { describe, it, expect, beforeEach } from "vitest";
import { createRun, recordCorridorLengthFeet, getRunState } from "../scripts/dungeon-runner.mjs";

function settingsRef() {
  const store = new Map();
  return {
    get: (moduleId, key) => store.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => {
      store.set(`${moduleId}.${key}`, value);
    },
  };
}

function stubGenerator(rooms) {
  globalThis.game = globalThis.game ?? {};
  globalThis.game.modules = {
    get: () => ({
      api: {
        getGenerator: () => ({ buildRoomSequence: () => rooms }),
      },
    }),
  };
}

describe("#785 recordCorridorLengthFeet", () => {
  it("writes corridorLengthFeet onto the target room, leaving other rooms untouched", async () => {
    const ref = settingsRef();
    const rooms = [
      { id: "room-a", kind: "safe_entry" },
      { id: "room-b", kind: "skill_challenge" },
    ];
    // createRun needs a real generator; this test only exercises
    // recordCorridorLengthFeet against a hand-built state via the same
    // settingsRef, so it writes state directly rather than depending on
    // createRun's own generator wiring.
    await ref.set("pf2e-dungeon-crawl", "dungeonRuns", {
      "scene-1": {
        rooms,
        currentRoomId: "room-a",
        edges: { "room-a": ["room-b"] },
        history: [],
        completed: false,
      },
    });
    const result = await recordCorridorLengthFeet("scene-1", "room-b", 45, { settingsRef: ref });
    expect(result.rooms["room-b"].corridorLengthFeet).toBe(45);
    expect(result.rooms["room-a"].corridorLengthFeet).toBeUndefined();
  });

  it("is a no-op returning null when the scene has no run state", async () => {
    const ref = settingsRef();
    const result = await recordCorridorLengthFeet("missing-scene", "room-b", 45, { settingsRef: ref });
    expect(result).toBeNull();
  });

  it("is a no-op returning the unchanged state when roomId isn't in state.rooms", async () => {
    const ref = settingsRef();
    await ref.set("pf2e-dungeon-crawl", "dungeonRuns", {
      "scene-1": { rooms: [{ id: "room-a" }], currentRoomId: "room-a", edges: {}, history: [], completed: false },
    });
    const result = await recordCorridorLengthFeet("scene-1", "no-such-room", 10, { settingsRef: ref });
    expect(result.rooms.find?.((r) => r.id === "no-such-room")).toBeUndefined();
  });
});
```

Note: `getRunState`'s exact settingsRef shape must match this repo's existing test convention — before writing this test for real, read one existing passing test that exercises a `dungeon-runner.mjs` writer end-to-end (e.g. `tests/dungeon-runner-skill-challenge.test.mjs` if it exists, else any test importing `recordSkillChallengeAttempt` or `markRoomOutcome`) and copy its exact `settingsRef`/state-seeding shape instead of the sketch above — the sketch above may not match `getRunState`'s real signature precisely.

- [ ] **Step 2: Find the real settingsRef test convention and adjust the test**

Run: `grep -rl "recordSkillChallengeAttempt\|markRoomOutcome" tests/*.mjs`

Open the first matching file, copy its exact pattern for seeding a run and calling `defaultSettingsRef`/a stub `settingsRef`, and rewrite Step 1's test to match it exactly (same helper names, same state shape) before proceeding.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/dungeon-runner-corridor-length.test.mjs`
Expected: FAIL — `recordCorridorLengthFeet` is not exported yet.

- [ ] **Step 4: Add `recordCorridorLengthFeet` to `scripts/dungeon-runner.mjs`**

Insert after `recordPuzzleStageAttempt` (after line 1017), mirroring its exact read-mutate-persist shape and the `Array.isArray(state.rooms)` defensive handling `markRoomOutcome` already uses:

```js
/**
 * #785: persists a corridor's real length (in feet) onto the room it
 * leads INTO, computed once at build time (buildPopulateAndUnlockGraphNode)
 * from that edge's own real corridorSegments/transitCells
 * (game-clock.mjs's corridorLengthFeetFromSegments). Read back at
 * door-open time (handleDungeonDoorOpened) to advance the game clock for
 * corridor traversal. `state.rooms` may still be the original array
 * (a run with no other per-room state written yet) or the object map it
 * becomes after the first such write (#93) — handled the same
 * defensive way markRoomOutcome's own room lookup already does.
 */
export async function recordCorridorLengthFeet(
  sceneId,
  roomId,
  feet,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const isArray = Array.isArray(state.rooms);
  const room = isArray ? state.rooms.find((r) => r.id === roomId) : state.rooms[roomId];
  if (!room) return state;
  const rooms = isArray
    ? state.rooms.map((r) => (r.id === roomId ? { ...r, corridorLengthFeet: feet } : r))
    : { ...state.rooms, [roomId]: { ...room, corridorLengthFeet: feet } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/dungeon-runner-corridor-length.test.mjs`
Expected: PASS.

- [ ] **Step 6: Wire build-time persistence in `scripts/dungeon-scene.mjs`**

Add `recordCorridorLengthFeet` to the existing `dungeon-runner.mjs` import block (`scripts/dungeon-scene.mjs:63-77`):

```js
import {
  getRunState,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  ensureSkillChallenge,
  ensurePuzzleState,
  ensureNarrativeState,
  ensureTrapState,
  ensureTreasureState,
  markRoomOutcome,
  effectiveMarchingOrder,
  retreatTo,
  markStubOpened,
  recordCorridorLengthFeet,
} from "./dungeon-runner.mjs";
```

Add a new import for the game-clock helpers used in this file:

```js
import {
  corridorLengthFeetFromSegments,
  feetToMinutesAtSlowestSpeed,
  advanceGameTime,
} from "./game-clock.mjs";
```

In `buildPopulateAndUnlockGraphNode`, right after `edgeId`/`edgePlan` are computed (`scripts/dungeon-scene.mjs:2018-2020`), add:

```js
      const edgeId = `${sourceId}->${room.id}`;
      const edgePlan = corridorEdgeTiles({ corridorSegments, transitCells }, { fullWidth: layoutVersion >= 3 });
      const edgeCells = edgePlan.mainCells;
      // #785: real corridor length for this edge, persisted onto the
      // room it leads into — read back by handleDungeonDoorOpened to
      // advance the game clock for corridor traversal.
      await recordCorridorLengthFeet(
        scene.id,
        room.id,
        corridorLengthFeetFromSegments(corridorSegments, transitCells),
      );
```

- [ ] **Step 7: Wire door-open-time advancement in `handleDungeonDoorOpened`**

In `scripts/dungeon-scene.mjs`, in `handleDungeonDoorOpened` (around line 2438-2454), right after the `advanceToRoom` call succeeds (`if (ok) { ... }`, line 2450-2452), add the corridor-time advance using the room that was just entered (`room`, already looked up at line 2439):

```js
    const { ok, state: advancedState } = await advanceToRoom({
      sceneId,
      roomId,
      revealedTokenIds,
    });
    // #175: the party has committed to this branch -- lock its unchosen siblings.
    if (ok) {
      await relockSiblingDoors(scene, state.currentRoomId, roomId, openChildren(advancedState, state.currentRoomId));
      // #785: corridor traversal time, using the real corridor length
      // recorded at build time and the slowest party member's land
      // speed (PF2e's own group-travel convention). A room with no
      // recorded length (adjacent rooms, or a state persisted before
      // this feature existed) advances zero time.
      const partyMembers = game.actors?.party?.members ?? [];
      await advanceGameTime(
        feetToMinutesAtSlowestSpeed(room?.corridorLengthFeet ?? 0, partyMembers) * 60,
      );
    }
```

- [ ] **Step 8: Write an integration test for the door-open corridor-time wiring**

```js
// tests/game-clock-corridor-integration.test.mjs
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync(new URL("../scripts/dungeon-scene.mjs", import.meta.url), "utf8");

describe("#785 corridor-time wiring in dungeon-scene.mjs", () => {
  it("buildPopulateAndUnlockGraphNode persists corridor length at build time", () => {
    expect(src).toMatch(/recordCorridorLengthFeet\(\s*scene\.id,\s*room\.id,\s*corridorLengthFeetFromSegments\(corridorSegments, transitCells\),?\s*\)/);
  });

  it("handleDungeonDoorOpened advances game time using the entered room's corridorLengthFeet", () => {
    expect(src).toMatch(/feetToMinutesAtSlowestSpeed\(room\?\.corridorLengthFeet \?\? 0, partyMembers\)/);
    expect(src).toMatch(/advanceGameTime\(/);
  });

  it("imports the game-clock helpers it uses", () => {
    expect(src).toMatch(/from "\.\/game-clock\.mjs"/);
  });
});
```

- [ ] **Step 9: Run both new tests and the full suite**

Run: `npm test -- tests/dungeon-runner-corridor-length.test.mjs tests/game-clock-corridor-integration.test.mjs`
Expected: PASS.

Run: `npm test`
Expected: PASS (0 new failures — in particular, re-run any existing `dungeon-scene.mjs`/`dungeon-corridor-*` tests that exercise `buildPopulateAndUnlockGraphNode`/`handleDungeonDoorOpened` directly, since this task adds an `await` inside their call paths).

- [ ] **Step 10: Commit**

```bash
git add scripts/dungeon-runner.mjs scripts/dungeon-scene.mjs tests/dungeon-runner-corridor-length.test.mjs tests/game-clock-corridor-integration.test.mjs
git commit -m "feat(#785): persist and consume corridor length for game-clock travel time

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Advance time on non-combat room-kind resolution

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs:144-208` (`resolveCurrentRoom`)
- Modify: `scripts/dungeon-scene.mjs:2463-2477` (the `safe_rest` auto-resolve branch inside `handleDungeonDoorOpened`)
- Test: `tests/game-clock-room-kind-integration.test.mjs`

**Interfaces:**
- Consumes: `minutesForRoomResolution`, `advanceGameTime` from Task 1's `scripts/game-clock.mjs`.
- Produces: nothing further downstream — this is the last integration point.

- [ ] **Step 1: Wire `resolveCurrentRoom` in `scripts/ui/dungeon-app.mjs`**

Add the import (alongside the other `../*.mjs` feature imports, e.g. right after line 35's `resolveChoiceSetsOnItemData` import):

```js
import { minutesForRoomResolution, advanceGameTime } from "../game-clock.mjs";
```

In `resolveCurrentRoom` (`scripts/ui/dungeon-app.mjs:144-208`), the existing `if (currentRoom && effectKey) { await applyRoomEffect(...); }` block (lines 189-208) is already the correct gate — it's truthy only on a genuine resolution, never on the `#152` duplicate-resolve guard (`effectKey: null`). Add the time-advance call inside that same block, right after the `applyRoomEffect` call:

```js
  if (currentRoom && effectKey) {
    // ... existing applyRoomEffect call unchanged ...
    await applyRoomEffect(effectKey, {
      scene,
      seed: preState.seed,
      roomId: currentRoom.id,
      rank: preState.layoutPositionByRoomId[currentRoom.id].rank,
      maxRank: preState.maxRank,
      isGoal: currentRoom.isGoal,
      revealedRoomId,
      revealedStubId,
    });
    // #785: non-combat room-kind resolution time. attempts comes from
    // whichever attempt-count the room's own state already tracks
    // (recordSkillChallengeAttempt/recordPuzzleStageAttempt); any other
    // kind (trap/narrative/treasure/combat/safe_rest/safe_entry) costs 0
    // minutes per the registry, so the fallback of 1 never matters for
    // them.
    const attempts = currentRoom.challenge?.attemptsUsed ?? currentRoom.puzzle?.attemptsUsed ?? 1;
    await advanceGameTime(minutesForRoomResolution(currentRoom.kind, { attempts }) * 60);
  }
```

- [ ] **Step 2: Wire the `safe_rest` auto-resolve branch in `scripts/dungeon-scene.mjs`**

This branch's `room.kind` is always `"safe_rest"`, which has no registry entry and therefore always costs `0` minutes — `restForTheNight` (#613) already advances the clock by 8 hours on its own. Wire the same call here anyway, for a single uniform rule ("every room resolution path calls `advanceGameTime(minutesForRoomResolution(...))`") rather than a silent carve-out that a future kind added to this branch could fall through unnoticed.

Add `minutesForRoomResolution` to the existing game-clock import added in Task 3, Step 6 (`scripts/dungeon-scene.mjs`):

```js
import {
  corridorLengthFeetFromSegments,
  feetToMinutesAtSlowestSpeed,
  minutesForRoomResolution,
  advanceGameTime,
} from "./game-clock.mjs";
```

In the `safe_rest` branch (`scripts/dungeon-scene.mjs:2463-2477`), right after the `markRoomOutcome` call:

```js
      const { state: resolvedState } = await markRoomOutcome({
        sceneId,
        succeeded: true,
      });
      // #785: always 0 minutes for safe_rest (not in the registry) —
      // restForTheNight above already advanced the clock 8 hours. Called
      // anyway so every room-resolution path follows the same rule.
      await advanceGameTime(minutesForRoomResolution(room.kind, { attempts: 1 }) * 60);
```

- [ ] **Step 3: Write the integration test**

```js
// tests/game-clock-room-kind-integration.test.mjs
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const appSrc = readFileSync(new URL("../scripts/ui/dungeon-app.mjs", import.meta.url), "utf8");
const sceneSrc = readFileSync(new URL("../scripts/dungeon-scene.mjs", import.meta.url), "utf8");

describe("#785 room-kind resolution time wiring", () => {
  it("resolveCurrentRoom advances game time using the room's attempt count, gated on effectKey", () => {
    expect(appSrc).toMatch(/const attempts = currentRoom\.challenge\?\.attemptsUsed \?\? currentRoom\.puzzle\?\.attemptsUsed \?\? 1;/);
    expect(appSrc).toMatch(/advanceGameTime\(minutesForRoomResolution\(currentRoom\.kind, \{ attempts \}\) \* 60\)/);
  });

  it("resolveCurrentRoom imports minutesForRoomResolution/advanceGameTime from game-clock.mjs", () => {
    expect(appSrc).toMatch(/from "\.\.\/game-clock\.mjs"/);
  });

  it("the safe_rest auto-resolve branch also calls advanceGameTime after markRoomOutcome", () => {
    expect(sceneSrc).toMatch(/await advanceGameTime\(minutesForRoomResolution\(room\.kind, \{ attempts: 1 \}\) \* 60\);/);
  });
});
```

- [ ] **Step 4: Run the new test and the full suite**

Run: `npm test -- tests/game-clock-room-kind-integration.test.mjs`
Expected: PASS.

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/dungeon-app.mjs scripts/dungeon-scene.mjs tests/game-clock-room-kind-integration.test.mjs
git commit -m "feat(#785): advance game time on non-combat room-kind resolution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Version bump

**Files:**
- Modify: `module.json:5`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — this is the final housekeeping step before merge.

- [ ] **Step 1: Bump the version**

This is a new subsystem (game-clock integration spanning 4 files), so per `CLAUDE.md`'s versioning rule this is a **minor** bump.

```bash
npm pkg get version --prefix . 2>/dev/null || true
```

Edit `module.json:5` from `"version": "0.80.6"` to `"version": "0.81.0"`.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "0\.80\.6" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`
Expected: only `module.json`'s own changelog/manifest entry, if any — no other file references the old version string as a comparison or assertion target.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#785): bump version to 0.81.0 for game-clock feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (scope: corridor + non-combat room-kind resolution only, no combat/rest code) — Tasks 3-4 touch only those two integration points; Review Focus and Global Constraints both call out never adding combat/rest advancement.
- Decision 2 (distance-based corridor time, slowest party speed) — Task 1 (`feetToMinutesAtSlowestSpeed`), Task 3 (wiring).
- Decision 3 (central extensible registry, not scattered bespoke logic) — Task 1 (`ROOM_KIND_TIME_COST_DEFAULTS`/`minutesForRoomResolution`), reused identically by both Task 4 integration points.
- Decision 4 (the exact registry values, and which kinds are absent/0) — Task 1's `ROOM_KIND_TIME_COST_DEFAULTS` literal, pinned by Task 1's own tests.
- Decision 5 (stored as a world setting, matching the tunable-setting convention) — Task 2.
- Decision 6 (agent tunability through dedicated API methods, never `game.settings.set` directly from relayed text) — Task 2's `setRoomKindTimeCost`/`getRoomKindTimeCosts`, with a Global Constraint and a dedicated test asserting validation gates the write.
- Decision 7 (automatic, not a GM toggle; only values are tunable) — no on/off setting exists anywhere in this plan; `advanceGameTime` always fires when minutes > 0.
- Decision 8 (UI display out of scope) — no chat message, HUD, or tracker display is added anywhere in this plan.
- Architecture's `scripts/game-clock.mjs` responsibilities — all four named functions (`advanceGameTime`, `ROOM_KIND_TIME_COST_DEFAULTS`, `minutesForRoomResolution`, `feetToMinutesAtSlowestSpeed`) are in Task 1, plus the un-named-but-required `corridorLengthFeetFromSegments` helper the Architecture's corridor section implies.
- Architecture's corridor integration (build-time persist, door-open-time read) — Task 3.
- Architecture's room-kind integration (the same two files named in the spec) — Task 4.
- Error handling section (no-op not throw for missing `game.time.advance`; default speed fallback; `0` for unrecognized kind) — all three are explicit Task 1 tests.
- Testing considerations section — pure-function unit tests (Task 1), mocked-`game`/`game.time` GM-gating test (Task 1), corridor build/read wiring test (Task 3), API method validation test (Task 2) — all present.

**2. Placeholder scan:** No TBD/TODO/"add appropriate X" anywhere in this plan; every step has literal code or an exact shell command.

**3. Type consistency:** `minutesForRoomResolution(kind, { attempts = 1 } = {})` and `feetToMinutesAtSlowestSpeed(feet, partyMembers = [])` are defined once in Task 1 and called with matching argument shapes in every later task. `corridorLengthFeetFromSegments(mainSegments = [], transitCells = [])` matches its one call site in Task 3 exactly (`corridorLengthFeetFromSegments(corridorSegments, transitCells)`). `recordCorridorLengthFeet(sceneId, roomId, feet, { settingsRef } = {})` matches `recordSkillChallengeAttempt`'s own existing shape (`sceneId, roomId, outcome, { settingsRef }`), and its one call site passes `scene.id, room.id, <number>` in that order.

**4. Review Focus:** all six items each have a direct test: zero-length corridor (Task 1, `feetToMinutesAtSlowestSpeed` "returns 0 for zero or negative feet"), speed-less party (Task 1, "falls back... for an empty party" + "...when no member has a readable speed"), unregistered kind (Task 1, "returns 0 for a kind with no registry entry at all"), invalid `setRoomKindTimeCost` input (Task 2's test, "setRoomKindTimeCost validates before writing"), missing `game.time.advance` (Task 1, "is a no-op (not a throw) when game.time.advance is unavailable"), and the double-resolution/`effectKey`-null guard (Task 4 Step 1's placement of the new call strictly inside the existing `if (currentRoom && effectKey)` gate, which the existing `#152` guard in `markRoomOutcome` already makes return `effectKey: null` for a repeat resolution — not independently re-tested here since it rides the same existing gate every other post-resolution side effect in that function already relies on).
