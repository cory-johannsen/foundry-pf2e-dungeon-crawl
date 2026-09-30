# Merge-Room Co-Parent Gate-Sharing (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the connectivity regression the Round 1 final review found: when a merge room's second-parent edge's own null-path dogleg (Round 1, already merged) is blocked by a room that turns out to be the target's own co-parent, prevent the collision *by construction* — assign door slots so the colliding connection lands on whichever slot already sits closest to the blocking room's own margin edge, so Round 1's existing dogleg never needs to widen toward the co-parent's own slot, and the co-parent's own corridor never needs to reach into the dogleg's own lane.

**Architecture:** (Revised 2026-09-29 — the original "ride-along" architecture in this section was abandoned after Task 4's own implementation found it geometrically unsound; see the spec's own "Round 2 correction" section for the full defect trace.) `buildPopulateAndUnlockGraphNode`'s incoming-connections loop stays a **single pass** (no restructuring needed — this is simpler than the abandoned design, not just different). Before assigning door slots, a pure detection function scans the target room's own real incoming connections for a priority collision (Round 1's own dogleg-trigger condition — 2 ranks/columns apart, same column/row, occupied intermediate cell — where the occupant is *also* one of this room's own other real parents, reusing the already-merged `findCoParentCollision` to confirm the match). If found, the colliding connection is assigned whichever door slot contains (or sits nearest east-of, for the residual case) the blocking room's own far margin edge; every other connection gets the remaining slots, in their own original order. Round 1's own `buildEdgeCorridor` call is **completely unchanged** — it just receives a different `toSlot` for the colliding connection than list order alone would have given it.

**Tech Stack:** Vanilla JS (ESM), Vitest, Foundry VTT v13/v14 module (`pf2e-dungeon-crawl`).

**Spec:** `docs/superpowers/specs/2026-09-29-merge-room-gate-share-design.md` (the "Round 2 correction: slot priority" section, and its amended Testing/Success criteria — Round 1's own sections above it describe the already-merged dogleg, kept fully unmodified; the original, now-superseded "ride-along" sections are kept in the spec as the historical record of why that design doesn't work).

## Global Constraints

- Round 1's own dogleg logic in `buildEdgeCorridor` (south/east branches, `scripts/dungeon-layout.mjs`) is **not modified by any task in this revised plan** — every connection's own corridor is still built by the exact same, already-reviewed function call; only *which slot* gets passed to it changes for the colliding connection. Task 1's refactor (already merged) must stay behavior-preserving — no task in this plan touches it further.
- **Every task's own tests must use a graph where the relevant room has 2+ real incoming connections**, with slots resolved via `incomingConnectionsFor` + `doorSlotsForFace(rect, incomingConnections.length, face)[i]` — never a hand-built single-slot `doorSlotsForFace(rect, 1, face)[0]`. This is the single most important lesson from Round 1's own final review: every Round 1 test used a single-connection graph, which is exactly the configuration that hid all three of that review's Critical findings. A task whose own tests use a single-connection graph has not actually exercised this plan's own subject matter.
- Doors and flags are unchanged: `dungeonDoorToRoomId`/`dungeonDoorFromRoomId` (or `dungeonHiddenDoorForEdge` for a hidden connection), `unlockDoorsFromRoom`, `handleDungeonDoorOpened` all keep working exactly as today. Only *which slot index* a connection's own door lands on changes for the colliding case — never which flags it carries.
- The co-parent is always exactly one rank/column below the blocking cell relative to the second-parent's own source (`toPos.rank === fromPos.rank + 2` south / `toPos.col === fromPos.col + 2` east, Round 1's own scoped detection) — meaning the co-parent's own edge to the SAME target is necessarily rank+1/col+1 apart (directly adjacent). The co-parent's own corridor is therefore expected to take `buildEdgeCorridor`'s simple adjacent (`path.length <= 2`) branch, not a dogleg itself — verify this as an explicit assertion in the new task's own tests, not an unchecked assumption.
- Scope: exactly one co-parent colliding with exactly one second-parent edge. Three-or-more real parents colliding at the same cell, a co-parent whose own connection also needs Round 1's dogleg, and the documented residual (blocking room `LARGE`, target room `SMALL` — the blocking room's own margin edge falls past the target's own face entirely, so no slot assignment can contain it) are explicitly out of scope for elimination — measured and documented, not silently left uncovered, per this file's own established "measure and document" pattern.
- Version bump: this branch is currently at `0.51.0`. Check `origin/main`'s own current version before the final bump (same recovery Round 1's own Task 6 used) — bump past it, minor bump (architecture-level change).

## Review Focus

