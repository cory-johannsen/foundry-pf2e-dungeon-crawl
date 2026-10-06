# Corridor Trap Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #779 — a trap can be placed in a corridor segment between two rooms, not only inside a room, using the same independent per-location roll #754 already established for rooms.

**Scope decision (user, 2026-10-05):** mechanics only. A corridor trap spawns, is detected, can be disabled, and triggers/damages a party member exactly like a room trap — all of that is already geometry-only and room/corridor-agnostic in `trap-combat.mjs` (confirmed live-reading `handleTrapTokenMove`/`attemptTrapDisableForScene`: both sweep every `trapHazard`-flagged token on the scene by footprint, never by room identity). What this plan deliberately does **not** build: #136's agent-customization hook and #56's tracker-display persistence, both keyed by `roomId` today with no corridor equivalent — building a parallel edge-keyed version of those is real additional scope, tracked separately as **#820**, filed per this same decision. A corridor trap's chat announcements and damage use its own default compendium name/description, exactly like every hazard already does when uncustomized.

**Architecture:** Reuses #754's own exact pattern (`trapRollSucceeds`, `hasTrapInRoom`, `populateSlotTrap`) one level down: an **edge id** (`${sourceId}->${room.id}`, the same string this file already uses for `dungeonHiddenDoorForEdge`/door-pair flags) stands in for a room id everywhere a corridor trap needs one. `populateSlotTrap` is called completely unchanged, passing the edge id as both its `slot` and `roomId` arguments — its own internal `ensureTrapState`/`trapCustomization`-flag calls key off `state.rooms[roomId]`, which is safely `undefined` for an edge id (confirmed live-reading `ensureTrapState`'s own `if (!room || room.trap) return state;` guard), so they no-op harmlessly rather than erroring; this is exactly the "mechanics only" scope decision made real in code, not just in prose. The only new geometry work is tagging a corridor's own already-computed floor tiles with which edge they belong to (additive, no change to tile positions, rotation, or the pathfinding that produced them) and picking one of those tagged cells to place the hazard on.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — bounded, reusing an already-spec'd pattern (#754) one level down, with the one real scope fork (minimal mechanics vs. full customization/display parity) decided by the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new mechanic: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- Scoped to a **real, non-hidden** edge's own **main corridor segments** only — hidden/shortcut edges and dead-end stub corridors, and any intermediate transit-cell detour geometry (#174's own multi-cell routing, the less-common obstacle-avoidance case), are out of scope for this plan. A corridor trap only ever lands on one of the direct segment tiles `corridorTilesForSegments` already lays for the edge's own door-to-door path.
- No change to `buildEdgeCorridor`'s own pathfinding, segment, or door geometry — this plan only tags and reads tiles `corridorTilesForSegments` already produces, never changes where they are.
- `trap-combat.mjs` needs **zero changes** — confirmed its detect/disable/trigger sweep is already room/corridor-agnostic.

## Review Focus

- **A corridor trap must be detectable, disable-able, and able to trigger and damage a party member exactly like a room trap** — since this reuses the identical mechanism, a live scenario walking through all three confirms nothing about being edge-keyed instead of room-keyed broke anything.
- **A corridor trap must never be placed on a transit/detour cell, only a main segment tile** — the scope boundary this plan draws; a trap landing somewhere the party can't actually reach via the edge's own real door-to-door path would be unreachable and undetectable.
- **Placing a corridor trap must not change the corridor's own floor-tile positions, rotation, or art** — the tagging is additive (a new flag), never a change to any existing tile field.
- **A corridor trap's own `trapCustomization`/`ensureTrapState` calls (inherited unchanged from `populateSlotTrap`) must no-op safely for an edge id, not throw** — confirmed by reading the guard, pinned by a test rather than left as an assumption.
- **The roll must be independent per edge, seeded and deterministic**, matching `trapRollSucceeds`'s own room-level convention exactly — the same edge, same seed, always the same roll result.

---

### Task 1: Pure functions — corridor roll and cell extraction

**Files:**
- Modify: `scripts/dungeon-deck.mjs` (new `corridorTrapRollSucceeds`)
- Modify: `scripts/dungeon-scene.mjs` (`corridorTilesForSegments` returns its own cell list alongside its tiles)
- Test: `tests/dungeon-deck.test.mjs`, wherever `corridorTilesForSegments`'s own current callers are tested (check `tests/dungeon-scene*.test.mjs` for existing coverage of corridor tile geometry before writing new assertions, to match conventions)

