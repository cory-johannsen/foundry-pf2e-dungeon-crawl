# Corridor Wall-Generation Mismatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #877 — three separate wall-generation mechanisms (`transitCellContainmentWalls`, `cellMarginWalls`, `roomEnclosureWalls`) each sometimes draw a solid wall across a cell boundary the corridor's own art shows as open, concentrated on hidden-detour edges. Already measured with a committed, categorized sweep (`tests/dungeon-corridor-wall-crossing-sweep.test.mjs`, added in #861's own PR): 101 crossings across 11/100 seeds, split `dungeonCellMarginWallForRoom: 29`, `dungeonTransitCellMarginForCell+dungeonTransitCellOpenings: 70`, `dungeonEnclosureWallForRoom+dungeonEnclosureWallDirection: 2`.

**Investigation state going into this plan (this session):** The transit-cell case (the issue's own suggested starting point) is the most concrete of the three — a transit cell's tile and its own margin wall both theoretically derive from the same `transitCellCrossing()` output (`corridorSegments`), confirmed by reading `corridorEdgeTiles` (`scripts/dungeon-scene.mjs:286-288`: `transits = transitCells.map((c) => corridorTilesForSegments(c.corridorSegments))`) against `buildTransitCellIfNeeded`'s own margin-wall code (uses `cell.entryPoint`/`cell.exitPoint` directly) — so in principle they should already agree. They empirically don't (confirmed: seed-8's own recorded wall opening sits at y=28, the real tile joint at y=32). An attempt this session to independently re-derive the exact crossing for seed-8's own edge (calling `layoutEdgeGeometry` with a hand-reconstructed `occupiedCells`/`routingFor`/state outside the real scene-build call chain) produced a **different** transit-cell structure than `buildSceneForLayout` actually used for that same edge — meaning some build-order or accumulated-state dependency (`claimedCorridorCells`, prior `dungeonTransitCellOpenings` accumulation, or similar) isn't captured by a standalone reconstruction. Getting the real numbers needs instrumenting the actual build path directly, not a parallel reconstruction — implementation-level iteration this plan hands to whoever executes it, rather than a guessed fix.

**Architecture:** Each of the three mechanisms gets its own instrument-compare-fix task, in the order the issue itself suggests (transit-cell first, since it's the most concrete; then the two smaller categories). Each task starts by adding **temporary** `console.log` instrumentation directly in the real function (not a parallel reconstruction, which this session confirmed is unreliable), running the already-committed sweep (`tests/dungeon-corridor-wall-crossing-sweep.test.mjs`) or a narrower single-seed repro against the real build, reading the actual values, and only then designing the fix — removing the temporary logging before the real fix is committed. After each task, the sweep is re-run and re-measured before deciding whether the next task's own category still needs its own separate fix, since it is not yet known whether these are one shared root cause or three independent ones.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — each category's own fix is investigated and designed at implementation time by the instrumentation step below, not guessed at here.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real behavioral fix to corridor-adjacent wall geometry: minor bump if any category's fix changes wall positions for a broad class of edges, patch if narrowly scoped — decide based on the real diff once Task 1-3 land.
- Every temporary instrumentation `console.log` added during investigation is removed before that task's own commit — a shipped fix never carries debug logging.
- `tests/dungeon-corridor-wall-crossing-sweep.test.mjs`'s own `expect(byCategory)...` assertion (confirmed current, pinned to `{dungeonCellMarginWallForRoom: 29, 'dungeonTransitCellMarginForCell+dungeonTransitCellOpenings': 70, 'dungeonEnclosureWallForRoom+dungeonEnclosureWallDirection': 2}`) is updated to the real post-fix numbers after each task, never left stale, and a category fully resolved to 0 is removed from the pinned object entirely (not kept as a dead `0` entry).
- Per the issue's own open question ("one shared root cause or three, not yet determined"): each task must independently confirm via the sweep whether its own fix also resolved a *different* category before assuming it didn't — don't skip re-measuring between tasks.

## Review Focus

- **The transit-cell case's own real divergence (wall opening vs. real tile position) must be captured from the actual build path, with real logged values, before any fix is designed** — the one piece of groundwork this session's own investigation found a dead end on (a parallel reconstruction that didn't match reality).
- **A fix must never regress the #860/#861-era sweeps** (`tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs`, `tests/dungeon-corridor-joins-sweep.test.mjs`) — both already pin real corridor-geometry numbers that a wall-only fix should not disturb, but must be re-checked, not assumed safe.
- **Every fixed category's pinned sweep count must drop to exactly what's actually measured after the fix**, never guessed in advance — the sweep's own `toEqual` assertion will tell the implementer the real number on a failed run; that real number is what gets written back, not a rounded-down guess.
- **A category whose root cause turns out shared with another (if a fix for one empirically also resolves another) must not be fixed twice** — re-measure after each task before starting the next.
- **If any category proves unexpectedly deep (matching this session's own transit-cell reconstruction dead-end) partway through a task**, that task's own closing step is to re-file the remaining category with whatever real evidence was gathered, rather than force a guessed fix — the same honest-residual pattern #860/#861/#873 already established in this exact corridor subsystem.

---

### Task 1: Transit-cell margin wall (the issue's own suggested start)

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (temporary instrumentation, then `transitCellCrossing` or wherever the real fix lands) and/or `scripts/dungeon-scene.mjs` (`buildTransitCellIfNeeded`)
- Test: `tests/dungeon-corridor-wall-crossing-sweep.test.mjs` (update the pinned count)

- [ ] **Step 1: Instrument the real build path for seed-8's own known-mismatched crossing**

Add a temporary `console.log` directly inside `transitCellCrossing` (confirmed current, `scripts/dungeon-layout.mjs:2249`), logging `{rank, col, entrySide, exitSide, edgeId, entryPoint, exitPoint, corridorSegments}` on every call, and another inside `buildTransitCellIfNeeded` (confirmed current, `scripts/dungeon-scene.mjs:419`) logging `{cellKey, openings, corridorTiles: corridorTiles.map(t => ({x: t.x, y: t.y}))}` right before it calls `transitCellContainmentWalls`.

Run the existing committed sweep narrowed to seed-8 only (temporarily change `SEEDS = 100` to a loop over just `[8]`, or run `tests/dungeon-corridor-wall-crossing-sweep.test.mjs` with a quick local edit — revert the narrowing afterward, keep the test file itself unchanged except the instrumentation being investigated elsewhere):

```bash
npx vitest run tests/dungeon-corridor-wall-crossing-sweep.test.mjs 2>&1 | tee /tmp/877-seed8-trace.log
```

Find the specific `edgeId: room-room-room-entry-1-1->room-detour-0` entries in the log and compare: does the `entryPoint`/`exitPoint` logged by `transitCellCrossing` match the `corridorTiles`' own real `{x,y}` positions logged by `buildTransitCellIfNeeded`, for the SAME cell/edge? If they already match at this point, the divergence is introduced later (e.g., in `corridorEdgeTiles`'s own cell-ownership/claiming logic, or in `skipClaimedCorridorTiles`) — follow the value forward from here rather than assuming this is the only place to look.

- [ ] **Step 2: Design and apply the fix from the real logged values**

Once the exact point of divergence is identified (not guessed), apply the minimal correction — likely either passing the same already-committed point through to whichever computation currently re-derives it independently, or correcting a flooring/rounding mismatch (`corridorTilesForSegments`'s own `Math.floor(segment.gx/gy)`, confirmed current `scripts/dungeon-scene.mjs:259-260`, is a known candidate given #324's own prior history with exactly this class of floor-vs-fractional mismatch in this same file).

- [ ] **Step 3: Remove the temporary instrumentation**

Delete both `console.log` additions from Step 1.

- [ ] **Step 4: Re-run the full sweep, read the real new numbers**

Run: `npx vitest run tests/dungeon-corridor-wall-crossing-sweep.test.mjs`
Expected: the test FAILS on its own stale `expect(byCategory)...` assertion — read the actual `byCategory` object Vitest prints on the mismatch. Update the assertion to those real numbers. If `dungeonTransitCellMarginForCell+dungeonTransitCellOpenings` is now `0`, remove that key from the pinned object entirely rather than leaving a `0`.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, including `tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs` and `tests/dungeon-corridor-joins-sweep.test.mjs` unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/dungeon-scene.mjs tests/dungeon-corridor-wall-crossing-sweep.test.mjs
git commit -m "fix(#877): transit-cell margin wall agrees with the real corridor tile position

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Room cell-margin wall (`dungeonCellMarginWallForRoom`, 29 instances)

- [ ] **Step 1: Check whether Task 1's fix already resolved this category**

Read Task 1 Step 4's own real `byCategory` numbers again — if `dungeonCellMarginWallForRoom` already dropped, this task may be partially or fully unnecessary; confirm from the real measured count before investigating further.

- [ ] **Step 2: Instrument the real build path for a named `dungeonCellMarginWallForRoom` crossing**

Using the same technique as Task 1 Step 1 (temporary `console.log`, run the sweep, revert after), instrument `cellMarginWalls`' own caller (confirmed current, `scripts/dungeon-scene.mjs:739-768`: `plannedMarginOpenings`/`pendingForeignMarginOpenings` feeding `openingsBySide`) against the real corridor tile positions for one of the seeds the sweep's own `examples` (or a quick ad-hoc log of `all.otherRoom`-style data) names for this category.

- [ ] **Step 3: Design and apply the fix, remove instrumentation, re-measure, commit**

Same shape as Task 1 Steps 2-6. If this category proves to need deeper investigation than a single pass reasonably affords (matching this session's own transit-cell reconstruction dead-end), stop and re-file it with whatever real evidence was gathered rather than guessing — do not force an unverified fix.

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-corridor-wall-crossing-sweep.test.mjs
git commit -m "fix(#877): room cell-margin wall agrees with the real corridor tile position

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Room enclosure wall (`dungeonEnclosureWallForRoom`, 2 instances)

- [ ] **Step 1: Check whether Tasks 1-2's fixes already resolved this category**

Same re-measurement check as Task 2 Step 1.

- [ ] **Step 2: Instrument and fix, same shape as Tasks 1-2**

`roomEnclosureWalls` (confirmed current, `scripts/dungeon-layout.mjs:420`) is the mechanism; only 2 instances exist in the measured 100 seeds, so this is likely the fastest of the three to pin down once instrumented. Same instrument → compare → fix → remove instrumentation → re-measure → commit shape.

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-corridor-wall-crossing-sweep.test.mjs
git commit -m "fix(#877): room enclosure wall agrees with the real corridor tile position

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Final sweep reconciliation

- [ ] **Step 1: Run the full sweep one more time, confirm the pinned object matches reality exactly**

Run: `npx vitest run tests/dungeon-corridor-wall-crossing-sweep.test.mjs`
Expected: PASS, with `expect(byCategory)...` reflecting whatever real, final state the three tasks above left — ideally `{}` (every category resolved), but honestly whatever remains if a category was re-filed instead of fixed.

- [ ] **Step 2: If any category remains unresolved, file its own follow-up issue with the real gathered evidence**

Same disposition pattern #860/#861/#873 already established: real measured counts, named example seeds, and whatever the instrumentation step actually revealed about the mechanism — never a guess.

- [ ] **Step 3: Run the full test suite one final time**

Run: `npx vitest run`
Expected: PASS across the board.

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump if any task's own fix changed wall geometry broadly (likely, given three separate mechanisms), or **patch** if the real diff turned out narrower than expected — decide from the actual commits made in Tasks 1-3, not in advance.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#877): bump version for the corridor wall-generation mismatch fixes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #877's own three measured categories each get their own dedicated task, in the issue's own suggested order, with re-measurement between each to catch a shared root cause rather than assuming independence. The issue's own explicit "not yet determined" question is directly addressed by Task 2 Step 1 / Task 3 Step 1's own re-check.

**2. Placeholder scan:** No guessed fix code — this plan is honest that the exact code change for each category is not yet known, and gives a concrete, specific instrumentation methodology (exact functions, exact seed, exact technique already proven in this session's own investigation) rather than a vague "investigate and fix" placeholder.

**3. Type consistency:** No new exported interfaces are introduced by this plan itself; each task's own fix shape depends on what its own instrumentation reveals, consistent with this plan's own stated epistemic honesty about not yet knowing the fix.

**4. Review Focus:** All five items (real logged values before any fix, existing sweeps never assumed safe, pinned counts always read from real failures not guessed, no double-fixing a shared cause, an honest re-file when a category proves too deep) each map to a specific step across the three tasks. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-corridor-wall-generation-mismatch.md`.
