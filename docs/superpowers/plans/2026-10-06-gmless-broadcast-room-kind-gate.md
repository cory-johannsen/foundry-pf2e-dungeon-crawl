# GM-Less Broadcast Room-Kind Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #845 — the tracker never auto-opens on entering a treasure, puzzle, skill-challenge, or combat room, on **any** client, not just the GM's.

**Root cause (confirmed live-reading the real code and its own existing tests, not assumed):** #771 (merged) only gates the GM-side `updateWall` → `openDungeonTrackerIfNotOpen` path (`handleDungeonDoorOpened`'s own `autoOpenTracker`, confirmed current `scripts/dungeon-scene.mjs:2336-2339`). A completely separate path, `syncGmLessDungeonBroadcast` (`scripts/module.mjs:533-541`, #109), re-opens or re-renders the tracker for every connected client on every `dungeonRuns` setting change and on `canvasReady`, with no room-kind awareness at all.

**Scope correction found mid-investigation (confirmed by reading `tests/dungeon-permissions.test.mjs` directly, not assumed from the issue's own framing):** opening a **read-only** tracker instance for a non-host player is itself deliberate, already-tested #109 behavior (`decideGmLessBroadcast`'s own `"opens a fresh read-only instance for another player"` test) — a GM-less run has no human GM watching, so this gives every player *some* visibility. `canActOnDungeon` already gates the rendered context's own `interactive` flag false for a non-host, so that instance shows status only, never a redundant control. The original framing this session asked the user about ("scope the broadcast to the host only") would have silently removed that tested feature; the user confirmed the corrected fix instead — apply #771's own room-kind exclusion to the broadcast's open/render decision for **every** client, host or not, while leaving every other part of the existing host-vs-non-host behavior (read-only visibility, close-on-run-end) completely unchanged.

**Architecture:** #771's own literal exclusion list (`["combat", "treasure", "skill_challenge", "puzzle"]`, today duplicated nowhere else) is extracted into one new exported pure function, `roomKindAllowsTrackerAutoOpen(kind)`, in `scripts/dungeon-scene.mjs` — both `handleDungeonDoorOpened` (unchanged behavior, refactored to call it) and the new broadcast gate reuse the identical rule, so the two paths can never drift apart again. `decideGmLessBroadcast` (`scripts/dungeon-permissions.mjs`) gains one new optional parameter, `autoOpenAllowed`, gating only the closed→open transition — never the already-open "render" case or the run-ended "close" case, mirroring #771's own GM-side philosophy of never force-closing a tracker a user already has open.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a bounded fix extending an already-shipped rule to a second code path; the one real design fork (host-only scoping vs. applying the exclusion universally) was investigated, found to risk regressing a different tested feature, and corrected with the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A behavioral fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- The read-only visibility behavior for a non-host player (#109) is preserved **exactly** for every room kind #771 did not exclude — only the four already-excluded kinds additionally suppress the broadcast's own auto-open, on every client.
- An already-open tracker (host's or any other player's) is never force-closed by this change — `autoOpenAllowed` only ever blocks a closed→open transition, matching the GM-side path's own identical "never close, only skip re-opening" behavior.
- Trap, narrative, rest rooms, and the stub/dead-end door stay auto-opening everywhere, matching #771's own deliberate prior scope — the user explicitly declined widening this further.
- `roomKindAllowsTrackerAutoOpen`'s exclusion list must be the single source of truth both paths read — no second literal copy of the kind list anywhere.

## Review Focus

- **A treasure/puzzle/skill-challenge/combat room must never auto-open the tracker for a non-host player either**, not just the GM and the host — #845's own actual reported symptom.
- **A non-host player must still get the read-only auto-opened tracker for every other room kind** (narrative, rest, trap, the entry, etc.) — the #109 feature this plan must not regress.
- **An already-open tracker must keep re-rendering (staying in sync) regardless of room kind** — only the opening transition is gated, confirmed by this plan's own test for the "render" case.
- **The GM-side `handleDungeonDoorOpened` path's own existing behavior must be bit-for-bit unchanged** after the refactor — the extraction must be behavior-preserving, verified by the existing #771 tests passing unmodified.
- **A run that just ended (goal reached) must still close every open tracker on every client**, regardless of the goal room's own kind — the "close" transition is untouched by `autoOpenAllowed`.

---

