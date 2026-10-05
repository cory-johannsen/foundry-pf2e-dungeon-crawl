# Decouple traps from room kind — design

**Tracks:** [#754](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/754) (part of #569's decomposition)

**Follow-up filed, deliberately out of this spec's scope:** [#779](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/779) (place traps in corridors/hallways) — deferred per user decision 2026-10-05; this spec covers room placement only.

## Problem

Traps are currently their own mutually-exclusive room kind (`ROOM_KIND_WEIGHTS`, `scripts/dungeon-deck.mjs`, weight 1 of 12 ≈ 8.3% of rooms) instead of an independent layer that can appear within any other room kind.

## Key discovery: the setpiece machinery this touches is already dead weight

A trap room's player-facing flavor text (`room.trap.name`/`.description`, read by `dungeon-app.mjs`'s `_prepareContext`) comes from the **spawned hazard actor's own name/description** (`populateSlotTrap`, `scripts/dungeon-scene.mjs`, confirmed: `ensureTrapState(scene.id, roomId, {name: actor.name, description: actor.system?.details?.description ?? ""})`) — never from a setpiece at all. The `trapSetpieceIds`/`kind === 'trap' ? setpieceAt(...) : ...` machinery threaded through `scripts/dungeon-deck.mjs`'s four room-generation functions (`buildRoomSequence`, `buildRoomGraph`, `insertRestRoom`, `attachHiddenPaths` — confirmed live, all four still real/called, not legacy dead code themselves) is only ever consumed as a boolean gate (`room.setpieceId` truthy) at `populateSlotTrap`'s own call site, never for its actual content. Decoupling traps from room kind therefore **deletes** this machinery rather than needing to extend it to more call sites — a net simplification, not added complexity.

## Scheme

**`scripts/dungeon-deck.mjs`:**
- Remove `{ kind: 'trap', weight: 1 }` from `ROOM_KIND_WEIGHTS` (remaining weights: combat 5, skill_challenge 2, puzzle 1, narrative 1, treasure 2 — sum 11; `roomKindAt` never returns `'trap'` again).
- Delete the `trapSetpieceIds` parameter and its `kind === 'trap' ? setpieceAt(...) : ...` branch from all four generation functions (`buildRoomSequence`, `buildRoomGraph`, `insertRestRoom`, `attachHiddenPaths`), including each function's own occurrence counter (`trapOccurrence`/`detourTrapOccurrence`) where present.

**Callers threading `trapSetpieceIds`** (confirmed live: `scripts/dungeon-runner.mjs`'s `startDungeonRun`/`markRoomOutcome`, `scripts/dungeon-reseed.mjs`'s reseed flow, and any grouped-by-kind setpiece-id computation feeding them) lose that parameter too — the implementation plan's own job to enumerate every site exhaustively (a grep for `trapSetpieceIds` finds them all; this is mechanical, low-risk deletion, not new logic).

**`scripts/dungeon-scene.mjs`:** the existing trap build-time branch —

```js
if (
  room.kind === "trap" &&
  room.setpieceId &&
  !isSlotPopulated(scene, room.id)
) {
  await populateSlotTrap(scene, room.id, { ... });
}
```

— is replaced by a new, independent check that runs regardless of which kind the room actually is (including `combat`, after that branch's own encounter population already ran — `populateSlotTrap`'s own `spawnCreatures` call already computes `occupied` from existing scene tokens before placing, so it naturally avoids overlapping an already-spawned encounter), excluding only `safe_entry`/`safe_rest`/goal rooms:

```js
if (
  !["safe_entry", "safe_rest"].includes(room.kind) &&
  !room.isGoal &&
  !hasTrapInRoom(scene, room.id) &&
  trapRollSucceeds(state.seed, room.id)
) {
  await populateSlotTrap(scene, room.id, { ... });
}
```

`trapRollSucceeds(seed, roomId)`: a new pure function (`scripts/dungeon-deck.mjs`, alongside `roomKindAt`/`exitCountAt`) using the same `splitmix32(seedFromString(...))` convention every other seeded room-property check in this file already uses, returning true at the same **~8.3% rate traps occur at today** (matching the removed weight-1-of-12 share — confirmed as the right target rate per user decision 2026-10-05). `hasTrapInRoom(scene, roomId)`: a new small helper (mirrors the existing `isSlotPopulated` style) checking whether a trap hazard token already exists for this room (needed for idempotency — this check runs on every `buildPopulateAndUnlockGraphNode` call, which is itself called repeatedly/idempotently elsewhere in this codebase, e.g. the ensure-built retry loop `resolveCurrentRoom` already uses).

**`data/dungeon-setpieces.json`:** its 3 `kind: "trap"` entries become genuinely unused data once the above lands. **Decision:** leave them in place rather than deleting — harmless dead data, and deleting risks an unforeseen second consumer this spec's investigation didn't find. Worth a `tools/validate-dungeon-setpieces.mjs`-style note or a follow-up cleanup issue if this bothers future maintenance, not blocking for this spec.

## What does NOT need changes

- `scripts/trap-library.mjs`, `scripts/trap-mechanics.mjs`, `scripts/trap-combat.mjs`, `scripts/dungeon-runner.mjs`'s `ensureTrapState`/`populateSlotTrap` itself — the actual trap engine (selection, state, detect/disable/trigger per #753) is untouched; this spec only changes *when/how often* a trap gets placed, never what a trap IS once placed.
- #753's own detect/disable/trigger wiring — fully independent of which room kinds a trap can appear in.

## Deliberately out of scope

- Corridor/hallway placement — filed as #779.
- Multi-tile trap footprints, expanded trap library sourcing, art generation — separate #569 sub-issues (#757, #756, #759), unaffected by this change.
- Re-tuning the overall trap frequency beyond matching today's existing ~8.3% rate — a product decision for later if the new independence from room-kind turns out to feel too sparse/frequent in actual play; this spec deliberately preserves today's rate unchanged rather than guessing a new one.
