# Corridor Trap Description Chat Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #820 — a corridor-placed trap's own customized description is never shown to players anywhere, unlike a room trap's (visible via the tracker's room-info panel).

**Premise narrowed (confirmed by direct code reading + resolved this session via AskUserQuestion):** #820's own title asks for "tracker display parity," but investigation found the real gap is smaller than that implies:
- **#136 (agent customization) already works for a corridor trap today, mostly.** `getPendingTrapCustomization` (confirmed current, `scripts/trap-combat.mjs:726`) scans every hidden token for a pending `trapCustomization` flag with no room/edge filtering at all — a corridor trap's hazard token is found exactly the same as a room trap's. `applyTrapCustomization`'s own `actor.update({name, description})` (confirmed current, line 773-789) writes directly onto the hazard Actor regardless of whether its own `trapCustomization.roomId` is a real room id or (for a corridor trap) an edge id string — only the *separate* `applyTrapRoomState` mirror call additionally no-ops for an edge id (`state.rooms[edgeId]` is never populated, confirmed via `ensureTrapState`/`applyTrapRoomState`, `scripts/dungeon-runner.mjs:898`/`958`, both keyed strictly on real room-graph nodes).
- **A customized *name* already reaches players correctly for a corridor trap, with zero extra plumbing.** `handleTrapTokenMove`'s own trigger/detect chat announcements (confirmed current, `scripts/trap-combat.mjs:572-575`, `603-606`) and `attemptTrapDisableForScene`'s own critical-failure announcement (line 669-672) all read `hazardActor.name` **live**, at the moment of the event — any customization `applyTrapCustomization` already applied to the actor's own name shows up correctly, room or corridor alike.
- **The one real, confirmed gap: a trap's own customized *description* is never shown anywhere except the room tracker panel** (`currentRoom.trap.description`, confirmed current, `scripts/ui/dungeon-app.mjs:1196-1197`) — which only exists for rooms. A corridor has no tracker panel at all (confirmed: no "current corridor" UI concept exists anywhere in this codebase), so its own description has nowhere to surface.

**Scope decision (resolved this session via AskUserQuestion):** Chat-based parity, not a new UI surface. Add the trap's own description to the same existing trigger/detection chat messages that already show its name — for room and corridor traps alike — reading it live off the actor, exactly the same way `name` already is. No new persisted state, no "current corridor" concept, no new tracker panel. The room tracker panel itself is untouched (still shows a room trap's own description there too — this is an addition, not a replacement).

**Architecture:** A small, shared formatting helper builds an optional trailing clause (`" — {description}"` or empty) from `hazardActor.system?.details?.description`, passed as a new `description` field into the existing `"PF2EDC.Dungeon.Trap.TriggeredChat"`/`"PF2EDC.Dungeon.Trap.DetectedChat"` i18n templates (confirmed current, `lang/en.json:164`/`176`), which gain a trailing `{description}` placeholder.

**Tech Stack:** Vanilla ES modules, Vitest, Foundry i18n.

**Spec:** None — bounded; confirmed via AskUserQuestion this session, no further design ambiguity remains.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A small, additive chat-message change: patch bump.
- `getPendingTrapCustomization`/`applyTrapCustomization`'s own exported signatures and behavior (confirmed current) are **unchanged** — this plan only changes what the trigger/detect chat messages include, never the customization write path itself.
- The room tracker panel's own existing description display (`scripts/ui/dungeon-app.mjs:1196-1197`) is **unchanged** — this is additive (chat gains a description too), not a replacement.
- `DetectionRollGM` (the GM-only secret-check whisper, confirmed current `scripts/trap-combat.mjs:593-599`) is **out of scope** — the GM already has direct access to the hazard actor; only the two player-facing announcements (`TriggeredChat`, `DetectedChat`) and the critical-failure variant in `attemptTrapDisableForScene` gain the description.
- A trap with no customized (or no compendium-default) description must render the SAME message as before this fix, with no trailing dash/empty clause artifact — the optional-clause formatting must degrade cleanly to nothing, not `"... trap! — "` or similar.

## Review Focus