**Interfaces:**
- Produces: `corridorTrapRollSucceeds(seed, edgeId): boolean` (mirrors `trapRollSucceeds(seed, roomId)` exactly). `corridorTilesForSegments(segments, opts)` now returns `{tiles, cells}` instead of a bare tile array — `cells` is `[{gx, gy}, ...]`, one entry per tile, in the same order. Consumed by Task 2.

- [x] **Step 1: Write the failing tests**

Add to `tests/dungeon-deck.test.mjs`, alongside its existing `trapRollSucceeds` tests (mirror their exact style):

```js
describe('corridorTrapRollSucceeds', () => {
  it('is deterministic for the same seed and edgeId', () => {
    expect(corridorTrapRollSucceeds('seed', 'a->b')).toBe(corridorTrapRollSucceeds('seed', 'a->b'));
  });

  it('is independent of the room-level roll for the same seed', () => {
    // Different salt strings (confirmed below) -- not expected to always
    // agree, just confirmed here to use a genuinely different seed input
    // than trapRollSucceeds rather than accidentally aliasing it.
    const roomRoll = trapRollSucceeds('shared-seed', 'a->b');
    const edgeRoll = corridorTrapRollSucceeds('shared-seed', 'a->b');
    expect(typeof roomRoll).toBe('boolean');
    expect(typeof edgeRoll).toBe('boolean');
  });

  it('succeeds at approximately the same rate as the room-level roll', () => {
    let hits = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      if (corridorTrapRollSucceeds('rate-seed', `edge-${i}`)) hits += 1;
    }
    const rate = hits / trials;
    expect(rate).toBeGreaterThan(0.06);
    expect(rate).toBeLessThan(0.10);
  });
});
```

