# Decouple Traps From Room Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trap can appear in any room kind (not just its own dedicated `trap` kind), at roughly the same overall rate as today, by deleting the now-dead trap-setpiece machinery and adding one new independent build-time placement check.

**Architecture:** Remove `trap` from `ROOM_KIND_WEIGHTS` (`scripts/dungeon-deck.mjs`) so `roomKindAt`/`pickAt` never produce it again — every room-kind-selection call site in this codebase already funnels through one of these two functions, so this alone prevents `'trap'` from ever being chosen anywhere, with no further code change needed to the kind-selection logic itself. The now-unreachable `kind === 'trap' ? setpieceAt(...) : ...` branches (and their `trapSetpieceIds` parameters) are deleted from the four generation functions that had them, and the same parameter is unwound from every caller that threads it through. A new, independent, kind-agnostic trap-placement roll replaces the old kind-gated check in `scripts/dungeon-scene.mjs`.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-decouple-traps-from-room-kind-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real behavioral change to room generation: minor bump. Current version at plan-writing time is `0.61.1` — re-check immediately before committing, since concurrent sessions push to this repo.
- `populateSlotTrap`/`ensureTrapState`/the real trap detect-disable-trigger engine (#753, already merged) are **not modified** — this plan only changes when/how a trap gets placed, never what happens once it's placed.
- `puzzleSetpieceIds`/`narrativeSetpieceIds`/`treasureSetpieceIds` are **not touched** anywhere — only the `trap`-specific thread is removed from each shared call site; every other pool stays exactly as it is today, even at call sites (noted below) where it turns out to be equally unused dead weight — fixing that is out of this plan's scope.
- `data/dungeon-setpieces.json`'s 3 `kind: "trap"` entries are left untouched (become harmless unused data, per the spec's own explicit decision).
- The new trap-placement roll must happen regardless of which branch (`combat` or the non-combat `else`) a room's own build-time dispatch took — it is a cross-cutting addition, not nested inside either branch.

## Review Focus

- **Every one of the four generation functions' own `kind === 'trap'` branches must become genuinely unreachable**, not just "unlikely" — confirmed by removing `trap` from `ROOM_KIND_WEIGHTS` first (Task 1), so by the time Task 2 deletes the dead branches, there's no behavior change left to accidentally lose, only dead code to remove.
- **A combat room's own new trap roll must never collide with its already-placed encounter tokens** — `populateSlotTrap`'s own `spawnCreatures` call already computes occupied cells from existing scene tokens before placing (confirmed read this session), so placing the trap roll *after* combat's own encounter population is what makes this safe; getting the ordering wrong would reintroduce the collision risk this review item exists to catch.
- **The new trap-specific idempotency check must not reuse `isSlotPopulated`** — that function already returns `true` once *either* a combat encounter or a trap exists for a room (both set the same `dungeonSlot` flag), so reusing it would silently prevent a combat room from ever rolling a trap at all. Covered by Task 3's own dedicated check.
- **`safe_entry`/`safe_rest`/goal rooms must never roll a trap** — explicit exclusion, covered by a dedicated test.
- **Existing tests in `tests/dungeon-deck.test.mjs` that assert trap-specific behavior must be found and fixed, not left to silently start failing** — this file has real, passing tests today asserting `ROOM_KIND_WEIGHTS` contains a `trap` entry, that `roomKindAt` can produce `'trap'`, and that `buildRoomSequence`/`attachHiddenPaths` assign trap setpieces — all confirmed by direct reading this session, enumerated exhaustively in Task 2 below rather than discovered by a failing test run.

---

### Task 1: Remove `trap` from `ROOM_KIND_WEIGHTS`

**Files:**
- Modify: `scripts/dungeon-deck.mjs` (`ROOM_KIND_WEIGHTS`)
- Modify: `tests/dungeon-deck.test.mjs` (`describe('ROOM_KIND_WEIGHTS', ...)`, `describe('roomKindAt', ...)`)