1. **The priority slot assignment must actually contain (or sit immediately east/south of) the blocking room's own real margin edge**, not an approximation — a test asserting only "no overlap with the co-parent's rect" is not enough; the specific slot boundary relationship to `occupantEastEdge`/`occupantSouthEdge` must be verified numerically (this is exactly Round 1's own Critical-1/2 shape — a geometric-alignment bug a coarse test wouldn't catch).
2. **The co-parent's own connection must still get a valid, independent slot** — reassigning the colliding connection's own slot must not leave the co-parent without one, duplicate a slot between two connections, or change the *total number* of slots assigned (still exactly `incomingConnections.length`, still exactly one per connection).
3. **`pendingForeignMarginOpenings`'s slot-count fix (Task 2, already merged) is unaffected by this rework** — confirm no task in this plan needs to touch it further; its own job (foreign margin openings for the *unrelated-blocker* dogleg case) is orthogonal to slot-priority, which only affects the *target* room's own slot assignment, not any *blocking* room's own margin walls.
4. **The single-pass detection must not change behavior for the overwhelmingly common case** (a room with exactly one real incoming connection, or two-plus real connections that don't collide) — a test asserting byte-identical slot assignment (and therefore byte-identical wall/tile output) to today's list-order assignment for a non-colliding multi-parent room is needed, not just for the colliding case.
5. **Hidden connections must not be mistaken for co-parents, and must never receive slot-priority treatment.** A hidden connection's own `sourceId` (a shortcut's hidden extra, or a detour's own real parent link marked hidden) must never be treated as a priority collision, in either direction (as the blocker, or as the colliding connection) — reuse `findCoParentCollision`'s own already-tested hidden-connection guard rather than re-deriving it. A test with a hidden connection present alongside two real ones, where the hidden one happens to be positioned at what would otherwise look like a blocking cell, must confirm it's correctly ignored.
6. **The documented residual (blocking room `LARGE`, target room `SMALL`) must be measured, not assumed.** The sweep task must report its own real rate for this specific size combination, separately from the overall collision rate — a silent "close enough" is not acceptable per this file's own established discipline.

---

### Task 1: Extract the shared margin-band approach helper

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (the `exitFace === 'south' && sameColumn` and `exitFace === 'east' && sameRank` branches of `buildEdgeCorridor` — find via `grep -n "exitFace === 'south' && sameColumn\|exitFace === 'east' && sameRank"`)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new — this task only reorganizes existing code.
- Produces: a new exported pure function, `marginBandApproach(doorX0, doorX1, faceY, targetLaneX0, targetLaneWidth)` (south-axis version — see Step 3 for the exact signature and the east-axis mirror, `marginBandApproachY`), returning `{ turnGx, turnGx2, turnBottom, turnSegment, turnWalls }` where `turnSegment` is the turn-1 floor box and `turnWalls` is the array of containment walls for that turn (the caps at `turnBottom`, mirroring what Round 1's own dogleg already builds). Round 1's own dogleg logic in `buildEdgeCorridor` calls this new function instead of duplicating the jog math inline. (Note, added 2026-09-29: the original plan for this task also expected a Round 2 "ride-along" function to call `marginBandApproach` with a different `targetLaneX0` — that design was abandoned during Task 4's own implementation and replaced with slot-priority assignment, which needs no corridor-geometry helper at all. This extraction is still worth doing on its own merits — Round 1's own dogleg logic reads more clearly as an extracted function — and is unaffected by that later change.)

- [ ] **Step 1: Read the current south-branch dogleg code in full**

Read `scripts/dungeon-layout.mjs`'s `exitFace === 'south' && sameColumn` branch in full (roughly lines 501-812 as of this plan's own writing — confirm via `grep -n "exitFace === 'south' && sameColumn"` since line numbers may have shifted). Identify exactly which lines compute `turnGx`/`turnGx2`/`turnBottom` (the dogleg's own "turn 1") and the two containment walls capping `turnBottom` (`{x1: dogleg.turnGx, y1: dogleg.turnBottom, x2: dogleg.laneX0, y2: dogleg.turnBottom}` and the mirror at `laneX1`/`turnGx2`) and the two side walls at `turnGx`/`turnGx2` spanning `faceY`..`turnBottom` (the "Self-review finding (round 2)" containment added in Round 1's own review). These four pieces — `turnGx`, `turnGx2`, `turnBottom`, and the 2+2 walls — are what this task extracts.

- [ ] **Step 2: Write the failing test for the new helper**

Add to `tests/dungeon-layout.test.mjs`:

```js
describe('marginBandApproach — #297 Round 2 extraction', () => {
  it('produces the turn geometry Round 1\'s own south-branch dogleg already computes for its own laneX0 target', () => {
    // Uses the same pinned seed/room-ids Round 1's own dogleg tests use --
    // find the exact values via tests/dungeon-layout.test.mjs's own
    // existing 'dogleg-repro-seed-0' describe block (search for it) rather
    // than re-deriving them.
    const doorX0 = 308; // from Round 1's own 'dogleg-miss-seed-2' test scenario (tests/dungeon-layout.test.mjs, search for it) -- read the ACTUAL current pinned values from that test before using these literals, they are illustrative only
    const doorX1 = 309;
    const faceY = 12;
    const laneX0 = 306;
    const laneWidth = 1; // DOOR_WIDTH
    const result = marginBandApproach(doorX0, doorX1, faceY, laneX0, laneWidth);
    expect(result.turnGx).toBe(Math.min(doorX0, laneX0));
    expect(result.turnGx2).toBe(Math.max(doorX1, laneX0 + laneWidth));
    expect(result.turnBottom).toBe(faceY + 1); // DOOR_WIDTH
    expect(result.turnSegment).toEqual({ gx: result.turnGx, gy: faceY, gw: result.turnGx2 - result.turnGx, gh: 1 });
    expect(result.turnWalls.length).toBeGreaterThan(0);
  });
});
```

**Before writing the assertions above as final**, read the ACTUAL current pinned test values from `tests/dungeon-layout.test.mjs`'s own existing dogleg describe block (search for `dogleg-miss-seed-2` or the nearest scenario with concrete `doorX0`/`laneX0` values already verified correct) and substitute the real numbers — the literals above are illustrative, not verified; do not commit a test with unverified literal expectations.

- [ ] **Step 3: Extract the helper**

In `scripts/dungeon-layout.mjs`, add near `buildEdgeCorridor` (before it, so it's in scope):

```js
/**
 * The "turn 1" jog shared by every #297 dogleg (Round 1) and every #297
 * Round 2 ride-along corridor: a short floor segment confined to the
 * SOURCE room's own margin band (never the blocking cell itself -- see
 * Round 1's own spec section for why: a room's floor starts immediately
 * at its own cell's NW corner, so there is no y-range inside the blocking
 * cell where turning wouldn't overlap that room's own floor), jogging
 * from the source's own real door (doorX0..doorX1 at faceY) sideways to
 * wherever the corridor needs to continue (targetLaneX0..+targetLaneWidth).
 * Round 1's own dogleg used this to land at a blocking room's own margin
 * edge; Round 2's own ride-along corridor (Task 4/5) uses the exact same
 * shape to land on a co-parent's own real corridor position instead --
 * extracted here (Round 2 Task 1) so both call one shared, single-source-
 * of-truth implementation instead of two independently-maintained copies
 * of the same jog math.
 */
export function marginBandApproach(doorX0, doorX1, faceY, targetLaneX0, targetLaneWidth) {
  const turnGx = Math.min(doorX0, targetLaneX0);
  const turnGx2 = Math.max(doorX1, targetLaneX0 + targetLaneWidth);
  const turnBottom = faceY + DOOR_WIDTH;
  const turnSegment = { gx: turnGx, gy: faceY, gw: turnGx2 - turnGx, gh: DOOR_WIDTH };
  const turnWalls = [
    // Side containment (Round 1's own round-2 self-review fix).
    { x1: turnGx, y1: faceY, x2: turnGx, y2: turnBottom },
    { x1: turnGx2, y1: faceY, x2: turnGx2, y2: turnBottom },
    // Bottom cap, except where the lane continues down through it.
    { x1: turnGx, y1: turnBottom, x2: targetLaneX0, y2: turnBottom },
    { x1: targetLaneX0 + targetLaneWidth, y1: turnBottom, x2: turnGx2, y2: turnBottom },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
  return { turnGx, turnGx2, turnBottom, turnSegment, turnWalls };
}

/** East-branch mirror of `marginBandApproach` — axes swapped (see Task 1's
 * own east-branch step for the full mapping table, same as Round 1's own
 * south/east mirror). */
export function marginBandApproachY(doorY0, doorY1, faceX, targetLaneY0, targetLaneWidth) {
  const turnGy = Math.min(doorY0, targetLaneY0);
  const turnGy2 = Math.max(doorY1, targetLaneY0 + targetLaneWidth);
  const turnRight = faceX + DOOR_WIDTH;
  const turnSegment = { gx: faceX, gy: turnGy, gw: DOOR_WIDTH, gh: turnGy2 - turnGy };
  const turnWalls = [
    { x1: faceX, y1: turnGy, x2: turnRight, y2: turnGy },
    { x1: faceX, y1: turnGy2, x2: turnRight, y2: turnGy2 },
    { x1: turnRight, y1: turnGy, x2: turnRight, y2: targetLaneY0 },
    { x1: turnRight, y1: targetLaneY0 + targetLaneWidth, x2: turnRight, y2: turnGy2 },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
  return { turnRight, turnGy, turnGy2, turnSegment, turnWalls };
}
```

Then replace the south branch's own inline `turnGx`/`turnGx2`/`turnBottom` computation and its own two side-containment walls (the ones added in Round 1's own review round 2, at `dogleg.turnGx`/`dogleg.turnGx2` spanning `faceY`..`turnBottom`) with a call to `marginBandApproach(doorX0, doorX1, faceY, laneX0, DOOR_WIDTH)`, destructuring `{ turnGx, turnGx2, turnBottom, turnWalls: turn1Walls }` into the `dogleg` object construction. Replace the two side-wall entries in `plainWalls`'s dogleg branch with `...turn1Walls` (spread), and the `corridorSegments`'s own first entry with the helper's own `turnSegment`. Do the same mirror for the east branch using `marginBandApproachY`.

**This step must not change ANY observable output** — it is a pure refactor. If any existing Round 1 test's own pinned values change as a result, that is a bug in this extraction, not an acceptable side effect; fix the extraction, not the test.

- [ ] **Step 4: Run the new test and the full existing dogleg test suite**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "marginBandApproach"`
Expected: PASS.

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "dogleg"`
Expected: PASS, every existing Round 1 dogleg test unchanged in outcome — this is the behavior-preservation check for the refactor.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS, 0 regressions from Round 1's own baseline.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "refactor(#297): extract marginBandApproach helper from Round 1's dogleg turn-1 construction"
```

---

### Task 2: Fix `pendingForeignMarginOpenings`'s slot-count assumption

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`pendingForeignMarginOpenings`, currently ~line 1153 — confirm via `grep -n "export function pendingForeignMarginOpenings"`)
- Modify: `scripts/dungeon-scene.mjs` (`pendingForeignMarginOpenings`'s own call site inside `buildRoomAtGraphNode` — find via `grep -n "pendingForeignMarginOpenings("`)
- Test: `tests/dungeon-layout.test.mjs`, `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `incomingConnectionsFor` (already exported, `scripts/dungeon-layout.mjs`).
- Produces: `pendingForeignMarginOpenings`'s own signature gains two new parameters: `pendingForeignMarginOpenings(seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells, layoutEdges, hiddenIncomingByRoomId = {})`. Every existing call site must be updated to pass the two new arguments.

- [ ] **Step 1: Write the failing test proving the current bug**

Add to `tests/dungeon-layout.test.mjs`:

```js
describe('pendingForeignMarginOpenings — #297 Round 2: real slot resolution', () => {
  it('resolves the REAL per-connection slot for a multi-parent target, not slot 0 of an assumed single-connection room', () => {
    // A merge room with TWO real parents: coParentId (index 0, its own
    // direct adjacent edge) and shortcutSourceId (index 1, the edge whose
    // own dogleg blocks through the SAME room this test targets). The
    // merge room's own incoming face is 'north' with 2 real connections,
    // so doorSlotsForFace(targetRect, 2, 'north') produces TWO half-width
    // slots -- genuinely different from the single full-width slot the
    // OLD, buggy call (doorSlotsForFace(targetRect, 1, 'north')[0]) would
    // have used. This difference is what makes the test actually pin the
    // fix, not just happen to pass under both the old and new code.
    const seed = 'dogleg-repro-seed-0'; // reuse Round 1's own pinned seed
    const blockerRoomId = 'blocker-room'; // this test's own room being queried -- the co-parent AND the blocker, per Round 2's own detection
    const shortcutSourceId = 'from-room';
    const mergeRoomId = 'to-room';
    const layoutPositionByRoomId = {
      [shortcutSourceId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [mergeRoomId]: { rank: 2, col: 0 },
    };
    // blockerRoomId is ALSO a real parent of mergeRoomId here (a second,
    // independent edge, unrelated to shortcutSourceId's own edge) --
    // giving mergeRoomId 2 real incoming connections.
    const layoutEdges = {
      [shortcutSourceId]: [mergeRoomId, blockerRoomId],
      [blockerRoomId]: [mergeRoomId],
    };
    const edges = layoutEdges; // no detour rooms in this scenario
    const occupiedCells = { '0,0': shortcutSourceId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    const incomingFaceByRoomId = { [mergeRoomId]: 'north', [blockerRoomId]: 'north' };

    const openings = pendingForeignMarginOpenings(
      seed, blockerRoomId, 1, 0, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
      layoutEdges, {},
    );

    // Cross-check: the REAL slot for shortcutSourceId's own edge into
    // mergeRoomId is index 0 of a 2-connection doorSlotsForFace call --
    // parentRoomIdsFor iterates Object.entries(layoutEdges) in insertion
    // order, and shortcutSourceId ('from-room') is this object literal's
    // own first key, so it's this target's own first real parent
    // (verified directly: `node -e` printing Object.entries(layoutEdges)
    // for this exact literal gives `from-room` before `blocker-room`).
    // blockerRoomId occupies index 1.
    const mergeRect = roomRect(seed, mergeRoomId, 2, 0);
    const realSlots = doorSlotsForFace(mergeRect, 2, 'north');
    const realSlotForShortcut = realSlots[0];
    const { foreignOpening } = buildEdgeCorridor(
      seed, shortcutSourceId, mergeRoomId, roomRect(seed, shortcutSourceId, 0, 0), mergeRect,
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, 'south', realSlotForShortcut, occupiedCells, 'north',
    );
    expect(foreignOpening).not.toBeNull();
    expect(openings.south).toEqual([{ offset: foreignOpening.offset, width: foreignOpening.width }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "real slot resolution"`
Expected: FAIL — the current code uses `doorSlotsForFace(targetRect, 1, targetIncomingFace)[0]` (a full-width slot) instead of the real half-width `realSlots[0]`, so `foreignOpening`'s own `offset`/`width` won't match.

- [ ] **Step 3: Fix `pendingForeignMarginOpenings`**

Replace the current `toSlot` line (`const toSlot = doorSlotsForFace(targetRect, 1, targetIncomingFace)[0];`) with:

```js
      const targetConnections = incomingConnectionsFor(layoutEdges ?? edges, childId, hiddenIncomingByRoomId);
      const slotIndex = targetConnections.findIndex((c) => !c.hidden && c.sourceId === sourceId);
      // A real parent not found among its own target's real connections
      // would be a graph-consistency bug elsewhere (childIds and
      // parentRoomIdsFor disagreeing) -- fall back to a single full-width
      // slot rather than crash, matching this function's own existing
      // defensive style (the `if (!sourcePos) continue`/`if (!targetPos)
      // return` guards just above).
      const toSlot = slotIndex >= 0
        ? doorSlotsForFace(targetRect, targetConnections.length, targetIncomingFace)[slotIndex]
        : doorSlotsForFace(targetRect, 1, targetIncomingFace)[0];
```

Update the function's own signature to `export function pendingForeignMarginOpenings(seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells, layoutEdges, hiddenIncomingByRoomId = {}) {` and add `incomingConnectionsFor` to whatever this function already has in scope (it's defined earlier in the same file, no import needed).

- [ ] **Step 4: Update the call site in `scripts/dungeon-scene.mjs`**

Find `pendingForeignMarginOpenings(` inside `buildRoomAtGraphNode` (`scripts/dungeon-scene.mjs`). Add `edges` (or `layoutEdges`, whichever this call site already has in scope — check `buildRoomAtGraphNode`'s own parameter list; if it only has `edges` today, this task also needs `buildRoomAtGraphNode` to accept a new `layoutEdges`/`hiddenIncomingByRoomId` option, threaded from `buildPopulateAndUnlockGraphNode`'s own call into it, which already has `state.layoutEdges`/`state.hiddenIncomingByRoomId` available) as the two new trailing arguments.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "pendingForeignMarginOpenings"`
Expected: PASS, both the new Round 2 test and every existing Round 1 test for this function (which use a single-connection graph and must still get slot 0 of a 1-slot call — the fix must be a strict generalization, not a behavior change for the single-connection case).

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs
git commit -m "fix(#297): resolve the real per-connection door slot in pendingForeignMarginOpenings instead of assuming a single connection"
```

---

### Task 3: Co-parent collision detection

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (new exported function, placed near `pendingForeignMarginOpenings`)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findCoParentCollision(candidateForeignOpening, incomingConnections)` — a new exported pure function. `candidateForeignOpening` is a `buildEdgeCorridor` result's own `foreignOpening` field (`{roomId, side, offset, width} | null`). `incomingConnections` is the SAME list `incomingConnectionsFor` returns for the room currently being built (`{sourceId, hidden}[]`). Returns the matching connection's own list index (an integer, `>= 0`) if `candidateForeignOpening` is non-null AND its `roomId` matches a REAL (non-hidden) connection's own `sourceId` in the list; returns `-1` otherwise (no collision, or the match is a hidden connection — Review Focus item 5).

- [ ] **Step 1: Write the failing tests**

```js
describe('findCoParentCollision — #297 Round 2', () => {
  it('finds the matching real connection index when the blocker is a co-parent', () => {
    const incomingConnections = [
      { sourceId: 'blocker-room', hidden: false },
      { sourceId: 'from-room', hidden: false },
    ];
    const foreignOpening = { roomId: 'blocker-room', side: 'south', offset: 5, width: 2 };
    expect(findCoParentCollision(foreignOpening, incomingConnections)).toBe(0);
  });

  it('returns -1 when there is no blocker', () => {
    const incomingConnections = [{ sourceId: 'from-room', hidden: false }];
    expect(findCoParentCollision(null, incomingConnections)).toBe(-1);
  });

  it('returns -1 when the blocker is unrelated to this target (Round 1\'s own unrelated-blocker case)', () => {
    const incomingConnections = [{ sourceId: 'from-room', hidden: false }];
    const foreignOpening = { roomId: 'some-unrelated-room', side: 'south', offset: 5, width: 2 };
    expect(findCoParentCollision(foreignOpening, incomingConnections)).toBe(-1);
  });

  it('returns -1 when the matching connection is HIDDEN, not a real co-parent (Review Focus item 5)', () => {
    const incomingConnections = [
      { sourceId: 'detour-room', hidden: true },
      { sourceId: 'from-room', hidden: false },
    ];
    const foreignOpening = { roomId: 'detour-room', side: 'south', offset: 5, width: 2 };
    expect(findCoParentCollision(foreignOpening, incomingConnections)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "findCoParentCollision"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement**

```js
/**
 * Whether a connection's own candidate corridor's `foreignOpening` (a
 * #297 Round 1 dogleg trigger) points at ANOTHER of the same target
 * room's own real parents -- the #297 Round 2 collision this file's own
 * spec calls out: the blocking room turns out to be the target's own
 * co-parent, whose own corridor already occupies the space Round 1's own
 * dogleg would draw new geometry through. Returns that co-parent's own
 * index in `incomingConnections` (so the caller can look up its own
 * already-computed pass-1 result), or -1 for "no collision, use the
 * candidate's own geometry unchanged" -- covers both "no dogleg at all"
 * and "dogleg fired, but the blocker is genuinely unrelated" (Round 1's
 * own original, still-valid case).
 *
 * A HIDDEN connection's own sourceId is never treated as a co-parent to
 * ride along, even if it happens to match `roomId` -- its own corridor
 * may not be safely reusable (its own door stays sealed/unrevealed until
 * a later game-state event, not simply "already built"), and the whole
 * point of Round 1's own dungeonHiddenDoorForEdge/dungeonDoorFromRoomId
 * split is that a hidden connection's own geometry is handled by a
 * completely separate mechanism this file does not touch.
 */
export function findCoParentCollision(candidateForeignOpening, incomingConnections) {
  if (!candidateForeignOpening) return -1;
  return incomingConnections.findIndex(
    (c) => !c.hidden && c.sourceId === candidateForeignOpening.roomId,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "findCoParentCollision"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat(#297): detect when a dogleg's own blocker is the target's own co-parent"
```

---

### Task 4: Slot-priority collision detection and assignment

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (two new exported functions, placed near `findCoParentCollision`)
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`'s own single line building `slots` — currently ~line 1149, confirm via `grep -n "const slots = incomingConnections.length"`)
- Test: `tests/dungeon-layout.test.mjs`, `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `findCoParentCollision` (already merged, Task 3) — reused verbatim (not re-derived) to confirm a blocking room is genuinely one of the target's own real parents.
- Produces: `findPriorityCollision(seed, roomId, rank, col, incomingConnections, layoutPositionByRoomId, occupiedCells)` → `{ collidingIndex, axis, blockerId, blockRank, blockCol } | null` (pure, no `buildEdgeCorridor` call — this is what makes single-pass detection possible, unlike the abandoned ride-along design). `assignDoorSlotsWithPriority(seed, rect, incomingConnections, incomingFace, collision)` → the same shape `doorSlotsForFace(rect, incomingConnections.length, incomingFace)` already returns (an array, one slot per connection, same order as `incomingConnections`), but with the colliding connection's own entry reassigned per the collision (or unchanged, byte-identical to `doorSlotsForFace`'s own direct output, when `collision` is `null`).

- [ ] **Step 1: Write the failing tests for `findPriorityCollision`**

```js
describe('findPriorityCollision — #297 Round 2 (slot priority)', () => {
  it('finds the priority collision for the pinned dogleg scenario', () => {
    const seed = 'dogleg-repro-seed-0'; // reuses Task 2's own pinned seed/graph
    const shortcutSourceId = 'from-room';
    const blockerRoomId = 'blocker-room';
    const mergeRoomId = 'to-room';
    const layoutPositionByRoomId = {
      [shortcutSourceId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [mergeRoomId]: { rank: 2, col: 0 },
    };
    const occupiedCells = { '0,0': shortcutSourceId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    // Real parent order for mergeRoomId matches Object.entries(layoutEdges)'s
    // own insertion order from Task 2's own pinned scenario: shortcutSourceId
    // first (index 0), blockerRoomId second (index 1) -- verified via
    // `node -e` in Task 2's own report, reused here directly.
    const incomingConnections = [
      { sourceId: shortcutSourceId, hidden: false },
      { sourceId: blockerRoomId, hidden: false },
    ];
    const collision = findPriorityCollision(
      seed, mergeRoomId, 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells,
    );
    expect(collision).not.toBeNull();
    expect(collision.collidingIndex).toBe(0);
    expect(collision.axis).toBe('south');
    expect(collision.blockerId).toBe(blockerRoomId);
    expect(collision.blockRank).toBe(1);
    expect(collision.blockCol).toBe(0);
  });

  it('returns null when the intermediate cell is unoccupied (no dogleg needed at all)', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = { a: { rank: 0, col: 0 }, b: { rank: 2, col: 0 } };
    const occupiedCells = { '0,0': 'a', '2,0': 'b' };
    const incomingConnections = [{ sourceId: 'a', hidden: false }];
    expect(findPriorityCollision(seed, 'b', 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells)).toBeNull();
  });

  it('returns null when the intermediate occupant is NOT one of this target\'s own real parents (Round 1\'s own unrelated-blocker case)', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = { a: { rank: 0, col: 0 }, unrelated: { rank: 1, col: 0 }, b: { rank: 2, col: 0 } };
    const occupiedCells = { '0,0': 'a', '1,0': 'unrelated', '2,0': 'b' };
    // 'unrelated' is not in incomingConnections at all -- not a parent of 'b'.
    const incomingConnections = [{ sourceId: 'a', hidden: false }];
    expect(findPriorityCollision(seed, 'b', 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells)).toBeNull();
  });

  it('ignores a HIDDEN connection as the colliding edge (Review Focus item 5)', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = { hiddenSource: { rank: 0, col: 0 }, blocker: { rank: 1, col: 0 }, target: { rank: 2, col: 0 } };
    const occupiedCells = { '0,0': 'hiddenSource', '1,0': 'blocker', '2,0': 'target' };
    const incomingConnections = [
      { sourceId: 'hiddenSource', hidden: true },
      { sourceId: 'blocker', hidden: false },
    ];
    expect(findPriorityCollision(seed, 'target', 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "findPriorityCollision"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `findPriorityCollision`**

```js
/**
 * #297 Round 2 (revised after the "ride-along" design in this file's own
 * earlier docblocks was found geometrically unsound): detects whether ANY
 * of `roomId`'s own real incoming connections is blocked, on its own
 * null-path fast-path fallback (Round 1's own dogleg trigger condition --
 * 2 ranks/columns apart, same column/row), by a cell occupied by ANOTHER
 * of `roomId`'s own real parents. Unlike the abandoned ride-along design,
 * this needs NO `buildEdgeCorridor` call -- the detection is purely
 * geometric (room positions, `occupiedCells`), so it can run BEFORE any
 * connection's own door slot or corridor is built, in a single pass.
 *
 * Reuses `findCoParentCollision` (unchanged, already merged) to confirm
 * the blocking room is genuinely one of `roomId`'s own real parents, by
 * passing it a synthetic `{roomId: blockerId}` -- that function only ever
 * reads `.roomId` off its own first argument, so this is a legitimate
 * reuse of its own already-tested hidden-connection guard, not a hack.
 *
 * Returns the FIRST such collision found (scope: exactly one, per this
 * feature's own spec) or `null`.
 */
export function findPriorityCollision(seed, roomId, rank, col, incomingConnections, layoutPositionByRoomId, occupiedCells) {
  for (let i = 0; i < incomingConnections.length; i += 1) {
    const { sourceId, hidden } = incomingConnections[i];
    if (hidden) continue;
    const sourcePos = layoutPositionByRoomId[sourceId];
    if (!sourcePos) continue;
    let blockerId = null;
    let axis = null;
    let blockRank = null;
    let blockCol = null;
    if (sourcePos.col === col && rank === sourcePos.rank + 2) {
      blockRank = sourcePos.rank + 1;
      blockCol = col;
      blockerId = occupiedCells[`${blockRank},${blockCol}`];
      axis = 'south';
    } else if (sourcePos.rank === rank && col === sourcePos.col + 2) {
      blockRank = rank;
      blockCol = sourcePos.col + 1;
      blockerId = occupiedCells[`${blockRank},${blockCol}`];
      axis = 'east';
    }
    if (blockerId == null || blockerId === sourceId || blockerId === roomId) continue;
    if (findCoParentCollision({ roomId: blockerId }, incomingConnections) < 0) continue;
    return { collidingIndex: i, axis, blockerId, blockRank, blockCol };
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "findPriorityCollision"`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for `assignDoorSlotsWithPriority`**

```js
describe('assignDoorSlotsWithPriority — #297 Round 2', () => {
  it('assigns the colliding connection the slot nearest the blocker\'s own east edge, for the pinned scenario', () => {
    const seed = 'dogleg-repro-seed-0';
    const mergeRect = roomRect(seed, 'to-room', 2, 0);
    const incomingConnections = [
      { sourceId: 'from-room', hidden: false },
      { sourceId: 'blocker-room', hidden: false },
    ];
    const collision = { collidingIndex: 0, axis: 'south', blockerId: 'blocker-room', blockRank: 1, blockCol: 0 };
    const slots = assignDoorSlotsWithPriority(seed, mergeRect, incomingConnections, 'north', collision);
    const blockerRect = roomRect(seed, 'blocker-room', 1, 0);
    const edgeX = blockerRect.gx + blockerRect.gw;
    // The colliding connection's own slot must contain, or lie entirely
    // east of, the blocker's own east edge -- the real property, not a
    // hardcoded expectation, so this test still pins the fix if the
    // pinned seed's own room sizes ever change.
    expect(slots[0].x1).toBeGreaterThanOrEqual(Math.min(edgeX, mergeRect.gx));
    expect(slots[0].x1 <= edgeX && slots[0].x2 >= edgeX || slots[0].x1 >= edgeX).toBe(true);
    // The co-parent's own slot must lie entirely at-or-west of the
    // blocker's own east edge (never reaching into the dogleg's own lane).
    expect(slots[1].x2).toBeLessThanOrEqual(edgeX);
    // Every connection still gets exactly one, distinct slot (Review Focus
    // item 2) -- no duplication, no dropped connection.
    expect(slots).toHaveLength(2);
    expect(slots[0]).not.toEqual(slots[1]);
  });

  it('returns list-order slots, unchanged, when there is no collision (Review Focus item 4)', () => {
    const seed = 'dogleg-repro-seed-0';
    const rect = roomRect(seed, 'to-room', 2, 0);
    const incomingConnections = [{ sourceId: 'a', hidden: false }, { sourceId: 'b', hidden: false }];
    const plain = doorSlotsForFace(rect, 2, 'north');
    const result = assignDoorSlotsWithPriority(seed, rect, incomingConnections, 'north', null);
    expect(result).toEqual(plain);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "assignDoorSlotsWithPriority"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 7: Implement `assignDoorSlotsWithPriority`**

```js
/**
 * #297 Round 2: the real per-connection slot list (`doorSlotsForFace`'s
 * own output, unchanged), with the colliding connection's own entry
 * (per `findPriorityCollision`) reassigned to whichever slot already
 * contains -- or sits nearest east/south of, when the blocking room's
 * own margin edge falls past every slot (the documented residual: a
 * LARGE blocker with a SMALL target) -- the blocking room's own far
 * margin edge. Every other connection keeps its own original relative
 * order across the remaining slots. When `collision` is `null`, returns
 * `doorSlotsForFace`'s own direct output, byte-identical to today.
 */
export function assignDoorSlotsWithPriority(seed, rect, incomingConnections, incomingFace, collision) {
  const slots = incomingConnections.length
    ? doorSlotsForFace(rect, incomingConnections.length, incomingFace)
    : [];
  if (!collision) return slots;
  const blockerRect = roomRect(seed, collision.blockerId, collision.blockRank, collision.blockCol);
  const edgeCoord = collision.axis === 'south'
    ? blockerRect.gx + blockerRect.gw
    : blockerRect.gy + blockerRect.gh;
  let priorityIndex = slots.findIndex((s) => {
    const end = collision.axis === 'south' ? s.x2 : s.y2;
    return edgeCoord < end;
  });
  if (priorityIndex < 0) priorityIndex = slots.length - 1;
  const remaining = slots.filter((_, idx) => idx !== priorityIndex);
  const assignment = new Array(incomingConnections.length);
  assignment[collision.collidingIndex] = slots[priorityIndex];
  let r = 0;
  for (let i = 0; i < incomingConnections.length; i += 1) {
    if (i === collision.collidingIndex) continue;
    assignment[i] = remaining[r];
    r += 1;
  }
  return assignment;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "assignDoorSlotsWithPriority"`
Expected: PASS.

- [ ] **Step 9: Wire into `buildPopulateAndUnlockGraphNode`**

Read `buildPopulateAndUnlockGraphNode` (`scripts/dungeon-scene.mjs`) in full first, to confirm the exact current line. Replace the single existing line:

```js
const slots = incomingConnections.length ? doorSlotsForFace(rect, incomingConnections.length, incomingFace) : [];
```

with:

```js
// #297 Round 2: assign door slots with priority for a colliding
// connection, so Round 1's own already-proven dogleg never needs to
// widen toward a co-parent's own slot -- see this room's own spec
// ("Round 2 correction: slot priority") for the full reasoning. Every
// OTHER connection's own slot, and Round 1's own buildEdgeCorridor call
// below (unchanged), are completely unaffected.
const priorityCollision = findPriorityCollision(
  state.seed, room.id, rank, col, incomingConnections, state.layoutPositionByRoomId, occupiedCells,
);
const slots = assignDoorSlotsWithPriority(state.seed, rect, incomingConnections, incomingFace, priorityCollision);
```

**Nothing else in the loop changes** — every line below this (deriving `sourceRect`/`exitFaceFromSource`, calling `buildEdgeCorridor(..., toSlot, ...)`, building `wallDoc`s, pushing tiles) stays exactly as it is today, since `slots[i]` is still what `toSlot` reads from — only *which* slot object sits at which index changed.

- [ ] **Step 10: Write the scene-level end-to-end test**

Add to `tests/dungeon-scene.test.mjs` (follow the existing `buildRoomAtGraphNode`-level test's own scaffolding pattern in that file, per Round 1's own Task 4 precedent — read it first): a test building the merge room itself through `buildPopulateAndUnlockGraphNode`, using the pinned collision scenario (`dogleg-repro-seed-0`, `from-room`/`blocker-room`/`to-room`), asserting: both connections' own doors exist with distinct `dungeonDoorFromRoomId` flags; neither connection's own `dungeonRevealDoorForSlot` wall is covered by the other's `plainWalls` (the real property Round 1's own final review found violated); and a second, non-colliding 2-parent scenario produces Wall/Tile output identical to calling `doorSlotsForFace` directly (Review Focus item 4 — the common case must be provably unaffected).

- [ ] **Step 11: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "buildPopulateAndUnlockGraphNode"`
Expected: PASS.

- [ ] **Step 12: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs tests/dungeon-scene.test.mjs
git commit -m "feat(#297): slot-priority collision detection and assignment, replacing the abandoned ride-along design"
```

---

### Task 5: Regression test for the live repro (real graph) + system-wide sweep with real slots, residual measured

**Files:**
- Modify: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the dedicated regression test using the REAL live graph shape**

Unlike Round 1's own Task 5 (which used a single-connection graph and therefore never actually exercised the co-parent case at all, despite the live repro's own real merge room genuinely having 2 real parents), this test must reconstruct the live-reported seed's own FULL real graph: source `room-room-entry-0` (rank 1, col 0) with children `[room-room-room-entry-0-0 (merge room, rank 3), room-room-room-entry-0-1 (blocker, rank 2)]`, AND the merge room's own second real parent, `room-detour-0`. Since the merge room's real co-parent (`room-detour-0`, at position `(2,2)` per this session's own earlier live investigation) is NOT the blocker (`room-room-room-entry-0-1`) in the ORIGINAL live report — construct this test to confirm Round 1's own dogleg (still kept, unmodified) still correctly handles this exact original scenario (an unrelated blocker, not a co-parent — `findPriorityCollision` must return `null` for it, since `room-room-room-entry-0-1` is not one of the merge room's own real parents). Construct a SEPARATE regression scenario (Task 4's own already-pinned `dogleg-repro-seed-0`/`from-room`/`blocker-room`/`to-room` graph, the actual co-parent-collision shape) confirming the slot-priority mechanism resolves it: both connections' own doors exist, neither's own walls collide with the other's, and the colliding connection still uses Round 1's own unmodified dogleg geometry (only its own target slot differs from a naive `doorSlotsForFace` assignment). Both scenarios are real #297 shapes; neither alone is the "whole" regression suite.

- [ ] **Step 2: Run both to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "#297"`
Expected: PASS.

- [ ] **Step 3: Write the system-wide sweep with real per-connection slots, measuring the LARGE-blocker/SMALL-target residual explicitly**

Reuse Round 1's own #297 sweep harness (`tests/dungeon-layout.test.mjs`, search for it) but rebuild its own graph/slot construction to use `incomingConnectionsFor` + `assignDoorSlotsWithPriority` (Task 4) throughout (not the single-slot assumption the final review found hidden every Round 1 defect, and not plain `doorSlotsForFace` either — the sweep must exercise the real priority-assignment path). Assert, across the corpus: zero corridor/footprint overlap (Round 1's own property, unchanged) AND zero cross-connection wall collisions (no connection's own `plainWalls` collinear with another connection's own `doorWall`/`revealDoorWall` into the same target) for every case where the blocking room's own width is `<=` the target room's own width. Separately count and report, via `console.log`, the rate of the documented residual (blocking room LARGE, target room SMALL — where `assignDoorSlotsWithPriority`'s own `priorityIndex` fallback to `slots.length - 1` cannot fully contain the blocker's own margin edge within a single slot): do not assert this residual is zero, measure it and print it, matching this file's own established convention of reporting real rates rather than assuming them away.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Note both measured rates (collision-resolved rate for `<=`-width cases, and the LARGE/SMALL residual rate) in the commit message. If the residual rate is non-zero, that is expected and documented in the spec — do not soften the assertion to hide it; if the `<=`-width case shows ANY non-zero overlap/collision rate, treat it as DONE_WITH_CONCERNS, the same discipline Round 1's own Task 5 used when it found the original 8.79% regression.

- [ ] **Step 5: Commit**

```bash
git add tests/dungeon-layout.test.mjs
git commit -m "test(#297): regression test for the live repro's real graph + system-wide sweep with slot priority, residual measured"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Check `origin/main`'s current version before bumping**

Run: `git fetch origin main` then check `git show origin/main:module.json | grep version`. If it has advanced past this branch's own current `0.51.0`, bump past that version instead.

- [ ] **Step 2: Bump `module.json`**

Change `"version": "0.51.0"` to `"version": "0.52.0"` (or higher, per Step 1) — a minor bump, since this is an architecture-level change (a new cross-connection door-slot-priority mechanism), not a routine fix.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#297): bump version to 0.52.0"
```
