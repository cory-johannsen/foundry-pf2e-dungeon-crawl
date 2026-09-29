# Merge-Room Co-Parent Gate-Sharing (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the connectivity regression the Round 1 final review found: when a merge room's second-parent edge's own null-path dogleg (Round 1, already merged) is blocked by a room that turns out to be the target's own co-parent, stop drawing new dogleg geometry through the co-parent's own corridor space — instead reuse that co-parent's own already-built corridor for the shared stretch and branch to a separate door only at the very end.

**Architecture:** `buildPopulateAndUnlockGraphNode`'s incoming-connections loop splits into two passes: pass 1 computes every connection's own candidate corridor exactly as today (unchanged `buildEdgeCorridor` call, including Round 1's own dogleg); pass 2 detects a co-parent collision (a candidate's own `foreignOpening.roomId` matching another real parent's own `sourceId` in the same room's incoming-connections list) and, when found, replaces that candidate's geometry with a "ride-along" corridor: a short approach segment (reusing a helper extracted from Round 1's own dogleg turn-1 construction) that converges on the co-parent's own real corridor position instead of an arbitrary margin edge, followed by the co-parent's own corridor segments/walls reused verbatim, followed by one short new branch segment to the candidate's own separate door.

**Tech Stack:** Vanilla JS (ESM), Vitest, Foundry VTT v13/v14 module (`pf2e-dungeon-crawl`).

**Spec:** `docs/superpowers/specs/2026-09-29-merge-room-gate-share-design.md` (the "Round 2: co-parent collision" section, and its amended Testing/Success criteria — Round 1's own sections above it describe the already-merged dogleg, kept unmodified except for the Task 1 refactor below).

## Global Constraints

- Round 1's own dogleg logic in `buildEdgeCorridor` (south/east branches, `scripts/dungeon-layout.mjs`) keeps its exact behavior for the genuinely-unrelated-blocker case. Task 1's refactor must be behavior-preserving (verified by the existing Round 1 test suite staying green, byte-identical output) — it extracts shared code, it does not change what that code computes.
- **Every task's own tests must use a graph where the relevant room has 2+ real incoming connections**, with slots resolved via `incomingConnectionsFor` + `doorSlotsForFace(rect, incomingConnections.length, face)[i]` — never a hand-built single-slot `doorSlotsForFace(rect, 1, face)[0]`. This is the single most important lesson from Round 1's own final review: every Round 1 test used a single-connection graph, which is exactly the configuration that hid all three of that review's Critical findings. A task whose own tests use a single-connection graph has not actually exercised this plan's own subject matter.
- Doors and flags are unchanged: `dungeonDoorToRoomId`/`dungeonDoorFromRoomId` (or `dungeonHiddenDoorForEdge` for a hidden connection), `unlockDoorsFromRoom`, `handleDungeonDoorOpened` all keep working exactly as today. Only a colliding connection's own *corridor geometry* changes.
- The co-parent is always exactly one rank/column below the blocking cell relative to the second-parent's own source (`toPos.rank === fromPos.rank + 2` south / `toPos.col === fromPos.col + 2` east, Round 1's own scoped detection) — meaning the co-parent's own edge to the SAME target is necessarily rank+1/col+1 apart (directly adjacent). The co-parent's own corridor is therefore expected to take `buildEdgeCorridor`'s simple adjacent (`path.length <= 2`) branch, not a dogleg itself — verify this as an explicit assertion in Task 4/5's own tests, not an unchecked assumption.
- Scope: exactly one co-parent colliding with exactly one second-parent edge. Three-or-more real parents colliding at the same cell, and a co-parent whose own connection also needs Round 1's dogleg, are explicitly out of scope — leave undetected (falls through to Round 1's own existing, already-broken-for-this-case behavior) and document as residuals in the final task's own commit message, per this file's own established "measure and document" pattern.
- Version bump: this branch is currently at `0.51.0`. Check `origin/main`'s own current version before the final bump (same recovery Round 1's own Task 6 used) — bump past it, minor bump (architecture-level change).

## Review Focus