**Interfaces:** None — no new exports, no signature changes.

- [x] **Step 1: Update the two existing tests that assert trap's own weight/presence**

In `tests/dungeon-deck.test.mjs`, change the `describe('ROOM_KIND_WEIGHTS', ...)` block's two trap-specific tests from:

```js
  it('splits puzzle and trap into independent kinds with an even 1/1 weight (#32)', () => {
    expect(ROOM_KIND_WEIGHTS.some((w) => w.kind === 'puzzle_or_trap')).toBe(false);
    const puzzle = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'puzzle');
    const trap = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'trap');
    expect(puzzle?.weight).toBe(1);
    expect(trap?.weight).toBe(1);
  });

  it('keeps the combined puzzle+trap weight, and the overall total, unchanged from before the split (#32)', () => {
    const puzzle = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'puzzle');
    const trap = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'trap');
    expect(puzzle.weight + trap.weight).toBe(2);
    const total = ROOM_KIND_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBe(12);
  });
```

to:

```js
  it('has no puzzle_or_trap combined kind (#32)', () => {
    expect(ROOM_KIND_WEIGHTS.some((w) => w.kind === 'puzzle_or_trap')).toBe(false);
    const puzzle = ROOM_KIND_WEIGHTS.find((w) => w.kind === 'puzzle');
    expect(puzzle?.weight).toBe(1);
  });

  it('no longer includes trap as a room kind (#754 — traps are now an independent layer, not a room kind)', () => {
    expect(ROOM_KIND_WEIGHTS.some((w) => w.kind === 'trap')).toBe(false);
    const total = ROOM_KIND_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBe(11);
  });
```

Change the `describe('roomKindAt', ...)` block's trap-specific test from:

```js
  it('can produce a puzzle room and a trap room as independent kinds (#32)', () => {
    const kinds = new Set();
    for (let i = 0; i < 200; i += 1) kinds.add(roomKindAt('probe-seed', i));
    expect(kinds).toContain('puzzle');
    expect(kinds).toContain('trap');
    expect(kinds.has('puzzle_or_trap')).toBe(false);
  });
```

to:

```js
  it('can produce a puzzle room, and never produces trap (#32, #754)', () => {
    const kinds = new Set();
    for (let i = 0; i < 200; i += 1) kinds.add(roomKindAt('probe-seed', i));
    expect(kinds).toContain('puzzle');
    expect(kinds.has('trap')).toBe(false);
    expect(kinds.has('puzzle_or_trap')).toBe(false);
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t "754"`
Expected: FAIL — `ROOM_KIND_WEIGHTS` still contains a `trap` entry with weight 1 and a total of 12, and `roomKindAt` can still produce `'trap'`.

- [x] **Step 3: Remove the `trap` entry**

In `scripts/dungeon-deck.mjs`, change:

```js
export const ROOM_KIND_WEIGHTS = [
  { kind: 'combat', weight: 5 },
  { kind: 'skill_challenge', weight: 2 },
  { kind: 'puzzle', weight: 1 },
  { kind: 'trap', weight: 1 },
  { kind: 'narrative', weight: 1 },
  { kind: 'treasure', weight: 2 }
];
```

to:

```js
// #754: trap is no longer its own mutually-exclusive room kind — a trap
// can now appear independently within any other kind's own room, decided
// by its own separate roll (trapRollSucceeds below), not by this table.
export const ROOM_KIND_WEIGHTS = [
  { kind: 'combat', weight: 5 },
  { kind: 'skill_challenge', weight: 2 },
  { kind: 'puzzle', weight: 1 },
  { kind: 'narrative', weight: 1 },
  { kind: 'treasure', weight: 2 }
];
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t "754"`
Expected: PASS, all tests from Step 1 green.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "feat(#754): remove trap from ROOM_KIND_WEIGHTS

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Delete the now-dead trap-setpiece code from the four generation functions

