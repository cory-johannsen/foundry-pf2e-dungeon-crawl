# Announce Encounter Friend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #768 — when an encounter's Friend card is drawn and spawned, tell the players in chat that the new creature is an ally, so they stop mistaking it for a hostile they should flank or attack.

**Architecture:** `spawnEncounterTokens` (`scripts/encounter-generator.mjs:98-144`) already has a dedicated `if (roster.friend)` branch (confirmed current, lines 124-129) that spawns the Friend with `disposition: 1`. It currently discards `spawnCreatures`'s return value — the function's own doc comment (`scripts/foundry-api.mjs:945-951`) confirms this is safe to start reading (`{name, actorId, tokenId}`, no existing caller reads it). The fix captures that return and posts one new, public `ChatMessage` via the existing `api.postChatCard` helper (`scripts/foundry-api.mjs:1111-1118`) — the same mechanism `postEncounterChatCard` already uses for its own (GM-only) roster card, just without `whisperGM`.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a small, well-scoped addition to an existing function with a single clear fix; no open design question.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). This is a small UX fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- The announcement is public to all players (no `whisperGM`), per #768's own scope decision — a Friend is an ally, not something to hide from the party the way a hostile roster stays GM-only.
- The announcement fires regardless of the Friend's token `hidden` state (#768's own note: "a hidden Friend should probably still be announced, since it is an ally") — `spawnEncounterTokens` already computes `hidden: forceHidden` for the Friend exactly like every other spawn in this function, and the fix does not gate the chat message on it.
- No change to `roster.foes`/`roster.twins`/`roster.lurker` spawning, nor to `postEncounterChatCard`'s existing GM-only roster card — this plan touches only the Friend branch.

## Review Focus

- **The chat message must name the actual spawned creature**, not a generic "a friend appears" — `spawnCreatures`'s returned `name` is the real compendium actor's name (e.g. "Clockwork Spy", the exact creature from #768's own reported incident), so the fix must read it from the spawn result, not from `roster.friend`'s own `{pack, id}` (which has no name).
- **A Friend draw with no scene/party context must not throw** — `spawnCreatures` already returns `[]`/no entry in edge cases (e.g. `doc` not found, per its own `if (!doc) continue`); the new code must tolerate an empty/undefined spawn result rather than crash on `spawned.name`.
- **The message must actually be public** — `postChatCard`'s own `whisperGM` destructure (confirmed current) only whispers the GM when `whisperGM` is truthy; the new call must omit it entirely (not pass `whisperGM: false`, which works identically here but omitting it matches this file's own existing non-GM chat calls, e.g. none currently pass `whisperGM: false` explicitly).

---

### Task 1: Announce the Friend in a public chat message

