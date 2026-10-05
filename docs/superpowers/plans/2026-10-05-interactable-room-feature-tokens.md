# Interactable Room-Feature Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give treasure, puzzle, and skill-challenge rooms an in-scene Token prop a player can target to trigger (treasure) or unlock (puzzle/skill-challenge) the room's existing resolution path, replacing the player-facing sidebar UI as the only way in.

**Architecture:** A shared pure data/builder module (`scripts/room-feature-tokens.mjs`) defines the three prop types; `dungeon-scene.mjs`'s existing build-time branches spawn one per room; a new `targetToken` hook in `module.mjs` dispatches on the targeted prop's own flags, reusing `claimTreasureFor` unchanged for treasure and a new `revealRoomFeature` (mirroring `ensureSkillChallenge`'s own shape) for puzzle/skill-challenge; the sidebar template gates its existing controls behind `isGM` (and, for puzzle/skill-challenge, the new `revealed` flag).

**Tech Stack:** Vanilla ES modules, Vitest, Foundry's native `targetToken` hook and `loot`-type Actor, the `foundry-rest` skill for live verification of every Foundry-glue task.

**Spec:** `docs/superpowers/specs/2026-10-05-interactable-room-feature-tokens-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). This is a cross-cutting new interaction subsystem spanning three room kinds: minor bump. Current version at plan-writing time is `0.58.7` — re-check immediately before committing, since concurrent sessions push to this repo.
- `claimTreasureFor`, `ensureTreasureState`, `ensurePuzzleState`, `ensureSkillChallenge`, `rollSkillChallengeAttempt`, `rollPuzzleStageAttempt` are **not modified** — every grant/attempt function is reused exactly as it exists today (spec's own "What does NOT need changes").
- `playSound`-style `broadcast`/permission concerns don't apply here, but the equivalent discipline does: every new mutating dispatch in `module.mjs`'s `targetToken` handler must use the identical `game.user.isGM ? direct : requestDungeonAction(...)` shape every other mutating action in this codebase already uses (`#onClaimTreasure`, `scripts/ui/dungeon-app.mjs:1508`).
- A `targetToken` hook fires on **every** connected client whenever any user's targets change — every new handler must guard on `user.id === game.user.id` so only the targeting player's own client proceeds.
- No new art assets: `icons/svg/chest.svg` (treasure), `icons/svg/clockwork.svg` (puzzle), `icons/svg/dice-target.svg` (skill challenge) — confirmed live, already served by the running Foundry server.
- Players never see the sidebar Claim Treasure button or Attempt forms (wrapped in `{{#if isGM}}`); the GM always can, and for puzzle/skill-challenge the GM's form additionally stays hidden until `revealed`.

## Review Focus

- **A room-feature token is a real scene object that outlives the party's visit.** A late/stray `targetToken` event against an old treasure prop (the party has since moved to a different room) must never grant treasure for whatever room the party is *currently* in — `claimTreasureFor(sceneId)` reads `state.currentRoomId` internally with no room parameter of its own. Covered by Task 4's explicit "token belongs to a room the party already left" test.
- **The `targetToken` hook broadcasts to every connected client.** Without a `user.id === game.user.id` guard, every other connected client's own identical hook registration would also try to act on one player's single click. Covered by Task 4's explicit "a different client's own `game.user` than the targeting user is a no-op" test.
- **Re-targeting an already-resolved room's token must not double-grant or double-reveal.** Covered by Task 2's `revealRoomFeature` idempotency test and Task 4's "already-resolved room is a no-op" test.
- **A puzzle/skill-challenge token's interaction must never attempt the challenge itself** — only reveal the form, since an actor/skill choice can't come from a target-click. A bug conflating "revealed" with "resolved" would silently skip the player's own choice. Covered by Task 2's test asserting `revealRoomFeature` only ever sets `revealed`, never touches `resolved`/`successes`/`vp`.
- **Un-targeting (`targeted: false`) must be a no-op**, not a second trigger — right-clicking the same token again to release it must not fire the action a second time. Covered by Task 4's explicit `targeted: false` test.

---

## Amendments (controller, 2026-10-05/06 — found by checking the plan against the code; these SUPERSEDE any conflicting text in the Global Constraints and Tasks below)

1. **Authorization (Cory's decision, via AskUserQuestion): any NON-GM player who OWNS a character in the party may trigger a room-feature token — and nobody else new.** The spec said "any connected player ... matches the sidebar's permission model"; that premise is false: `isAuthorizedRequest` (`scripts/dungeon-permissions.mjs`) honors a relayed action only from the run's `hostUserId`, so with a GM present (no host) every player request is silently rejected, and in a GM-less run only the host could act. Fix: ONE new relay action `roomFeatureInteract` with args `{ sceneId, roomId, kind }` (replaces the plan's `claimTreasure`-for-tokens use and its separate `revealRoomFeature` registry entry; the sidebar's existing `claimTreasure` entry is untouched). Extend `isAuthorizedRequest(actionName, requestingUserId, run, { ownsPartyCharacter = false } = {})`: for `actionName === "roomFeatureInteract"` return `!!run && !run.completed && (ownsPartyCharacter || (!!run.hostUserId && run.hostUserId === requestingUserId))`; every other action keeps today's host-only rule unchanged. In `dungeon-remote.mjs`'s socket handler compute `ownsPartyCharacter` for the requester: the requesting user (`game.users.get(msg.requestingUserId)`) exists, is active, is NOT a GM, and owns (`ownership[userId] >= 3`, the OWNER level `dungeon-follow.mjs` already uses) at least one `type === "character"` member of `game.actors.party` — then pass it as the 4th argument. Pure, unit-tested in the existing permissions test file (or a new one) with injected data.
2. **The GM-side action is AUTHORITATIVE and idempotent — never trust the client's guards.** A relayed request is the trust boundary, and `claimTreasureFor` has no resolved-check of its own (a second grant before the first resolves would double-pay). New pure helper `planRoomFeatureAction({ state, kind, roomId })` in `scripts/room-feature-tokens.mjs` returning `{ ok: true, room }` or `{ ok: false, reason }` with reasons `"no-state"`, `"unknown-kind"`, `"run-completed"`, `"not-current-room"`, `"room-kind-mismatch"` (token kind `treasure|puzzle|skill_challenge` must equal `state.rooms[roomId].kind`), `"already-resolved"` (`state.history.some(h => h.roomId === roomId)`). New async `runRoomFeatureAction({ sceneId, roomId, kind }, { getRunState, claimTreasureFor, revealRoomFeature, inFlight = moduleLevelSet })` in the same module (all collaborators injected, so it stays Foundry-free and testable): re-reads state via `getRunState(sceneId)`, runs `planRoomFeatureAction`, and if ok takes a per-`${sceneId}:${roomId}` in-flight lock (a second concurrent call for the same room returns `{ ok: false, reason: "in-flight" }` WITHOUT acting; lock released in `finally`) then for `treasure` calls `claimTreasureFor(sceneId)`, for `puzzle`/`skill_challenge` calls `revealRoomFeature(sceneId, roomId, kind)`; returns `{ ok: true }`. The dungeon-remote registry entry is `roomFeatureInteract: (args) => runRoomFeatureAction(args, { getRunState, claimTreasureFor, revealRoomFeature })`, and a GM client's own `targetToken` handler calls the SAME `runRoomFeatureAction` directly (no separate GM path). Tests: each reason; two concurrent treasure calls => `claimTreasureFor` called ONCE; the lock is released after a throw; puzzle/challenge only ever call `revealRoomFeature` (never `claimTreasureFor`).
3. **Extract the `targetToken` decision logic into a pure function and unit-test it** (the plan's Review Focus promises tests for these cases that its Task 4 never wrote): `routeTargetTokenEvent({ userId, gameUserId, targeted, flags, sceneId, state })` in `scripts/room-feature-tokens.mjs` returns `null` (no-op) or `{ sceneId, roomId, kind }`; null for: `targeted` false (un-target is a no-op), `userId !== gameUserId` (another client's broadcast), no `roomFeatureKind` flag, no `sceneId`, no `state`, `roomFeatureRoomId !== state.currentRoomId` (stale token of a room the party left), or the room already resolved (use `planRoomFeatureAction`; a false plan => null). The `Hooks.on("targetToken", ...)` in `module.mjs` becomes a thin wrapper: compute the route, then `game.user.isGM ? runRoomFeatureAction(route, realDeps) : requestDungeonAction("roomFeatureInteract", route)`. Spec guards still hold (user-id guard first).
4. **Template context must expose `revealed` or the GM's forms are locked FOREVER.** `_prepareContext` in `scripts/ui/dungeon-app.mjs` builds `challenge = { vp, vpTarget, attemptsRemaining, templateName, templateSummary, specialtySkills }` and `puzzle = { name, summary, ..., stages }` from the raw room state and neither carries `revealed`, so Task 5's `{{#if challenge.revealed}}` / `{{#if ../puzzle.revealed}}` would always be false. Add `revealed: !!raw.revealed` to BOTH context objects (Task 5). Verify live (render with the flag false then true).
5. **Cleanup and passability need no work** (verified): `sweepLooseNpcActors` already deletes every non-party actor on the scene at teardown/completion, so the prop actors are swept; `dungeon-follow.mjs` already treats `loot`-type tokens as `passable`.
6. **Architecture docs:** the new module and its imports require the `update-architecture-docs` skill (new edges: `dungeon-scene -> room-feature-tokens`, `module -> room-feature-tokens`, `dungeon-remote -> room-feature-tokens`, possibly `ui/dungeon-app`); add a final commit. **Version:** minor bump (re-check main at release; 0.59.1 at amendment time). **Commit trailers:** `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
7. **Execution split:** Dispatch A = the logic/tests (Task 1 + the new pure helpers/`runRoomFeatureAction`/authorization/router + Task 2); Dispatch B = the Foundry glue (Task 3 spawn, Task 4 hook + dungeon-remote entry + relay ownership computation, Task 5 template + context + lang, architecture docs). Live verification (Tasks 3-5) needs a started run and the world updated: the controller does it with Cory.

8. **Template visibility gate is `interactive`, NOT `isGM` (found in Dispatch A's pre-flight of Task 5).** `_prepareContext` already computes `interactive = canActOnDungeon(state)` (GM or the run's host) and the template already hides the control panel from everyone else (`{{#unless interactive}}` read-only banner at the top, `{{#if interactive}}` sections). Wrapping the Claim button and Attempt forms in `{{#if isGM}}` (Task 5 as written) would ALSO hide them from a GM-less run's HOST (a non-GM player who operates the dungeon) — and for puzzle/skill-challenge rooms nobody could then submit the Attempt form (deadlock). So Task 5 must NOT add `isGM` wrappers: first read the template and confirm the Claim Treasure button and the skill-challenge / puzzle Attempt forms already sit inside the `interactive` gate (if any does not, wrap it in `{{#if interactive}}`, never `isGM`). The only new gating is the `revealed` gate for puzzle/skill-challenge (`{{#if challenge.revealed}} form {{else}} NotRevealedHint {{/if}}`, and `../puzzle.revealed` inside the stages loop) plus Amendment 4's `revealed` in the context objects. The treasure button simply stays as the operator's redundant fallback alongside the token. Players who are not interactive still see only the token (read-only panel), exactly as the spec intends.

---

### Task 1: `scripts/room-feature-tokens.mjs` — pure data + builder

**Files:**
- Create: `scripts/room-feature-tokens.mjs`
- Test: `tests/room-feature-tokens.test.mjs`

**Interfaces:**
- Produces: `export const ROOM_FEATURE_TOKEN_TYPES` (object keyed by `"treasure" | "puzzle" | "skill_challenge"`, each `{name, img}`); `export function buildRoomFeatureTokenActorData(kind, roomId)` returning the full Actor-creation payload. Consumed by Task 3.

- [x] **Step 1: Write the failing tests**

Create `tests/room-feature-tokens.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import {
  ROOM_FEATURE_TOKEN_TYPES,
  buildRoomFeatureTokenActorData,
} from "../scripts/room-feature-tokens.mjs";

describe("ROOM_FEATURE_TOKEN_TYPES", () => {
  it("has exactly the three room kinds this feature covers", () => {
    expect(Object.keys(ROOM_FEATURE_TOKEN_TYPES).sort()).toEqual([
      "puzzle",
      "skill_challenge",
      "treasure",
    ]);
  });

  it("every entry has a name and an icon path", () => {
    for (const entry of Object.values(ROOM_FEATURE_TOKEN_TYPES)) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.img).toMatch(/^icons\/svg\/.+\.svg$/);
    }
  });
});

describe("buildRoomFeatureTokenActorData", () => {
  it("builds a loot-type actor with the kind's own name and icon", () => {
    const data = buildRoomFeatureTokenActorData("treasure", "room-1");
    expect(data.type).toBe("loot");
    expect(data.name).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.name);
    expect(data.img).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.img);
    expect(data.prototypeToken.texture.src).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.img);
  });

  it("flags the actor with its room-feature kind and room id", () => {
    const data = buildRoomFeatureTokenActorData("puzzle", "room-42");
    expect(data.flags["pf2e-dungeon-crawl"]).toEqual({
      roomFeatureKind: "puzzle",
      roomFeatureRoomId: "room-42",
    });
  });

  it("builds a distinct actor per kind", () => {
    const puzzle = buildRoomFeatureTokenActorData("puzzle", "room-1");
    const challenge = buildRoomFeatureTokenActorData("skill_challenge", "room-1");
    expect(puzzle.name).not.toBe(challenge.name);
    expect(puzzle.img).not.toBe(challenge.img);
  });

  it("throws on an unknown kind", () => {
    expect(() => buildRoomFeatureTokenActorData("not-a-kind", "room-1")).toThrow(
      /not-a-kind/,
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/room-feature-tokens.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/room-feature-tokens.mjs'`.

- [x] **Step 3: Write `scripts/room-feature-tokens.mjs`**

```js
/**
 * Interactable room-feature prop tokens (#611/#623): a player-visible,
 * player-targetable scene object for a treasure/puzzle/skill-challenge
 * room, replacing the sidebar-only trigger those rooms used to have.
 * Pure data + a builder — no Foundry documents touched here; dungeon-scene.mjs
 * is the one place that turns this into a real Actor/Token (same pure/glue
 * split cover-items.mjs already uses for its own scene-prop actors).
 */
export const ROOM_FEATURE_TOKEN_TYPES = {
  treasure: { name: "Treasure Chest", img: "icons/svg/chest.svg" },
  puzzle: { name: "Puzzle Mechanism", img: "icons/svg/clockwork.svg" },
  skill_challenge: { name: "Challenge Marker", img: "icons/svg/dice-target.svg" },
};

const MODULE_ID = "pf2e-dungeon-crawl";

/** Full Actor-creation payload for one room-feature prop — a PF2e `loot`
 * actor (needs no HP/combat schema, confirmed live), flagged with its own
 * kind and room id so module.mjs's `targetToken` handler can tell which
 * room/feature was interacted with without any further lookup. */
export function buildRoomFeatureTokenActorData(kind, roomId) {
  const type = ROOM_FEATURE_TOKEN_TYPES[kind];
  if (!type) throw new Error(`Unknown room-feature kind: ${kind}`);
  return {
    name: type.name,
    type: "loot",
    img: type.img,
    prototypeToken: { texture: { src: type.img } },
    flags: {
      [MODULE_ID]: { roomFeatureKind: kind, roomFeatureRoomId: roomId },
    },
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/room-feature-tokens.test.mjs`
Expected: PASS, all 6 tests green.

- [x] **Step 5: Commit**

```bash
git add scripts/room-feature-tokens.mjs tests/room-feature-tokens.test.mjs
git commit -m "feat(#611,#623): add room-feature-tokens pure data/builder module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `revealRoomFeature` in `dungeon-runner.mjs`

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (add `revealRoomFeature`, directly after `ensurePuzzleState`)
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Consumes: `getRunState`, `persist`, `defaultSettingsRef` (already imported/defined in this file, same as `ensureSkillChallenge` uses).
- Produces: `export async function revealRoomFeature(sceneId, roomId, kind, {settingsRef = defaultSettingsRef()} = {})` — returns the new state (or the unchanged state on a no-op, or `null` if no run exists). Consumed by Task 4.

- [x] **Step 1: Write the failing tests**

In `tests/dungeon-runner.test.mjs`, add `revealRoomFeature` to the existing import list from `../scripts/dungeon-runner.mjs` (alongside `ensureSkillChallenge`/`ensurePuzzleState`), then add this new `describe` block after the existing `describe("ensureSkillChallenge / recordSkillChallengeAttempt", ...)` block:

```js
describe("revealRoomFeature", () => {
  it("sets revealed on a skill_challenge room's own challenge state", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const state = await revealRoomFeature("s", roomId, "skill_challenge", {
      settingsRef,
    });
    expect(state.rooms[roomId].challenge.revealed).toBe(true);
  });

  it("sets revealed on a puzzle room's own puzzle state, without touching resolved/successes", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: [{ skill: "arcana", dc: 15 }] },
      { settingsRef },
    );
    const state = await revealRoomFeature("s", roomId, "puzzle", { settingsRef });
    expect(state.rooms[roomId].puzzle.revealed).toBe(true);
    expect(state.rooms[roomId].puzzle.resolved).toBeNull();
    expect(state.rooms[roomId].puzzle.successes).toBe(0);
  });

  it("is a no-op if the room's feature is already revealed", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const first = await revealRoomFeature("s", roomId, "skill_challenge", {
      settingsRef,
    });
    const second = await revealRoomFeature("s", roomId, "skill_challenge", {
      settingsRef,
    });
    expect(second.rooms[roomId].challenge).toEqual(first.rooms[roomId].challenge);
  });

  it("is a no-op if the room has no matching feature state at all", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await revealRoomFeature("s", roomId, "puzzle", { settingsRef });
    expect(state.rooms[roomId].puzzle).toBeUndefined();
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await revealRoomFeature("nope", "room-x", "puzzle", {
      settingsRef,
    });
    expect(result).toBeNull();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t revealRoomFeature`
Expected: FAIL — `revealRoomFeature is not a function` (or an import error).

- [x] **Step 3: Write `revealRoomFeature`**

In `scripts/dungeon-runner.mjs`, insert this directly after `ensurePuzzleState`'s closing `}` (before its teardown counterpart's own docblock):

```js
const ROOM_FEATURE_STATE_KEY = {
  puzzle: "puzzle",
  skill_challenge: "challenge",
};

/**
 * Marks a room's puzzle/skill-challenge state as `revealed` (#611/#623) —
 * the room-feature token's own interaction sets this, unlocking the GM's
 * existing Attempt form in the sidebar. Deliberately only ever touches
 * `revealed`: the actual attempt (and its `resolved`/`successes`/`vp`
 * fields) still needs a player-chosen actor (and, for a skill challenge, a
 * skill) that a token interaction can't carry — this never attempts
 * anything on the room's behalf.
 */
export async function revealRoomFeature(
  sceneId,
  roomId,
  kind,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  const stateKey = ROOM_FEATURE_STATE_KEY[kind];
  const feature = room?.[stateKey];
  if (!feature || feature.revealed) return state;
  const rooms = {
    ...state.rooms,
    [roomId]: { ...room, [stateKey]: { ...feature, revealed: true } },
  };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t revealRoomFeature`
Expected: PASS, all 5 new tests green.

- [x] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS, every existing test still green.

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "feat(#611,#623): add revealRoomFeature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Spawn the prop token at room-build time

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (import `buildRoomFeatureTokenActorData` from `./room-feature-tokens.mjs`; add a spawn call inside each of the three existing build-time branches, lines ~1693 skill_challenge, ~1746 puzzle, ~1782 treasure — re-locate each via your editor before editing, since concurrent commits may have shifted them)

**Interfaces:**
- Consumes: `buildRoomFeatureTokenActorData(kind, roomId)` (Task 1); `roomRect` (`./dungeon-layout.mjs`, already imported) and `freeSpotInRect` (`./placement.mjs`, already imported).
- Produces: a real scene Token, flagged `flags["pf2e-dungeon-crawl"] = {roomFeatureKind, roomFeatureRoomId}` — consumed by Task 4's `targetToken` handler.

No unit test for this task: it's build-time glue creating real Foundry Actor/Token documents, the same category of code this codebase has consistently verified live rather than mocked (e.g. `populateSlotTrap`, `placePartyInRoom` have no unit tests of their own either). Verified live in Step 2 below.

- [x] **Step 1: Add the spawn helper and wire it into all three branches**

Add this import to `scripts/dungeon-scene.mjs`'s existing import block:

```js
import { buildRoomFeatureTokenActorData } from "./room-feature-tokens.mjs";
```

Change the existing `import { freeSpotInRect } from "./placement.mjs";` (line 57) to also pull in `footprint`:

```js
import { freeSpotInRect, footprint } from "./placement.mjs";
```

Add this new function (placed near `populateSlotTrap`, which it mirrors). Note it deliberately uses this file's own local `GRID_SIZE` constant (line 89, already used by this file's own `toPixels`, line 92) rather than reading `scene.grid.size` dynamically — matching every other placement call in this file, all of which assume the same fixed grid size `toPixels` itself assumes:

```js
/** Spawns one room-feature prop token (#611/#623) — a player-targetable
 * scene object for a treasure/puzzle/skill-challenge room. `rank`/`col`
 * locate the room the same way placePartyInRoom's own placement does. */
async function spawnRoomFeatureToken(scene, roomId, kind, { rank, col, seed }) {
  const rect = roomRect(seed, roomId, rank, col);
  const occupied = scene.tokens.map((t) => footprint(t, GRID_SIZE));
  const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? {
    gx: rect.gx,
    gy: rect.gy,
  };
  const [actor] = await Actor.createDocuments([
    buildRoomFeatureTokenActorData(kind, roomId),
  ]);
  const td = await actor.getTokenDocument({
    x: toPixels(spot.gx),
    y: toPixels(spot.gy),
  });
  await scene.createEmbeddedDocuments("Token", [td.toObject()]);
}
```

Then, inside the existing `if (room.kind === "skill_challenge") { ... }` branch (around line 1693), directly after its `await ensureSkillChallenge(...)` call, add:

```js
      await spawnRoomFeatureToken(scene, room.id, "skill_challenge", {
        rank,
        col,
        seed: state.seed,
      });
```

Inside the existing `} else if (room.kind === "puzzle" && room.setpieceId) { ... }` branch (around line 1746), directly after its `await ensurePuzzleState(...)` call, add:

```js
      await spawnRoomFeatureToken(scene, room.id, "puzzle", {
        rank,
        col,
        seed: state.seed,
      });
```

Inside the existing `if (room.kind === "treasure" && room.setpieceId) { ... }` branch (around line 1782), directly after its `await ensureTreasureState(...)` call, add:

```js
      await spawnRoomFeatureToken(scene, room.id, "treasure", {
        rank,
        col,
        seed: state.seed,
      });
```

- [ ] **Step 2: Live-verify with `foundry-rest`**

Save this to the session scratchpad as `verify-room-feature-spawn.js` and run it with `.claude/skills/foundry-rest/foundry-exec.sh`:

```js
// Confirms spawnRoomFeatureToken's real effect end-to-end: start a fresh
// dungeon run on a throwaway scene the GM isn't currently viewing (reuse
// this module's own startDungeonRun-equivalent flow if easier, or, for a
// narrower check, directly import and call spawnRoomFeatureToken against
// an existing real scene/room from an active run and verify a loot-type
// token with the right flags appears). Report what actually landed, then
// clean up anything created.
return "Run this against a real started dungeon run on this world once Task 3's code is live-reloaded; confirm via: canvas.scene.tokens.filter(t => t.actor?.type === 'loot' && t.getFlag('pf2e-dungeon-crawl', 'roomFeatureKind'))";
```

In practice: start (or use an already-started) dungeon run with a treasure/puzzle/skill-challenge room built, then run:

```bash
echo 'return canvas.scene.tokens.filter(t => t.getFlag("pf2e-dungeon-crawl", "roomFeatureKind")).map(t => ({name: t.name, actorType: t.actor?.type, kind: t.getFlag("pf2e-dungeon-crawl", "roomFeatureKind"), roomId: t.getFlag("pf2e-dungeon-crawl", "roomFeatureRoomId")}));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: one entry per treasure/puzzle/skill-challenge room already built in that run, each `actorType: "loot"` with the right `kind`/`roomId`.

- [x] **Step 3: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "feat(#611,#623): spawn a room-feature prop token at room-build time

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `targetToken` hook dispatch + remote-action registration (see Amendments 1-3: one `roomFeatureInteract` action, pure router, authoritative runner)

**Files:**
- Modify: `scripts/module.mjs` (new imports: `claimTreasureFor` from `./ui/dungeon-app.mjs`, `revealRoomFeature` from `./dungeon-runner.mjs`, `requestDungeonAction` from `./dungeon-remote.mjs`; new `Hooks.on("targetToken", ...)` registration)
- Modify: `scripts/dungeon-remote.mjs` (new `revealRoomFeature` import and action-registry entry, alongside the existing `claimTreasure` entry)

**Interfaces:**
- Consumes: `claimTreasureFor(sceneId)`, `revealRoomFeature(sceneId, roomId, kind)` (Task 2), `getRunState` (already imported into `module.mjs`), the `flags["pf2e-dungeon-crawl"]` shape Task 3 writes.
- Produces: the live `targetToken` dispatch — nothing further in this plan consumes it directly; Task 5's template changes read the state it produces.

No unit test: this is a live-document/socket dispatch hook, the same category this codebase always verifies live (e.g. `updateWall`'s `handleDungeonDoorOpened` wiring has no unit test either). Verified live in Step 3.

- [x] **Step 1: Add the new imports**

In `scripts/module.mjs`, change:

```js
import {
  DungeonApp,
  resolveCurrentRoom,
  retreatFromCard,
} from "./ui/dungeon-app.mjs";
```

to:

```js
import {
  DungeonApp,
  resolveCurrentRoom,
  retreatFromCard,
  claimTreasureFor,
} from "./ui/dungeon-app.mjs";
```

Add `revealRoomFeature` to the existing `from "./dungeon-runner.mjs"` import block (alongside `getRunState`).

Change:

```js
import { registerDungeonActionSocket } from "./dungeon-remote.mjs";
```

to:

```js
import {
  registerDungeonActionSocket,
  requestDungeonAction,
} from "./dungeon-remote.mjs";
```

- [x] **Step 2: Add the hook**

Add this registration directly after the existing `Hooks.on("updateWall", ...)` block in `scripts/module.mjs`:

```js
const MODULE_ID = "pf2e-dungeon-crawl";

Hooks.on("targetToken", async (user, token, targeted) => {
  if (!targeted) return;
  // #611/#623: this hook fires on every connected client whenever ANY
  // user's targets change (broadcast) -- only the client belonging to the
  // user who actually did the targeting should act on it.
  if (user.id !== game.user.id) return;

  const roomFeatureKind = token.getFlag(MODULE_ID, "roomFeatureKind");
  if (!roomFeatureKind) return;
  const roomFeatureRoomId = token.getFlag(MODULE_ID, "roomFeatureRoomId");

  const sceneId = token.parent?.id;
  if (!sceneId) return;
  const state = getRunState(sceneId);
  if (!state) return;
  // The prop token is a real scene object that outlives the party's visit
  // to its room -- a stray target on an old room's token must never act
  // on whatever room the party is CURRENTLY in.
  if (roomFeatureRoomId !== state.currentRoomId) return;
  const currentRoom = state.rooms[state.currentRoomId];
  const alreadyResolved = state.history.some(
    (h) => h.roomId === currentRoom.id,
  );
  if (alreadyResolved) return;

  if (roomFeatureKind === "treasure") {
    if (game.user.isGM) {
      await claimTreasureFor(sceneId);
    } else {
      await requestDungeonAction("claimTreasure", { sceneId });
    }
  } else if (roomFeatureKind === "puzzle" || roomFeatureKind === "skill_challenge") {
    if (game.user.isGM) {
      await revealRoomFeature(sceneId, roomFeatureRoomId, roomFeatureKind);
    } else {
      await requestDungeonAction("revealRoomFeature", {
        sceneId,
        roomId: roomFeatureRoomId,
        kind: roomFeatureKind,
      });
    }
  }
});
```

(If `MODULE_ID` is already declared elsewhere at the top of `scripts/module.mjs`, reuse that existing declaration instead of redeclaring it here — check with `grep -n "const MODULE_ID" scripts/module.mjs` before adding a duplicate.)

- [x] **Step 3: Register the remote action**

In `scripts/dungeon-remote.mjs`, add `revealRoomFeature` to the existing import from `./dungeon-runner.mjs` (alongside whatever that file already imports there), then add this entry to the action registry directly after the existing `claimTreasure` entry:

```js
  revealRoomFeature: (args) =>
    revealRoomFeature(args.sceneId, args.roomId, args.kind),
```

- [ ] **Step 4: Live-verify with `foundry-rest`**

```bash
cat > /tmp/verify-target-dispatch.js <<'EOF'
// With a real dungeon run already started and a treasure room built
// (confirm its prop token exists first, per Task 3's own verification),
// simulate a player targeting it and confirm claimTreasureFor actually
// ran (party gold increased) and the room resolved -- then confirm
// targeting it AGAIN is a no-op (gold doesn't increase twice), and
// confirm a token flagged with a DIFFERENT roomId than the party's
// current room is a no-op even when targeted.
const scene = canvas.scene;
const propToken = scene.tokens.find(
  (t) => t.getFlag("pf2e-dungeon-crawl", "roomFeatureKind") === "treasure",
);
if (!propToken) return { error: "no treasure prop token found on this scene" };

const party = game.actors.party;
const before = party?.system?.campaign?.treasure?.currency?.gold?.value ?? null;

propToken.object.setTarget(true, { user: game.user, releaseOthers: false });
await new Promise((r) => setTimeout(r, 300));
propToken.object.setTarget(false, { user: game.user, releaseOthers: false });

const after = party?.system?.campaign?.treasure?.currency?.gold?.value ?? null;

return { before, after, grew: after > before };
EOF
.claude/skills/foundry-rest/foundry-exec.sh /tmp/verify-target-dispatch.js
rm /tmp/verify-target-dispatch.js
```

Expected: `grew: true` (or inspect whatever this world's actual party-currency field shape turns out to be if `system.campaign.treasure.currency.gold.value` doesn't match — confirm the real field path live first with a read-only query against `game.actors.party` before relying on it here). Then re-run the same targeting sequence a second time and confirm gold does **not** increase again (idempotency).

For the stale-room guard: create a second prop token with a `roomFeatureRoomId` that does **not** equal `getRunState(scene.id).currentRoomId` (e.g. copy an existing prop token's data and edit its flag), target it, and confirm no gold change and no error.

- [x] **Step 5: Commit**

```bash
git add scripts/module.mjs scripts/dungeon-remote.mjs
git commit -m "feat(#611,#623): dispatch targetToken to claimTreasureFor/revealRoomFeature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Gate the sidebar controls in the template

**Files:**
- Modify: `templates/dungeon-tracker.hbs` (skill-challenge form ~line 147-170, treasure button ~line 223-235, puzzle per-stage form ~line 236-289 — re-locate via your editor before editing)

**Interfaces:** None — template-only, consumed by Foundry's own rendering, no other task depends on its exact markup.

No unit test: this codebase has no template-testing harness anywhere (confirmed: no test file imports/renders any `.hbs`). Verified live in Step 2.

- [x] **Step 1: Wrap each control**

Change the skill-challenge form (currently):

```handlebars
              <form class="pf2edc-dungeon__skill-challenge-form">
                ...
              </form>
```

to:

```handlebars
              {{#if isGM}}
                {{#if challenge.revealed}}
                  <form class="pf2edc-dungeon__skill-challenge-form">
                    ...
                  </form>
                {{else}}
                  <p class="hint">{{localize
                      "PF2EDC.Dungeon.SkillChallenge.NotRevealedHint"
                    }}</p>
                {{/if}}
              {{/if}}
```

Change the treasure button (currently):

```handlebars
              <footer>
                <button type="button" data-action="claimTreasure">{{localize
                    "PF2EDC.Dungeon.Treasure.ClaimButton"
                  }}</button>
              </footer>
```

to:

```handlebars
              {{#if isGM}}
                <footer>
                  <button type="button" data-action="claimTreasure">{{localize
                      "PF2EDC.Dungeon.Treasure.ClaimButton"
                    }}</button>
                </footer>
              {{/if}}
```

Change the puzzle per-stage form's `{{else}}` branch (currently):

```handlebars
                    {{else}}
                      <form
                        class="pf2edc-dungeon__puzzle-stage-form"
                        data-stage-index="{{this.index}}"
                      >
                        ...
                      </form>
                    {{/if}}
```

to:

```handlebars
                    {{else}}
                      {{#if isGM}}
                        {{#if ../puzzle.revealed}}
                          <form
                            class="pf2edc-dungeon__puzzle-stage-form"
                            data-stage-index="{{this.index}}"
                          >
                            ...
                          </form>
                        {{else}}
                          <p class="hint">{{localize
                              "PF2EDC.Dungeon.Puzzle.NotRevealedHint"
                            }}</p>
                        {{/if}}
                      {{/if}}
                    {{/if}}
```

(`../puzzle.revealed` because this branch is nested inside `{{#each puzzle.stages}}` — this file's own puzzle-stage form already reaches outside the loop the identical way, via `../partyMembers`, at its existing `{{#each ../partyMembers}}` line.)

- [x] **Step 2: Add the two new lang keys**

In `lang/en.json`, add (placed alphabetically near the existing `PF2EDC.Dungeon.SkillChallenge.*`/`PF2EDC.Dungeon.Puzzle.*` keys — re-check the file fresh for the exact current surrounding keys before inserting, since concurrent sessions push to this repo):

```json
"PF2EDC.Dungeon.SkillChallenge.NotRevealedHint": "Waiting for a player to interact with this room's challenge marker.",
"PF2EDC.Dungeon.Puzzle.NotRevealedHint": "Waiting for a player to interact with this room's puzzle marker.",
```

- [ ] **Step 3: Live-verify with `foundry-rest`**

With a real dungeon run that has a puzzle or skill-challenge room built and not yet revealed, open `DungeonApp` as the GM and confirm the "not revealed" hint shows instead of the Attempt form; then call `revealRoomFeature` directly (or target the real prop token, confirming Task 4's wiring) and re-render; confirm the Attempt form now shows. Confirm a treasure room's Claim Treasure button is absent entirely when rendering as a non-GM user (there's no second real player account on this world to log in as — confirm instead by temporarily reading the rendered HTML with `isGM` forced false via a direct call to the app's own `_prepareContext()` override, or by code-reading the final template to confirm the `{{#if isGM}}` wrapping is syntactically correct and matches every other `{{#if isGM}}` block already working elsewhere in this same file).

- [x] **Step 4: Commit**

```bash
git add templates/dungeon-tracker.hbs lang/en.json
git commit -m "feat(#611,#623): gate sidebar treasure/puzzle/challenge controls behind isGM+revealed

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:** None.

- [ ] **Step 1: Bump the version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (cross-cutting new interaction subsystem spanning three room kinds), e.g. `0.58.7` → `0.59.0`, using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #611/#623 room-feature tokens

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** The spec's four concrete deliverables — shared token prop + `targetToken` dispatch, treasure's full-trigger, puzzle/skill-challenge's reveal-gate, and the GM-only visibility split — map onto Task 1 (prop data), Task 3 (spawn), Task 4 (dispatch, covering both the treasure full-trigger and the reveal-gate), and Task 5 (visibility split + reveal-gated form). Task 2 is the reveal-gate's own state primitive, consumed by Task 4. #740 (blocking progression) is explicitly out of scope per the spec. No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling," no "similar to Task N." Task 4's live-verification step flags one real unknown (the exact party-currency field path) and tells the implementer to confirm it live first rather than guessing — that's an instruction to verify, not a placeholder for missing code.

**3. Type consistency:** `buildRoomFeatureTokenActorData(kind, roomId)` (Task 1) is invoked with the identical signature in Task 3's `spawnRoomFeatureToken`. `revealRoomFeature(sceneId, roomId, kind, {settingsRef})` (Task 2) is invoked with the identical argument order in Task 4's hook handler and Task 4's `dungeon-remote.mjs` registry entry. The `flags["pf2e-dungeon-crawl"] = {roomFeatureKind, roomFeatureRoomId}` shape is defined once in Task 1 and read with the identical key names in Task 4's hook handler.

**4. Review Focus:** All five items (stale-room-after-party-moves-on, multi-client hook broadcast, double-grant/double-reveal idempotency, reveal-vs-resolve conflation, untarget-as-no-op) each have a dedicated test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-interactable-room-feature-tokens.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because Tasks 3-5 each introduce real, live Foundry-document-mutating glue code with no unit-test harness to catch a mistake mechanically — the multi-client broadcast guard and the stale-room guard in Task 4 are exactly the kind of subtle logic a fresh reviewer's eyes are worth having before Task 5 builds the player-facing UI on top of it. Does the plan capture what you want, and which approach should we use?
