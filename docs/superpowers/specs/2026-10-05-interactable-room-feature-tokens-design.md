# Interactable room-feature tokens (treasure / puzzle / skill-challenge) — design

**Tracks:** [#611](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/611), [#623](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/623) (explicit companion issues, user-stated: "share the tile machinery")

**Follow-up filed, deliberately out of this spec's scope:** [#740](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/740) (block room progression until the token is used) — deferred per user decision 2026-10-05; this spec preserves today's non-blocking behavior unchanged.

## Problem, and a correction to both issues' own premise

Both issues describe their current gap as "activates automatically" (#611: treasure auto-granted; #623: puzzle/challenge auto-activate on door open). Neither is quite right, and the real gap is actually *identical* across all three room kinds:

- Treasure: `ensureTreasureState` (build time) only attaches the room's gp/item payload to state. The actual grant (`claimTreasureFor`, `scripts/ui/dungeon-app.mjs:731`) only ever fires from a sidebar "Claim Treasure" button click (`#onClaimTreasure`).
- Puzzle/skill-challenge: `ensurePuzzleState`/`ensureSkillChallenge` (build time, `scripts/dungeon-scene.mjs:1693-1757`) only attach the challenge's state (VP target, hint checks, specialty skills). The actual attempt only ever fires from a sidebar form submission (`#onAttemptSkillChallenge`/`#onAttemptPuzzleStage`), which additionally requires **player choice input** (which party member, and for a skill challenge, which skill) read from a `<select>` in that form.

So in every case, the room's content is already prepared at build/door-open time, and resolution is already gated behind a sidebar UI action — never literally automatic. The real ask in both issues is the same: move (or supplement) the *trigger* into the scene itself, as something a player interacts with directly.

Confirmed in code (relevant to #740, not actioned here): no room kind currently blocks door-unlocking on being resolved except combat (`isCombatRoom`/`currentRoomResolved` gating) — a party can already walk past an unclaimed treasure room or a skipped puzzle/challenge today.

## Key decision: a Token prop with `targetToken`, not a literal Tile

The issues' own suggested mechanism (a double-clicked Tile) doesn't fit this module's GM-less-capable design goal: Foundry's Tiles canvas control layer is one of the GM-only layers (grouped with Walls/Lighting/Sounds — confirmed live via this world's own control-layer list), never exposed to a non-GM player's UI. A literal Tile isn't clickable by a plain player through any normal path.

**Decision (user, 2026-10-05):** use a Token-based prop instead, with Foundry's native `targetToken` hook as the interaction signal. Confirmed live on this world:

- `Hooks.on("targetToken", (user, token, targeted) => {...})` fires correctly on right-click/target, for **any** token regardless of viewer ownership — no permission grant needed, unlike `controlToken` (select), which requires at least Observer ownership.
- The hook fires on every connected client whenever *any* user's target set changes (broadcast), not just the targeting user's own client. The handler must guard on `user.id === game.user.id` so only the client belonging to the player who actually did the targeting proceeds — otherwise every other connected client's own `targetToken` listener would also try to act on the same event.

**Prop implementation:** a PF2e `loot`-type Actor (confirmed live: needs no HP/combat schema, ships `actorLink: false` by default — a clean, already-idiomatic PF2e concept for "a thing in the scene you interact with," distinct from this module's existing `hazard`-type cover-item props which are meant to be *attacked*, not targeted) with its own Token, flagged `flags["pf2e-dungeon-crawl"] = {roomFeatureKind: "treasure" | "puzzle" | "skill_challenge", roomFeatureRoomId}`.

**Icons** (confirmed live against the running server, all return 200 — no new art assets needed): `icons/svg/chest.svg` (treasure), `icons/svg/clockwork.svg` (puzzle), `icons/svg/dice-target.svg` (skill challenge). A GM can override per-room art later the same way any Actor's `img` is editable; not a blocker.

## Per-kind behavior — a real asymmetry

- **Treasure:** `claimTreasureFor(sceneId)` takes no player-choice parameters, so the token's interaction is a **complete trigger** — identical effect to clicking "Claim Treasure" today.
- **Puzzle / skill-challenge:** attempting requires choosing an actor (and, for a skill challenge, a skill) from the sidebar form — a token click can't carry that choice. The token's interaction can only **reveal** the existing Attempt form (a new boolean room-state flag, e.g. `room.challengeRevealed` / `room.puzzleRevealed`); the player still submits the existing form afterward to actually attempt it.

## Visibility split (user decision, 2026-10-05)

Players see **only** the in-scene token; the GM still sees and can use the existing sidebar controls (Claim Treasure button, Attempt forms) as a GM-facing fallback/override. Implemented by wrapping those existing template blocks in `{{#if isGM}}` in `templates/dungeon-tracker.hbs` — `isGM` is already threaded into `_prepareContext`'s template context today, no new plumbing needed.

## Who may trigger it (user decision, 2026-10-05)

Any connected player — matches this module's GM-less design goal and the existing sidebar buttons' own permission model (any player can already click those today).

## Idempotency

Before acting on a `targetToken` event, the handler checks the room isn't already resolved — reusing the exact `currentRoomResolved` pattern (`state.history.some(h => h.roomId === currentRoom.id)`) already used elsewhere in `dungeon-app.mjs` — so a stray re-target (e.g. a player targeting, then re-targeting, the same prop before leaving the room) can't double-grant treasure or re-process an already-resolved room.

## Scheme

**New file, `scripts/room-feature-tokens.mjs`** (pure data + a builder function, no Foundry globals touched directly — mirrors `cover-items.mjs`'s own pure/glue split):

```js
export const ROOM_FEATURE_TOKEN_TYPES = {
  treasure: { name: "Treasure Chest", img: "icons/svg/chest.svg" },
  puzzle: { name: "Puzzle Mechanism", img: "icons/svg/clockwork.svg" },
  skill_challenge: { name: "Challenge Marker", img: "icons/svg/dice-target.svg" },
};
```

Plus a pure `buildRoomFeatureTokenActorData(kind, roomId)` returning the full Actor-creation payload (`{name, type: "loot", img, prototypeToken: {texture: {src}}, flags: {...}}`), so the glue code calling it stays a thin wrapper, same split this module uses everywhere else.

**`scripts/dungeon-scene.mjs`** — inside `buildPopulateAndUnlockGraphNode`'s existing `treasure`/`puzzle`/`skill_challenge` branches (right after each one's existing `ensureTreasureState`/`ensurePuzzleState`/`ensureSkillChallenge` call), spawn one prop: `roomRect(seed, roomId, rank, col)` for the room's rect, `freeSpotInRect({occupied, rect, gw: 1, gh: 1})` for placement (same pattern `placePartyInRoom` already uses), `actor.getTokenDocument({x, y})` + `scene.createEmbeddedDocuments("Token", [...])` to place it.

**`scripts/module.mjs`** — a new `Hooks.on("targetToken", ...)` registration dispatching on the targeted token's `flags["pf2e-dungeon-crawl"].roomFeatureKind`:
- `"treasure"` → `game.user.isGM ? claimTreasureFor(sceneId) : requestDungeonAction("claimTreasure", {sceneId})` (the exact existing dispatch `#onClaimTreasure` already uses).
- `"puzzle"` / `"skill_challenge"` → a new `revealRoomFeature(sceneId, roomId, kind)` function (new, in `dungeon-runner.mjs` alongside `ensurePuzzleState`/`ensureSkillChallenge`) setting the new reveal flag, dispatched the same `isGM ? direct : requestDungeonAction("revealRoomFeature", {...})` way, with a new `revealRoomFeature` entry in `dungeon-remote.mjs`'s action registry (mirroring `claimTreasure`'s own entry there).

**`templates/dungeon-tracker.hbs`** — wrap the existing "Claim Treasure" button and the skill-challenge/puzzle Attempt forms in `{{#if isGM}}` (players never see any of them, per the visibility-split decision). For puzzle/skill-challenge specifically, nest a second condition inside that block: `{{#if isGM}}{{#if challengeRevealed}}<!-- existing Attempt form --> {{else}}<!-- "waiting for a player to interact with the challenge marker" hint --> {{/if}}{{/if}}`. This is what gives the token real mechanical weight under the GM-only-sidebar decision: even though only the GM ever submits the Attempt form, that form stays hidden/inert until a player's token interaction sets the reveal flag — so #623's "the encounter starts only when a player interacts with it" is genuinely true, the GM just performs the mechanical roll on the party's behalf once it's started, same as they always could. Treasure needs no equivalent gating: its token interaction is already a complete trigger, so the GM's "Claim Treasure" button is simply a redundant fallback alongside it, not something that needs to unlock.

## What does NOT need changes

- `claimTreasureFor`, `lootGpForTreasureRoom`, `treasureRoomItemTableName`, `drawTreasureItem`, `rollSkillChallengeAttempt`, `rollPuzzleStageAttempt`, `ensureTreasureState`, `ensurePuzzleState`, `ensureSkillChallenge` — every existing grant/attempt/state-attachment function is reused as-is. This spec only adds a new way to *trigger* the existing treasure path, and a new *reveal* gate in front of the existing puzzle/skill-challenge attempt path.
- Door-unlock/progression logic (`unlockDoorsFromRoom`) — unchanged, per the deferred #740.
- Cover-item (`cover-items.mjs`) or trap (`trap-library.mjs`/`trap-combat.mjs`) mechanics — unrelated systems, not touched.

## Deliberately out of scope

- Blocking room progression on token interaction — filed as #740.
- Custom art for the prop tokens — Foundry's own core icons are used; a GM can retune art later same as any other actor.
- A dialog-based "choose actor/skill at the moment of interaction" flow for puzzle/skill-challenge (which would let the token fully replace the sidebar form instead of only revealing it) — not requested by either issue, and the per-kind visibility-split decision (GM-only sidebar) already means a player never needs that dialog at all; only the GM ever fills the form, already able to do so today.