**Files:**
- Modify: `scripts/dungeon-deck.mjs` (`buildRoomSequence`, `applySequenceMutation`, `buildRoomGraph`, `attachHiddenPaths`)
- Modify: `tests/dungeon-deck.test.mjs`

**Interfaces:** None — removes a parameter from four existing exported functions; no behavior for puzzle/narrative/treasure changes.

- [x] **Step 1: Delete/update the tests that exercised trap-setpiece assignment**

In `tests/dungeon-deck.test.mjs`, **delete** this entire test (its own premise — a dedicated trap room with a setpiece — no longer exists):

```js
  it('only assigns a set-piece to trap rooms, and only when trap set-pieces are supplied (#32)', () => {
    const withPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, trapSetpieceIds: ['t1', 't2'] });
    expect(withPieces.some((r) => r.kind === 'trap')).toBe(true);
    for (const room of withPieces) {
      if (room.kind === 'trap') expect(['t1', 't2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, trapSetpieceIds: [] });
    for (const room of withoutPieces) expect(room.setpieceId).toBeNull();
  });
```

Change the pool-independence test from:

```js
  it('draws puzzle, trap, narrative and treasure set-pieces from independent pools (#32, #165, #89)', () => {
    const rooms = buildRoomSequence({
      seed: 'gamma',
      roomCount: 12,
      puzzleSetpieceIds: ['p1', 'p2'],
      trapSetpieceIds: ['t1', 't2'],
      narrativeSetpieceIds: ['n1', 'n2'],
      treasureSetpieceIds: ['tr1', 'tr2']
    });
    expect(rooms.some((r) => r.kind === 'puzzle')).toBe(true);
    expect(rooms.some((r) => r.kind === 'trap')).toBe(true);
    expect(rooms.some((r) => r.kind === 'narrative')).toBe(true);
    expect(rooms.some((r) => r.kind === 'treasure')).toBe(true);
    for (const room of rooms) {
      if (room.kind === 'puzzle') expect(['p1', 'p2']).toContain(room.setpieceId);
      else if (room.kind === 'trap') expect(['t1', 't2']).toContain(room.setpieceId);
      else if (room.kind === 'narrative') expect(['n1', 'n2']).toContain(room.setpieceId);
      else if (room.kind === 'treasure') expect(['tr1', 'tr2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
  });
```

to:

```js
  it('draws puzzle, narrative and treasure set-pieces from independent pools (#32, #165, #89, #754)', () => {
    const rooms = buildRoomSequence({
      seed: 'gamma',
      roomCount: 12,
      puzzleSetpieceIds: ['p1', 'p2'],
      narrativeSetpieceIds: ['n1', 'n2'],
      treasureSetpieceIds: ['tr1', 'tr2']
    });
    expect(rooms.some((r) => r.kind === 'puzzle')).toBe(true);
    expect(rooms.some((r) => r.kind === 'narrative')).toBe(true);
    expect(rooms.some((r) => r.kind === 'treasure')).toBe(true);
    for (const room of rooms) {
      if (room.kind === 'puzzle') expect(['p1', 'p2']).toContain(room.setpieceId);
      else if (room.kind === 'narrative') expect(['n1', 'n2']).toContain(room.setpieceId);
      else if (room.kind === 'treasure') expect(['tr1', 'tr2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
  });
```

In the `describe('attachHiddenPaths detour content (#93 post-merge fix)', ...)` block, change:

```js
  it('a puzzle/trap/narrative/treasure detour room gets a real setpieceId when pools are provided', () => {
    const puzzleSetpieceIds = ['p1', 'p2'];
    const trapSetpieceIds = ['t1', 't2'];
    const narrativeSetpieceIds = ['n1', 'n2'];
    const treasureSetpieceIds = ['tr1', 'tr2'];
    let sawContentKind = false;
    for (let i = 0; i < 300; i += 1) {
      const seed = `detour-setpiece-${i}`;
      const { rooms, edges } = buildRoomGraph({ seed, roomCount: 10 });
      const attached = attachHiddenPaths({
        rooms, edges, seed,
        puzzleSetpieceIds, trapSetpieceIds, narrativeSetpieceIds, treasureSetpieceIds,
      });
      for (const roomId of attached.hiddenRooms) {
        const room = attached.rooms[roomId];
        if (['puzzle', 'trap', 'narrative', 'treasure'].includes(room.kind)) {
          sawContentKind = true;
          expect(room.setpieceId).not.toBeNull();
        }
      }
    }
    expect(sawContentKind).toBe(true);
  });
```

