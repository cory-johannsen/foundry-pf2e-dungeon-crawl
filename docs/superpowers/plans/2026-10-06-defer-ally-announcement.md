# Defer Ally Announcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #810 — an encounter's Friend ally is announced to the party only when its room is actually revealed, not at full-dungeon-pregeneration time.

**Root cause (confirmed live-reading the current code, not assumed):** #768's own already-implemented fix (`scripts/encounter-generator.mjs`'s `spawnEncounterTokens`) posts the `PF2EDC.Encounter.FriendAnnounceChat` message immediately after spawning, unconditionally — including when the Friend spawns `hidden: true`, which is exactly what happens for every combat room during #93's full eager dungeon pregeneration (`populateSlotEncounter` passes `forceHidden: true`, confirmed current). The result is every ally in the whole dungeon announced in a burst the moment the run starts, precisely #810's own complaint. The fix only needs to skip the immediate announcement when the spawn is hidden, and instead announce it from `revealSlotTokens` (`scripts/dungeon-scene.mjs`), the same door-open-time reveal point this module already uses for every other piece of room content (monsters, traps).

**Architecture:** No new subsystem — `spawnEncounterTokens` gains one condition (`!placement.hidden`) on its existing announcement call; `revealSlotTokens` gains a small loop over the tokens it just revealed, posting the identical announcement for any that are Friend-type allies. "Friend-type ally" is derived from data `spawnCreatures` already sets at spawn time (`alliance: "party"` on a non-`character`-type actor, confirmed current in `scripts/foundry-api.mjs`'s disposition-to-alliance mapping) — nothing new is stored for this.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a bounded fix to one already-implemented feature's timing bug; the one real optional scope question (a GM-only generation-time whisper summary) was presented to and declined by the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A behavioral fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- No GM-only generation-time whisper summary is added — the user explicitly declined that optional extra; this plan only fixes the timing.
- The standalone "Generate Encounter" macro path (`generateEncounter` called with no `forceHidden`, which never goes through a later `revealSlotTokens` call at all) must keep announcing its Friend immediately — the fix is conditional on hidden state, not an unconditional removal of the existing announcement.
- `friendly_aid`'s own ally-grant (`scripts/ui/dungeon-app.mjs`'s `applyRoomEffect`) is confirmed unaffected and out of scope — it already fires at interactive room-resolution time, never during pregeneration, so it has no version of #810's bug. (Separately, it currently uses `ui.notifications.info`, a GM-local toast other players never see — a real but different, not-yet-filed issue; not touched here.)

## Review Focus

- **A Friend spawned hidden (the normal dungeon-room, pregenerated case) must not be announced at spawn time** — #810's own bug, the thing this plan exists to fix.
- **That same Friend must be announced exactly once, when its room's tokens are actually revealed** — not zero times (silently dropped) and not twice (double-announced if revealed more than once, e.g. a re-render).
- **A Friend spawned non-hidden (the standalone macro path) must still be announced immediately, exactly as before** — this plan must not regress #768's own original fix for that path.
- **`revealSlotTokens`'s existing trap-hazard exclusion and return value must be completely unaffected** — the new ally-announcement loop is additive, reading the same already-computed `tokens`/`ids`, never changing which tokens get revealed or what the function returns.
- **A revealed room with no ally present must announce nothing new** — the loop must not fire for ordinary combat foes, puzzle/treasure props, or any other revealed token.

---

### Task 1: Defer the announcement to reveal time

