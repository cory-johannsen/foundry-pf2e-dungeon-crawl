# Room-Feature Art Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #764 — extend #750's themed door/room-feature art with two more variant axes: (1) matching a room's own floor-art variant (0-2, the same seeded `room.artVariant` floor art already uses), and (2) a state variant for a door that's currently locked, and for a treasure/puzzle/skill-challenge token once its room has been resolved (used/solved) — both scoped, per user decision, to one image per theme regardless of floor variant (Foundry's own door-swing animation already shows open/closed for free; no new art needed there).

**Architecture:** Everything builds directly on #750's already-shipped infrastructure (`scripts/room-feature-art.mjs`'s pure lookup, `data/room-feature-art.json`'s manifest, `tools/room-feature-art-prompts.mjs`'s generator subjects) — no new subsystem. The manifest's per-theme value changes from a flat kind-list to `{kind: [variants]}`; `roomFeatureArtPath` gains a `variant` parameter that falls back to variant 0. Two new state-only kind keys are added (`door_locked`, and one shared `_used` suffix per token kind) to the SAME kind list the existing lookup already iterates, so no new lookup function is needed. `room.artVariant` (already assigned at room-generation time, `scripts/dungeon-deck.mjs`'s `roomArtVariantAt`, confirmed current) is threaded into the existing door/token art call sites; a door's locked-state swap happens at `unlockDoorsFromRoom` (confirmed current: today it updates only `ds`, never `animation`); a token's used-state swap is a new collaborator in `runRoomFeatureAction`'s existing injected-dependency shape.

**Tech Stack:** Vanilla ES modules, Vitest, ComfyUI (image generation).

**Spec:** None — a bounded extension of an already-shipped, already-spec'd feature (#750's own spec explicitly named this exact follow-up: "Per-floor-variant art and open/used/locked/solved state variants — #764"). The one real open scope question (whether state-variant art also needs 3 floor-variants each) was presented to and decided by the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new mechanic plus new art: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- Per the user's own decision: state-variant art (`door_locked`, `*_used`) gets exactly **one** image per theme, independent of floor variant. Floor-variant art (variants 1/2 of the 4 base kinds) is a separate axis, only ever applied to the base (non-state) art.
- Variant 0 of every existing base kind keeps its current, already-shipped, unsuffixed filename (`<kind>.webp`) — no renaming of #750's 32 already-reviewed files. Only variant 1/2 are suffixed (`<kind>-1.webp`, `<kind>-2.webp`).
- `roomFeatureArtPath`'s existing fallback philosophy is preserved exactly: a missing manifest entry (unlisted theme, kind, or variant) is always a silent fallback, never an error — falling back to variant 0 if the requested variant is missing, then to the caller's own existing fallback (core icon for tokens, no texture for doors) if even variant 0 is missing.
- No change to door/lock/unlock mechanics, token targeting, or room-resolution logic — every change here is purely which image gets shown, never whether/when something happens.

## Review Focus

- **A door that starts locked must show the locked-state art if available, and the normal (variant-matched) art must come back the instant it's unlocked** — `unlockDoorsFromRoom` today only ever updates `ds`; it must also recompute `animation.texture`, not just leave whatever texture was set at build time.
- **A resolved room's treasure/puzzle/skill-challenge token must swap to its used-state art if available, and must never touch the token at all if no such art exists** (today's unchanged behavior is itself a valid fallback, not a bug).
- **A room's floor-variant (0/1/2) must select the matching door/token art variant when one exists, and fall back to variant 0 when it doesn't** — a theme with only variant 0 generated must look identical to how it looks today, not break or show nothing.
- **The manifest migration must not silently drop any of #750's existing 32 entries** — every one of today's `{theme: [kind,...]}` entries must become `{theme: {kind: [0]}}`, verified by the updated manifest-coverage test.
- **A door's locked-art and base-art must use the SAME theme/variant pairing rule #750 already established** ("a door takes the theme of the room whose wall it's on") — the locked swap must not accidentally pick a different room's theme than the door's own base art would.

---

### Task 1: Extend the manifest schema and lookup