to:

```js
  it('a puzzle/narrative/treasure detour room gets a real setpieceId when pools are provided (#754: never trap)', () => {
    const puzzleSetpieceIds = ['p1', 'p2'];
    const narrativeSetpieceIds = ['n1', 'n2'];
    const treasureSetpieceIds = ['tr1', 'tr2'];
    let sawContentKind = false;
    for (let i = 0; i < 300; i += 1) {
      const seed = `detour-setpiece-${i}`;
      const { rooms, edges } = buildRoomGraph({ seed, roomCount: 10 });
      const attached = attachHiddenPaths({
        rooms, edges, seed,
        puzzleSetpieceIds, narrativeSetpieceIds, treasureSetpieceIds,
      });
      for (const roomId of attached.hiddenRooms) {
        const room = attached.rooms[roomId];
        expect(room.kind).not.toBe('trap');
        if (['puzzle', 'narrative', 'treasure'].includes(room.kind)) {
          sawContentKind = true;
          expect(room.setpieceId).not.toBeNull();
        }
      }
    }
    expect(sawContentKind).toBe(true);
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t "754"`
Expected: FAIL — `buildRoomSequence`/`attachHiddenPaths` still accept and act on `trapSetpieceIds`, so the updated assertions (no `'trap'` kind, no trap pool) don't yet hold... actually since Task 1 already removed `trap` from `ROOM_KIND_WEIGHTS`, these rooms can never be kind `'trap'` already — re-run to confirm these specific tests already pass post-Task-1 (if so, that's fine: it means Task 1 alone already satisfies the *kind* assertions here, and this task is purely the *dead-parameter cleanup*, not a second behavior fix). Either way, proceed to Step 3 to remove the now-fully-dead parameters.

- [x] **Step 3: Delete the dead code from `buildRoomSequence`**

In `scripts/dungeon-deck.mjs`, change:

```js
export function buildRoomSequence({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = []
}) {
```

to:

```js
export function buildRoomSequence({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = []
}) {
```

Change:

```js
  let puzzleOccurrence = 0;
  let trapOccurrence = 0;
  let narrativeOccurrence = 0;
  let treasureOccurrence = 0;
```

to:

```js
  let puzzleOccurrence = 0;
  let narrativeOccurrence = 0;
  let treasureOccurrence = 0;
```

Change:

```js
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, trapOccurrence++, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, treasureOccurrence++, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
```

to:

```js
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, treasureOccurrence++, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
```

- [x] **Step 4: Delete the dead code from `applySequenceMutation`**

Change:

```js
export function applySequenceMutation(
  rooms,
  currentIndex,
  mutation,
  {
    seed,
    puzzleSetpieceIds = [],
    trapSetpieceIds = [],
    narrativeSetpieceIds = [],
    treasureSetpieceIds = []
  } = {}
) {
```

to:

```js
export function applySequenceMutation(
  rooms,
  currentIndex,
  mutation,
  {
    seed,
    puzzleSetpieceIds = [],
    narrativeSetpieceIds = [],
    treasureSetpieceIds = []
  } = {}
) {
```

Change:

```js
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, rooms.length, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, rooms.length, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, rooms.length, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, rooms.length, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
```

to:

```js
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, rooms.length, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, rooms.length, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, rooms.length, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
```

- [x] **Step 5: Delete the dead code from `buildRoomGraph`**

Change:

```js
export function buildRoomGraph({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = [],
}) {
```