- **A corridor trap's own customized description must now appear in its own TriggeredChat/DetectedChat messages**, matching a room trap's own now-equally-covered behavior — the issue's own real, confirmed gap.
- **A trap with no description at all (compendium default, uncustomized, empty string) must render identically to today's message** — no trailing artifact, no `"undefined"`/empty-dash text.
- **A long compendium description is used as-is, not reformatted or truncated** — the hazard actor's own `system.details.description` field is the same short, "narrative flavor" field #136's own customization already targets (confirmed distinct from an action item's own full mechanical `system.actions[].description` prose, which this plan never touches).
- **The GM-only `DetectionRollGM` whisper is unaffected** — confirmed by a specific test, not just by omission.
- **The room tracker panel's own description display keeps working exactly as before** — a regression check, not an assumption.

---

### Task 1: Description clause in the trigger/detect chat announcements

**Files:**
- Modify: `scripts/trap-combat.mjs` (`handleTrapTokenMove`, `attemptTrapDisableForScene`)
- Modify: `lang/en.json`
- Test: `tests/trap-token-move.test.mjs`, `tests/trap-disable-ui.test.mjs` (or wherever each of the three call sites' own existing tests live — confirm with `grep -rln "TriggeredChat\|DetectedChat" tests/` before editing)

**Interfaces:**
- Produces: a new internal helper (not exported unless an existing test file needs direct access) formatting a hazard actor's own optional description clause — `descriptionClause(hazardActor): string` (`" — {text}"` or `""`).

- [ ] **Step 1: Check which existing tests cover these three call sites**

```bash
grep -rln "TriggeredChat\|DetectedChat" tests/
```

Read each matching file's own existing assertions on the `announce`/`whisperGM` mock calls before writing new ones, so the new `description` field is added consistently with how each file already asserts on the data object.

- [ ] **Step 2: Write the failing tests**

Add to the relevant existing test file(s) found in Step 1 (follow each file's own existing mock/fixture conventions rather than inventing new ones):

```js
it("#820: includes the hazard's own description in the TriggeredChat announcement", async () => {
  // Reuse this file's own existing hazardActor/announce-mock fixture,
  // setting hazardActor.system.details.description = "A rusted iron door."
  // before triggering the walk-over/trigger path this test already covers.
  // ... (fixture setup matches the file's own existing style) ...
  expect(announce).toHaveBeenCalledWith(
    "PF2EDC.Dungeon.Trap.TriggeredChat",
    expect.objectContaining({ description: " — A rusted iron door." }),
  );
});

it("#820: an empty/missing description renders as an empty clause, not an artifact", async () => {
  // hazardActor.system.details.description left unset (undefined) or "".
  expect(announce).toHaveBeenCalledWith(
    "PF2EDC.Dungeon.Trap.TriggeredChat",
    expect.objectContaining({ description: "" }),
  );
});

it("#820: DetectedChat also includes the description", async () => {
  // Same pattern, for the detection-success path.
  expect(announce).toHaveBeenCalledWith(
    "PF2EDC.Dungeon.Trap.DetectedChat",
    expect.objectContaining({ description: expect.any(String) }),
  );
});

it("#820: DetectionRollGM is unaffected (no description field added)", async () => {
  expect(whisperGM).toHaveBeenCalledWith(
    "PF2EDC.Dungeon.Trap.DetectionRollGM",
    expect.not.objectContaining({ description: expect.anything() }),
  );
});
```

Add a parallel pair of tests (customized description present / absent) for `attemptTrapDisableForScene`'s own critical-failure `TriggeredChat` announcement in whichever file covers it (likely `tests/trap-disable-ui.test.mjs`, per Step 1's own grep).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/trap-token-move.test.mjs tests/trap-disable-ui.test.mjs`
Expected: FAIL — no `description` field is passed to any of these `announce`/`whisperGM` calls today.

- [ ] **Step 4: Implement the helper and wire it into the three call sites**

Add near the top of `scripts/trap-combat.mjs`, alongside `announceTrap`/`whisperGMChat` (confirmed current, lines 196-206):

```js
/** #820: a hazard's own short narrative description (the same field #136's
 * agent customization already targets, system.details.description -- a
 * plain string, distinct from an action item's own full mechanical
 * "Trigger/Effect" prose, which this never touches), formatted as an
 * optional trailing chat clause. Empty/missing renders as "", never a
 * trailing artifact. */
function descriptionClause(hazardActor) {
  const text = hazardActor.system?.details?.description;
  return text ? ` — ${text}` : "";
}
```

Change (confirmed current, `scripts/trap-combat.mjs:572-575`):

```js
          await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
            name: tokenDoc.name ?? tokenDoc.actor.name,
            trap: hazardActor.name,
          });
