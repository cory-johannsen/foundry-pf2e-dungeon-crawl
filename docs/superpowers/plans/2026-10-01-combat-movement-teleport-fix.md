# Combat Movement `{ teleport: true }` Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix AI-controlled tokens landing off-grid during combat movement (#141) by passing `{ teleport: true }` on every token-position `.update()` call in `scripts/dungeon-combat.mjs`, the same fix already shipped for follow-the-leader movement in `scripts/dungeon-follow.mjs` (#87, PR #407).

**Architecture:** No new code, no new files — a one-option addition to four existing `token.update({x, y})` call sites in one file. Foundry v14 runs every `TokenDocument#update({x, y})` through its own movement/pathing pipeline, which does a wall-collision check on the straight-line path from current to destination position even for a scripted update — if that line clips a wall, Foundry silently substitutes a quarter-cell "collision waypoint" instead of the exact grid cell requested. `dungeon-combat.mjs` already does its own wall-aware pathfinding before ever calling `update()`, so Foundry's redundant check is pure liability here. `{ teleport: true }` maps to Foundry's `displace` movement action (`walls: null`, no collision check at all), eliminating the substitution.

**Tech Stack:** Vanilla JS (`scripts/dungeon-combat.mjs`), vitest.

**Spec:** None — a bounded fix with no open design question. The root cause and fix are already fully established by #87/PR #407 (the identical mechanism, already fixed in the sibling file `scripts/dungeon-follow.mjs`) and confirmed against issue #141's own history (two prior, unrelated fix attempts — `{animation: {duration: 0}}`, PR #352 — reverted in PR #361 after triggering a genuine Foundry v14 core crash in `#preUpdateMovement`; this plan does not repeat that approach). See issue #141 and `scripts/dungeon-follow.mjs:120-144`'s own docblock for the full rationale this plan argues from instead of a separate spec file.

## Global Constraints

- Do **not** reintroduce `{ animation: { duration: 0 } }` (or any other animation-disabling option) on these call sites — that was the already-reverted #352/#361 fix, and it triggers a Foundry v14 core crash (`TypeError: can't redefine non-configurable property` inside Foundry's own `#preUpdateMovement`) under real player-driven movement.
- `{ teleport: true }` must be added to all four token-position `.update()` call sites in `scripts/dungeon-combat.mjs` — `snapTokenToGrid` (not just the mover functions that call it) is one of the four; missing it would leave the #86 off-grid self-correction path still vulnerable to the same bug it's meant to fix.
- This plan only touches `scripts/dungeon-combat.mjs` and its existing tests — `scripts/dungeon-follow.mjs` already has this fix (#87/PR #407) and is out of scope here.
- Per the #141 history's own lesson: a scripted-update test proving the fix works does **not** by itself prove it's safe under real native (keyboard/ruler-driven) player movement — the #352 fix passed every unit test and scripted live-verification before failing catastrophically under real play. This plan's tests give confidence the option is being passed correctly; genuine confidence that it doesn't trigger a different Foundry-side issue still requires a real live playtest (a leader/combatant moving through a door in an actual running game) before this is trusted as done, exactly as #87/PR #407 was.

## Review Focus

- **`snapTokenToGrid`'s own corrective update** (fired when a token is already off-grid and a mover function's early-return path would otherwise leave it untouched) must carry `{ teleport: true }` too, not just the "real move" writes — it's a separate call site from the three mover functions' own waypoint writes, and the #86 bug this corrects is exactly the "token sitting off-grid" symptom #141 reports. Task 1's tests cover this via the existing snap-only scenarios.
- **`pushTokenAway`'s own push-move write** (line ~2169) is a different call site from `snapTokenToGrid`'s correction (line ~2142) inside the same function — a fix that only touches the snap call but not the push-move call would still leave knockback/retreat movement vulnerable. Task 1 adds a dedicated successful-push test for this.
- **`strideByPosture`'s own move write** (line ~3295) has no existing "successful move" test in `tests/dungeon-combat-grid-snap.test.mjs` at all (both existing tests in that file's `strideByPosture` block are snap-only early-return cases) — without a new test, this call site could silently keep being missed. Task 1 adds it.
- **A call site where `{ teleport: true }` is added but the existing positional `{x, y}` argument is accidentally dropped or malformed** — each test asserts both the resulting token position *and* the options argument, not just one or the other, so a mistake in either direction fails loudly.
- **A full-suite regression** from this change rippling into some other test that asserts on the exact shape of a `token.update()` call elsewhere in the codebase — Task 1's last step runs the full suite, not just the directly-modified test file.

