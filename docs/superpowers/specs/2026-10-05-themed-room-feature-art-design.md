# Themed art for doors and room-feature tokens — design

**Tracks:** [#750](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/750)
**Follow-up filed, deliberately out of scope:** [#764](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/764) (per-floor-variant art and open/used/locked state variants)
**Builds on:** #611/#623 (room-feature prop tokens, `scripts/room-feature-tokens.mjs`), #574 (floor-art tiles), #628 (art naming/layout)

## Problem

The interactable markers a dungeon room shows its players look generic. The treasure, puzzle and skill-challenge props (#611/#623) use Foundry's own core icons (`icons/svg/chest.svg`, `clockwork.svg`, `dice-target.svg`), and doors use Foundry's native door drawing. Every room theme gets the same markers, so they do not look like they belong on the themed floor art (`assets/dungeon-rooms/<theme>-N.webp`) they sit on.

#750 gives each marker custom art that matches the room's environment, with a sensible fallback when a theme has no art.

## Decisions (user, 2026-10-05)

1. **Doors are in scope**, via Foundry's native wall door texture (below), not a new overlay mechanism.
2. **Volume: one image per theme x kind.** Variants are split out to #764.
3. **A door takes the theme of the room the party is leaving** (the room whose wall the door is on). Corridor doors use a neutral corridor door.
4. **Art generation reuses the existing pipeline** with its own prompt table, in a new tool (approach A of the brainstorm); the creature generator's routing, failure registry and review log are not touched.

## What a Wall can carry (verified live, Foundry 14.368)

Doors are Foundry **Wall** documents (`door: CONST.WALL_DOOR_TYPES.DOOR`), not tokens, built by `wallDoc()` in `scripts/dungeon-scene.mjs`. A Wall has no image field, but `WallDocument.schema` has an `animation` block:

| field | type | default |
|---|---|---|
| `texture` | FilePathField ("Door Texture") | null |
| `type` | one of `swing`, `slide`, `ascend`, `descend`, `swivel` | `swing` |
| `direction` | -1 or 1 | 1 |
| `double` | boolean | false |
| `flip` | boolean | false |
| `duration` | ms | 750 |
| `strength` | 0-2 multiplier | 1 |

Today every door wall in the live scene has `animation: null`. Setting `animation.texture` (and `type`) on a door wall at build time is the whole door mechanism: no spawner, no overlay, no state tracking. Limit: one texture per wall. Foundry animates open/closed itself, so there are no separate closed/open/locked images; locked state stays on Foundry's door control icon. Per-state art is #764.

**Unverified:** how the texture renders (orientation, how it is scaled to the wall segment, how each animation type moves it). The first task of the plan is a live spike that settles this before any art is generated (see Spike).

## Art set

**Themes (9):** the 8 `locationTag` values the floor art already uses — `aberration`, `beast`, `construct`, `dragon`, `elemental`, `fiend`, `plant`, `undead` — plus `corridor` (neutral corridor door; no tokens).

**Kinds (4):** `door`, `treasure`, `puzzle`, `skill_challenge` (the existing room-feature kind keys).

**Files (33):** 8 themes x 4 kinds, plus `corridor/door`. Transparent-background WebP, at

```
assets/room-features/<theme>/<kind>.webp
```

(for example `assets/room-features/undead/treasure.webp`). Door images follow the format the spike fixes (aspect ratio and viewpoint); token images are square, front/three-quarter view.

## Selection and fallback

New pure module `scripts/room-feature-art.mjs` (no Foundry access, unit-testable):

- `ROOM_FEATURE_ART_THEMES` — the 9 theme keys above.
- `roomFeatureArtPath({ theme, kind })` — returns the module-relative path `modules/pf2e-dungeon-crawl/assets/room-features/<theme>/<kind>.webp` if `data/room-feature-art.json` lists that theme and kind as available, else `null`.

`data/room-feature-art.json` is a manifest, `{ "<theme>": ["door", "treasure", ...] }`. It is the single source of truth for what exists, because the runtime cannot check the filesystem. A test asserts the manifest matches the files on disk exactly (no manifest entry without a file, no file without an entry).

**Fallback, per marker, never an error:**

- Treasure / puzzle / skill-challenge token: themed art if available, else the current core icon from `ROOM_FEATURE_TOKEN_TYPES`.
- Door: themed texture if available, else no `animation.texture` (Foundry's native door, exactly as today).
- Unknown or missing `locationTag`: treated as no art (the fallbacks above).

## Wiring

**Tokens.** `buildRoomFeatureTokenActorData(kind, roomId)` gains a `theme` argument and sets `img` and `prototypeToken.texture.src` from `roomFeatureArtPath({ theme, kind }) ?? type.img`. The call site in the existing treasure / puzzle / skill-challenge branches of `buildPopulateAndUnlockGraphNode` passes `room.locationTag`. The actor `name` and the `roomFeatureKind` / `roomFeatureRoomId` flags are unchanged, so click handling (`targetToken` routing, `planRoomFeatureAction`) is untouched.

**Doors.** `wallDoc()` accepts an optional `art` path. When present on a door wall it sets `animation: { type, texture: art }` (type and any other animation fields per the spike). Every call site that builds a door (`door: CONST.WALL_DOOR_TYPES.DOOR`) for a room's own wall passes `roomFeatureArtPath({ theme: <the room's locationTag>, kind: "door" })`; corridor doors pass `theme: "corridor"`. Hidden-door gate/reveal and stub doors take the same rule, so a hidden door looks like its room's other doors. Wall collision, vision, door state, locking and the unlock/reveal logic are untouched; only the `animation` field is added.

## Generation pipeline

New tool `tools/generate-room-feature-art.mjs`:

- A prompt table keyed by `<theme>/<kind>`, 33 entries, each describing the object in that theme's style (for example an undead treasure chest: bone-trimmed coffin-chest; a fiend door: iron-banded door with a brimstone glow). Prompts follow the repo's existing rules (no apostrophes inside prompt strings; plain empty background).
- Backends: reuse the creature generator's ComfyUI-first, OpenRouter-fallback code by importing it. If the needed functions are not exported from `tools/generate-token-art.mjs`, export them with no behavior change. The creature routing registry, persistent-failure list and `docs/gemini-hand-queue.tsv` are not used (these are objects, not creatures).
- Post-process every image with `tools/make-bg-transparent.mjs` (flood-fills the flat background to transparency), then write the WebP to the path above and add it to `data/room-feature-art.json`.
- Review: every image is checked on a contact sheet against its kind (a door reads as a door, a chest as a chest, a puzzle mechanism as a puzzle, a challenge marker as a challenge) and its theme, with no stray frames, rings, pedestals or scenery, and redone if not.

## Spike (first task of the plan)

Before generating art, on a throwaway wall in the live world: set `animation.texture` to a test image on a door wall and observe (a) which way the image is oriented along the wall, (b) how it is scaled to the wall segment, (c) what each animation `type` does on open/close, (d) whether a texture changes how the door control or click works. The outcome fixes the door image format (aspect ratio, viewpoint) and the animation `type` for the 9 door images. If the texture does not render usably, doors drop out of #750 and move to a follow-up issue; the 24 token images and all token wiring still ship.

## Testing

- `roomFeatureArtPath`: returns the path for a listed theme/kind; `null` for an unlisted kind, an unlisted theme, a null/unknown theme.
- Manifest coverage: `data/room-feature-art.json` matches `assets/room-features/**` exactly; every theme x kind is either present or knowingly absent (a test lists the intentional gaps).
- `buildRoomFeatureTokenActorData`: themed `img` / `prototypeToken.texture.src` when available, core icon fallback otherwise; flags and name unchanged.
- `wallDoc`: sets `animation.texture` only for door walls with an `art` path; non-door walls and the no-art case are unchanged.
- Door and token wiring against the live scene is verified live, as with other Foundry glue in this repo: start a run and confirm the markers and doors show the room's theme art and the fallbacks work.

## Out of scope

- Per-floor-variant art and open/used/locked/solved state variants — #764.
- Changing how tokens are targeted or interacted with, or door/lock/unlock behavior.
- Art for traps, cover items or anything else; creature token art (#16/#229).
- Letting a GM pick custom art per room.

## Amendments from planning (2026-10-05)

- **No corridor door.** Every door the code builds (stub, hidden gate/reveal, real gate/reveal) sits on a room face, so `corridor/door` has no call site. Themes are the 8 `locationTag` values; the art set is **32** files, not 33.
- **Generator integration.** Instead of a new `tools/generate-room-feature-art.mjs`, prompts live in `tools/room-feature-art-prompts.mjs` as a `ROOM_FEATURE_ART` subject list spread into the existing generator's `ALL` list (ids `rf-<theme>-<kind>`). This reuses its backends and skip-if-exists logic with less risk than importing internals into a new tool.
- **Wiring detail.** `wallDoc` is exported and takes `art`; the manifest is loaded once per build via `loadRoomFeatureArt()` in `scripts/data-loader.mjs`, which never rejects.

## Spike result (2026-10-05, live, Foundry 14.368)

Throwaway scene with five door walls (one per animation type), each carrying a room-floor image as `animation.texture`:

- **Type:** `swing` is the right one for a dungeon door. It pivots about the wall's SW end through 90 degrees clockwise. All five types open and close on click, and the door control still works.
- **Scaling:** the texture is drawn with its width equal to the wall segment's length, keeps its own aspect ratio, and is centered on the wall midpoint (the door control icon sits at its center). A square image therefore covers a square as wide as the door.
- **Door art format:** a hinged door leaf seen from directly above, a long flat horizontal strip. Because it keeps its aspect ratio, a wide strip draws as a thin leaf along the wall. Task 6 crops each generated door to a wide strip (about 6:1) after keying the background transparent.
- `DOOR_ANIMATION` stays `{ type: "swing" }`.