1. **The ride-along corridor's own approach segment must actually converge on the co-parent's real corridor position**, not an approximation — a test asserting "no overlap with the co-parent's rect" is not enough; the specific point of convergence (where the approach segment's own floor meets the co-parent's own floor) must be verified to actually align, both in the target's own overlap axis and in the perpendicular axis, or the two floors won't visually/functionally connect (this is exactly Round 1's own Critical-1 shape — a "connectivity" bug that a "no overlap" test alone doesn't catch).
2. **The branch segment near the target must not re-seal the co-parent's own door** — the entire point of this redesign is that the co-parent's own door stays open; a test must assert the co-parent's own `revealDoorWall` is not collinear with or covered by any wall the candidate's own branch segment introduces.
3. **`pendingForeignMarginOpenings`'s slot-count fix must be tested against a real multi-parent target**, not just a single-connection scenario that happens to also pass with the wrong assumption (count=1 and count=2-with-index-0 can coincidentally agree for some geometries) — the test must use a scenario where the real slot and the assumed slot-0-of-1 genuinely differ, so the fix is actually pinned.
4. **The two-pass restructuring must not change behavior for the overwhelmingly common case** (a room with exactly one real incoming connection, or two real connections that don't collide) — a test asserting byte-identical wall/tile output to Round 1's own single-pass behavior for a non-colliding multi-parent room is needed, not just for the colliding case.
5. **Hidden connections must not be mistaken for co-parents.** A hidden connection's own `sourceId` (a shortcut's hidden extra, or a detour's own real parent link marked hidden) must never be treated as a "co-parent to ride along" — only a REAL (non-hidden) parent's own corridor is safe to reuse, since a hidden connection's own door stays sealed/unrevealed and its corridor may not even be built yet in the order this plan's own detection runs. A test with a hidden connection present alongside a real one, where the hidden one happens to be positioned at what would otherwise look like a blocking cell, must confirm it's correctly ignored by the detection logic.

---

### Task 1: Extract the shared margin-band approach helper

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (the `exitFace === 'south' && sameColumn` and `exitFace === 'east' && sameRank` branches of `buildEdgeCorridor` — find via `grep -n "exitFace === 'south' && sameColumn\|exitFace === 'east' && sameRank"`)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new — this task only reorganizes existing code.
- Produces: a new exported pure function, `marginBandApproach(doorX0, doorX1, faceY, targetLaneX0, targetLaneWidth)` (south-axis version — see Step 3 for the exact signature and the east-axis mirror, `marginBandApproachY`), returning `{ turnGx, turnGx2, turnBottom, turnSegment, turnWalls }` where `turnSegment` is the turn-1 floor box and `turnWalls` is the array of containment walls for that turn (the caps at `turnBottom`, mirroring what Round 1's own dogleg already builds). Round 1's own dogleg logic in `buildEdgeCorridor` calls this new function instead of duplicating the jog math inline; Task 4/5's own new ride-along function also calls it, with a different `targetLaneX0`.

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

### Task 4: Ride-along corridor geometry (south branch)

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (new exported function, placed near `buildEdgeCorridor`)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `marginBandApproach` (Task 1), the same `{doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells, foreignOpening}` shape `buildEdgeCorridor` already returns (for both the candidate's own naive pass-1 result and the co-parent's own pass-1 result).
- Produces: `buildRideAlongCorridorSouth(candidateNaive, candidateDoorSlot, coParentResult)` — a new exported pure function returning the SAME `{doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells}` shape, to be used in place of `candidateNaive` when Task 3's own `findCoParentCollision` finds a match. `candidateNaive` is the colliding connection's own pass-1 `buildEdgeCorridor` result (its `doorWall` — the real, unmovable source door — is reused verbatim; its own dogleg-specific fields are discarded). `candidateDoorSlot` is the colliding connection's own `toSlot` (its OWN separate door slot into the target, from `doorSlotsForFace`, unrelated to the co-parent's own slot). `coParentResult` is the co-parent's own pass-1 `buildEdgeCorridor` result (its `corridorSegments`/`plainWalls` are reused verbatim for the shared stretch; its own `doorWall`/`revealDoorWall` are NOT reused — the candidate needs its own separate door).

- [ ] **Step 1: Write the failing test**

This test needs a concrete scenario where a real seed produces: (a) a shortcut edge whose own naive dogleg is blocked by a co-parent, and (b) that co-parent's own edge to the same target is a simple adjacent (non-dogleg) corridor. Reuse Task 2's own pinned scenario (seed `dogleg-repro-seed-0`, `shortcutSourceId='from-room'` at rank 0, `blockerRoomId='blocker-room'` at rank 1 (co-parent), `mergeRoomId='to-room'` at rank 2) — Task 2's own test already established `blockerRoomId` is a real parent of `mergeRoomId` and that `shortcutSourceId`'s own edge triggers a Round 1 dogleg blocked by `blockerRoomId`.

```js
describe('buildRideAlongCorridorSouth — #297 Round 2', () => {
  it('reuses the co-parent\'s own corridor and reaches its own separate door, without covering the co-parent\'s own door', () => {
    const seed = 'dogleg-repro-seed-0';
    const shortcutSourceId = 'from-room';
    const blockerRoomId = 'blocker-room';
    const mergeRoomId = 'to-room';
    const shortcutPos = { rank: 0, col: 0 };
    const blockerPos = { rank: 1, col: 0 };
    const mergePos = { rank: 2, col: 0 };
    const layoutEdges = {
      [shortcutSourceId]: [mergeRoomId, blockerRoomId],
      [blockerRoomId]: [mergeRoomId],
    };
    const occupiedCells = { '0,0': shortcutSourceId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    const mergeRect = roomRect(seed, mergeRoomId, mergePos.rank, mergePos.col);
    const realSlots = doorSlotsForFace(mergeRect, 2, 'north');
    // Real parent order matches Object.entries(layoutEdges)'s own
    // insertion order — shortcutSourceId ('from-room') is this literal's
    // first key (verified via `node -e` printing Object.entries for this
    // exact object), so it's mergeRoomId's own first real parent (index
    // 0); blockerRoomId is index 1.
    const shortcutSlot = realSlots[0];
    const coParentSlot = realSlots[1];

    const shortcutRect = roomRect(seed, shortcutSourceId, shortcutPos.rank, shortcutPos.col);
    const blockerRect = roomRect(seed, blockerRoomId, blockerPos.rank, blockerPos.col);

    const coParentResult = buildEdgeCorridor(
      seed, blockerRoomId, mergeRoomId, blockerRect, mergeRect, blockerPos, mergePos,
      'south', coParentSlot, occupiedCells, 'north',
    );
    // Invariant (Global Constraints): the co-parent is always directly
    // adjacent to the target, so its own corridor must NOT itself be a
    // dogleg.
    expect(coParentResult.foreignOpening).toBeNull();
    expect(coParentResult.corridorSegments).toHaveLength(1);

    const candidateNaive = buildEdgeCorridor(
      seed, shortcutSourceId, mergeRoomId, shortcutRect, mergeRect, shortcutPos, mergePos,
      'south', shortcutSlot, occupiedCells, 'north',
    );
    expect(candidateNaive.foreignOpening).not.toBeNull();
    expect(candidateNaive.foreignOpening.roomId).toBe(blockerRoomId);

    const result = buildRideAlongCorridorSouth(candidateNaive, shortcutSlot, coParentResult);

    // No segment overlaps the blocking (co-parent) room's own footprint --
    // Round 1's own core property, still required.
    for (const seg of result.corridorSegments) {
      const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
      const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }
    // Connectivity (Review Focus item 1): the result's own final segment
    // must reach its own revealDoorWall.
    const lastSeg = result.corridorSegments[result.corridorSegments.length - 1];
    expect(lastSeg.gx).toBeLessThanOrEqual(result.revealDoorWall.x1);
    expect(lastSeg.gx + lastSeg.gw).toBeGreaterThanOrEqual(result.revealDoorWall.x2);
    // The candidate's own door is its OWN slot, not the co-parent's.
    expect(result.revealDoorWall.x1).toBeGreaterThanOrEqual(shortcutSlot.x1);
    expect(result.revealDoorWall.x2).toBeLessThanOrEqual(shortcutSlot.x2);
    // Review Focus item 2: the co-parent's own door must stay uncovered --
    // no wall in `result.plainWalls` may be collinear with (same y, and
    // an x-range that intersects) the co-parent's own revealDoorWall.
    const coParentDoor = coParentResult.revealDoorWall;
    const collides = result.plainWalls.some(
      (w) => w.y1 === w.y2 && w.y1 === coParentDoor.y1
        && Math.min(w.x1, w.x2) < coParentDoor.x2 && Math.max(w.x1, w.x2) > coParentDoor.x1,
    );
    expect(collides).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildRideAlongCorridorSouth"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement**

```js
/**
 * #297 Round 2: replaces a colliding connection's own naive dogleg
 * (Round 1) with a corridor that rides along its own co-parent's ALREADY
 * -BUILT corridor for the shared stretch, instead of drawing new geometry
 * through the same space -- the co-parent's own corridor, already
 * independently reviewed and verified sound in isolation, already
 * occupies and contains that space correctly, so there is no second,
 * independent geometry computation for the shared span that could
 * disagree with the first (this file's own recurring "two things must
 * agree" lesson, resolved here by NOT computing a second thing at all).
 *
 * `candidateNaive` is the colliding connection's own pass-1
 * `buildEdgeCorridor` result -- only its own real, unmovable `doorWall`
 * (the source's own door, seeded independently of any of this) is reused;
 * everything else about its own naive dogleg geometry is discarded.
 * `coParentResult` is the co-parent's own pass-1 result, assumed (per
 * this plan's own Global Constraints) to be a simple adjacent corridor,
 * i.e. `coParentResult.corridorSegments.length === 1` and
 * `coParentResult.foreignOpening === null` -- NOT verified defensively
 * here (a violated invariant is a residual per this plan's own documented
 * scope, not a runtime error condition this function needs to handle).
 */
export function buildRideAlongCorridorSouth(candidateNaive, candidateDoorSlot, coParentResult) {
  const doorWall = candidateNaive.doorWall;
  const doorX0 = doorWall.x1;
  const doorX1 = doorWall.x2;
  const faceY = doorWall.y1;

  const coParentSeg = coParentResult.corridorSegments[0];
  const laneX0 = coParentSeg.gx;
  const laneWidth = coParentSeg.gw;
  // The co-parent's own revealDoorWall sits exactly at the TARGET's own
  // face (the same convention every non-dogleg corridor in this file
  // already uses: `corridorEndY = toRect.gy`) -- reading it back here
  // means this function never re-derives the target's own position
  // independently.
  const corridorEndY = coParentResult.revealDoorWall.y1;

  const { turnSegment, turnWalls, turnBottom } = marginBandApproach(doorX0, doorX1, faceY, laneX0, laneWidth);

  // The branch (the lateral jog to the candidate's OWN door) occupies the
  // LAST DOOR_WIDTH-deep strip before the target's own face -- mirroring
  // how turn 1 occupies the FIRST DOOR_WIDTH-deep strip after the
  // source's own face. Every corridor segment in this file has its own
  // far edge land exactly on corridorEndY (see any non-dogleg branch's
  // own `corridorSegments`), so the branch's own `gy` must be
  // `corridorEndY - DOOR_WIDTH`, never `corridorEndY` itself -- a segment
  // AT `corridorEndY` would sit one unit INSIDE the target room's own
  // footprint, not in the corridor.
  const branchTop = corridorEndY - DOOR_WIDTH;

  // The bridge: a straight run, at the lane's own x (already converged-to
  // by turn 1 above), from turnBottom down to the branch's own top —
  // NOT down to the co-parent's own corridor's start (`coParentSeg.gy`,
  // which describes the CO-PARENT's own source's own margin depth, an
  // unrelated value). If turn 1's own bottom already reaches branchTop
  // (only possible in a degenerate, very-short-cell edge case; never
  // observed in this scope's own rank+2 geometry, where there are always
  // several units between them), there is nothing to bridge.
  const bridgeSegments = turnBottom < branchTop
    ? [{ gx: laneX0, gy: turnBottom, gw: laneWidth, gh: branchTop - turnBottom }]
    : [];
  const bridgeWalls = turnBottom < branchTop
    ? [
        { x1: laneX0, y1: turnBottom, x2: laneX0, y2: branchTop },
        { x1: laneX0 + laneWidth, y1: turnBottom, x2: laneX0 + laneWidth, y2: branchTop },
      ]
    : [];

  // The candidate's own door gap, clamped into its OWN slot -- same
  // formula every other branch in this file already uses
  // (`Math.min(Math.max(x, slot.x1), slot.x2 - DOOR_WIDTH)`); every real
  // slot `doorSlotsForFace` produces is always >= DOOR_WIDTH wide, so no
  // extra guard is needed here.
  const candidateGapX0 = Math.min(Math.max(laneX0, candidateDoorSlot.x1), candidateDoorSlot.x2 - DOOR_WIDTH);
  const candidateGapX1 = candidateGapX0 + DOOR_WIDTH;
  const branchGx0 = Math.min(laneX0, candidateGapX0);
  const branchGx1 = Math.max(laneX0 + laneWidth, candidateGapX1);
  const branchSegment = { gx: branchGx0, gy: branchTop, gw: branchGx1 - branchGx0, gh: DOOR_WIDTH };
  const branchWalls = [
    // Cap the branch's own top edge except where the lane continues down into it.
    { x1: branchGx0, y1: branchTop, x2: laneX0, y2: branchTop },
    { x1: laneX0 + laneWidth, y1: branchTop, x2: branchGx1, y2: branchTop },
    // Contain the branch's own left/right sides for its own depth (down
    // to corridorEndY, its own far edge — the target's own door is the
    // only opening left uncovered, per the "seal everything except the
    // declared opening" discipline every other wall in this file uses).
    { x1: branchGx0, y1: branchTop, x2: branchGx0, y2: corridorEndY },
    { x1: branchGx1, y1: branchTop, x2: branchGx1, y2: corridorEndY },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

  // The candidate's own reveal door sits at corridorEndY itself (the
  // target's own face), same as the co-parent's own and every other
  // corridor's own revealDoorWall in this file — NOT corridorEndY +
  // DOOR_WIDTH, which would place it one unit past the target's own face,
  // inside the target room.
  const revealDoorWall = { x1: candidateGapX0, y1: corridorEndY, x2: candidateGapX1, y2: corridorEndY };

  return {
    doorWall,
    revealDoorWall,
    // The co-parent's own doorWall/revealDoorWall/plainWalls are NOT
    // included here -- they belong to the co-parent's OWN connection,
    // already committed separately by pass 2's own loop; this function
    // returns only what the CANDIDATE's own connection newly needs.
    plainWalls: [...turnWalls, ...bridgeWalls, ...branchWalls],
    corridorSegments: [turnSegment, ...bridgeSegments, branchSegment],
    transitCells: [],
  };
}
```

**This is the most geometrically intricate function in this plan** — and this exact code already had one real bug caught and fixed during this plan's own preparation (the branch segment originally landed one unit inside the target room's own footprint, and the bridge referenced the wrong boundary). If your own test from Step 1 still fails in a way that suggests something else doesn't match the real pinned scenario, trust your own hand-trace of the real numbers over this step's own literal code — flag the discrepancy clearly in your report rather than silently adjusting values until the test passes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildRideAlongCorridorSouth"`
Expected: PASS.

- [ ] **Step 5: Self-verify full containment before moving on**

Write a throwaway script (delete after use) enumerating every segment in `result.corridorSegments` and every wall in `result.plainWalls` (plus `doorWall`/`revealDoorWall`) for this task's own pinned scenario, confirming every floor-segment edge not shared with an adjacent segment or a door opening has a matching wall. This is the exact check that took Round 1's own south-branch dogleg two review rounds to get right (a dead-end corridor, then two separate containment leaks) — do this yourself before requesting review, not after.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat(#297): ride-along corridor for a co-parent collision (south branch)"
```

---

### Task 5: Mirror the ride-along corridor for the east branch

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `marginBandApproachY` (Task 1).
- Produces: `buildRideAlongCorridorEast(candidateNaive, candidateDoorSlot, coParentResult)` — the exact axis-swap mirror of Task 4's own `buildRideAlongCorridorSouth`, following the same X↔Y swap table Round 1's own Task 3 (`docs/superpowers/plans/2026-09-29-merge-room-gate-share.md`, if still present, or the SDD ledger's own record of it) already established for the south/east dogleg mirror: `doorX0/X1 → doorY0/Y1`, `faceY → faceX`, `corridorEndY → corridorEndX`, `gx/gw → gy/gh` and vice versa.

- [ ] **Step 1: Read Task 4's own final committed code in full first**

This task's own correctness depends entirely on faithfully mirroring Task 4's ACTUAL code (read it fresh from the file, not from this plan's own Task 4 text, in case Task 4's own review rounds changed it), the same discipline Round 1's own Task 3 used when mirroring Round 1's own Task 2.

- [ ] **Step 2: Write the failing test**

Mirror Task 4's own test, transposed onto columns/rows (source at `{rank:0,col:0}`, co-parent/blocker at `{rank:0,col:1}`, merge target at `{rank:0,col:2}`, `exitFace: 'east'`), using a concrete seed found via Task 2's own Step 1a-style process (a throwaway seed-search script, not committed) if `dogleg-repro-seed-0` doesn't happen to also produce an east-branch collision — check first before assuming a new seed is needed.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildRideAlongCorridorEast"`
Expected: FAIL.

- [ ] **Step 4: Implement `buildRideAlongCorridorEast`**

Mirror Task 4's own `buildRideAlongCorridorSouth` exactly, swapping X/Y axes throughout (matching `marginBandApproachY`'s own already-established mirror in Task 1). If Task 4's own final code (after its own review rounds) differs from this plan's own Task 4 text, mirror the ACTUAL code, not this plan's text.

- [ ] **Step 5: Run test to verify it passes, self-verify containment (same discipline as Task 4's own Step 5), run the full suite**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildRideAlongCorridorEast"`
Expected: PASS.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat(#297): mirror the ride-along corridor onto the east branch"
```

---

### Task 6: Two-pass restructuring of `buildPopulateAndUnlockGraphNode`

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`'s own incoming-connections loop, currently ~lines 1142-1238 — confirm via `grep -n "export async function buildPopulateAndUnlockGraphNode"`)
- Test: `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `findCoParentCollision` (Task 3), `buildRideAlongCorridorSouth`/`buildRideAlongCorridorEast` (Task 4/5).
- Produces: no new exports — this task only restructures `buildPopulateAndUnlockGraphNode`'s own internal loop. Its own external behavior (what Foundry documents get created, in what order relative to placeholder deletion) is unchanged for every non-colliding case.

- [ ] **Step 1: Read the current loop in full**

Read `buildPopulateAndUnlockGraphNode`'s own incoming-connections loop (the `for (let i = 0; i < incomingConnections.length; i += 1)` block) in full, including how `sourceRect`/`exitFaceFromSource`/`toSlot` are derived per connection and how `connectionWalls`/`tiles`/`placeholderIdsToDelete` accumulate before being committed after the loop.

- [ ] **Step 2: Write the failing test for the non-colliding case (Review Focus item 4)**

Add to `tests/dungeon-scene.test.mjs` (follow the existing `buildRoomAtGraphNode`-level test's own scaffolding pattern in that file, per Round 1's own Task 4 precedent): a test building a room with 2 real, non-colliding incoming connections (e.g. two direct, adjacent parents, no dogleg involved at all), asserting the resulting Wall/Tile documents are IDENTICAL (same count, same flags, same geometry) to what a single-pass build would produce — pin this by comparing against `buildEdgeCorridor`'s own direct output for each connection, not against a second copy of `buildPopulateAndUnlockGraphNode` itself.

- [ ] **Step 3: Write the failing test for the colliding case**

A second test in the same file, this time with the co-parent-collision scenario (reuse Task 4's own pinned seed/graph shape), building the MERGE ROOM itself through `buildPopulateAndUnlockGraphNode` end-to-end, and asserting: both connections' own doors exist and are independently unlockable (distinct `dungeonDoorFromRoomId` flags); the colliding connection's own Wall/Tile documents match what `buildRideAlongCorridorSouth` (Task 4) would produce standalone, not what its own naive `buildEdgeCorridor` call would have produced.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "buildPopulateAndUnlockGraphNode"`
Expected: FAIL (the restructuring hasn't happened yet, so the colliding case still produces Round 1's own broken dogleg).

- [ ] **Step 5: Restructure the loop into two passes**

Replace the single-pass loop with:

```js
    // #297 Round 2: pass 1 computes every connection's own candidate
    // corridor (unchanged buildEdgeCorridor call, including Round 1's own
    // dogleg) without committing anything yet -- list order doesn't
    // guarantee a co-parent is processed before a connection that needs
    // to ride along it, so every candidate must be known before any of
    // them are resolved.
    const slots = incomingConnections.length ? doorSlotsForFace(rect, incomingConnections.length, incomingFace) : [];
    const candidates = incomingConnections.map(({ sourceId, hidden }, i) => {
      const toSlot = slots[i];
      const sourcePos = state.layoutPositionByRoomId[sourceId];
      const sourceRect = roomRect(state.seed, sourceId, sourcePos.rank, sourcePos.col);
      const sourceChildIds = state.edges[sourceId] ?? [];
      const sourceIncomingFace = state.incomingFaceByRoomId?.[sourceId] ?? 'north';
      const exitFaceFromSource = hidden
        ? exitFaceForIndex(sourceChildIds.length, sourceIncomingFace)
        : exitFaceForIndex(sourceChildIds.indexOf(room.id), sourceIncomingFace);
      const naive = buildEdgeCorridor(state.seed, sourceId, room.id, sourceRect, rect, sourcePos, { rank, col }, exitFaceFromSource, toSlot, occupiedCells, incomingFace);
      return { sourceId, hidden, toSlot, exitFaceFromSource, naive };
    });

    const connectionWalls = [];
    const tiles = [];
    const placeholderIdsToDelete = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const { sourceId, hidden, toSlot, naive } = candidates[i];
      // #297 Round 2: a colliding connection's own naive dogleg is
      // replaced with a corridor riding along its own co-parent's ALREADY
      // -COMPUTED (pass 1, above) corridor -- see this room's own spec
      // (docs/superpowers/specs/2026-09-29-merge-room-gate-share-design.md,
      // "Round 2") for the full reasoning. A non-colliding connection's
      // own geometry is completely unchanged from Round 1.
      const coParentIndex = findCoParentCollision(naive.foreignOpening, incomingConnections);
      let doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells;
      if (coParentIndex >= 0) {
        const coParentResult = candidates[coParentIndex].naive;
        // Dispatch on the collision's OWN foreignOpening.side, not on this
        // room's own incomingFace or exit-face index -- side describes
        // which wall the BLOCKING room's own margin the corridor actually
        // crosses, which is exactly which axis (south-branch vs.
        // east-branch) the ORIGINAL Round 1 dogleg fired on for THIS
        // specific connection. Confirmed against Round 1's own final,
        // twice-reviewed convention: the south branch's own dogleg
        // produces `side: 'south'` (the lane sits in the blocker's east
        // margin but crosses its south wall); the east branch's own
        // mirror produces `side: 'east'` (lane in the blocker's south
        // margin, crosses its east wall) -- see either branch's own
        // `foreignOpening` assignment in scripts/dungeon-layout.mjs for
        // the current, authoritative values if this ever needs
        // reconfirming.
        const rideAlong = naive.foreignOpening.side === 'south'
          ? buildRideAlongCorridorSouth(naive, toSlot, coParentResult)
          : buildRideAlongCorridorEast(naive, toSlot, coParentResult);
        ({ doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells } = rideAlong);
      } else {
        ({ doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells } = naive);
      }
      // ... unchanged from here: the same hidden/real wallDoc construction,
      // tiles.push(...corridorTilesForSegments(corridorSegments)),
      // placeholderIdsToDelete.push(...placeholderIdsByConnection[i]), and
      // the transitCells loop, exactly as the pre-Round-2 code already has
      // them -- only the SOURCE of doorWall/revealDoorWall/plainWalls/
      // corridorSegments/transitCells changed, not what's done with them.
    }
```

Before using this dispatch condition, confirm `foreignOpening.side`'s exact values against the CURRENT code (`grep -n "side: '" scripts/dungeon-layout.mjs`) — this plan's own Task 4/5 build on Round 1's already-established convention and should not change it, but verify rather than assume.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "buildPopulateAndUnlockGraphNode"`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene.test.mjs
git commit -m "feat(#297): two-pass connection building, resolving co-parent collisions before committing any connection's geometry"
```

---

### Task 7: Regression test for the live repro (real graph) + system-wide sweep with real slots

**Files:**
- Modify: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the dedicated regression test using the REAL live graph shape**

Unlike Round 1's own Task 5 (which used a single-connection graph and therefore never actually exercised the co-parent case at all, despite the live repro's own real merge room genuinely having 2 real parents), this test must reconstruct the live-reported seed's own FULL real graph: source `room-room-entry-0` (rank 1, col 0) with children `[room-room-room-entry-0-0 (merge room, rank 3), room-room-room-entry-0-1 (blocker, rank 2)]`, AND the merge room's own second real parent, `room-detour-0`. Since the merge room's real co-parent (`room-detour-0`, at position `(2,2)` per this session's own earlier live investigation) is NOT the blocker (`room-room-room-entry-0-1`) in the ORIGINAL live report — construct this test to confirm Round 1's own dogleg (still kept, unmodified) still correctly handles this exact original scenario (an unrelated blocker, not a co-parent), AND construct a SEPARATE regression scenario (using Task 4's own already-pinned `dogleg-repro-seed-0`/`from-room`/`blocker-room`/`to-room` graph, which IS the co-parent-collision shape) confirming Round 2's own ride-along mechanism handles that case. Both scenarios are real #297 shapes; neither alone is the "whole" regression suite.

- [ ] **Step 2: Run both to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "#297"`
Expected: PASS.

- [ ] **Step 3: Write the system-wide sweep with real per-connection slots**

Reuse Round 1's own #297 sweep harness (`tests/dungeon-layout.test.mjs`, search for it) but rebuild its own graph/slot construction to use `incomingConnectionsFor` + real `doorSlotsForFace(rect, connections.length, face)[i]` throughout (not the single-slot assumption the final review found hidden every Round 1 defect). Assert, across the corpus: zero corridor/footprint overlap (Round 1's own property, unchanged) AND zero cross-connection wall collisions (no connection's own `plainWalls` collinear with another connection's own `doorWall`/`revealDoorWall` into the same target). Report both rates via `console.log`, matching this file's own established convention.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Note both measured rates in the commit message. If either rate is non-zero for the specific collision case this plan covers, do not soften the assertion — report it honestly and treat it as DONE_WITH_CONCERNS, the same discipline Round 1's own Task 5 used when it found the original 8.79% regression.

- [ ] **Step 5: Commit**

```bash
git add tests/dungeon-layout.test.mjs
git commit -m "test(#297): regression test for the live repro's real graph + system-wide sweep with real per-connection slots"
```

---

### Task 8: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Check `origin/main`'s current version before bumping**

Run: `git fetch origin main` then check `git show origin/main:module.json | grep version`. If it has advanced past this branch's own current `0.51.0`, bump past that version instead.

- [ ] **Step 2: Bump `module.json`**

Change `"version": "0.51.0"` to `"version": "0.52.0"` (or higher, per Step 1) — a minor bump, since this is an architecture-level change (a new cross-connection corridor-sharing mechanism), not a routine fix.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#297): bump version to 0.52.0"
```
