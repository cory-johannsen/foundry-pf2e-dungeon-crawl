# Trap Hazard Passable For Followers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #836 — a trap hazard token (armed or already tripped) never blocks AI follower/marching-order pathing, the same way a loot pile already doesn't.

**Root cause and scope correction (confirmed live-reading the real code, not assumed):** `scripts/dungeon-follow.mjs`'s `moveFollowersToward` builds the one occupancy list every follower's pathfinding call shares (confirmed current, lines 259-267) — it already has exactly the mechanism #836 needs: a `passable: true` flag, added today only for `t.actor?.type === "loot"` (corpses/piles, #365's own precedent). A trap hazard's actor type is `"hazard"`, never `"loot"`, so it falls through as a full blocking obstacle — the actual bug. Investigating the issue's own broader "(follow/marching-order/combat)" framing: combat-time AI Stride movement (`scripts/dungeon-combat.mjs`'s `movementBlockedEdges`) only ever checks real Combatants (`hostileFootprints`) and flagged cover items (`livingCoverFootprints`) — confirmed current, neither sweep ever includes a trap hazard token (disposition 0, never a Combatant, never cover-item-flagged) — so combat movement does not actually block on a trap hazard today at all; this plan does not need to touch it. `resnapTokenNow`'s own separate drift-correction occupancy check (#141) is a different mechanism (correcting one token's own off-grid position, not ongoing movement pathing) that the issue does not describe as broken; left untouched.

**Architecture:** One condition added to the existing `passable` flag computation, mirroring the already-shipped loot-token pattern exactly — no new mechanism, no new flag, no new function.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a one-condition bug fix reusing an already-built, already-tested mechanism; no open design question.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A small behavioral fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- A trap hazard token is passable for pathing **regardless of its own state** (armed/undetected, detected, disabled, or triggered) — matching the issue's own explicit "an armed, undiscovered trap should not block movement either" statement, not just the narrower "after it has been tripped" title.
- This never changes whether a trap hazard **triggers** — `trap-combat.mjs`'s `handleTrapTokenMove` (confirmed current) reacts to any `updateToken` position change regardless of pathing's own `passable` flag; the two are unrelated. A token that now paths straight through a hazard's square still triggers it exactly as before.
- No change to combat-time AI movement (`dungeon-combat.mjs`) or drift-correction (`resnapTokenNow`) — confirmed neither is actually affected by this bug.

## Review Focus

- **An armed (undetected) trap hazard must not block a follower's path**, not just a spent one — the issue's own broader statement, easy to under-scope to just the "tripped" case in the title.
- **The fix must not accidentally make every other token passable** — only a `trapHazard`-flagged token, same precision the existing loot check already has for `type === "loot"`.
- **A follower's destination choice should still avoid landing exactly on a trap hazard's square when a non-hazard alternative exists** — `passable` already means "doesn't block the path through it," not "ignored as a destination" (`freeCellsNear`'s own existing behavior, confirmed current: it already avoids passable footprints as *destinations* while allowing travel *through* them, matching the file's own loot-pile precedent) — this plan relies on that existing behavior rather than changing it.
- **The trap must still trigger normally when a follower walks through or onto it** — confirmed unrelated mechanism, pinned by reasoning in this plan rather than a new test, since no existing test for `handleTrapTokenMove` needs to change at all.

---

### Task 1: Mark trap hazard tokens passable for follower pathing