**Files:**
- Modify: `scripts/room-feature-art.mjs` (`roomFeatureArtPath`, kind constants)
- Modify: `data/room-feature-art.json` (migrate to the new per-kind variant-array shape)
- Test: `tests/room-feature-art.test.mjs` (or wherever #750's own tests for this file live — confirm the exact filename first)

**Interfaces:**
- Produces: `roomFeatureArtPath({theme, kind, variant = 0, manifest})` — same name/callers as today, now variant-aware. `ROOM_FEATURE_ART_STATE_KINDS` — the 4 new kind keys (`door_locked`, `treasure_used`, `puzzle_used`, `skill_challenge_used`), exported for Task 4's generator wiring. Consumed by Tasks 2 and 3.

- [x] **Step 1: Confirm the existing test file and current manifest-coverage test**

```bash
grep -rln "roomFeatureArtPath" tests/
```

Open whichever file that finds and read its existing `describe`/`it` blocks in full before writing new ones below, matching its exact conventions (fixture style, manifest-coverage assertion shape).

- [x] **Step 2: Write the failing tests**

Add to that file:

```js
describe('roomFeatureArtPath variants (#764)', () => {
  const manifest = { undead: { door: [0, 1], treasure: [0], door_locked: [0] } };

  it('returns the exact variant when listed', () => {
    expect(roomFeatureArtPath({ theme: 'undead', kind: 'door', variant: 1, manifest }))
      .toBe('modules/pf2e-dungeon-crawl/assets/room-features/undead/door-1.webp');
  });

  it('variant 0 keeps the unsuffixed filename', () => {
    expect(roomFeatureArtPath({ theme: 'undead', kind: 'door', variant: 0, manifest }))
      .toBe('modules/pf2e-dungeon-crawl/assets/room-features/undead/door.webp');
  });

  it('falls back to variant 0 when the requested variant is missing', () => {
    expect(roomFeatureArtPath({ theme: 'undead', kind: 'door', variant: 2, manifest }))
      .toBe('modules/pf2e-dungeon-crawl/assets/room-features/undead/door.webp');
  });

  it('returns null when even variant 0 is missing for that kind', () => {
    expect(roomFeatureArtPath({ theme: 'undead', kind: 'treasure', variant: 1, manifest })).toBe(null);
  });

  it('a state kind (no variant concept) resolves from its own unsuffixed file', () => {
    expect(roomFeatureArtPath({ theme: 'undead', kind: 'door_locked', manifest }))
      .toBe('modules/pf2e-dungeon-crawl/assets/room-features/undead/door_locked.webp');
  });

  it('defaults variant to 0 when omitted', () => {
    expect(roomFeatureArtPath({ theme: 'undead', kind: 'door', manifest }))
      .toBe('modules/pf2e-dungeon-crawl/assets/room-features/undead/door.webp');
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/room-feature-art.test.mjs -t "variants"` (adjust path to whatever Step 1 found)
Expected: FAIL — `roomFeatureArtPath` doesn't understand `variant` or the new manifest shape yet.

- [x] **Step 4: Rewrite `roomFeatureArtPath` and extend the kind list**

In `scripts/room-feature-art.mjs`, change:

```js
export const ROOM_FEATURE_ART_KINDS = ["door", "treasure", "puzzle", "skill_challenge"];
export const ROOM_FEATURE_ART_DIR = `modules/${MODULE_ID}/assets/room-features`;

/** Module-relative path of the themed image, or null when the manifest does
 * not list that theme/kind (or either name is unknown). */
export function roomFeatureArtPath({ theme, kind, manifest } = {}) {
  if (!ROOM_FEATURE_ART_THEMES.includes(theme)) return null;
  if (!ROOM_FEATURE_ART_KINDS.includes(kind)) return null;
  const kinds = manifest?.[theme];
  if (!Array.isArray(kinds) || !kinds.includes(kind)) return null;
  return `${ROOM_FEATURE_ART_DIR}/${theme}/${kind}.webp`;
}
```

to:

```js
export const ROOM_FEATURE_ART_BASE_KINDS = ["door", "treasure", "puzzle", "skill_challenge"];
// #764: one state variant per base kind, ignoring floor variant (user decision
// 2026-10-05) -- a locked door or a used/solved token looks the same across
// a theme's own 3 floor sub-styles.
export const ROOM_FEATURE_ART_STATE_KINDS = [
  "door_locked", "treasure_used", "puzzle_used", "skill_challenge_used",
];
export const ROOM_FEATURE_ART_KINDS = [...ROOM_FEATURE_ART_BASE_KINDS, ...ROOM_FEATURE_ART_STATE_KINDS];
export const ROOM_FEATURE_ART_DIR = `modules/${MODULE_ID}/assets/room-features`;

/**
 * Module-relative path of the themed image, or null when the manifest does
 * not list that theme/kind/variant (or either name is unknown).
 *
 * #764: the manifest's per-theme value is `{kind: [variants]}` -- an array
 * of which floor-variant indices (0, 1, 2) exist for that kind. `variant`
 * defaults to 0; an unlisted requested variant falls back to variant 0
 * (never an error, matching this function's own pre-#764 fallback
 * philosophy) before giving up and returning null. Variant 0's file stays
 * unsuffixed (`<kind>.webp`, #750's own already-shipped 32 files); only
 * variant 1/2 add a `-<variant>` suffix. A state kind (`door_locked`,
 * `*_used`) never has more than variant 0 — the suffix is simply never
 * added for it, same code path, no special-casing needed.
 */
export function roomFeatureArtPath({ theme, kind, variant = 0, manifest } = {}) {
  if (!ROOM_FEATURE_ART_THEMES.includes(theme)) return null;
  if (!ROOM_FEATURE_ART_KINDS.includes(kind)) return null;
  const variants = manifest?.[theme]?.[kind];
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const resolved = variants.includes(variant) ? variant : (variants.includes(0) ? 0 : null);
  if (resolved === null) return null;
  const suffix = resolved === 0 ? "" : `-${resolved}`;
  return `${ROOM_FEATURE_ART_DIR}/${theme}/${kind}${suffix}.webp`;
}
```

- [x] **Step 5: Migrate `data/room-feature-art.json`**

Replace its entire contents with (every existing entry's kinds carried forward unchanged as `[0]`; no new variants/state kinds listed yet — Task 5 adds them once the art actually exists):

```json
{
  "aberration": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "beast": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "construct": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "dragon": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "elemental": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "fiend": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "plant": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] },
  "undead": { "door": [0], "treasure": [0], "puzzle": [0], "skill_challenge": [0] }
}
```

- [x] **Step 6: Update the manifest-coverage test for the new shape**

The existing "manifest matches the files on disk exactly" test (found in Step 1) walks `manifest[theme]` as an array of kind strings; update it to walk `Object.keys(manifest[theme])` as the kind list instead (the variant array itself only matters for Task 5's own coverage check, added there once variant/state files actually exist) — adjust its exact logic to match whatever shape the real test used, preserving its "no manifest entry without a file, no file without an entry" guarantee for variant 0's unsuffixed filename.

- [x] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/room-feature-art.test.mjs`
Expected: PASS, every test (old and new) green.

- [x] **Step 8: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — every existing caller of `roomFeatureArtPath` (Tasks 2/3's own current code, pre-this-plan) still passes a bare `{theme, kind, manifest}` with no `variant`, which now defaults to 0 and resolves identically to before the manifest migration.

- [ ] **Step 9: Commit**

```bash
git add scripts/room-feature-art.mjs data/room-feature-art.json tests/room-feature-art.test.mjs
git commit -m "feat(#764): extend room-feature art manifest with variants and state kinds

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Door floor-variant and locked-state art

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildRoomAtGraphNode`'s and `buildPopulateAndUnlockGraphNode`'s own `doorArt` closures and their call sites; `unlockDoorsFromRoom`)
- Test: `tests/dungeon-scene-door-art.test.mjs` (confirmed current filename, grown by #750's own PR #796 — read its existing conventions first)

**Interfaces:**
- Consumes: `roomFeatureArtPath({theme, kind, variant, manifest})` (Task 1).
- Produces: nothing further in this plan consumes it.

- [x] **Step 1: Write the failing tests**

Read `tests/dungeon-scene-door-art.test.mjs` in full first to match its exact fixture/mock conventions (confirmed current: it already covers #750's door-art wiring, so this is an extension, not a new harness). Add cases asserting:
- A door built for a room whose `artVariant` is 1 (and whose manifest lists `door: [0, 1]` for that theme) gets `animation.texture` ending in `door-1.webp`, not `door.webp`.
- A door built with `ds: LOCKED` and a manifest that lists `door_locked: [0]` for that theme gets `animation.texture` ending in `door_locked.webp`, not `door.webp`/`door-N.webp`.
- A door built with `ds: LOCKED` but NO `door_locked` entry in the manifest falls back to the normal (variant-matched) `door` art, unchanged from #750's own existing behavior.
- `unlockDoorsFromRoom`, called against a wall whose `animation.texture` currently points at a `door_locked` image, updates it (via `wall.update`) to the normal `door`/`door-N` art for that same room's theme and variant.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-door-art.test.mjs -t "#764"`
Expected: FAIL.

- [x] **Step 3: Extend both `doorArt` closures**

In `buildRoomAtGraphNode` (confirmed current, lines 507-509):

```js
  const doorArtManifest = await loadRoomFeatureArt();
  const doorArt = (theme) => roomFeatureArtPath({ theme, kind: "door", manifest: doorArtManifest });
```

to:

```js
  const doorArtManifest = await loadRoomFeatureArt();
  const doorArt = (theme, variant = 0) =>
    roomFeatureArtPath({ theme, kind: "door", variant, manifest: doorArtManifest });
  // #764: a locked door's own art, falling back to the normal (variant-matched)
  // art when no dedicated locked image exists for that theme -- never no
  // texture at all if the base art is available.
  const lockedDoorArt = (theme, variant = 0) =>
    roomFeatureArtPath({ theme, kind: "door_locked", manifest: doorArtManifest }) ?? doorArt(theme, variant);
```

Change the stub-door call site (confirmed current, line 741, `ds: LOCKED`):

```js
          art: doorArt(locationTag),
```

to:

```js
          art: lockedDoorArt(locationTag, artVariant),
```

Apply the identical extension to `buildPopulateAndUnlockGraphNode`'s own `doorArt` closure (confirmed current, line 1537, same two-line shape as line 508-509) — add the same `lockedDoorArt` helper there. Change its four call sites (confirmed current, lines 1692/1693/1711/1712):

```js
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "gate" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR, art: doorArt(state.rooms?.[sourceId]?.locationTag) }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "reveal" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR, art: doorArt(room.locationTag) }),
          ...plainWalls.map((w) => wallDoc(w)),
```

to:

```js
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "gate" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR, art: lockedDoorArt(state.rooms?.[sourceId]?.locationTag, state.rooms?.[sourceId]?.artVariant) }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "reveal" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR, art: lockedDoorArt(room.locationTag, room.artVariant) }),
          ...plainWalls.map((w) => wallDoc(w)),
```

(the second occurrence, lines 1711/1712, is identical except `revealDoorWall`'s own `ds` is already `CLOSED` not `LOCKED` — confirmed current, line 1712 — so ONLY its sibling `doorWall` at line 1711 changes to `lockedDoorArt`; `revealDoorWall` at 1712 changes to pass the variant but keeps using plain `doorArt`):

```js
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonDoorToRoomId: room.id, dungeonDoorFromRoomId: sourceId } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR, art: lockedDoorArt(state.rooms?.[sourceId]?.locationTag, state.rooms?.[sourceId]?.artVariant) }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonRevealDoorForSlot: room.id, dungeonDoorFromRoomId: sourceId } }, ds: CONST.WALL_DOOR_STATES.CLOSED, door: CONST.WALL_DOOR_TYPES.DOOR, art: doorArt(room.locationTag, room.artVariant) }),
```

- [x] **Step 4: Swap the texture back on unlock**

In `unlockDoorsFromRoom` (confirmed current, lines 1913-1938), change:

```js
export async function unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds = []) {
  const targets = childIds.filter((id) => !hiddenChildIds.includes(id));
  for (const targetId of targets) {
    const wall = scene.walls.find(
      (w) =>
        w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === targetId &&
        w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId,
    );
    if (wall) {
      await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
      playDoorSound("unlock");
    }
  }
  // #427: the source's dead-end stub doors unlock with its real doors (Decision 10: indistinguishable, no extra
  // check). A hidden stub keeps its sealed hidden-door flags and opens only when revealed (unsealHiddenDoorFromRoom).
  for (const wall of scene.walls) {
    if (
      wall.getFlag(MODULE_ID, "dungeonStubDoorFor") &&
      wall.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId &&
      !wall.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge")
    ) {
      await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
      playDoorSound("unlock");
    }
  }
}
```

to:

```js
export async function unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds = []) {
  // #764: a door's own locked-state art (if any) must come back to its
  // normal, variant-matched art the instant it unlocks -- recomputed here
  // rather than threaded in by every caller, since every unlock of a
  // roomId's own doors shares this one theme/variant pair ("a door takes
  // the theme of the room whose wall it's on", #750's own rule).
  const unlockRoom = getRunState(scene.id)?.rooms?.[roomId];
  const doorArtManifest = await loadRoomFeatureArt();
  const unlockAnimation = unlockRoom
    ? doorAnimationFor(
        roomFeatureArtPath({
          theme: unlockRoom.locationTag,
          kind: "door",
          variant: unlockRoom.artVariant,
          manifest: doorArtManifest,
        }),
      )
    : null;
  const update = unlockAnimation
    ? { ds: CONST.WALL_DOOR_STATES.CLOSED, animation: unlockAnimation }
    : { ds: CONST.WALL_DOOR_STATES.CLOSED };
  const targets = childIds.filter((id) => !hiddenChildIds.includes(id));
  for (const targetId of targets) {
    const wall = scene.walls.find(
      (w) =>
        w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === targetId &&
        w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId,
    );
    if (wall) {
      await wall.update(update);
      playDoorSound("unlock");
    }
  }
  // #427: the source's dead-end stub doors unlock with its real doors (Decision 10: indistinguishable, no extra
  // check). A hidden stub keeps its sealed hidden-door flags and opens only when revealed (unsealHiddenDoorFromRoom).
  for (const wall of scene.walls) {
    if (
      wall.getFlag(MODULE_ID, "dungeonStubDoorFor") &&
      wall.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId &&
      !wall.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge")
    ) {
      await wall.update(update);
      playDoorSound("unlock");
    }
  }
}
```

(`getRunState` is already imported in this file, confirmed current line 64 — no new import needed.)

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-door-art.test.mjs`
Expected: PASS, old and new cases green.

- [x] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-door-art.test.mjs
git commit -m "feat(#764): wire door floor-variant and locked-state art

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Token floor-variant and used-state art

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`spawnRoomFeatureToken` and its 3 call sites; new `applyRoomFeatureUsedArt`)
- Modify: `scripts/room-feature-tokens.mjs` (`runRoomFeatureAction` gains a `deps.applyUsedArt` call)
- Modify: `scripts/module.mjs`, `scripts/dungeon-remote.mjs` (both existing `runRoomFeatureAction` call sites pass the new real collaborator)
- Test: wherever #750/#611/#623's own tests for `spawnRoomFeatureToken`/`runRoomFeatureAction` live — confirm filenames first (`grep -rln "runRoomFeatureAction" tests/`)

**Interfaces:**
- Produces: `applyRoomFeatureUsedArt(scene, roomId, kind, {theme, manifest})` (new, `scripts/dungeon-scene.mjs`) — finds the room's own feature token (via the same `roomFeatureRoomId`/`roomFeatureKind` flags `hasRoomFeatureToken` already reads) and updates its `img`/`prototypeToken.texture.src` to the `${kind}_used` art if the manifest lists it, else does nothing. `runRoomFeatureAction`'s own `deps` shape gains `applyUsedArt` (optional; a no-op default keeps every existing caller that doesn't pass it unaffected — though this plan updates both real callers to pass it).

- [x] **Step 1: Write the failing tests**

`grep -rln "runRoomFeatureAction\|spawnRoomFeatureToken" tests/` first and read the matching file(s) in full to match their exact fixture conventions. Add cases:
- `spawnRoomFeatureToken` called with a room whose `artVariant` is 1 (manifest lists `treasure: [0, 1]` for that theme) builds the actor with `art` ending in `treasure-1.webp`.
- `runRoomFeatureAction` for `kind: "treasure"`, on success, calls `deps.applyUsedArt(scene-or-sceneId, roomId, "treasure", {theme, manifest})` (match whatever exact argument shape reads most naturally against this function's own existing `deps` calls, e.g. `claimTreasureFor`/`revealRoomFeature`'s own argument style) exactly once; a failed/not-ok plan never calls it.
- `applyRoomFeatureUsedArt`: updates the matching token's `img`/`prototypeToken.texture.src` (via `token.actor.update`, matching how every other room-feature token update in this codebase applies a visual change) when the manifest lists `${kind}_used` for that theme; does nothing (no `update` call) when it doesn't; does nothing when no matching token exists on the scene.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "#764"` across whichever files Step 1 touched.
Expected: FAIL.

- [x] **Step 3: Thread `artVariant` into `spawnRoomFeatureToken`**

Change (confirmed current, lines 1085-1096):

```js
async function spawnRoomFeatureToken(scene, roomId, kind, { rank, col, seed, theme }) {
  const existing = scene.tokens.map((t) => t.flags?.[MODULE_ID]);
  if (hasRoomFeatureToken(existing, roomId, kind)) return;
  const rect = roomRect(seed, roomId, rank, col);
  const occupied = scene.tokens.map((t) => footprint(t, GRID_SIZE));
  const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? {
    gx: rect.gx,
    gy: rect.gy,
  };
  const art = roomFeatureArtPath({ theme, kind, manifest: await loadRoomFeatureArt() });
  const actorData = buildRoomFeatureTokenActorData(kind, roomId, { art });
  const [actor] = await Actor.createDocuments([actorData]);
```

to:

```js
async function spawnRoomFeatureToken(scene, roomId, kind, { rank, col, seed, theme, variant = 0 }) {
  const existing = scene.tokens.map((t) => t.flags?.[MODULE_ID]);
  if (hasRoomFeatureToken(existing, roomId, kind)) return;
  const rect = roomRect(seed, roomId, rank, col);
  const occupied = scene.tokens.map((t) => footprint(t, GRID_SIZE));
  const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? {
    gx: rect.gx,
    gy: rect.gy,
  };
  const art = roomFeatureArtPath({ theme, kind, variant, manifest: await loadRoomFeatureArt() });
  const actorData = buildRoomFeatureTokenActorData(kind, roomId, { art });
  const [actor] = await Actor.createDocuments([actorData]);
```

Update all three call sites (confirmed current, ~lines 1800, 1848, 1884) to add `variant: room.artVariant,` alongside their existing `theme: room.locationTag,` line.

- [x] **Step 4: Write `applyRoomFeatureUsedArt`**

Add near `spawnRoomFeatureToken` in `scripts/dungeon-scene.mjs`:

```js
/**
 * #764: swap a resolved room's own feature token to its used/solved-state
 * art, if the manifest has one for this theme — a no-op (token left
 * exactly as it was) when it doesn't, matching #750's own "silent
 * fallback, never an error" rule, and when no matching token exists at
 * all (e.g. the room had none to begin with).
 */
export async function applyRoomFeatureUsedArt(scene, roomId, kind, { theme, manifest } = {}) {
  const art = roomFeatureArtPath({ theme, kind: `${kind}_used`, manifest });
  if (!art) return;
  const token = scene.tokens.find(
    (t) =>
      t.getFlag(MODULE_ID, "roomFeatureRoomId") === roomId &&
      t.getFlag(MODULE_ID, "roomFeatureKind") === kind,
  );
  if (!token?.actor) return;
  await token.actor.update({ img: art, "prototypeToken.texture.src": art });
}
```

- [x] **Step 5: Wire it into `runRoomFeatureAction`**

In `scripts/room-feature-tokens.mjs`, change `runRoomFeatureAction` (confirmed current, lines 64-87):

```js
export async function runRoomFeatureAction(
  { sceneId, roomId, kind },
  {
    // MUST be the real SYNCHRONOUS getRunState: the in-flight lock's
    // correctness relies on there being no await between plan and lock.
    getRunState,
    claimTreasureFor,
    revealRoomFeature,
    inFlight = moduleInFlight,
  },
) {
  const plan = planRoomFeatureAction({ state: getRunState(sceneId), kind, roomId });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const key = `${sceneId}:${roomId}`;
  if (inFlight.has(key)) return { ok: false, reason: "in-flight" };
  inFlight.add(key);
  try {
    if (kind === "treasure") await claimTreasureFor(sceneId);
    else await revealRoomFeature(sceneId, roomId, kind);
    return { ok: true };
  } finally {
    inFlight.delete(key);
  }
}
```

to:

```js
export async function runRoomFeatureAction(
  { sceneId, roomId, kind },
  {
    // MUST be the real SYNCHRONOUS getRunState: the in-flight lock's
    // correctness relies on there being no await between plan and lock.
    getRunState,
    claimTreasureFor,
    revealRoomFeature,
    // #764: swaps the resolved token's own art to its used/solved variant.
    // Optional (a no-op default) so a caller that hasn't been updated to
    // pass it yet degrades to #750's own pre-#764 behavior, not a crash.
    applyUsedArt = async () => {},
    inFlight = moduleInFlight,
  },
) {
  const plan = planRoomFeatureAction({ state: getRunState(sceneId), kind, roomId });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const key = `${sceneId}:${roomId}`;
  if (inFlight.has(key)) return { ok: false, reason: "in-flight" };
  inFlight.add(key);
  try {
    if (kind === "treasure") await claimTreasureFor(sceneId);
    else await revealRoomFeature(sceneId, roomId, kind);
    await applyUsedArt(sceneId, roomId, kind, { theme: plan.room.locationTag });
    return { ok: true };
  } finally {
    inFlight.delete(key);
  }
}
```

- [x] **Step 6: Wire the real collaborator at both call sites**

In `scripts/module.mjs` (confirmed current, line 371 area, where `revealRoomFeature`/`claimTreasureFor`/`getRunState` are already passed into `runRoomFeatureAction`'s `deps`) and `scripts/dungeon-remote.mjs` (confirmed current, line 91), add a new local wrapper and pass it as `applyUsedArt`:

```js
async function applyRoomFeatureUsedArtForScene(sceneId, roomId, kind, { theme }) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  await applyRoomFeatureUsedArt(scene, roomId, kind, { theme, manifest: await loadRoomFeatureArt() });
}
```

(import `applyRoomFeatureUsedArt` from `./dungeon-scene.mjs` and `loadRoomFeatureArt` from `./data-loader.mjs` in both files — `dungeon-remote.mjs` and `module.mjs` both already import several other things from `dungeon-scene.mjs`, confirmed current, so this is additive to an existing import line, not a new cross-file dependency) then add `applyUsedArt: applyRoomFeatureUsedArtForScene` to each of the two `{ getRunState, claimTreasureFor, revealRoomFeature }` deps objects passed into `runRoomFeatureAction`.

- [x] **Step 7: Run tests to verify they pass**

Run: `npx vitest run -t "#764"` across the files Step 1 touched.
Expected: PASS.

- [x] **Step 8: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add scripts/dungeon-scene.mjs scripts/room-feature-tokens.mjs scripts/module.mjs scripts/dungeon-remote.mjs
git commit -m "feat(#764): wire token floor-variant and used-state art

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Generator subjects for the new art

**Files:**
- Modify: `tools/room-feature-art-prompts.mjs`

**Interfaces:** None — pure content, consumed by Task 5's generation run via the existing `generate-token-art.mjs` pipeline (unchanged import/splice mechanism, confirmed current from #750).

- [x] **Step 1: Add the 4 new state-kind subjects**

In `tools/room-feature-art-prompts.mjs`, change the import and `KIND_SUBJECT`/generation list:

```js
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_BASE_KINDS, ROOM_FEATURE_ART_STATE_KINDS } from '../scripts/room-feature-art.mjs';
```

Extend `KIND_SUBJECT` (add alongside the existing 4 entries):

```js
  door_locked: 'the same single heavy wooden dungeon door lying flat, seen from directly above in strict orthographic plan view, a long narrow horizontal rectangle of vertical planks, with a heavy iron chain and a large padlock looped tightly across the ring handle and lock plate, visibly locked and barred shut, no perspective, no side view, no wall, no archway, no door frame, no shadow, filling the frame edge to edge as one wide strip, aspect ratio 5:1',
  treasure_used: 'an open, emptied treasure chest with its lid thrown fully back, the bare interior visible and empty, seen from a three-quarter angle',
  puzzle_used: 'a small free-standing puzzle device with every dial and sliding block aligned and settled motionless into place, a solved and quiescent mechanism, seen from a three-quarter angle',
  skill_challenge_used: 'a tall trial standard with its banner lowered and furled tight against the pole, the crossed tools now resting still and spent, a completed challenge marker, seen from a three-quarter angle',
```

Change the generation list (currently):

```js
export const ROOM_FEATURE_ART = ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
  ROOM_FEATURE_ART_KINDS.map((kind) => ({
    id: `rf-${theme}-${kind}`,
    file: kind,
    dir: `assets/room-features/${theme}`,
    icon: true,
    prompt: `${KIND_SUBJECT[kind]}, styled as a ${theme} dungeon object with ${THEME_FLAVOR[theme]}, `
      + 'an inanimate object only, no creature and no face, the single object centered and filling the picture, plain empty background',
    avoid: AVOID,
  })),
);
```

to:

```js
// #764: floor-variant proof batch -- the "undead" theme's own 2 extra
// floor variants (1, 2) for all 4 base kinds, proving the variant pipeline
// end to end. Every other theme's variants 1/2 are a tracked follow-up
// batch through this exact same mechanism, not generated here.
const FLOOR_VARIANT_PROOF_THEME = 'undead';
const FLOOR_VARIANT_PROOF_VARIANTS = [1, 2];

function baseKindSubject(theme, kind) {
  return `${KIND_SUBJECT[kind]}, styled as a ${theme} dungeon object with ${THEME_FLAVOR[theme]}, `
    + 'an inanimate object only, no creature and no face, the single object centered and filling the picture, plain empty background';
}

export const ROOM_FEATURE_ART = [
  ...ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
    ROOM_FEATURE_ART_BASE_KINDS.map((kind) => ({
      id: `rf-${theme}-${kind}`,
      file: kind,
      dir: `assets/room-features/${theme}`,
      icon: true,
      prompt: baseKindSubject(theme, kind),
      avoid: AVOID,
    })),
  ),
  // #764 state variants: one per theme per state kind, no floor-variant axis.
  ...ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
    ROOM_FEATURE_ART_STATE_KINDS.map((kind) => ({
      id: `rf-${theme}-${kind}`,
      file: kind,
      dir: `assets/room-features/${theme}`,
      icon: true,
      prompt: `${KIND_SUBJECT[kind]}, styled as a ${theme} dungeon object with ${THEME_FLAVOR[theme]}, `
        + 'an inanimate object only, no creature and no face, the single object centered and filling the picture, plain empty background',
      avoid: AVOID,
    })),
  ),
  // #764 floor-variant proof batch.
  ...FLOOR_VARIANT_PROOF_VARIANTS.flatMap((variant) =>
    ROOM_FEATURE_ART_BASE_KINDS.map((kind) => ({
      id: `rf-${FLOOR_VARIANT_PROOF_THEME}-${kind}-${variant}`,
      file: `${kind}-${variant}`,
      dir: `assets/room-features/${FLOOR_VARIANT_PROOF_THEME}`,
      icon: true,
      prompt: baseKindSubject(FLOOR_VARIANT_PROOF_THEME, kind),
      avoid: AVOID,
    })),
  ),
];
```

(`baseKindSubject`'s extraction is a pure refactor of the existing single-line prompt-building expression — same text, reused for both the original 32 and the new proof-batch entries, since a floor-variant image describes the identical object/theme as variant 0, just a different roll of the same prompt — the generator's own per-attempt seed, confirmed current in `generate-token-art.mjs`, already produces a different image per distinct `id`.)

- [x] **Step 2: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — `tools/room-feature-art-prompts.mjs` has no dedicated unit test (confirmed, matching #750's own precedent for this exact file and `generate-token-art.mjs`'s own content arrays generally); this is a regression check on the rest of the suite.

- [x] **Step 3: Commit**

```bash
git add tools/room-feature-art-prompts.mjs
git commit -m "feat(#764): add generator subjects for state and floor-variant art

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Generate the art, update the manifest, live-verify, version bump

**Files:**
- Create: `assets/room-features/<theme>/{door_locked,treasure_used,puzzle_used,skill_challenge_used}.webp` (32 files), `assets/room-features/undead/{door,treasure,puzzle,skill_challenge}-{1,2}.webp` (8 files)
- Modify: `data/room-feature-art.json`
- Modify: `module.json`

No unit test: this task is the image-generation run, manifest update, and live verification, not code.

- [ ] **Step 1: Generate the 40 images**

```bash
node tools/generate-token-art.mjs \
  rf-aberration-door_locked rf-aberration-treasure_used rf-aberration-puzzle_used rf-aberration-skill_challenge_used \
  rf-beast-door_locked rf-beast-treasure_used rf-beast-puzzle_used rf-beast-skill_challenge_used \
  rf-construct-door_locked rf-construct-treasure_used rf-construct-puzzle_used rf-construct-skill_challenge_used \
  rf-dragon-door_locked rf-dragon-treasure_used rf-dragon-puzzle_used rf-dragon-skill_challenge_used \
  rf-elemental-door_locked rf-elemental-treasure_used rf-elemental-puzzle_used rf-elemental-skill_challenge_used \
  rf-fiend-door_locked rf-fiend-treasure_used rf-fiend-puzzle_used rf-fiend-skill_challenge_used \
  rf-plant-door_locked rf-plant-treasure_used rf-plant-puzzle_used rf-plant-skill_challenge_used \
  rf-undead-door_locked rf-undead-treasure_used rf-undead-puzzle_used rf-undead-skill_challenge_used \
  rf-undead-door-1 rf-undead-treasure-1 rf-undead-puzzle-1 rf-undead-skill_challenge-1 \
  rf-undead-door-2 rf-undead-treasure-2 rf-undead-puzzle-2 rf-undead-skill_challenge-2
```

Per #750's own documented precedent (its spec's "As built" note): the generator produces straight-on/flat results needing the same `tools/cutout-room-feature-art.py` post-process (crop/turn/squash for doors to the established 5:1 strip; rembg cutout for tokens) — run it the same way #750's own batch did.

- [ ] **Step 2: Review every image**

Per #750's own established review discipline (its spec's "Review" section): check each image against its kind (a locked door reads as barred/chained, an open chest reads as emptied, a solved puzzle reads as settled/quiescent, a spent challenge marker reads as lowered/still) and its theme, with no stray frames, rings, pedestals, or scenery. Redo (via `--force --reroll=N`) any that fail.

- [ ] **Step 3: Update the manifest**

Add the new entries to each theme's object in `data/room-feature-art.json` — for example, `undead` becomes:

```json
  "undead": {
    "door": [0, 1, 2],
    "treasure": [0, 1],
    "puzzle": [0, 1],
    "skill_challenge": [0, 1],
    "door_locked": [0],
    "treasure_used": [0],
    "puzzle_used": [0],
    "skill_challenge_used": [0]
  }
```

(`undead`'s `treasure`/`puzzle`/`skill_challenge` only reach variant 1, not 2, since Task 4's proof batch generated variant 1 AND 2 for `door` but the example above only shows 1 — adjust to match exactly which variants Step 1 actually produced for each kind, reading the real file list rather than assuming.) Every other theme (`aberration`, `beast`, `construct`, `dragon`, `elemental`, `fiend`, `plant`) gets only the 4 new state keys added, each `[0]`, with its base kinds unchanged at `[0]`.

- [ ] **Step 4: Run `npx vitest run` to confirm the manifest-coverage test still passes**

Expected: PASS — every new file has a matching manifest entry and vice versa.

- [ ] **Step 5: Live-verify via `foundry-rest`**

Generate (or advance) a real dungeon run until a treasure/puzzle/skill-challenge room resolves and a locked door is unlocked, confirming:

```bash
echo 'const w = canvas.scene.walls.find(w => w.door === 1); return { animation: w?.animation, ds: w?.ds };' | .claude/skills/foundry-rest/foundry-exec.sh
```

- a still-locked door's `animation.texture` ends in `door_locked.webp`;
- the same door, once unlocked, has `animation.texture` back to `door.webp`/`door-N.webp` matching its room's own floor variant;
- a resolved treasure/puzzle/skill-challenge room's token `img` ends in `_used.webp`;
- an `undead` room with `artVariant` 1 or 2 shows the matching `door-1`/`door-2` (etc.) art, and any theme without that variant generated still shows its unsuffixed variant-0 art exactly as before this plan.

- [ ] **Step 6: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (new generated content + new mechanics), using whatever the fetch above shows as current.

- [ ] **Step 7: Commit**

```bash
git add assets/room-features data/room-feature-art.json module.json
git commit -m "feat(#764): generate and ship state and floor-variant room-feature art

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #764's own three scope bullets (per-floor-variant art, state variants for doors and tokens, selection wiring and fallback) are each covered: Task 1 is the shared mechanism, Task 2 is doors (both variant axes), Task 3 is tokens (both variant axes), Tasks 4-5 are the actual content. The user's own scope-limiting decision (state variants get one image per theme, not 3) is applied consistently in both the manifest design and the generator subjects. The remaining 7 themes' variant-1/2 floor art (beyond the `undead` proof batch) is explicitly named as a tracked follow-up batch through the exact same mechanism, not silently dropped.

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real change; Task 5's manifest-update step explicitly flags where the implementer must read the real generated file list rather than copy a guessed example verbatim.

**3. Type consistency:** `roomFeatureArtPath({theme, kind, variant, manifest})`'s signature (Task 1) is used identically by Task 2's door closures, Task 3's `spawnRoomFeatureToken`/`applyRoomFeatureUsedArt`, matching the same `{theme, kind, variant?, manifest}` shape everywhere. `runRoomFeatureAction`'s new `applyUsedArt(sceneId, roomId, kind, {theme})` signature (Task 3) is defined once and called identically at both of Task 3's own wiring sites.

**4. Review Focus:** All five items (locked-art swap on build and un-swap on unlock, used-art swap on resolve with a safe no-op fallback, floor-variant selection with a safe variant-0 fallback, a complete and correct manifest migration, consistent theme/variant pairing between a door's locked and base art) each map to a specific test or step in the task that owns them. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-room-feature-art-variants.md`.
