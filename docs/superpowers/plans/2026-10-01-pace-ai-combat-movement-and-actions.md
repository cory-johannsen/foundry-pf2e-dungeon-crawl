# Pace AI Combat Movement and Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-controlled combat movement and actions visible to players in real time — walk one grid square at a time with a delay between hops instead of jumping straight to the destination, and pace individual actions within a turn instead of resolving them back-to-back instantly.

**Architecture:** `stepToward`/`strideByPosture`/`pushTokenAway` (`scripts/dungeon-combat.mjs`) already compute a full wall-aware path (`findPath`/`posturePath`) and the final reachable cell along it (`walkPath`); this plan has `walkPath` also return the intermediate cells it walked through, and adds a small shared helper that writes each one in turn — still via `{ teleport: true }` on every single-square hop (never re-enabled Foundry animation, per #87/#141/#361's hard-won lesson) — with a delay between hops. Separately, `runAgentDecisionLoop` (the agent-decision path) and `playHeuristicTurn` (the heuristic fallback) each get a delay between the individual actions they apply within one turn, using one new named constant shared by both, the same way `AUTO_PLAY_DELAY_MS`/`AGENT_TIMEOUT_MS` are already named, tunable constants rather than inline magic numbers.

**Tech Stack:** Vanilla JS (`scripts/dungeon-combat.mjs`), vitest with fake timers for the new pacing assertions.

**Spec:** None — a bounded change with no open design question; the one constraint that matters (never undo `{ teleport: true }` or re-enable Foundry's animation) is already explicit in the issue itself and restated below as a Global Constraint.

## Global Constraints

- Every single-square movement write must keep `{ teleport: true }` — never remove it, never re-enable Foundry's default slide animation, anywhere in this plan. This is the confirmed fix for #87/#141/#361's multi-session off-grid-drift saga; losing it reintroduces that bug.
- `MOVEMENT_STEP_DELAY_MS` (new, movement pacing) and `ACTION_PACE_DELAY_MS` (new, within-turn action pacing) must be named top-level constants in `scripts/dungeon-combat.mjs`, matching the existing `AUTO_PLAY_DELAY_MS`/`AGENT_TIMEOUT_MS` convention — not inline numbers at their call sites.
- `ACTION_PACE_DELAY_MS` applies to both `runAgentDecisionLoop` (the agent-decision path) and `playHeuristicTurn` (the heuristic fallback) — the issue explicitly calls out that today only the heuristic path has any pre-turn delay (`AUTO_PLAY_DELAY_MS`) and the agent path has none at all; this plan must not leave either path unpaced.
- No change to `AGENT_TIMEOUT_MS` (45s) or `AUTO_PLAY_DELAY_MS` (700ms, the existing pre-turn delay) — both stay exactly as they are; this plan only adds new, additional pacing, it doesn't touch the existing timeout/pre-turn-delay behavior.

## Review Focus

- **A multi-square move must actually produce multiple `token.update()` calls, not one.** This is the entire point of the issue — a test that only checks the *final* position (as several existing tests already do) would pass unchanged even with zero stepping added. Task 1's new tests explicitly assert `mock.calls.length` is greater than one for a move spanning more than one square, not just the end position.
- **An already-adjacent mover (zero-square move) must not gain a spurious delay or an extra no-op update call.** `MELEE_REACH_SQUARES`'s existing "already-there" early return happens before any path is even computed — Task 1 doesn't touch that branch, and its own existing test (`"stepToward returns 'already-there'..."`) is unaffected and left as-is, confirmed by inspection rather than assumed.
- **The action-pacing delay must never fire after a turn's last action** — only *between* actions. A test that only checks "a delay happened somewhere" could pass even if the delay wrongly fires after the final action too (needlessly stalling the end of every turn by `ACTION_PACE_DELAY_MS` for no visible benefit). Task 2 and Task 3's tests both assert the exact *count* of pacing delays for a known number of actions, not just "at least one."
- **A provider/decision failure mid-loop must not wait out a pacing delay it was never going to need.** `runAgentDecisionLoop` already returns immediately (no further delay) on a `fetchDecision`/`applyDecision` rejection — Task 2's new pacing delay must sit only on the success path between one applied decision and the next fetch, never on the error-return paths; its tests confirm the existing rejection-handling tests (already in `tests/dungeon-combat-agent-service-loop.test.mjs`) still pass unchanged.
- **Existing tests asserting an exact `token.update` call count on a now-multi-step path.** Searched for this explicitly rather than assumed absent: exactly one existing test (`strideByPosture`'s `"passes { teleport: true } on its own move update when it actually moves"`, `tests/dungeon-combat-grid-snap.test.mjs`) asserts `toHaveBeenCalledTimes(1)` on a scenario that will now take multiple hops — Task 1 fixes this specific test as part of its own work, not left as an incidental breakage for someone else to find.

---

## Task 1: Step movement one grid square at a time, with a delay between hops

**Files:**
- Modify: `scripts/dungeon-combat.mjs` — `walkPath` (~line 2061), `stepToward` (~line 2096), `pushTokenAway` (~line 2150), `strideByPosture` (~line 3267)
- Test: `tests/dungeon-combat-grid-snap.test.mjs`

**Interfaces:**
- Produces (module-private, same visibility as today's `walkPath`): `walkPath(...)` now returns `{ cell: {gx, gy}, steps: [{gx, gy}, ...] } | null` instead of `{gx, gy} | null` — `steps` is every intermediate cell from (but not including) the mover's own current cell up to and including `cell`, in travel order. `walkTokenThroughSteps(token, steps, gridSize): Promise<void>` (new, module-private) — writes each cell in `steps` via `token.update({x, y}, { teleport: true })` in order, waiting `MOVEMENT_STEP_DELAY_MS` between each write except after the last one.
- Consumes: nothing external — this task is entirely internal to `dungeon-combat.mjs`.

- [ ] **Step 1: Fix the one existing test this change breaks, and add the new stepping tests**

In `tests/dungeon-combat-grid-snap.test.mjs`, replace the `strideByPosture` `"passes { teleport: true } on its own move update when it actually moves"` test (it currently asserts `toHaveBeenCalledTimes(1)`, which will no longer hold once a 4-square move takes 4 separate update calls):

```js
  it("passes { teleport: true } on every hop of its own move update, walking multiple squares instead of jumping once", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, speedFt: 30 });
    const target = makeCombatant({ id: "target", x: 5 * GRID_SIZE, y: 0 });
    const combat = makeCombat({ combatants: [mover, target] });
    vi.useFakeTimers();

    const movePromise = strideByPosture(combat, mover, "approach", target);
    await vi.runAllTimersAsync();
    const status = await movePromise;

    expect(status).toBe("moved");
    // Grid-aligned start -> the #86 snap correction never fires here; every
    // call below is strideByPosture's own waypoint-walking (line ~3295).
    expect(mover.token.update.mock.calls.length).toBeGreaterThan(1);
    mover.token.update.mock.calls.forEach((call) => {
      expect(call[1]).toEqual({ teleport: true });
    });
    expect(mover.token.x % GRID_SIZE).toBe(0);
    expect(mover.token.y % GRID_SIZE).toBe(0);
    vi.useRealTimers();
  });
```

Add a new test to the `describe("stepToward corrects an off-grid mover...")` block's sibling scope (alongside the existing `"stepToward returns 'moved' on a normal successful move"` test in the `"footprint-aware movement (#140)"` describe block), asserting the same multi-hop behavior and the actual delay value for `stepToward`:

```js
  it("stepToward walks multiple squares one at a time, waiting MOVEMENT_STEP_DELAY_MS between hops", async () => {
    installFoundryStubs();
    // vi.useFakeTimers() must come before vi.spyOn(globalThis, "setTimeout")
    // -- it replaces the global, so spying first would wrap a reference
    // fake timers then discard, leaving the spy watching nothing.
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, speedFt: 30 });
    const target = makeCombatant({ id: "target", x: 5 * GRID_SIZE, y: 0 });
    const combat = makeCombat({ combatants: [mover, target] });

    const movePromise = stepToward(combat, mover, target, 10);
    await vi.runAllTimersAsync();
    const status = await movePromise;

    expect(status).toBe("moved");
    expect(mover.token.update.mock.calls.length).toBeGreaterThan(1);
    mover.token.update.mock.calls.forEach((call) => {
      expect(call[1]).toEqual({ teleport: true });
    });
    const stepDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 250);
    // One fewer delay than hops -- no delay waited after the final hop.
    expect(stepDelayCalls.length).toBe(mover.token.update.mock.calls.length - 1);
    vi.useRealTimers();
  });

  it("pushTokenAway walks multiple squares one at a time when pushed further than one square", async () => {
    installFoundryStubs();
    vi.useFakeTimers();
    const attacker = makeCombatant({ id: "attacker", x: 0, y: 0 });
    const target = makeCombatant({ id: "target", x: GRID_SIZE, y: 0 });
    const combat = makeCombat({ combatants: [attacker, target] });

    const pushPromise = pushTokenAway(combat, attacker, target, 3);
    await vi.runAllTimersAsync();
    await pushPromise;

    expect(target.token.update.mock.calls.length).toBeGreaterThan(1);
    target.token.update.mock.calls.forEach((call) => {
      expect(call[1]).toEqual({ teleport: true });
    });
    vi.useRealTimers();
  });
```

(The existing single-square `pushTokenAway` test, `"passes { teleport: true } on its own push-move update..."`, pushes by exactly `distanceSquares: 1` — a one-hop move — and is unaffected by this change; left as-is.)

- [ ] **Step 2: Run the test file to verify the new/updated assertions fail**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: FAIL — `strideByPosture`'s updated test fails (still only 1 call today), and both new tests fail (`stepToward`/`pushTokenAway` still write a single final destination, not multiple hops; `setTimeoutSpy` sees no calls with delay `250`).

- [ ] **Step 3: Add the new constant and helper**

In `scripts/dungeon-combat.mjs`, near `AUTO_PLAY_DELAY_MS`/`AGENT_TIMEOUT_MS` (~line 518), add:

```js
// #479: how long each individual grid-square hop of an AI-controlled
// combatant's movement pauses before the next one, so players can
// actually see it move instead of it jumping straight to its
// destination. Every hop still writes via { teleport: true } -- this
// paces the write-by-write sequence, it does not reintroduce Foundry's
// own animated movement pipeline (see #87/#141/#361: that pipeline's own
// wall-collision check silently relocates a token to the wrong cell;
// { teleport: true } bypasses it on every single hop, same as before).
const MOVEMENT_STEP_DELAY_MS = 250;
```

Add the shared stepping helper near `walkPath` (~line 2061, just above it):

```js
/** Writes `token`'s position through each cell in `steps` in order (an
 * ordered list of {gx, gy} cells, not including the token's own starting
 * cell -- see walkPath's own updated return shape), each still via
 * { teleport: true } so Foundry's wall-collision check never relocates a
 * single hop (#87/#141/#361), with MOVEMENT_STEP_DELAY_MS between each
 * write except after the last one. */
async function walkTokenThroughSteps(token, steps, gridSize) {
  for (let i = 0; i < steps.length; i += 1) {
    await token.update(
      { x: steps[i].gx * gridSize, y: steps[i].gy * gridSize },
      { teleport: true },
    );
    if (i < steps.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, MOVEMENT_STEP_DELAY_MS));
    }
  }
}
```

- [ ] **Step 4: Change `walkPath`'s return shape**

In `scripts/dungeon-combat.mjs`, change `walkPath`'s final line from:

```js
  return stepIndex > 0 ? path[stepIndex] : null;
```

to:

```js
  return stepIndex > 0
    ? { cell: path[stepIndex], steps: path.slice(1, stepIndex + 1) }
    : null;
```

Update `walkPath`'s own docblock's last sentence (currently *"Returns the destination {gx, gy} actually reached, or null..."*) to: *"Returns `{cell, steps}` — `cell` is the destination {gx, gy} actually reached, `steps` is every intermediate cell from the mover's own current cell up to and including `cell`, in travel order — or `null` if the mover shouldn't move at all (no path, or every waypoint is within the stop distance already or occupied)."*

- [ ] **Step 5: Update the three call sites**

In `stepToward` (~line 2120), change:

```js
  const waypoint = walkPath(
    path,
    goal,
    speedSquares,
    MELEE_REACH_SQUARES,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return "blocked";
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize }, { teleport: true });
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
```

to:

```js
  const waypoint = walkPath(
    path,
    goal,
    speedSquares,
    MELEE_REACH_SQUARES,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return "blocked";
  await walkTokenThroughSteps(me, waypoint.steps, gridSize);
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
```

In `pushTokenAway` (~line 2170), change:

```js
  const waypoint = walkPath(
    path,
    awayFrom,
    distanceSquares,
    0,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return;
  await target.token.update(
    {
      x: waypoint.gx * gridSize,
      y: waypoint.gy * gridSize,
    },
    { teleport: true },
  );
```

to:

```js
  const waypoint = walkPath(
    path,
    awayFrom,
    distanceSquares,
    0,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return;
  await walkTokenThroughSteps(target.token, waypoint.steps, gridSize);
```

In `strideByPosture` (~line 3299), change:

```js
  const waypoint = walkPath(
    path,
    targetCell,
    speedSquares,
    stopWithin,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return "blocked";
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize }, { teleport: true });
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
```

to:

```js
  const waypoint = walkPath(
    path,
    targetCell,
    speedSquares,
    stopWithin,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return "blocked";
  await walkTokenThroughSteps(me, waypoint.steps, gridSize);
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
```

- [ ] **Step 6: Run the test file to verify it passes**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: PASS (every test in the file, including the updated and two new ones)

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — no other test calls `walkPath` directly (it's module-private) or asserts an exact `token.update` call count on a path that now takes multiple hops, beyond the one already fixed in Step 1.

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-grid-snap.test.mjs
git commit -m "Walk AI combat movement one grid square at a time with a visible delay (#479)"
```

---

## Task 2: Pace individual actions within `runAgentDecisionLoop`

**Files:**
- Modify: `scripts/dungeon-combat.mjs` — `runAgentDecisionLoop` (~line 576)
- Test: `tests/dungeon-combat-agent-service-loop.test.mjs`

**Interfaces:**
- Produces: `runAgentDecisionLoop`'s existing signature and behavior are otherwise unchanged — this task only adds a delay between successive loop iterations, using the module-private `ACTION_PACE_DELAY_MS` constant it shares with Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-combat-agent-service-loop.test.mjs`, inside the existing `describe('runAgentDecisionLoop', ...)` block:

```js
  it('waits ACTION_PACE_DELAY_MS between applying one action and fetching the next, once per action boundary', async () => {
    installGameStub();
    const firstPending = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [], roundNumber: 1 }, candidates: [] };
    const secondPending = { ...firstPending, context: { candidates: [], roundNumber: 2 } };
    const getPending = vi.fn().mockResolvedValue(firstPending);
    const fetchDecision = vi
      .fn()
      .mockResolvedValueOnce({ candidateId: 'stride:approach:opp1' })
      .mockResolvedValueOnce({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValueOnce(secondPending).mockResolvedValueOnce(null);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const loopPromise = runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });
    await vi.runAllTimersAsync();
    await loopPromise;

    expect(fetchDecision).toHaveBeenCalledTimes(2);
    const paceDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 600);
    // Two actions -> exactly one gap between them, none after the turn ends.
    expect(paceDelayCalls.length).toBe(1);
    vi.useRealTimers();
  });

  it('does not wait at all when the very first decision already ends the turn', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 600)).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the test file to verify the new tests fail**

Run: `npx vitest run tests/dungeon-combat-agent-service-loop.test.mjs`
Expected: FAIL — no delay exists yet, so `paceDelayCalls.length` is `0`, not `1`, in the first new test (the second new test already passes today, since there's genuinely no delay anywhere yet — confirms it isn't a false positive once the real assertion is added in Step 1 of this task).

- [ ] **Step 3: Add the constant and the delay**

Near `AUTO_PLAY_DELAY_MS`/`MOVEMENT_STEP_DELAY_MS` (Task 1), add:

```js
// #479: how long an agent-controlled combatant's turn pauses between one
// applied action and the next decision, on both the agent-decision path
// (here) and the heuristic fallback (playHeuristicTurn) -- so a turn's
// actions resolve visibly one at a time instead of all at once. Shared
// by both paths rather than two separate constants, since the issue asks
// for "a similar delay" on both, not independently-tunable ones.
// Deliberately a different value from AUTO_PLAY_DELAY_MS (also 700ms) so
// a test spying on setTimeout by delay value can never confuse the two,
// even though they happen to serve a similar pacing purpose.
const ACTION_PACE_DELAY_MS = 600;
```

In `runAgentDecisionLoop`, change the `while (pending)` loop's success-path tail from:

```js
    try {
      pending = await applyDecision(
        combat,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
      );
    } catch (err) {
      console.error("agent-service: applyAgentDecision failed:", err.message);
      return;
    }
  }
}
```

to:

```js
    try {
      pending = await applyDecision(
        combat,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
      );
    } catch (err) {
      console.error("agent-service: applyAgentDecision failed:", err.message);
      return;
    }
    if (pending) {
      await new Promise((resolve) => setTimeout(resolve, ACTION_PACE_DELAY_MS));
    }
  }
}
```

(The `if (pending)` guard is what keeps the delay from firing after the turn's last action — `pending` is `null` once `applyDecision` reports the turn is over, and the `while` loop is about to exit anyway.)

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run tests/dungeon-combat-agent-service-loop.test.mjs`
Expected: PASS (all tests in the file, including the two new ones and every pre-existing one — none of the existing tests use fake timers or assert on `setTimeout`, so a real-but-short 600ms delay in a couple of them is the only behavior change, and vitest's default test timeout comfortably covers it)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-agent-service-loop.test.mjs
git commit -m "Pace individual actions within runAgentDecisionLoop's turn (#479)"
```

---

## Task 3: Pace the move-then-strike sequence in `playHeuristicTurn`

**Files:**
- Modify: `scripts/dungeon-combat.mjs` — `playHeuristicTurn` (~line 2546)
- Test: `tests/dungeon-combat-heuristic-turn-pacing.test.mjs` (new)

**Interfaces:**
- Produces: `playHeuristicTurn(combat, combatant, deps?)` — `deps` (`{ move, strike, delayMs }`, each defaulting to the real `stepToward`/the module-private strike helper/`ACTION_PACE_DELAY_MS`) is injectable purely so this task's test can assert pacing without needing a full strike-capable actor fixture — the same test-only dependency-injection idiom `runAgentDecisionLoop` already uses (Task 2, and originally #105). Production callers (`armAgentTimeout`, `autoPlayCombatantTurnIfDue`) never pass `deps`.

- [ ] **Step 1: Write the failing test**

Create `tests/dungeon-combat-heuristic-turn-pacing.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import { playHeuristicTurn } from "../scripts/dungeon-combat.mjs";

const GRID_SIZE = 100;

function installFoundryStubs() {
  globalThis.game = {
    combats: { has: () => true },
  };
}

function makeCombatant({ id, x, y, disposition = -1 } = {}) {
  return {
    id,
    isDefeated: false,
    token: { x, y, disposition },
  };
}

function makeCombat({ combatants = [] } = {}) {
  return {
    id: "combat-1",
    combatant: combatants[0] ?? null,
    combatants,
    scene: { grid: { size: GRID_SIZE, distance: 5 } },
    nextTurn: vi.fn(),
  };
}

describe("playHeuristicTurn action pacing (#479)", () => {
  it("waits between moving and striking when there's a target to act against", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, disposition: -1 });
    const target = makeCombatant({ id: "target", x: GRID_SIZE, y: 0, disposition: 1 });
    const combat = makeCombat({ combatants: [mover, target] });
    const move = vi.fn().mockResolvedValue("moved");
    const strike = vi.fn().mockResolvedValue(undefined);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const turnPromise = playHeuristicTurn(combat, mover, { move, strike });
    await vi.runAllTimersAsync();
    await turnPromise;

    expect(move).toHaveBeenCalledWith(combat, mover, target, 1);
    expect(strike).toHaveBeenCalledWith(combat, mover, target);
    // move must fully resolve, then the pacing delay, then strike -- not
    // both fired back-to-back with the delay merely racing alongside them.
    expect(move.mock.invocationCallOrder[0]).toBeLessThan(setTimeoutSpy.mock.invocationCallOrder[0]);
    expect(setTimeoutSpy.mock.invocationCallOrder[0]).toBeLessThan(strike.mock.invocationCallOrder[0]);
    const paceDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 600);
    expect(paceDelayCalls).toHaveLength(1);
    expect(combat.nextTurn).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("never waits or strikes when there's no opponent at all", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0 });
    const combat = makeCombat({ combatants: [mover] });
    const move = vi.fn();
    const strike = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await playHeuristicTurn(combat, mover, { move, strike });

    expect(move).not.toHaveBeenCalled();
    expect(strike).not.toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 600)).toHaveLength(0);
    expect(combat.nextTurn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run tests/dungeon-combat-heuristic-turn-pacing.test.mjs`
Expected: FAIL — `playHeuristicTurn` doesn't accept a third `deps` argument yet (`move`/`strike` are never called, since the real `stepToward`/strike helper run instead and need a full actor fixture this test deliberately doesn't provide), and there is no pacing delay yet either.

- [ ] **Step 3: Update `playHeuristicTurn`**

In `scripts/dungeon-combat.mjs`, change:

```js
export async function playHeuristicTurn(combat, combatant) {
  const target = nearestOpponent(combat, combatant);
  if (target) {
    await stepToward(
      combat,
      combatant,
      target.combatant,
      target.distanceSquares,
    );
    await rollAndApplyStrike(combat, combatant, target.combatant);
  }
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}
```

to:

```js
export async function playHeuristicTurn(
  combat,
  combatant,
  { move = stepToward, strike = rollAndApplyStrike, delayMs = ACTION_PACE_DELAY_MS } = {},
) {
  const target = nearestOpponent(combat, combatant);
  if (target) {
    await move(combat, combatant, target.combatant, target.distanceSquares);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await strike(combat, combatant, target.combatant);
  }
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run tests/dungeon-combat-heuristic-turn-pacing.test.mjs`
Expected: PASS (both tests)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — no existing test called `playHeuristicTurn` before this task (confirmed by `grep -rl "playHeuristicTurn" tests/*.test.mjs` returning nothing prior to this task's own new file), so there's no pre-existing call site passing positional arguments that the new third parameter could collide with.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-heuristic-turn-pacing.test.mjs
git commit -m "Pace the move-then-strike sequence in playHeuristicTurn (#479)"
```