```

to:

```js
          await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
            name: tokenDoc.name ?? tokenDoc.actor.name,
            trap: hazardActor.name,
            description: descriptionClause(hazardActor),
          });
```

Change (confirmed current, lines 603-606):

```js
          await announce("PF2EDC.Dungeon.Trap.DetectedChat", {
            name,
            trap: hazardActor.name,
          });
```

to:

```js
          await announce("PF2EDC.Dungeon.Trap.DetectedChat", {
            name,
            trap: hazardActor.name,
            description: descriptionClause(hazardActor),
          });
```

Change (confirmed current, `attemptTrapDisableForScene`, lines 669-672):

```js
      await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
        name: actor.name,
        trap: hazardActor.name,
      });
```

to:

```js
      await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
        name: actor.name,
        trap: hazardActor.name,
        description: descriptionClause(hazardActor),
      });
```

`whisperGM("PF2EDC.Dungeon.Trap.DetectionRollGM", {...})` (lines 593-599) is left completely untouched.

- [ ] **Step 5: Update the i18n templates**

In `lang/en.json`, change (confirmed current, lines 164/176):

```json
  "PF2EDC.Dungeon.Trap.DetectedChat": "{name} notices a hidden trap: {trap}!",
  ...
  "PF2EDC.Dungeon.Trap.TriggeredChat": "{name} sets off a trap: {trap}!",
```

to:

```json
  "PF2EDC.Dungeon.Trap.DetectedChat": "{name} notices a hidden trap: {trap}!{description}",
  ...
  "PF2EDC.Dungeon.Trap.TriggeredChat": "{name} sets off a trap: {trap}!{description}",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/trap-token-move.test.mjs tests/trap-disable-ui.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — in particular every other existing trap-combat test (strike-path, basic-save-path from #839's own recent merge) stays green, since this change only adds one new field to three existing calls.

- [ ] **Step 8: Commit**

```bash
git add scripts/trap-combat.mjs lang/en.json tests/trap-token-move.test.mjs tests/trap-disable-ui.test.mjs
git commit -m "feat(#820): include a trap's own description in its trigger/detect chat announcement

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live verification

- [ ] **Step 1: Verify a room trap**

Customize a room trap's own description via the external-agent flow (or set it directly for the test), trigger it, confirm the chat message now includes the description and the room tracker panel still shows it too (unaffected).

- [ ] **Step 2: Verify a corridor trap**

Place a corridor trap (#779's own mechanism), customize its description the same way, trigger and detect it, confirm the chat messages now show the description — the real, previously-missing case this plan fixes.

- [ ] **Step 3: Verify the empty-description case**

Trigger an uncustomized trap with no description set and confirm the chat message reads identically to before this change (no trailing dash or empty-clause artifact).

- [ ] **Step 4: Report findings on the issue**

---

### Task 3: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a small, additive chat-message change), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#820): bump version for corridor trap description chat parity

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #820's own real, confirmed gap (a corridor trap's own description never shown anywhere) is directly closed. The issue's own title ("tracker display parity") is addressed via the narrower, user-confirmed chat-based approach rather than the bigger "build a corridor display surface" path the issue's own text had already flagged as needing its own design pass — resolved via AskUserQuestion this session, not guessed.

**2. Placeholder scan:** No TBD. Every claim (name already propagating correctly today, the exact no-op mechanism for `state.rooms[edgeId]`, the three exact call sites and their current line numbers) was confirmed by direct code reading this session, post the #839 merge that changed this same file's own line numbers.

**3. Type consistency:** `descriptionClause(hazardActor): string` is a pure, narrow helper — its one call shape (`announce(key, {..., description: descriptionClause(hazardActor)})`) is identical across all three call sites, and the two i18n templates it feeds both gain the exact same `{description}` placeholder.

**4. Review Focus:** All five items (corridor trap description now shown, empty case renders cleanly, long/short description used as-is, GM-only whisper unaffected, room panel regression-checked) each map to a specific test or live-verification step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-corridor-trap-description-chat-parity.md`.