**Files:**
- Modify: `scripts/encounter-generator.mjs` (`spawnEncounterTokens`'s `roster.friend` branch)
- Modify: `lang/en.json` (new locale key)
- Test: `tests/encounter-generator.test.mjs`

**Interfaces:**
- Consumes: `api.spawnCreatures(entries, opts)`'s existing return shape `[{name, actorId, tokenId}]` (confirmed current, `scripts/foundry-api.mjs:945-958`), `api.postChatCard({content, whisperGM?})` (confirmed current, `scripts/foundry-api.mjs:1111-1118`).
- Produces: nothing further in this plan consumes it — this is the feature's final wiring.

- [x] **Step 1: Write the failing test**

Add `makeFoundryApi` to this test file's own import (currently only `generateEncounter` is imported from `encounter-generator.mjs`; add a new import line for the mocked `makeFoundryApi`):

```js
import { makeFoundryApi } from "../scripts/foundry-api.mjs";
```

Add a new test inside the existing `describe("generateEncounter (no approval gate)", ...)` block (or a new sibling `describe`, matching whichever reads more naturally next to the existing two tests):

```js
it("announces a drawn Friend in a public chat message naming it", async () => {
  const dialogShownRef = { shown: false };
  installFoundryStubs({ dialogShownRef });
  generateEncounterRoster.mockResolvedValueOnce({
    foes: [],
    friend: { pack: "pf2e.pathfinder-monster-core-2", id: "abc123" },
    twins: null,
    lurker: null,
  });
  const postChatCard = vi.fn(async () => {});
  makeFoundryApi.mockReturnValueOnce({
    partyLevel: vi.fn(async () => 3),
    postChatCard,
    spawnCreatures: vi.fn(async (entries, opts) =>
      opts.disposition === 1
        ? [{ name: "Clockwork Spy", actorId: "a1", tokenId: "t1" }]
        : [],
    ),
    spawnCoverItems: vi.fn(async () => {}),
    listCreatureTraits: vi.fn(async () => []),
  });

  await generateEncounter({ skipThemeDialog: true, scene: { id: "scene1" } });

  const friendCall = postChatCard.mock.calls.find((c) =>
    c[0].content.includes("Clockwork Spy"),
  );
  expect(friendCall).toBeTruthy();
  expect(friendCall[0].whisperGM).toBeFalsy();
});

it("does not crash and posts no Friend message when nothing is spawned", async () => {
  const dialogShownRef = { shown: false };
  installFoundryStubs({ dialogShownRef });
  generateEncounterRoster.mockResolvedValueOnce({
    foes: [],
    friend: { pack: "pf2e.pathfinder-monster-core-2", id: "missing" },
    twins: null,
    lurker: null,
  });
  const postChatCard = vi.fn(async () => {});
  makeFoundryApi.mockReturnValueOnce({
    partyLevel: vi.fn(async () => 3),
    postChatCard,
    spawnCreatures: vi.fn(async () => []),
    spawnCoverItems: vi.fn(async () => {}),
    listCreatureTraits: vi.fn(async () => []),
  });

  await expect(
    generateEncounter({ skipThemeDialog: true, scene: { id: "scene1" } }),
  ).resolves.not.toThrow();
  expect(postChatCard).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/encounter-generator.test.mjs -t "Friend"`
Expected: FAIL — `postChatCard` is never called for the Friend today (`friendCall` is `undefined` in the first test).

- [x] **Step 3: Add the locale key**

In `lang/en.json`, add a new key near the existing `PF2EDC.Encounter.FriendLabel` entry (line 160):

```json
  "PF2EDC.Encounter.FriendAnnounceChat": "{name} is here to help — an ally, fighting on the party's side!",
```

- [x] **Step 4: Wire the announcement**

In `scripts/encounter-generator.mjs`, change the `roster.friend` branch (currently):

```js
  if (roster.friend) {
    const entries = [
      withArt({ pack: roster.friend.pack, id: roster.friend.id }),
    ];
    await api.spawnCreatures(entries, { ...place(false), disposition: 1 });
  }
```

to:

```js
  if (roster.friend) {
    const entries = [
      withArt({ pack: roster.friend.pack, id: roster.friend.id }),
    ];
    const [spawned] = await api.spawnCreatures(entries, {
      ...place(false),
      disposition: 1,
    });
    if (spawned) {
      await api.postChatCard({
        content: game.i18n.format("PF2EDC.Encounter.FriendAnnounceChat", {
          name: spawned.name,
        }),
      });
    }
  }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/encounter-generator.test.mjs -t "Friend"`
Expected: PASS, both new tests green.

- [x] **Step 6: Run the full test file and suite to confirm no regression**

Run: `npx vitest run tests/encounter-generator.test.mjs && npx vitest run`
Expected: PASS — in particular, the two existing `describe("generateEncounter (no approval gate)", ...)` tests stay green (they spawn no Friend, so the new branch's `if (spawned)` never fires for them).

- [ ] **Step 7: Live-verify via `foundry-rest`**

Generate a real encounter whose Friend slot resolves to a creature (rerun with different seeds/traits until one draws a Friend, or inspect `scripts/encounter-deck.mjs`'s `friend` slot odds to target one directly), and confirm a public chat message naming the spawned creature appears, visible to a non-GM player (not whispered):

```bash
echo 'return game.messages.contents.slice(-5).map(m => ({ content: m.content, whisper: m.whisper }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: the Friend's message has an empty/absent `whisper` array (public), distinct from the roster card's own GM-only whisper.

- [x] **Step 8: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (routine UX fix), using whatever the fetch above shows as current.

- [x] **Step 9: Commit**

```bash
git add scripts/encounter-generator.mjs lang/en.json tests/encounter-generator.test.mjs module.json
git commit -m "fix(#768): announce an encounter's Friend to the party in chat

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #768's own ask ("post a public chat message... naming the creature and saying it fights on the party's side"; "a hidden Friend should probably still be announced") is fully covered: Task 1's Step 4 posts the public message unconditionally on a successful spawn, regardless of the Friend's own `hidden` value. #580 (referenced as related) needs no change here — it's about defeat-resolution logic, not announcement, and isn't touched by this fix.

**2. Placeholder scan:** No TBD/TODO. The locale string and code change are the complete real text, not a description of what to write.

**3. Type consistency:** `spawnCreatures`'s return shape (`{name, actorId, tokenId}`) is read exactly as documented at its own definition; `postChatCard({content, whisperGM?})`'s existing optional-whisper behavior is used by omission, not by a new parameter.

**4. Review Focus:** All three items (real creature name in the message, no crash on an empty spawn result, genuinely public delivery) each have a dedicated test or explicit step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-announce-encounter-friend.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because this is a single small, self-contained addition to one existing function with no cross-task interface risk. Does the plan capture what you want, and which approach should we use?