to:

```js
export function buildRoomGraph({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = [],
}) {
```

Change:

```js
  let puzzleOccurrence = 0;
  let trapOccurrence = 0;
  let narrativeOccurrence = 0;
  let treasureOccurrence = 0;
```

to:

```js
  let puzzleOccurrence = 0;
  let narrativeOccurrence = 0;
  let treasureOccurrence = 0;
```

Change:

```js
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, trapOccurrence++, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, treasureOccurrence++, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
```

to:

```js
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : kind === 'treasure' ? setpieceAt(seed, treasureOccurrence++, treasureSetpieceIds, 'treasure-setpiece-order')
      : null;
```

- [x] **Step 6: Delete the dead code from `attachHiddenPaths`**

Change:

```js
export function attachHiddenPaths({
  rooms, edges, seed,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = [],
}) {
```

to:

```js
export function attachHiddenPaths({
  rooms, edges, seed,
  puzzleSetpieceIds = [],
  narrativeSetpieceIds = [],
  treasureSetpieceIds = [],
}) {
```

Change:

```js
  let detourPuzzleOccurrence = 0;
  let detourTrapOccurrence = 0;
  let detourNarrativeOccurrence = 0;
  let detourTreasureOccurrence = 0;
```

to:

```js
  let detourPuzzleOccurrence = 0;
  let detourNarrativeOccurrence = 0;
  let detourTreasureOccurrence = 0;
```

Change:

```js
      const setpieceId =
        kind === 'puzzle' ? setpieceAt(seed, detourPuzzleOccurrence++, puzzleSetpieceIds, 'detour-puzzle-setpiece-order')
        : kind === 'trap' ? setpieceAt(seed, detourTrapOccurrence++, trapSetpieceIds, 'detour-trap-setpiece-order')
        : kind === 'narrative' ? setpieceAt(seed, detourNarrativeOccurrence++, narrativeSetpieceIds, 'detour-narrative-setpiece-order')
        : kind === 'treasure' ? setpieceAt(seed, detourTreasureOccurrence++, treasureSetpieceIds, 'detour-treasure-setpiece-order')
        : null;
```

to:

```js
      const setpieceId =
        kind === 'puzzle' ? setpieceAt(seed, detourPuzzleOccurrence++, puzzleSetpieceIds, 'detour-puzzle-setpiece-order')
        : kind === 'narrative' ? setpieceAt(seed, detourNarrativeOccurrence++, narrativeSetpieceIds, 'detour-narrative-setpiece-order')
        : kind === 'treasure' ? setpieceAt(seed, detourTreasureOccurrence++, treasureSetpieceIds, 'detour-treasure-setpiece-order')
        : null;
```

