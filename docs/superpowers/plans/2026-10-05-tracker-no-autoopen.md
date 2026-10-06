# Tracker No-Autoopen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #771 — stop the Dungeon Tracker window from auto-opening when the party enters a treasure, skill-challenge, puzzle, or combat room. Today it already skips combat; the fix extends the same exclusion to the other three kinds, now that #611/#623 give them their own interactable room-feature tokens instead of tracker buttons.

**Architecture:** One line owns this behavior: `handleDungeonDoorOpened`'s final `return { autoOpenTracker: room?.kind !== "combat" }` (`scripts/dungeon-scene.mjs:2130`). `module.mjs`'s `updateWall` hook reads that boolean and calls `openDungeonTrackerIfNotOpen()` — confirmed current, nothing else in the codebase decides this. The fix widens the exclusion list; nothing else changes. Both #611 and #623 are already merged and confirmed to give treasure/puzzle/skill-challenge rooms their own token-click interaction and their own chat announcements (gp/item found, XP grant via #782's own fix) independent of whether the tracker window is open — confirmed by reading `scripts/ui/dungeon-app.mjs`'s `recordSkillChallengeOutcome`/`recordPuzzleStageOutcome`/the treasure-claim handler directly, so #771's own "make sure nothing is lost" concern is already satisfied by existing code, not something this plan needs to add.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a one-line behavioral change with a single, already-confirmed-safe resolution; no open design question.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A small behavioral change: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- The stub-door branch's own `return { autoOpenTracker: true }` (confirmed current, `scripts/dungeon-scene.mjs:2012`) is unrelated to room-kind and is **not touched** — it fires for a dead-end-corridor discovery regardless of the current room's kind, which #771 does not mention.
- Narrative and `safe_rest` rooms keep auto-opening (#771's own scope: "behaviour for other room kinds... is unchanged unless decided otherwise") — only `combat` (already excluded), `treasure`, `skill_challenge`, and `puzzle` are added to the exclusion.
- No change to how treasure/puzzle/skill-challenge rooms are actually resolved (#611/#623's own token-click flow) — this plan only changes whether the tracker window pops up automatically alongside that existing flow.

## Review Focus

- **The exclusion must check the real room-kind strings this codebase actually uses** (`treasure`, `skill_challenge`, `puzzle`, `combat` — confirmed current via `ROOM_KIND_WEIGHTS` in `scripts/dungeon-deck.mjs`), not a guessed or differently-cased variant.
- **Every other room kind (`narrative`, `safe_rest`, and any future kind) must still auto-open** — the fix is an exclusion list, not an allow-list, so an unrecognized or new kind defaults to still opening, matching today's behavior for anything that isn't explicitly listed.
- **The stub-door branch's unconditional `autoOpenTracker: true` must be unaffected** — it has no `room` variable in scope at all at that point in the function and must not be touched.
- **A revisited (already-judged) room's `autoOpenTracker: false` early return must be unaffected** — that path returns before the room-kind line is ever reached, for any room kind.

---

### Task 1: Widen the room-kind exclusion

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`handleDungeonDoorOpened`'s return + its own doc comment)
- Test: `tests/dungeon-scene-retreat.test.mjs`

**Interfaces:** None — no function signature changes; `handleDungeonDoorOpened`'s own `{autoOpenTracker}` return shape is unchanged, only which room kinds produce `false`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-scene-retreat.test.mjs`, inside the existing `describe('handleDungeonDoorOpened stub and revisit branches (#439 R3.2)', ...)` block (reusing its own `wall`/`token`/`v3State`/`installGlobals` fixtures exactly, mirroring the existing "first entry of an unjudged combat room still reveals and starts combat" test):

```js
  it.each(['treasure', 'skill_challenge', 'puzzle'])(
    '#771: a %s room does not auto-open the tracker',
    async (kind) => {
      const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
      const scene = makeScene({ walls: [revealB] });
      scenes.set(SID, scene);
      const state = v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] });
      state.rooms.b = { ...state.rooms.b, kind };
      await seed(state);
      const res = await handleDungeonDoorOpened(SID, 'w-b');
      expect(res.autoOpenTracker).toBe(false);
    },
  );

  it.each(['narrative', 'safe_rest'])(
    '#771: a %s room still auto-opens the tracker',
    async (kind) => {
      const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
      const scene = makeScene({ walls: [revealB] });
      scenes.set(SID, scene);
      const state = v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] });
      state.rooms.b = { ...state.rooms.b, kind, outcomeSlotId: null };
      await seed(state);
      const res = await handleDungeonDoorOpened(SID, 'w-b');
      expect(res.autoOpenTracker).toBe(true);
    },
  );
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-retreat.test.mjs -t "#771"`
Expected: the three `treasure`/`skill_challenge`/`puzzle` cases FAIL (`autoOpenTracker` is still `true` today); the two `narrative`/`safe_rest` cases already PASS (today's behavior is already `true` for them) — confirming the test correctly targets only the intended change.

- [ ] **Step 3: Widen the exclusion**

In `scripts/dungeon-scene.mjs`, change the final return (currently, line 2130):

```js
    return { autoOpenTracker: room?.kind !== "combat" };
```

to:

```js
    return {
      autoOpenTracker: !["combat", "treasure", "skill_challenge", "puzzle"].includes(
        room?.kind,
      ),
    };
```

- [ ] **Step 4: Update the stale doc comment**

The function's own doc comment (confirmed current, lines 1965-1976) still says "a skill challenge, puzzle/trap, narrative, or rest room has no such native surface at all" — stale now that #611/#623 gave treasure/skill-challenge/puzzle rooms their own interactable room-feature tokens. Change:

```js
 * Returns `{ autoOpenTracker }` (`false` on every early-return path, since
 * nothing was actually revealed) — #158: a combat room's own reveal already
 * draws the GM's attention through Foundry's native Combat Tracker the
 * instant `startCombatForRoom` runs below, but a skill challenge, puzzle/
 * trap, narrative, or rest room has no such native surface at all, so
 * without this the GM has to know to reopen the Dungeon Crawl tracker
 * themselves just to see the Succeed/Fail buttons. module.mjs's own
 * `updateWall` hook (which this file deliberately never imports back into,
 * see this file's own docblock) is what actually opens `DungeonApp` — this
 * only ever hands back the plain boolean, same bridge pattern
 * `onCombatAutoResolved` already uses for `resolveCurrentRoom`.
 */
```

to:

```js
 * Returns `{ autoOpenTracker }` (`false` on every early-return path, since
 * nothing was actually revealed) — #158, narrowed by #771: a combat room's
 * own reveal already draws the GM's attention through Foundry's native
 * Combat Tracker the instant `startCombatForRoom` runs below, and treasure/
 * skill-challenge/puzzle rooms (#611/#623) are now resolved by clicking
 * their own interactable room-feature token, with their own chat
 * announcements for gp/item found or XP earned (grantPartyXp, #782) —
 * neither needs the Dungeon Crawl tracker window open at all. Only a
 * narrative or rest room still has no native surface of its own, so those
 * (and any future unlisted kind) still auto-open it. module.mjs's own
 * `updateWall` hook (which this file deliberately never imports back into,
 * see this file's own docblock) is what actually opens `DungeonApp` — this
 * only ever hands back the plain boolean, same bridge pattern
 * `onCombatAutoResolved` already uses for `resolveCurrentRoom`.
 */
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-retreat.test.mjs -t "#771"`
Expected: PASS, all five cases green.

- [ ] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — in particular every existing test in `tests/dungeon-scene-retreat.test.mjs` and `tests/dungeon-scene.test.mjs` (all of which use `kind: 'combat'` or `kind: 'safe_rest'` fixtures, confirmed via this session's own search) stays green, since neither of those kinds' `autoOpenTracker` results changed.

- [ ] **Step 7: Live-verify via `foundry-rest`**

Close the tracker window, then advance a real dungeon run's door-open into a treasure room, a skill-challenge room, and a puzzle room in turn, confirming the tracker stays closed for each and that the room's own token-click interaction, chat announcements, and (where applicable) XP grant still work exactly as before. Then confirm a narrative or rest room still auto-opens it as before.

```bash
echo 'return !!foundry.applications.instances.get("pf2edc-dungeon-app");' | .claude/skills/foundry-rest/foundry-exec.sh
```

- [ ] **Step 8: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a small behavioral change), using whatever the fetch above shows as current.

- [ ] **Step 9: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-retreat.test.mjs module.json
git commit -m "fix(#771): stop the tracker auto-opening for treasure, skill-challenge, and puzzle rooms

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #771's own ask (stop auto-open for treasure/skill-challenge/puzzle/combat; combat already excluded; other kinds unchanged; nothing the tracker surfaced for these rooms should be lost) is fully covered: Task 1 widens the exclusion, confirms (via direct code reading, not assumption) that treasure/skill-challenge/puzzle already have their own chat announcements and token-click resolution independent of the tracker, and leaves narrative/rest untouched. #771's own named dependencies (#616, #611, #623) are all confirmed merged/closed.

**2. Placeholder scan:** No TBD/TODO. The code change and doc-comment rewrite are the complete real text.

**3. Type consistency:** `handleDungeonDoorOpened`'s return shape (`{autoOpenTracker: boolean}`) is unchanged; no caller needs touching.

**4. Review Focus:** All four items (correct real kind strings, exclusion-not-allow-list behavior for unlisted kinds, stub-door branch untouched, revisit early-return untouched) are each pinned by a specific test or by this plan's own scoped diff touching only the one line both of those other paths never reach. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-tracker-no-autoopen.md`.
