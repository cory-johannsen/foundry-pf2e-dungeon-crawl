# Basic-Save Trap Automation Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #884 — five minor follow-ups from #839's own second review (PR #883).

**Triage (confirmed by direct code reading this session, current `main` post-#839 merge):** Of the five findings, three have a real, concrete fix; two are documented, already-accepted limitations the issue itself frames as matching existing convention or not currently reachable — those two get a clarifying comment, not a behavior change, so a future reader doesn't mistake "known and accepted" for "unexamined."

1. **Line of effect, center-to-center (comment only):** confirmed current, `centerCell`/`resolveAreaTargets` (`scripts/trap-combat.mjs:383-438`) checks line of sight from the hazard's own center cell to each candidate's own center cell. The issue's own text says this "matches the existing dungeon-combat `hasLineOfSight` convention" — confirmed true: `dungeon-combat.mjs`'s own `hasLineOfSight` (line 2441) does the same single-cell-to-single-cell check via `tokenCell`. Since this mirrors an already-accepted pattern elsewhere rather than introducing a new gap, this plan documents the known edge case rather than building a new multi-corner line-of-effect algorithm neither module has today.
2. **`@Check`/`@Damage` not anchored to the Effect text (real fix, cheap):** confirmed current, `parseBasicSaveAction` (`scripts/trap-mechanics.mjs:238-267`) runs `checkMatch`/`damageMatch` against the full `descriptionHtml`, not `effectText(descriptionHtml)` — unlike `parseAreaFeet` (line 210-216, confirmed current), which already scopes to the Effect paragraph. Confirmed latent, not reachable today (per the issue's own text and this module's own hazard-selection logic), but the fix is a one-line scope change matching an already-established sibling pattern in the same file.
3. **HTML entities double-escaped in GM whispers (real fix):** confirmed current, `plainDescriptionText` (`scripts/trap-mechanics.mjs:185-207`) strips tags but never decodes entities — literal text like `&amp;` survives into the whisper's own interpolated value, where `escapeText` (`scripts/trap-combat.mjs:320-326`) then re-escapes its own `&`, producing `&#38;amp;` instead of a real `&`.
4. **`wallBlocksLine`/`wallBlocksMovement` triplicated (real fix, shared helper):** confirmed current — byte-identical bodies in `scripts/trap-combat.mjs:372-380`, `scripts/dungeon-combat.mjs:2382-2390`, `scripts/dungeon-follow.mjs:217-225`. `dungeon-follow.mjs`'s own copy already carries a "mirrors dungeon-combat.mjs" comment (lines 212-214); the other two don't. All three files already import from `scripts/pathfinding.mjs` (confirmed current, a true leaf module with zero imports of its own) — the shared-helper option the issue itself offers as preferable "if the import cycle allows" is cleanly available, not just the comment fallback.
5. **`applyDamage` missing `item`/`rollOptions` (real fix):** confirmed current, `scripts/trap-combat.mjs:269-272` — the SAVE roll two lines above (239-251) already builds and passes `item: actionItem` and `extraRollOptions` including `item:trait:${t}` entries for exactly this purpose; the damage-application call simply never reuses them.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). Small, independent fixes with no new user-facing feature: patch bump.
- Findings #1 and #2(partially)'s own "latent, not reachable today" framing is preserved honestly — the plan does not claim to close a live bug for either, only to document (#1) or future-proof (#2's parsing scope).
- The finding #4 shared helper lives in `scripts/pathfinding.mjs` (confirmed current: a true leaf module, zero imports, already depended on by all three call sites) — never re-introduce three separate copies.
- Finding #5's `rollOptions` passed to `applyDamage` mirror the save roll's own `item:trait:*`/`options` entries exactly, **excluding** `"damaging-effect"` (a save-DC-modifying trait, not a damage-type-matching one — irrelevant to IWR predicate matching).

## Review Focus