- [x] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs`
Expected: PASS, every test in the file green — including every test untouched by this plan (puzzle/narrative/treasure assertions unaffected).

- [x] **Step 8: Commit**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "feat(#754): delete dead trap-setpiece code from the four generation functions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove `trapSetpieceIds` threading from every caller

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (two functions take `trapSetpieceIds` — the `startDungeonRun`-adjacent legacy path at ~line 157-175, and `markRoomOutcome` at ~line 263-271)
- Modify: `scripts/dungeon-reseed.mjs` (`computeRunLayout`, ~line 88-99)
- Modify: `scripts/ui/dungeon-app.mjs` (two sites: ~line 147-161 feeding `markRoomOutcome`'s options, and ~line 470-510 feeding `createRun`/`chooseRunLayout`)

**Interfaces:** None — pure parameter removal, no behavior change for puzzle/narrative/treasure.

This is mechanical deletion with no new logic; no new test is needed beyond Task 2's own full-suite pass already confirming nothing broke. Re-locate each site fresh via your editor before editing (concurrent sessions push to this repo constantly) — do not rely solely on the line numbers below.

- [x] **Step 1: `scripts/dungeon-runner.mjs`**

Remove `trapSetpieceIds = [],` from both of this file's own option-destructuring blocks that currently have it (confirmed this session at two separate locations: one around the `startDungeonRun`-adjacent legacy `buildRoomSequence`-calling path, one in `markRoomOutcome`'s own options). Remove the corresponding `trapSetpieceIds,` entry from whichever object literal passes it onward (e.g. into `getGenerator().buildRoomSequence({...})`).

Note: confirmed this session that `markRoomOutcome`'s own `trapSetpieceIds` (along with `puzzleSetpieceIds`/`narrativeSetpieceIds`/`treasureSetpieceIds`) is accepted but never actually read anywhere in that function's body (it only ever calls `getGenerator().revealTravelTimeEffect({edges, hiddenEdges, stubEdges}, roomId, effectKey)`, which takes no setpiece pools at all) — all four pools are already fully dead weight at this specific call site, not just the trap one. Remove only `trapSetpieceIds` here, per this plan's own scope (puzzle/narrative/treasure stay, even though they're equally unused here) — leave a one-line comment noting the broader dead-parameter situation for a future cleanup, rather than fixing it now:

```js
    // #754: trapSetpieceIds removed (trap is no longer a room kind). Note:
    // puzzleSetpieceIds/narrativeSetpieceIds/treasureSetpieceIds are ALSO
    // never actually read in this function's own body (confirmed — it only
    // calls revealTravelTimeEffect, which takes no setpiece pools at all),
    // but removing those is out of this issue's own scope.
```

- [x] **Step 2: `scripts/dungeon-reseed.mjs`**

Change `computeRunLayout`'s own destructuring/bundling from:

```js
  const { puzzle: puzzleSetpieceIds, trap: trapSetpieceIds, narrative: narrativeSetpieceIds, treasure: treasureSetpieceIds } = setpieceIds;
  const sets = { puzzleSetpieceIds, trapSetpieceIds, narrativeSetpieceIds, treasureSetpieceIds };
```

to:

```js
  const { puzzle: puzzleSetpieceIds, narrative: narrativeSetpieceIds, treasure: treasureSetpieceIds } = setpieceIds;
  const sets = { puzzleSetpieceIds, narrativeSetpieceIds, treasureSetpieceIds };