**Files:**
- Modify: `scripts/encounter-generator.mjs` (`spawnEncounterTokens`'s `roster.friend` branch)
- Modify: `scripts/dungeon-scene.mjs` (`revealSlotTokens`)
- Test: `tests/encounter-generator.test.mjs`, `tests/reveal-slot-tokens-trap.test.mjs`

**Interfaces:**
- Produces: `revealSlotTokens(scene, slot)`'s own existing return value (`ids`) is unchanged; it now also has the side effect of announcing any revealed Friend-type ally. No new exported function.

- [ ] **Step 1: Write the failing tests**

Add to `tests/encounter-generator.test.mjs`, inside the existing `describe("generateEncounter Friend announcement (#768)", ...)` block (reusing its own `friendRoster`/`apiWith` fixtures exactly):

```js
  it("#810: does not announce a Friend spawned hidden (full pregeneration)", async () => {
    installFoundryStubs({ dialogShownRef: { shown: false } });
    generateEncounterRoster.mockResolvedValueOnce(friendRoster("abc123"));
    const postChatCard = vi.fn(async () => {});
    makeFoundryApi.mockReturnValueOnce(
      apiWith(
        postChatCard,
        vi.fn(async (entries, opts) =>
          opts.disposition === 1
            ? [{ name: "Clockwork Spy", actorId: "a1", tokenId: "t1" }]
            : [],
        ),
      ),
    );

    await generateEncounter({
      skipThemeDialog: true,
      scene: { id: "scene1" },
      forceHidden: true,
    });

    expect(
      postChatCard.mock.calls.some((c) =>
        c[0].content.includes("PF2EDC.Encounter.FriendAnnounceChat"),
      ),
    ).toBe(false);
  });
```

Add to `tests/reveal-slot-tokens-trap.test.mjs` (add a `globalThis.game`/`globalThis.ChatMessage` stub and extend the `tok()` helper to accept an `actor`, matching this file's own minimal style):

```js
function tok(id, flags, hidden = true, actor = null) {
  return { id, hidden, actor, getFlag: (m, k) => (m === MODULE_ID ? flags[k] : undefined) };
}

describe("revealSlotTokens ally announcement (#810)", () => {
  beforeEach(() => {
    globalThis.game = { i18n: { format: (k, d) => `${k}|${JSON.stringify(d)}` } };
    globalThis.ChatMessage = { create: vi.fn(async () => {}) };
  });

  it("announces a Friend-type ally (party alliance, non-character actor) revealed with its room", async () => {
    const ally = { name: "Clockwork Spy", alliance: "party", type: "npc" };
    const scene = sceneOf([tok("friend", { dungeonSlot: 2 }, true, ally)]);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).toHaveBeenCalledWith({
      content: 'PF2EDC.Encounter.FriendAnnounceChat|{"name":"Clockwork Spy"}',
    });
  });

  it("does not announce an ordinary hostile or party-character token", async () => {
    const foe = { name: "Skeleton", alliance: "opposition", type: "npc" };
    const partyMember = { name: "Valeros", alliance: "party", type: "character" };
    const scene = sceneOf([
      tok("foe", { dungeonSlot: 2 }, true, foe),
      tok("pc", { dungeonSlot: 2 }, true, partyMember),
    ]);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
  });

  it("announces nothing extra when nothing in the slot is an ally", async () => {
    const scene = sceneOf([tok("mon", { dungeonSlot: 2 })]);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
  });
});
```

(Add `beforeEach` to this file's existing `import` line from `vitest` if not already present — confirmed current, it already imports `describe, it, expect, vi`, add `beforeEach`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/encounter-generator.test.mjs tests/reveal-slot-tokens-trap.test.mjs -t "#810"`
Expected: FAIL — the hidden-Friend case still announces today; `revealSlotTokens` never calls `ChatMessage.create` at all today.

- [ ] **Step 3: Gate the immediate announcement on hidden state**

In `scripts/encounter-generator.mjs`, change the `roster.friend` branch (currently):

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

to:

```js
  if (roster.friend) {
    const entries = [
      withArt({ pack: roster.friend.pack, id: roster.friend.id }),
    ];
    const placement = place(false);
    const [spawned] = await api.spawnCreatures(entries, {
      ...placement,
      disposition: 1,
    });
    // #810: a Friend spawned hidden (full dungeon pregeneration, #93) is
    // announced later, when its room is actually revealed
    // (dungeon-scene.mjs's revealSlotTokens) -- not here, which would
    // spoil every ally in the whole dungeon at once. A non-hidden Friend
    // (the standalone "Generate Encounter" macro path, which never goes
    // through a later reveal step at all) is still announced immediately.
    if (spawned && !placement.hidden) {
      await api.postChatCard({
        content: game.i18n.format("PF2EDC.Encounter.FriendAnnounceChat", {
          name: spawned.name,
        }),
      });
    }
  }
```

- [ ] **Step 4: Announce a revealed Friend from `revealSlotTokens`**

In `scripts/dungeon-scene.mjs`, change `revealSlotTokens` (currently, confirmed current lines 1235-1249):

```js
export async function revealSlotTokens(scene, slot) {
  const tokens = scene.tokens.filter(
    (t) =>
      t.getFlag(MODULE_ID, "dungeonSlot") === slot &&
      t.hidden &&
      !t.getFlag(MODULE_ID, "trapHazard"),
  );
  const ids = tokens.map((t) => t.id);
  if (ids.length)
    await scene.updateEmbeddedDocuments(
      "Token",
      ids.map((id) => ({ _id: id, hidden: false })),
    );
  return ids;
}
```

to:

```js
export async function revealSlotTokens(scene, slot) {
  const tokens = scene.tokens.filter(
    (t) =>
      t.getFlag(MODULE_ID, "dungeonSlot") === slot &&
      t.hidden &&
      !t.getFlag(MODULE_ID, "trapHazard"),
  );
  const ids = tokens.map((t) => t.id);
  if (ids.length)
    await scene.updateEmbeddedDocuments(
      "Token",
      ids.map((id) => ({ _id: id, hidden: false })),
    );
  // #810: an encounter's Friend ally spawns hidden during full dungeon
  // pregeneration (#93) and is announced HERE, the moment its room is
  // actually revealed -- announcing it at spawn time (encounter-
  // generator.mjs's own original #768 fix) spoiled every ally in the
  // whole dungeon at once. `alliance: "party"` on a non-`character` actor
  // is how spawnCreatures already marks a Friend-type ally (confirmed
  // current, foundry-api.mjs's own disposition-to-alliance mapping) --
  // nothing else revealed here is ever both.
  for (const token of tokens) {
    const actor = token.actor;
    if (actor?.alliance === "party" && actor.type !== "character") {
      await ChatMessage.create({
        content: game.i18n.format("PF2EDC.Encounter.FriendAnnounceChat", {
          name: actor.name,
        }),
      });
    }
  }
  return ids;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/encounter-generator.test.mjs tests/reveal-slot-tokens-trap.test.mjs`
Expected: PASS, old and new cases green — in particular, the pre-existing `"announces a drawn Friend in a public chat message naming it"` test (confirmed current, no `forceHidden` passed, so `placement.hidden` is `false`) still passes unchanged.

- [ ] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/encounter-generator.mjs scripts/dungeon-scene.mjs tests/encounter-generator.test.mjs tests/reveal-slot-tokens-trap.test.mjs
git commit -m "fix(#810): announce an encounter Friend when its room is revealed, not at generation time

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live verification, version bump

**Files:**
- Modify: `module.json`

No code changes in this task — verification and the version bump only.

- [ ] **Step 1: Live-verify via `foundry-rest`**

Start a fresh real dungeon run and confirm, immediately after generation completes (before opening any door), that no `PF2EDC.Encounter.FriendAnnounceChat`-derived message appears in chat even if the seed is known to place a Friend somewhere in the dungeon:

```bash
echo 'return game.messages.contents.map(m => m.content);' | .claude/skills/foundry-rest/foundry-exec.sh
```

Then open doors room by room until a Friend-containing combat room is revealed, confirming the announcement appears at that moment (and only then), naming the real spawned ally. Also run the standalone "Generate Encounter" macro directly (not through a dungeon room) and confirm its own Friend is still announced immediately, unchanged from #768's original behavior.

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a behavioral fix to an already-shipped feature), using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#810): bump version for deferred ally announcement fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #810's own "Fix" section ("stop emitting the message from the generation/spawn path; defer it to an encounter trigger... room entry/advance or first reveal of the ally token... make sure it fires once per ally") is fully covered: Task 1 removes the unconditional spawn-time announcement for the hidden case and adds it to the room-reveal step, with tests pinning "exactly once, not zero, not twice." The issue's own optional "consider a GM whisper instead" was presented to and declined by the user — not built.

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real change.

**3. Type consistency:** `revealSlotTokens(scene, slot)`'s signature and return value (`ids`) are completely unchanged; the new loop reads the same `tokens` array the function already computes, introducing no new parameters or shapes.

**4. Review Focus:** All five items (hidden Friend never announced at spawn, announced exactly once on reveal, non-hidden/macro Friend still announced immediately, `revealSlotTokens`'s existing trap exclusion and return value untouched, a revealed room with no ally announces nothing) each have a dedicated test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-defer-ally-announcement.md`.