- **The anchored `@Check`/`@Damage` parsing (finding #2) must still correctly parse every one of the three real automatable hazards this session's own earlier #839 work measured** (Electric Latch Rune, Insistent Privacy Fence, Steam Vents) — a regression check, not just a new-case test, since all three already have their own description text used as fixtures elsewhere in this test suite.
- **The HTML-entity fix (finding #3) must handle both named entities the issue names** (`&amp;`, `&nbsp;`) and leave ordinary text untouched — not a general HTML-entity-decoding library, just the bounded, realistic set PF2e compendium prose actually uses.
- **The shared `wallBlocksMovement` helper (finding #4) must produce byte-identical behavior to all three existing copies** — a passing existing test suite across `dungeon-combat.mjs`/`dungeon-follow.mjs`/`trap-combat.mjs` is the real confirmation, not just a new unit test on the extracted function alone.
- **Finding #5's fix must not change the outcome for a hazard with no traits/options at all** — an empty `rollOptions` array (or omitted key) must behave identically to today's call for that common case.
- **Finding #1's new comment must describe the actual, confirmed-matching convention** (`dungeon-combat.mjs`'s own `tokenCell`-based `hasLineOfSight`), not a generic disclaimer — so a future reader can go verify the claim themselves.

---

### Task 1: Anchor `@Check`/`@Damage` parsing to the Effect text (finding #2)

**Files:**
- Modify: `scripts/trap-mechanics.mjs`
- Test: `tests/trap-mechanics-basic-save.test.mjs`

- [x] **Step 1: Write the failing test**

```js
it("#884: @Check/@Damage before the Effect heading (a rider written earlier) is not mistaken for the real save", () => {
  const html =
    '<p><strong>Trigger</strong> Stage 4 (@Check[fortitude|dc:30|basic]) deals @Damage[4d6[poison]] damage.</p>' +
    '<p><strong>Effect</strong> The trap deals @Damage[2d8[piercing]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).</p>';
  expect(parseBasicSaveAction(html)).toEqual(
    expect.objectContaining({ save: "reflex", dc: 22, damage: [{ formula: "2d8", type: "piercing" }] }),
  );
});

it("#884: still parses every real automatable hazard's own description unchanged", () => {
  // Reuse this file's own existing ELECTRIC_LATCH_RUNE/INSISTENT_PRIVACY_FENCE/STEAM_VENTS fixtures
  // (confirmed current in this test file) -- a regression check, not a new case.
  expect(parseBasicSaveAction(ELECTRIC_LATCH_RUNE)).not.toBeNull();
  expect(parseBasicSaveAction(INSISTENT_PRIVACY_FENCE)).not.toBeNull();
  expect(parseBasicSaveAction(STEAM_VENTS)).not.toBeNull();
});
```

- [x] **Step 2: Run the tests to verify the first one fails**

Run: `npx vitest run tests/trap-mechanics-basic-save.test.mjs`
Expected: FAIL on the new rider test (today's code matches the Trigger line's own `@Check`/`@Damage`, not the Effect's); the regression test should already pass.

- [x] **Step 3: Anchor both regexes to the Effect text**

Change (confirmed current, `scripts/trap-mechanics.mjs:238-267`):

```js
export function parseBasicSaveAction(descriptionHtml) {
  if (typeof descriptionHtml !== "string") return null;
  const checkMatch = /@Check\[([a-z]+)((?:\|[^\]]*)?)\]/i.exec(descriptionHtml);
  ...
  const damageMatch = /@Damage\[((?:[^[\]]|\[[^\]]*\])+)\]/i.exec(descriptionHtml);
```

to:

```js
export function parseBasicSaveAction(descriptionHtml) {
  if (typeof descriptionHtml !== "string") return null;
  // #884: anchored to the Effect paragraph, same as parseAreaFeet already
  // is just below -- a Trigger-line (or any earlier) rider with its own
  // @Check/@Damage (an affliction's own later-stage text, say) must never
  // be mistaken for the hazard's real, primary save.
  const effect = effectText(descriptionHtml);
  const checkMatch = /@Check\[([a-z]+)((?:\|[^\]]*)?)\]/i.exec(effect);
  ...
  const damageMatch = /@Damage\[((?:[^[\]]|\[[^\]]*\])+)\]/i.exec(effect);
```

Every other use of `descriptionHtml` further down this same function (the `afterCheck`/residue-sentence extraction, confirmed current lines 269-298) must also switch to `effect` for consistency, since `checkMatch.index` now refers to an offset within `effect`, not `descriptionHtml` — read the function's own remaining body carefully and update every `descriptionHtml`-relative offset accordingly.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/trap-mechanics-basic-save.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add scripts/trap-mechanics.mjs tests/trap-mechanics-basic-save.test.mjs
git commit -m "fix(#884): anchor basic-save @Check/@Damage parsing to the Effect paragraph

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Decode common HTML entities before escaping (finding #3)

**Files:**
- Modify: `scripts/trap-mechanics.mjs`
- Test: `tests/trap-mechanics-basic-save.test.mjs` (or wherever `plainDescriptionText` already has its own direct tests — `grep -rln "plainDescriptionText" tests/`)

- [x] **Step 1: Write the failing test**

```js
it("#884: decodes common HTML entities instead of leaving them to be double-escaped later", () => {
  expect(plainDescriptionText("<p>Smith &amp; Sons&nbsp;trap</p>")).toBe("Smith & Sons trap");
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/trap-mechanics-basic-save.test.mjs`
Expected: FAIL — today's output is `"Smith &amp; Sons&nbsp;trap"` (entities untouched).

- [x] **Step 3: Decode entities in `plainDescriptionText`**

Change (confirmed current, `scripts/trap-mechanics.mjs:185-207`):

```js
export function plainDescriptionText(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(
      /@(\w+)\[((?:[^[\]]|\[[^\]]*\])*)\](?:\{([^}]*)\})?/g,
      (_m, kind, inner, label) => {
        ...
      },
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
```

to:

```js
// #884: the bounded, realistic set of HTML entities PF2e compendium prose
// actually uses -- not a general entity-decoding library. Decoded AFTER
// tag-stripping (an entity never looks like a tag) and BEFORE this text
// reaches trap-combat.mjs's own escapeText for a GM whisper, so that
// escaping step runs on real characters exactly once, not on literal
// entity text that then gets re-escaped into something like "&#38;amp;".
const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

export function plainDescriptionText(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(
      /@(\w+)\[((?:[^[\]]|\[[^\]]*\])*)\](?:\{([^}]*)\})?/g,
      (_m, kind, inner, label) => {
        ...
      },
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m])
    .replace(/\s+/g, " ")
    .trim();
}
```

(Leave the enricher-replacement callback's own body, confirmed current lines 190-202, completely unchanged — only the new entity-decode line and the `HTML_ENTITIES` map are added.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/trap-mechanics-basic-save.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add scripts/trap-mechanics.mjs tests/trap-mechanics-basic-save.test.mjs
git commit -m "fix(#884): decode common HTML entities in plainDescriptionText before they can be double-escaped

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Extract the shared `wallBlocksMovement` helper (finding #4)

**Files:**
- Modify: `scripts/pathfinding.mjs` (new export)
- Modify: `scripts/trap-combat.mjs`, `scripts/dungeon-combat.mjs`, `scripts/dungeon-follow.mjs` (use the shared export, delete each own local copy)
- Test: whichever existing test file(s) already cover these three call sites indirectly (`grep -rln "wallBlocksMovement\|wallBlocksLine" tests/`) — this is a pure refactor, so the existing test suite passing unchanged is the real confirmation; add one direct test on the new export itself.

- [ ] **Step 1: Write a direct test for the new shared export**

```js
import { wallBlocksMovement } from "../scripts/pathfinding.mjs";

describe("#884 wallBlocksMovement (shared by dungeon-combat.mjs, dungeon-follow.mjs, trap-combat.mjs)", () => {
  it("blocks a normal wall", () => {
    expect(wallBlocksMovement({ move: 20, door: 0, ds: 0 })).toBe(true);
  });
  it("does not block a wall with no movement sense", () => {
    expect(wallBlocksMovement({ move: 0, door: 0, ds: 0 })).toBe(false);
  });
  it("does not block an open door", () => {
    expect(wallBlocksMovement({ move: 20, door: 1, ds: 1 })).toBe(false);
  });
  it("blocks a closed or locked door", () => {
    expect(wallBlocksMovement({ move: 20, door: 1, ds: 0 })).toBe(true);
    expect(wallBlocksMovement({ move: 20, door: 1, ds: 2 })).toBe(true);
  });
});
```

(Use this codebase's own real `CONST.WALL_MOVEMENT_TYPES`/`CONST.WALL_DOOR_TYPES`/`CONST.WALL_DOOR_STATES` values if this test file already stubs `CONST` — confirm via an existing sibling test before hard-coding `20`/`0`/`1`/`2` as shown above.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run <the new test file>`
Expected: FAIL — `pathfinding.mjs` exports no such function yet.

- [ ] **Step 3: Add the shared export**

Add to `scripts/pathfinding.mjs`:

```js
/**
 * #884: the one real implementation of "does this wall block movement/line
 * of effect" -- previously three byte-identical private copies
 * (dungeon-combat.mjs's own wallBlocksMovement, dungeon-follow.mjs's own
 * mirror, trap-combat.mjs's own wallBlocksLine). A wall blocks unless its
 * own movement sense is NONE, or it is a door currently standing open.
 */
export function wallBlocksMovement(wall) {
  if (wall.move === CONST.WALL_MOVEMENT_TYPES.NONE) return false;
  if (
    wall.door !== CONST.WALL_DOOR_TYPES.NONE &&
    wall.ds === CONST.WALL_DOOR_STATES.OPEN
  )
    return false;
  return true;
}
```

- [ ] **Step 4: Switch all three call sites to the shared export**

In `scripts/dungeon-combat.mjs`, remove the local `wallBlocksMovement` (confirmed current, lines 2382-2390) and add `wallBlocksMovement` to this file's own existing import from `./pathfinding.mjs` (confirmed current, lines ~34-42).

In `scripts/dungeon-follow.mjs`, remove the local `wallBlocksMovement` and its own "mirrors" comment (confirmed current, lines 212-225) and add it to this file's own existing import from `./pathfinding.mjs` (confirmed current, line 16).

In `scripts/trap-combat.mjs`, remove the local `wallBlocksLine` (confirmed current, lines 372-380) and add `wallBlocksMovement` to this file's own existing import from `./pathfinding.mjs` (confirmed current, line 27) — update its one call site (confirmed current, line 422: `.filter(wallBlocksLine)`) to `.filter(wallBlocksMovement)`.

- [ ] **Step 5: Run the new test and the full suite**

Run: `npx vitest run`
Expected: PASS across the board — this is a pure extraction, no behavior changes anywhere.

- [ ] **Step 6: Commit**

```bash
git add scripts/pathfinding.mjs scripts/trap-combat.mjs scripts/dungeon-combat.mjs scripts/dungeon-follow.mjs tests/
git commit -m "refactor(#884): one shared wallBlocksMovement in pathfinding.mjs, not three identical copies

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Pass `item`/`rollOptions` to the basic-save trap's own `applyDamage` (finding #5)

**Files:**
- Modify: `scripts/trap-combat.mjs`
- Test: `tests/trap-combat-basic-save-trigger.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it("#884: applyDamage receives item and rollOptions, matching the save roll's own trait/option list", async () => {
  // Reuse this file's own existing area/single-target fixture (hazard
  // with parsed.traits = ["electricity"], say), drive a failing save so
  // applyDamage is actually called, and assert on the mock's own call.
  // ... existing fixture setup ...
  expect(actor.applyDamage).toHaveBeenCalledWith(
    expect.objectContaining({
      item: actionItem,
      rollOptions: expect.arrayContaining(["item:trait:electricity"]),
    }),
  );
});

it("#884: an empty traits/options list still calls applyDamage normally (no rollOptions key breaks anything)", async () => {
  // A hazard whose @Check has no traits:/options: segments at all.
  // ... existing fixture setup with parsed.traits = [], parsed.options = [] ...
  expect(actor.applyDamage).toHaveBeenCalledWith(
    expect.objectContaining({ damage: expect.anything(), token: expect.anything() }),
  );
});
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run: `npx vitest run tests/trap-combat-basic-save-trigger.test.mjs`
Expected: FAIL — today's `applyDamage` call has no `item`/`rollOptions` key at all.

- [ ] **Step 3: Pass `item`/`rollOptions` to `applyDamage`**

Change (confirmed current, `scripts/trap-combat.mjs:269-272`):

```js
          await actor.applyDamage({
            damage: multiplier === 1 ? damageRoll : damageRoll.alter(multiplier, 0),
            token,
          });
```

to:

```js
          // #884: the same item/trait rollOptions the save roll above
          // already builds (minus "damaging-effect", a save-DC trait, not
          // a damage-matching one) -- without these, a resistance or
          // weakness whose own predicate depends on the hazard's traits
          // (e.g. a ward with resistance keyed to item:trait:electricity)
          // never matches.
          await actor.applyDamage({
            damage: multiplier === 1 ? damageRoll : damageRoll.alter(multiplier, 0),
            token,
            item: actionItem,
            rollOptions: [
              ...parsed.traits.map((t) => `item:trait:${t}`),
              ...parsed.options,
            ],
          });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/trap-combat-basic-save-trigger.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/trap-combat.mjs tests/trap-combat-basic-save-trigger.test.mjs
git commit -m "fix(#884): pass item/rollOptions to a basic-save trap's own applyDamage, matching its save roll

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Document the center-to-center line-of-effect convention (finding #1)

**Files:**
- Modify: `scripts/trap-combat.mjs`

- [ ] **Step 1: Add the clarifying comment**

Change `resolveAreaTargets`'s own docblock (confirmed current, `scripts/trap-combat.mjs:398-411`) to add, after its existing "pathfinding.mjs's wall-aware `hasLineOfSight`" sentence:

```js
 * Line of effect is checked center cell to center cell (centerCell below),
 * matching dungeon-combat.mjs's own hasLineOfSight (tokenCell-based)
 * convention exactly -- a known, accepted limitation shared by both: a
 * 2x2+ creature whose own center square sits behind a wall corner is
 * excluded even when part of its real footprint is actually exposed.
 * Neither module does per-corner/multi-point line of effect today; fixing
 * this for traps without also fixing it for the identical combat case
 * would be a narrower, inconsistent improvement, not a real fix (#884).
```

- [ ] **Step 2: Run the full test suite to confirm nothing changed**

Run: `npx vitest run`
Expected: PASS — comment-only change.

- [ ] **Step 3: Commit**

```bash
git add scripts/trap-combat.mjs
git commit -m "docs(#884): note the center-to-center line-of-effect convention shared with dungeon-combat.mjs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (five small, independent fixes/documentation, no new feature), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#884): bump version for basic-save trap automation follow-ups

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** All five of #884's own findings are addressed: three with a real, confirmed-grounded fix (#2, #3, #5), one with a real refactor eliminating the duplication entirely rather than just commenting it (#4, since the import-cycle check this session ran confirms the better option is available), and one honestly documented as a shared, already-accepted limitation rather than a new fix (#1).

**2. Placeholder scan:** No TBD. Every finding's own current code, line numbers, and the exact cross-file import relationships (for Task 3's cycle check) were confirmed by direct reading this session.

**3. Type consistency:** `wallBlocksMovement`'s own signature (`(wall) => boolean`) is identical across all three original call sites and the new shared export — a pure relocation, not a reinterpretation. `applyDamage`'s new `rollOptions` shape mirrors the save roll's own `extraRollOptions` list exactly, confirmed against the real, current code.

**4. Review Focus:** All five items (the three automatable hazards still parse after the Effect-anchor change, entity decoding handles the named entities without over-reaching, the shared helper behaves identically to all three originals, an empty traits/options list doesn't break applyDamage, the new comment names the real matching convention) each map to a specific task's own test or step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-basic-save-trap-followups.md`.