### Task 1: Extract the shared exclusion rule

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`handleDungeonDoorOpened`)
- Test: `tests/dungeon-scene-retreat.test.mjs` (confirmed current, covers #771's own exclusion list — extend it), or a new small test block if a more fitting location exists for a standalone pure-function test

**Interfaces:**
- Produces: `export function roomKindAllowsTrackerAutoOpen(kind): boolean` — `true` for every kind except `"combat"`, `"treasure"`, `"skill_challenge"`, `"puzzle"`. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add a new small test block (in `tests/dungeon-scene-retreat.test.mjs`, or wherever reads most naturally alongside this file's own existing `#771` tests — check that file's own import line first and add `roomKindAllowsTrackerAutoOpen` to it):

```js
describe('roomKindAllowsTrackerAutoOpen (#845)', () => {
  it.each(['combat', 'treasure', 'skill_challenge', 'puzzle'])(
    'excludes %s',
    (kind) => {
      expect(roomKindAllowsTrackerAutoOpen(kind)).toBe(false);
    },
  );

  it.each(['narrative', 'safe_rest', 'safe_entry', undefined, null])(
    'allows %s',
    (kind) => {
      expect(roomKindAllowsTrackerAutoOpen(kind)).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-retreat.test.mjs -t "roomKindAllowsTrackerAutoOpen"`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Extract the function**

In `scripts/dungeon-scene.mjs`, add directly above `handleDungeonDoorOpened` (confirmed current function start, around line 2170):

```js
/** #771/#845: the room kinds that never auto-open the Dungeon Tracker on
 * entry — #611/#623 gave treasure/puzzle/skill-challenge their own
 * interactable room-feature token, and combat already draws attention
 * through Foundry's native Combat Tracker, so none of the four need the
 * Dungeon Tracker popping up uninvited. The single source both the
 * GM-side door-open path (below) and the GM-less broadcast path
 * (module.mjs's syncGmLessDungeonBroadcast, #845) read, so they can never
 * drift apart into two different rules for the same thing. */
export function roomKindAllowsTrackerAutoOpen(kind) {
  return !["combat", "treasure", "skill_challenge", "puzzle"].includes(kind);
}
```

Change the function's own return statement (confirmed current, lines 2336-2340):

```js
    return {
      autoOpenTracker: !["combat", "treasure", "skill_challenge", "puzzle"].includes(
        room?.kind,
      ),
```

to:

```js
    return {
      autoOpenTracker: roomKindAllowsTrackerAutoOpen(room?.kind),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-retreat.test.mjs -t "roomKindAllowsTrackerAutoOpen"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — in particular, every existing #771 test in this file (the ones exercising `handleDungeonDoorOpened`'s own `autoOpenTracker` value) stays green, confirming the extraction is behavior-preserving.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-retreat.test.mjs
git commit -m "refactor(#845): extract roomKindAllowsTrackerAutoOpen as the one shared rule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate the GM-less broadcast on the same rule

**Files:**
- Modify: `scripts/dungeon-permissions.mjs` (`decideGmLessBroadcast`)
- Modify: `scripts/module.mjs` (`syncGmLessDungeonBroadcast`)
- Test: `tests/dungeon-permissions.test.mjs`

**Interfaces:**
- Produces: `decideGmLessBroadcast(hostedRun, hasOpenInstance, {userRef, autoOpenAllowed = true})` — the new third option, defaulting `true` so every existing call/test keeps its current behavior unless it explicitly opts into the new gate.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-permissions.test.mjs`, inside the existing `describe("decideGmLessBroadcast", ...)` block (confirmed current, reusing its own `gm`/`player`/`otherPlayer` fixtures exactly):

```js
  it("#845: does not open a fresh instance for the host when the current room excludes auto-open", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, {
        userRef: player,
        autoOpenAllowed: false,
      }),
    ).toEqual({ action: "none" });
  });

  it("#845: does not open a fresh read-only instance for another player either, when excluded", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, {
        userRef: otherPlayer,
        autoOpenAllowed: false,
      }),
    ).toEqual({ action: "none" });
  });

  it("#845: still re-renders an already-open instance even when the current room excludes auto-open", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, true, {
        userRef: otherPlayer,
        autoOpenAllowed: false,
      }),
    ).toEqual({ action: "render" });
  });

  it("#845: still closes on run end regardless of autoOpenAllowed", () => {
    expect(
      decideGmLessBroadcast(null, true, {
        userRef: otherPlayer,
        autoOpenAllowed: false,
      }),
    ).toEqual({ action: "close" });
  });

  it("#845: defaults autoOpenAllowed to true (every existing caller/test is unaffected)", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: otherPlayer })).toEqual({
      action: "open",
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-permissions.test.mjs -t "#845"`
Expected: FAIL.

- [ ] **Step 3: Add the gate**

In `scripts/dungeon-permissions.mjs`, change `decideGmLessBroadcast` (confirmed current, lines 48-57):

```js
export function decideGmLessBroadcast(
  hostedRun,
  hasOpenInstance,
  { userRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "none" };
  if (hostedRun) return { action: hasOpenInstance ? "render" : "open" };
  return { action: hasOpenInstance ? "close" : "none" };
}
```

to:

```js
export function decideGmLessBroadcast(
  hostedRun,
  hasOpenInstance,
  { userRef = null, autoOpenAllowed = true } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "none" };
  if (hostedRun) {
    if (hasOpenInstance) return { action: "render" };
    // #845: gates only the closed -> open transition, on every client
    // (host or not) -- an already-open tracker (the branch above) keeps
    // rendering regardless, and a run ending (the branch below) always
    // still closes everything, matching #771's own "never force-close,
    // only skip re-opening" rule exactly.
    return { action: autoOpenAllowed ? "open" : "none" };
  }
  return { action: hasOpenInstance ? "close" : "none" };
}
```

- [ ] **Step 4: Wire the real room-kind check into the broadcast sync**

In `scripts/module.mjs`, add `roomKindAllowsTrackerAutoOpen` to the existing multi-line import from `./dungeon-scene.mjs` (confirmed current, ends line 42). Change `syncGmLessDungeonBroadcast` (confirmed current, lines 533-542):

```js
function syncGmLessDungeonBroadcast() {
  const existing = foundry.applications.instances.get("pf2edc-dungeon-app");
  const decision = decideGmLessBroadcast(
    findHostedRunForBroadcast(),
    !!existing,
  );
  if (decision.action === "open") new DungeonApp().render(true);
  else if (decision.action === "render") existing.render();
  else if (decision.action === "close") existing.close();
}
```

to:

```js
function syncGmLessDungeonBroadcast() {
  const existing = foundry.applications.instances.get("pf2edc-dungeon-app");
  const hostedRun = findHostedRunForBroadcast();
  // #845: the same room-kind rule the GM-side door-open path uses --
  // computed here (not inside decideGmLessBroadcast, which stays Foundry-
  // free/pure) since it needs a real getRunState lookup.
  const state = hostedRun ? getRunState(hostedRun.sceneId) : null;
  const currentRoom = state?.rooms?.[state.currentRoomId];
  const decision = decideGmLessBroadcast(hostedRun, !!existing, {
    autoOpenAllowed: roomKindAllowsTrackerAutoOpen(currentRoom?.kind),
  });
  if (decision.action === "open") new DungeonApp().render(true);
  else if (decision.action === "render") existing.render();
  else if (decision.action === "close") existing.close();
}
```

(`getRunState` is already imported in this file, confirmed current — no new import needed for it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-permissions.test.mjs`
Expected: PASS, old and new cases green.

- [ ] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-permissions.mjs scripts/module.mjs tests/dungeon-permissions.test.mjs
git commit -m "fix(#845): gate the GM-less broadcast auto-open on the same room-kind rule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Live verification, version bump

**Files:**
- Modify: `module.json`

No code changes in this task — verification and the version bump only.

- [ ] **Step 1: Live-verify via `foundry-rest`**

In a real GM-less (hosted) run, close the tracker on a non-host player's client, then advance into a treasure room: confirm it stays closed on that client (and on the host's, and the GM's). Advance into a narrative or rest room: confirm it still auto-(re)opens as a read-only instance for a non-host player, unchanged from today. With the tracker already open on a non-host client, advance into an excluded-kind room: confirm the open tracker keeps updating (doesn't freeze or close). Finally, resolve the run's goal room (any kind) and confirm every client's tracker still closes.

```bash
echo 'return !!foundry.applications.instances.get("pf2edc-dungeon-app");' | .claude/skills/foundry-rest/foundry-exec.sh
```

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a behavioral fix), using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#845): bump version for GM-less broadcast room-kind gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #845's own "Expected" section ("the tracker never auto-opens on room entry for treasure, puzzle, skill-challenge or combat rooms on any client") is fully covered: the same rule now gates both paths. Its own open questions are both answered and recorded: non-GM auto-open stays (read-only, #109, confirmed deliberate via its own existing test) but now room-kind-gated; trap/narrative/rest/stub stay unchanged per the user's explicit decision not to widen #771 further.

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real change.

**3. Type consistency:** `roomKindAllowsTrackerAutoOpen(kind): boolean` (Task 1) is used identically in both its own refactored call site and Task 2's new one. `decideGmLessBroadcast`'s new `autoOpenAllowed` option defaults to `true`, so its existing signature and every pre-existing call/test keep working unchanged — confirmed by the dedicated default-behavior test in Task 2.

**4. Review Focus:** All five items (excluded kinds blocked for non-host too, read-only visibility preserved for every other kind, already-open trackers keep rendering, the GM-side path's own behavior is bit-for-bit unchanged, run-end close is unaffected) each have a dedicated test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-gmless-broadcast-room-kind-gate.md`.