Find `corridorTilesForSegments`'s own existing test coverage (if any) via `grep -rln "corridorTilesForSegments" tests/`; if it's only exercised indirectly through a room/corridor-building integration test (likely, since it's a local, unexported function), add a new assertion to whichever integration test already builds a real corridor, confirming the SAME number of cells as tiles are produced, each cell's `{gx, gy}` matching the tile it corresponds to (derivable from that test's own existing tile-position assertions, if any — otherwise add a minimal new one).

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t "corridorTrapRollSucceeds"`
Expected: FAIL — not a function yet.

- [x] **Step 3: Write `corridorTrapRollSucceeds`**

In `scripts/dungeon-deck.mjs`, add directly after `trapRollSucceeds`:

```js
/** #779: a corridor's own independent trap roll, same rate and convention
 * as trapRollSucceeds, keyed by edge id (`${fromRoomId}->${toRoomId}`)
 * instead of a room id -- a corridor is never also a room, so there's no
 * risk of an edge id and a room id colliding and double-counting a trap
 * check for the same physical space. */
export function corridorTrapRollSucceeds(seed, edgeId) {
  const rand = splitmix32(seedFromString(`${seed}-corridor-trap-chance-${edgeId}`));
  return rand() < TRAP_CHANCE;
}
```

- [x] **Step 4: Refactor `corridorTilesForSegments` to also return cells**

In `scripts/dungeon-scene.mjs`, change (confirmed current, lines 175-240):

```js
function corridorTilesForSegments(segments, { fullWidth = false } = {}) {
  const tiles = [];
  for (const segment of segments) {
    ...
    for (let ci = 0; ci < cross; ci += 1) {
    ...
    for (let ti = 0; ti < length; ti += 1) {
      const dx = vertical ? ci : ti;
      const dy = vertical ? ti : ci;
      const { variant, rotation } = corridorTileVariant(ti, length, vertical);
      tiles.push({
        ...
        rotation,
      });
    }
    }
  }
  return tiles;
}
```

to (only the parts that change — the interior tile-building code between `const { variant, rotation } = ...` and the closing of the innermost loop is unchanged):

```js
function corridorTilesForSegments(segments, { fullWidth = false } = {}) {
  const tiles = [];
  // #779: parallel to `tiles`, one entry per tile, in the same order --
  // the grid cell each tile occupies, for a caller (corridor trap
  // placement) that needs to pick a real floor cell without duplicating
  // this function's own baseGx/baseGy flooring (#324's own fix, load-
  // bearing for tile/wall agreement -- see this function's existing
  // comment above) by hand.
  const cells = [];
  for (const segment of segments) {
    ...
    for (let ci = 0; ci < cross; ci += 1) {
    ...
    for (let ti = 0; ti < length; ti += 1) {
      const dx = vertical ? ci : ti;
      const dy = vertical ? ti : ci;
      const { variant, rotation } = corridorTileVariant(ti, length, vertical);
      cells.push({ gx: baseGx + dx, gy: baseGy + dy });
      tiles.push({
        ...
        rotation,
      });
    }
    }
  }
  return { tiles, cells };
}
```

Update both call sites to destructure accordingly. The transit-cell site (confirmed current, line 299):

```js
  const tiles = corridorTilesForSegments(cell.corridorSegments).map((t) => ({
```

to:

```js
  const { tiles: rawTiles } = corridorTilesForSegments(cell.corridorSegments);
  const tiles = rawTiles.map((t) => ({
```

The main edge site is Task 2's own concern (it needs `cells`, not just `tiles`) — leave its exact rewrite to Task 2's Step 1 so both changes land together and can be tested as one unit.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs tests/dungeon-scene.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — in particular, every existing caller/test of `corridorTilesForSegments` (via whichever integration tests exercise corridor building) stays green once updated to the new `{tiles, cells}` return shape.

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-deck.mjs scripts/dungeon-scene.mjs tests/dungeon-deck.test.mjs
git commit -m "feat(#779): add corridor trap roll and expose corridor cell geometry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire corridor trap placement, live-verify, version bump

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`'s corridor-building loop)
- Test: `tests/dungeon-scene-trap-placement.test.mjs` (confirmed current — created by #754's own PR #812, already covers room-kind-agnostic trap placement with a matching harness)

**Interfaces:**
- Consumes: `corridorTrapRollSucceeds` and `corridorTilesForSegments`'s new `cells` (Task 1), `hasTrapInRoom` and `populateSlotTrap` (both confirmed current, unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-scene-trap-placement.test.mjs`, reusing its exact existing `makeScene`/`state`/mocks (extend `state.edges`/`incomingFaceByRoomId`/etc. minimally as needed to exercise a real incoming connection — read `buildEdgeCorridor`'s own required inputs first to build the smallest viable fixture, matching whatever this file's own author would have had to do had corridor coverage been in scope for #754's own PR):

```js
describe("buildPopulateAndUnlockGraphNode — #779 corridor trap placement", () => {
  it("a roll-success edge gets exactly one corridor trap", async () => {
    // ...build a scene with a real incoming connection from a source room,
    // mock corridorTrapRollSucceeds to return true, run build(scene, room),
    // and assert exactly one trapHazard token exists whose dungeonSlot
    // equals the edge id "source-room->room-s" (or whatever this fixture's
    // own source room id is).
  });

  it("a roll-failure edge gets no corridor trap", async () => {
    // same fixture, mocked roll false; assert zero trapHazard tokens with
    // that edge's dungeonSlot.
  });

  it("a hidden edge never gets a corridor trap, even on a roll success", async () => {
    // same fixture with incomingConnections[i].hidden = true; assert zero,
    // regardless of the mocked roll's value.
  });

  it("rebuilding the same edge does not place a second corridor trap", async () => {
    // call build(scene, room) twice against the same fixture; assert
    // still exactly one trapHazard token for that edge's dungeonSlot.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-trap-placement.test.mjs -t "corridor trap"`
Expected: FAIL.

- [ ] **Step 3: Wire the placement**

In `scripts/dungeon-scene.mjs`'s `buildPopulateAndUnlockGraphNode`, inside the `for (let i = 0; i < incomingConnections.length; i += 1)` loop (confirmed current, starting line 1655), change the tile-push line (confirmed current, line 1733):

```js
      tiles.push(...corridorTilesForSegments(corridorSegments, { fullWidth: layoutVersion >= 3 }));
```

to:

```js
      const edgeId = `${sourceId}->${room.id}`;
      const { tiles: edgeTiles, cells: edgeCells } = corridorTilesForSegments(
        corridorSegments,
        { fullWidth: layoutVersion >= 3 },
      );
      tiles.push(...edgeTiles);
      // #779: a corridor trap only ever lands on one of THIS edge's own
      // main segment tiles (never a hidden/stub edge, never an
      // intermediate transit-cell detour -- both out of this plan's own
      // scope) -- reuses #754's exact pattern one level down, with the
      // edge id standing in for a room id. populateSlotTrap's own
      // ensureTrapState/trapCustomization-flag calls key off
      // state.rooms[edgeId], always undefined for an edge id, so they
      // no-op harmlessly -- #779's own "mechanics only" scope decision,
      // made real rather than assumed (see #820 for the deferred parity
      // work this would need instead).
      if (
        !hidden &&
        scene.tokens &&
        edgeCells.length > 0 &&
        !hasTrapInRoom(scene, edgeId) &&
        corridorTrapRollSucceeds(state.seed, edgeId)
      ) {
        const pickRand = splitmix32(seedFromString(`${state.seed}-corridor-trap-cell-${edgeId}`));
        const cell = edgeCells[Math.floor(pickRand() * edgeCells.length)];
        await populateSlotTrap(scene, edgeId, {
          rect: { gx: cell.gx, gy: cell.gy, gw: 1, gh: 1 },
          partyLevel: await makeFoundryApi().partyLevel(),
          levelOffsetBias: 0,
          locationTag: null,
          seed: state.seed,
          roomId: edgeId,
        });
      }
```

(`hasTrapInRoom`, `corridorTrapRollSucceeds`, `splitmix32`, `seedFromString`, `makeFoundryApi`, and `populateSlotTrap` are all already imported/defined in this file — confirmed current; add `corridorTrapRollSucceeds` to the existing `from "./dungeon-deck.mjs"` import line alongside `trapRollSucceeds`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-trap-placement.test.mjs`
Expected: PASS, old and new cases green.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Live-verify via `foundry-rest`**

Generate several real dungeon runs (varying seeds) and confirm:

```bash
echo 'const hazards = canvas.scene.tokens.filter(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard")); return hazards.map(t => ({ dungeonSlot: t.getFlag("pf2e-dungeon-crawl", "dungeonSlot") }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: some `dungeonSlot` values are edge-shaped (`"<roomId>-><roomId>"`) rather than a bare room id, confirming a corridor trap actually placed across a real multi-run sample. For one such corridor trap: confirm it's detected on approach (walk a party token adjacent to it), can be disabled via the click-to-disable dialog, and — on a fresh one — triggers and damages the walking-over character exactly like a room trap. Confirm its chat announcements use its own default compendium name (no customization applied, matching this plan's own scope decision).

- [ ] **Step 7: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real new mechanic), using whatever the fetch above shows as current.

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-trap-placement.test.mjs module.json
git commit -m "feat(#779): place traps in corridors between rooms

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #779's own three scope bullets are covered with one explicit, user-approved narrowing: state-keying is resolved by reusing `populateSlotTrap`'s existing room-keyed calls with an edge id (safely no-op for the parts that don't apply), not a parallel new state system; geometry is extended via an additive cell-tagging refactor, no pathfinding changes; detect/disable/trigger wiring needs zero changes, confirmed already generic. The deferred customization/display parity is tracked at **#820**, filed this session per the user's own explicit split.

**2. Placeholder scan:** The two new corridor-trap test bodies in Task 2 Step 1 are described rather than fully written out — flagged here deliberately: unlike every other plan this session, this task's own fixture (a real `incomingConnections` entry feeding `buildEdgeCorridor` successfully) is nontrivial to construct correctly, and `tests/dungeon-scene-trap-placement.test.mjs`'s own current fixture (confirmed current) uses `childIds: []`/no incoming connections, meaning the corridor-building loop never runs in its existing tests at all. The step's own text names exactly what each test must set up and assert; the implementer's own first job is confirming the minimal real fixture `buildEdgeCorridor` needs (reading its own parameter list, confirmed current at `scripts/dungeon-layout.mjs:656`) before writing the test bodies — a reasonable scoping of "no placeholders in the design," not a gap in it.

**3. Type consistency:** `corridorTilesForSegments`'s new `{tiles, cells}` return shape (Task 1) is consumed identically by both of its call sites (Task 1's transit-cell update, Task 2's main-edge wiring). `populateSlotTrap`'s existing `(scene, slot, {rect, partyLevel, levelOffsetBias, locationTag, seed, roomId})` signature is used with the exact same field names as every existing room-based call.

**4. Review Focus:** All five items (full detect/disable/trigger/damage parity, never placing on a transit/detour cell, zero change to existing tile geometry, a safe no-op for the inherited room-state calls, a deterministic independent roll) each map to a specific test or live-verification step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-corridor-trap-placement.md`.