**Files:**
- Modify: `scripts/dungeon-follow.mjs` (`moveFollowersToward`'s occupancy list)
- Test: `tests/dungeon-follow.test.mjs`

**Interfaces:** None — no function signature changes; the `occupied` array's own shape (`{gx, gy, gw, gh, passable?}`) is unchanged, only which tokens get `passable: true`.

- [ ] **Step 1: Write the failing test**

Add to `tests/dungeon-follow.test.mjs`, inside the existing `describe("moveFollowersToward footprint-awareness (#140)", ...)` block (reusing its own `makeToken`/`makeScene`/`installFoundryStubs`/`runFollowMoveNow`/`settle` exactly). First, extend `makeToken` (confirmed current, lines 82-106) to optionally accept `flags`, matching this file's own minimal-fixture style:

```js
function makeToken({
  id,
  x,
  y,
  actorId,
  width = 1,
  height = 1,
  sourceX = x,
  sourceY = y,
  flags = {},
}) {
  const token = {
    id,
    x,
    y,
    actor: { id: actorId },
    width,
    height,
    _source: { x: sourceX, y: sourceY },
    getFlag: (m, k) => (m === "pf2e-dungeon-crawl" ? flags[k] : undefined),
  };
  token.update = vi.fn(async (changes) => {
    Object.assign(token, changes);
    Object.assign(token._source, changes);
  });
  return token;
}
```

Then add:

```js
  it("#836: a trap hazard token (armed or tripped) never blocks a follower's path", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: 1 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: 1 * GRID,
      actorId: FOLLOWER_ACTOR_ID,
    });
    // Directly on the straight row-1 line between follower and leader --
    // today's bug forces a detour around it (row 0 or row 2); the fix
    // lets the follower path straight through row 1 instead.
    const hazard = makeToken({
      id: "t-hazard",
      x: 2 * GRID,
      y: 1 * GRID,
      actorId: "hazard-actor",
      flags: { trapHazard: true },
    });
    const scene = makeScene({ tokens: [leader, follower, hazard] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await settle();

    expect(follower.update).toHaveBeenCalled();
    const [{ x, y }] = follower.update.mock.calls.at(-1);
    // Not a precise expected cell (this scene's exact geometry would need
    // running findFollowMove directly to pin, matching this file's own
    // existing "does not treat the follower's own body as an obstacle"
    // test's documented practice above) -- the fix's own signature is
    // that the follower never needs to leave row 1 to get near the
    // leader, since nothing actually blocks that row once the hazard is
    // passable.
    expect(y / GRID).toBe(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "#836"`
Expected: FAIL — today, the hazard blocks row 1, forcing the follower to detour into row 0 or row 2, so `y / GRID` is not `1`.

- [ ] **Step 3: Fix the occupancy check**

In `scripts/dungeon-follow.mjs`, change (confirmed current, lines 259-267):

```js
    // #365: loot-type tokens (corpses/piles) are `passable` -- they don't
    // block follower pathing, though destinations still avoid them.
    const occupied = scene.tokens.map((t) => ({
      ...footprint(
        { ...sourcePosition(t), width: t.width, height: t.height },
        gridSize,
      ),
      ...(t.actor?.type === "loot" ? { passable: true } : {}),
    }));
```

to:

```js
    // #365: loot-type tokens (corpses/piles) are `passable` -- they don't
    // block follower pathing, though destinations still avoid them. #836:
    // a trap hazard (armed or already tripped) is the same -- it's a
    // thing to trigger or step around by choice, never a physical
    // obstacle; handleTrapTokenMove (trap-combat.mjs) still reacts to a
    // follower walking through or onto it exactly as before, since that
    // trigger is a completely separate updateToken-driven mechanism, not
    // affected by this pathing flag at all.
    const occupied = scene.tokens.map((t) => ({
      ...footprint(
        { ...sourcePosition(t), width: t.width, height: t.height },
        gridSize,
      ),
      ...(t.actor?.type === "loot" || t.getFlag(MODULE_ID, "trapHazard")
        ? { passable: true }
        : {}),
    }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "#836"`
Expected: PASS.

- [ ] **Step 5: Run the full test file and suite to confirm no regression**

Run: `npx vitest run tests/dungeon-follow.test.mjs && npx vitest run`
Expected: PASS — in particular, every other test in `describe("moveFollowersToward footprint-awareness (#140)", ...)` stays green (neither existing test's tokens carry a `trapHazard` flag, so `makeToken`'s new optional `flags` parameter defaulting to `{}` changes nothing for them).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-follow.mjs tests/dungeon-follow.test.mjs
git commit -m "fix(#836): trap hazard tokens no longer block follower pathing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live verification, version bump

**Files:**
- Modify: `module.json`

No code changes in this task — verification and the version bump only.

- [ ] **Step 1: Live-verify via `foundry-rest`**

In a real dungeon run, reach a corridor or room with an armed (undetected) trap hazard and confirm, via marching order / follow movement, that a follower walks through or past it without detouring (and that the trap still detects/triggers normally when a token actually steps onto its footprint, confirming the two mechanisms stayed independent). Repeat with a disabled/triggered (spent) hazard to confirm the same.

```bash
echo 'const hazards = canvas.scene.tokens.filter(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard")); return hazards.map(t => ({ x: t.x, y: t.y, hidden: t.hidden }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a routine bug fix), using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#836): bump version for trap-passable-for-followers fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #836's own "Expected" section (a tripped trap never blocks movement; an armed/undiscovered trap shouldn't either) is fully covered by one unconditional `passable` flag, not gated on trap state. The issue's own broader "(follow/marching-order/combat)" framing was investigated and corrected: combat-time Stride movement never checks trap tokens at all today, confirmed by reading `hostileFootprints`/`livingCoverFootprints` directly, so no combat-side change is needed or made. #569/#754/#804 (the issue's own "Related") are trap-mechanics issues this plan doesn't touch, since the fix is entirely on the pathing side.

**2. Placeholder scan:** No TBD/TODO. The code change is the complete real diff. The test's own assertion is deliberately relational (same row, not an exact guessed cell) rather than a placeholder — explicitly justified by this file's own existing precedent for exact-coordinate claims needing to be run, not hand-derived.

**3. Type consistency:** N/A — no new functions or signatures; the existing `occupied` footprint shape is unchanged.

**4. Review Focus:** All four items (armed trap passable too, only trap-hazard tokens affected, destination-avoidance behavior unchanged, triggering stays independent of pathing) are each addressed directly — the first three by the one test and the precise code change, the fourth by the architectural reasoning recorded in this plan (no existing trigger test needed changing, confirming nothing there was touched).

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-trap-passable-for-followers.md`.