---

## Task 1: Add `{ teleport: true }` to every token-position update in `dungeon-combat.mjs`

**Files:**
- Modify: `scripts/dungeon-combat.mjs:1846` (`snapTokenToGrid`), `scripts/dungeon-combat.mjs:2119` (`stepToward`), `scripts/dungeon-combat.mjs:2169` (`pushTokenAway`), `scripts/dungeon-combat.mjs:3295` (`strideByPosture`)
- Test: `tests/dungeon-combat-grid-snap.test.mjs`

**Interfaces:** None — no exported signatures change. `stepToward`, `strideByPosture`, `pushTokenAway` keep their existing parameters and return values (`"moved"`/`"blocked"`/`"no-route"`/`"no-speed"`/`"already-there"` for the first two); only the options argument passed to their internal `token.update()` calls changes.

- [ ] **Step 1: Add failing assertions to the two existing `stepToward` tests that currently exercise both call sites**

In `tests/dungeon-combat-grid-snap.test.mjs`, within `describe("stepToward corrects an off-grid mover even when it doesn't move (#86)", ...)`, add an assertion to the end of the **first** test (`"snaps the mover to its nearest grid cell when already within melee reach"`, exercises `snapTokenToGrid`'s own call site):

```js
    expect(mover.token.update.mock.calls[0][1]).toEqual({ teleport: true });
```

Within `describe("footprint-aware movement (#140)", ...)`, add the same kind of assertion to the end of the `"stepToward returns 'moved' on a normal successful move"` test (exercises `stepToward`'s own waypoint-write call site, line 2119 — this mover starts grid-aligned at `x: 0, y: 0`, so `update` is called exactly once, by the move write, not by `snapTokenToGrid`):

```js
    expect(mover.token.update.mock.calls[0][1]).toEqual({ teleport: true });
```

- [ ] **Step 2: Add a new successful-push test exercising `pushTokenAway`'s own move-write call site**

Add this test inside `describe("pushTokenAway corrects an off-grid target even when it can't be pushed (#86)", ...)`, after the existing test:

```js
  it("passes { teleport: true } on its own push-move update, separately from the #86 snap correction", async () => {
    installFoundryStubs();
    const attacker = makeCombatant({ id: "attacker", x: 0, y: 0 });
    const target = makeCombatant({ id: "target", x: GRID_SIZE, y: 0 });
    const combat = makeCombat({ combatants: [attacker, target] });

    await pushTokenAway(combat, attacker, target, 1);

    // Grid-aligned start -> the #86 snap correction (a separate call site,
    // already covered above) never fires here; this is the push itself.
    expect(target.token.update).toHaveBeenCalledTimes(1);
    expect(target.token.x % GRID_SIZE).toBe(0);
    expect(target.token.update.mock.calls[0][1]).toEqual({ teleport: true });
  });
```

- [ ] **Step 3: Add a new successful-move test exercising `strideByPosture`'s own move-write call site**

Add this test inside `describe("strideByPosture corrects an off-grid mover even when it doesn't move (#86)", ...)`, after the existing two tests:

```js
  it("passes { teleport: true } on its own move update when it actually moves", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, speedFt: 30 });
    const target = makeCombatant({ id: "target", x: 5 * GRID_SIZE, y: 0 });
    const combat = makeCombat({ combatants: [mover, target] });

    const status = await strideByPosture(combat, mover, "approach", target);

    expect(status).toBe("moved");
    // Grid-aligned start -> the #86 snap correction never fires here; this
    // is strideByPosture's own waypoint write (line ~3295).
    expect(mover.token.update).toHaveBeenCalledTimes(1);
    expect(mover.token.update.mock.calls[0][1]).toEqual({ teleport: true });
  });
```

- [ ] **Step 4: Run the test file to verify the new/extended assertions fail**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: FAIL — the two extended tests and the two new tests all fail with an assertion error comparing `undefined` (no second argument currently passed) against `{ teleport: true }`.

- [ ] **Step 5: Add `{ teleport: true }` to all four call sites**

In `scripts/dungeon-combat.mjs`:

Line 1846 (`snapTokenToGrid`), change:
```js
    await token.update({ x: snappedX, y: snappedY });
```
to:
```js
    await token.update({ x: snappedX, y: snappedY }, { teleport: true });
```

Line 2119 (`stepToward`), change:
```js
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
```
to:
```js
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize }, { teleport: true });
```

Line 2169 (`pushTokenAway`), change:
```js
  await target.token.update({
    x: waypoint.gx * gridSize,
    y: waypoint.gy * gridSize,
  });
```
to:
```js
  await target.token.update(
    {
      x: waypoint.gx * gridSize,
      y: waypoint.gy * gridSize,
    },
    { teleport: true },
  );
```

Line 3295 (`strideByPosture`), change:
```js
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
```
to:
```js
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize }, { teleport: true });
```

Add a short comment directly above `snapTokenToGrid`'s `token.update` call (matching `dungeon-follow.mjs:137-144`'s own rationale, so a future reader doesn't need to cross-reference the other file to understand why this option is here):

```js
  // #141: Foundry v14 runs every TokenDocument#update({x,y}) through its own
  // movement pipeline, which re-checks wall collisions on the straight-line
  // path even for a scripted update -- if that line clips a wall, Foundry
  // silently substitutes a quarter-cell "collision waypoint" instead of the
  // exact cell requested. This module already does its own wall-aware
  // pathfinding before ever calling update(), so that check is redundant
  // and is the actual mechanism putting tokens off-grid. { teleport: true }
  // (Foundry's `displace` movement action, walls: null) bypasses it -- same
  // fix as dungeon-follow.mjs's #87/PR #407, ported here for combat
  // movement's own four token.update() call sites.
```

- [ ] **Step 6: Run the test file to verify it passes**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: PASS (all tests in the file, including the 2 extended and 2 new ones)

- [ ] **Step 7: Run the full test suite to check for regressions elsewhere**

Run: `npx vitest run`
Expected: PASS (no other test asserts on the exact single-argument shape of a `token.update()` call made by `stepToward`/`strideByPosture`/`pushTokenAway`/`snapTokenToGrid` in a way that a second argument would break — confirmed by inspection of `tests/dungeon-combat-agent-move-stalled.test.mjs`, `tests/dungeon-strike-riders.test.mjs`, and `tests/dungeon-combat-reactive-strike.test.mjs`, none of which use `toHaveBeenCalledWith` against these specific calls)

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-grid-snap.test.mjs
git commit -m "Pass { teleport: true } on combat-movement token updates to fix off-grid landing (#141)"
```

- [ ] **Step 9: Request a real live playtest before trusting this closed**

Per this plan's own Global Constraints section (and #141's own hard-won lesson): ask the user to run a real combat encounter with an AI-controlled combatant moving through at least one doorway/corridor, live, in the actual running game — not a scripted `token.update()` call — before closing #141. Comment the outcome on the issue either way (confirmed fixed, or a new failure mode found) before removing its `assigned`/`in progress` label.