```

Also update this function's own docblock comment (`` `setpieceIds` is `{ puzzle, trap, narrative, treasure }` ``) to drop `trap` from the listed shape.

- [x] **Step 3: `scripts/ui/dungeon-app.mjs`**

At the site feeding `markRoomOutcome`'s options (confirmed this session, ~line 147-161), remove the `trapSetpieceIds: setpieces.filter((s) => s.kind === "trap").map((s) => s.id),` entry (keep the puzzle/narrative/treasure ones, which are still genuinely consumed by other callers even though this specific `markRoomOutcome` call never reads them, per Task 3 Step 1's own finding).

At the site feeding `createRun`/`chooseRunLayout` (confirmed this session, ~line 470-510): remove the `const trapSetpieceIds = setpieces.filter((s) => s.kind === "trap").map((s) => s.id);` local, remove `trapSetpieceIds,` from the object passed to `createRun`, and remove `trap: trapSetpieceIds,` from the `setpieceIds` object passed to `chooseRunLayout`.

- [x] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, every test in the repo green — this step is the real safety net for this task's otherwise untested mechanical deletions, since removing a now-unread parameter can't change any test's observable behavior if every actual consumer was already cleaned up correctly in Tasks 1-2.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-runner.mjs scripts/dungeon-reseed.mjs scripts/ui/dungeon-app.mjs
git commit -m "feat(#754): remove trapSetpieceIds threading from every caller

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Independent trap-placement roll + live verification + version bump

**Files:**
- Modify: `scripts/dungeon-deck.mjs` (new `trapRollSucceeds`)
- Test: `tests/dungeon-deck.test.mjs`
- Modify: `scripts/dungeon-scene.mjs` (the trap build-time branch, moved and made kind-agnostic)
- Modify: `module.json`

**Interfaces:**
- Produces: `export function trapRollSucceeds(seed, roomId): boolean` (`scripts/dungeon-deck.mjs`) — consumed by `scripts/dungeon-scene.mjs`'s new build-time check.

- [x] **Step 1: Write the failing test for `trapRollSucceeds`**

Add to `tests/dungeon-deck.test.mjs`, in a new `describe` block:

```js
describe('trapRollSucceeds (#754)', () => {
  it('is deterministic for the same seed and roomId', () => {
    expect(trapRollSucceeds('alpha', 'room-5')).toBe(trapRollSucceeds('alpha', 'room-5'));
  });

  it('is independent per room — different roomIds can roll differently under the same seed', () => {
    const results = new Set();
    for (let i = 0; i < 200; i += 1) results.add(trapRollSucceeds('alpha', `room-${i}`));
    expect(results.has(true)).toBe(true);
    expect(results.has(false)).toBe(true);
  });

  it('succeeds at approximately the same rate traps occurred at before #754 (~8.3%, weight 1 of 12)', () => {
    let successes = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      if (trapRollSucceeds('rate-probe-seed', `room-${i}`)) successes += 1;
    }
    const rate = successes / trials;
    expect(rate).toBeGreaterThan(0.06);
    expect(rate).toBeLessThan(0.11);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t "trapRollSucceeds"`
Expected: FAIL — `trapRollSucceeds is not a function`.

- [x] **Step 3: Write `trapRollSucceeds`**

In `scripts/dungeon-deck.mjs`, add directly after `ROOM_KIND_WEIGHTS`:

```js
// #754: traps are no longer their own room kind — this independent roll
// replaces the old weight-1-of-12 share (~8.3%), applied per-room
// regardless of whichever kind the room actually is.
const TRAP_CHANCE = 1 / 12;

export function trapRollSucceeds(seed, roomId) {
  const rand = splitmix32(seedFromString(`${seed}-trap-chance-${roomId}`));
  return rand() < TRAP_CHANCE;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t "trapRollSucceeds"`
Expected: PASS, all 3 tests green.

- [x] **Step 5: Commit the pure function**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "feat(#754): add trapRollSucceeds independent placement check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [x] **Step 6: Replace the kind-gated trap branch in `dungeon-scene.mjs`**

Import `trapRollSucceeds` from `./dungeon-deck.mjs` at the top of `scripts/dungeon-scene.mjs` (add to whatever existing import from that file is already there, or add a new import line if none exists).

Add a new helper directly above `buildPopulateAndUnlockGraphNode` (mirrors `isSlotPopulated`'s own style):

```js
/** Whether roomId already has its own trap hazard placed — #754's own
 * idempotency check, deliberately NOT isSlotPopulated (that flag is
 * shared with combat's own encounter population, so it's already true
 * for a combat room before this check ever runs). */
function hasTrapInRoom(scene, roomId) {
  return scene.tokens.some(
    (t) =>
      t.getFlag(MODULE_ID, "trapHazard") &&
      t.getFlag(MODULE_ID, "dungeonSlot") === roomId,
  );
}
```

Remove the existing kind-gated trap branch:

```js
    if (
      room.kind === "trap" &&
      room.setpieceId &&
      !isSlotPopulated(scene, room.id)
    ) {
      await populateSlotTrap(scene, room.id, {
        rect,
        partyLevel: await makeFoundryApi().partyLevel(),
        levelOffsetBias: effectiveRoomBias({
          rank,
          maxRank: state.maxRank,
          isGoal: room.isGoal,
          difficulty: state.difficulty,
        }),
        locationTag: room.locationTag,
        seed: state.seed,
        roomId: room.id,
      });
    }
```

Add this new, kind-agnostic check at the point where both the `combat` branch and the non-combat `else` branch have already completed (i.e. after the enclosing `if (room.kind === "combat") { ... } else { ... }` block, not nested inside either arm):

```js
  if (
    !["safe_entry", "safe_rest"].includes(room.kind) &&
    !room.isGoal &&
    !hasTrapInRoom(scene, room.id) &&
    trapRollSucceeds(state.seed, room.id)
  ) {
    await populateSlotTrap(scene, room.id, {
      rect,
      partyLevel: await makeFoundryApi().partyLevel(),
      levelOffsetBias: effectiveRoomBias({
        rank,
        maxRank: state.maxRank,
        isGoal: room.isGoal,
        difficulty: state.difficulty,
      }),
      locationTag: room.locationTag,
      seed: state.seed,
      roomId: room.id,
    });
  }
```

- [x] **Step 7: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, every test in the repo green.

- [ ] **Step 8: Live-verify with `foundry-rest`**

Generate several real dungeon runs (varying seeds) and, for each, read back every room's kind alongside whether it has a trap hazard token:

```bash
echo 'const state = game.settings.get("pf2e-dungeon-crawl", "dungeonRuns")[canvas.scene.id]; return Object.values(state.rooms).map(r => ({kind: r.kind, hasTrap: canvas.scene.tokens.some(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard") && t.getFlag("pf2e-dungeon-crawl", "dungeonSlot") === r.id)}));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected, across several real runs: traps now appear in rooms of multiple different kinds (not only a dedicated `trap` kind, which no longer exists at all), never in a `safe_entry`/`safe_rest`/goal room, and at a rate in the same rough ballpark as `trapRollSucceeds`'s own confirmed ~8.3%. For any run that happens to include a `combat`-kind room with a trap, confirm the trap hazard token's own position doesn't overlap any of that room's encounter tokens (read both sets of tokens' `x`/`y`/`width`/`height` and check for overlap) — this is the one scenario Task 2's own unit tests can't exercise (`populateSlotTrap`'s real occupied-avoidance logic only runs against a live scene's real token positions).

- [x] **Step 9: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real behavioral change to room generation), e.g. `0.61.1` → `0.62.0`, using whatever the fetch above shows as current.

- [x] **Step 10: Commit**

```bash
git add scripts/dungeon-scene.mjs module.json
git commit -m "feat(#754): place traps independently of room kind at build time

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** The spec's four concrete pieces — remove `trap` from `ROOM_KIND_WEIGHTS`, delete the dead setpiece machinery, the new independent per-room roll, and leaving `dungeon-setpieces.json` untouched — map onto Task 1, Tasks 2-3, Task 4, and an explicit Global Constraint respectively. No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling" steps. Task 3's own note about `markRoomOutcome`'s broader dead-parameter situation is an explicit, bounded scope decision (documented, not silently expanded), not a placeholder for missing work.

**3. Type consistency:** `trapRollSucceeds(seed, roomId): boolean` (Task 4) is defined once and invoked with the identical argument order in `dungeon-scene.mjs`'s new check. `hasTrapInRoom(scene, roomId)` is defined once and used only where it's defined. Every deleted `trapSetpieceIds`/`trapOccurrence`/`detourTrapOccurrence` reference is removed consistently across all four generation functions in Task 2 and every caller in Task 3 — none is left dangling in one file while removed in another.

**4. Review Focus:** All five items (dead branches genuinely unreachable before deletion, combat-room overlap avoidance via ordering, the new trap-specific idempotency check vs. the unsafe `isSlotPopulated` reuse, safe/goal room exclusion, exhaustive existing-test fixes) each have a dedicated step, test, or explicit reasoning. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-decouple-traps-from-room-kind.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because Tasks 2-3 touch four generation functions and five call sites with mostly-mechanical-but-easy-to-miss deletions across multiple files — a fresh reviewer checking that every `trapSetpieceIds` reference was actually found and removed (not just the ones this plan's own investigation happened to enumerate) is worth more here than the cost of separate contexts, especially since Task 4's live verification builds on all of it being clean. Does the plan capture what you want, and which approach should we use?
