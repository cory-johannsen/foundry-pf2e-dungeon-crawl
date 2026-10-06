# Room-Feature Check Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #822 — clicking a puzzle (or skill-challenge) room-feature token actually offers its skill-check attempt, not just a silent state reveal.

**Root cause (confirmed live-reading the real code, not assumed):** A room-feature token click (`scripts/module.mjs`'s `syncRoomFeatureControls` overlay, or the `targetToken` hook — both call `triggerRoomFeatureToken`) only ever calls `runRoomFeatureAction`, which for `kind: "puzzle"`/`"skill_challenge"` calls `revealRoomFeature` — a pure state flag, nothing else. The *actual* attempt form (`templates/dungeon-tracker.hbs`'s `attemptPuzzleStage`/`attemptSkillChallenge` blocks, gated on `puzzle.revealed`/`challenge.revealed`) has only ever existed inside the tracker application window — #611/#623 never migrated it to a token-click surface, the exact gap #754's own click-to-disable dialog already solved for traps. The server-side roll/record logic (`rollPuzzleStageAttempt`/`recordPuzzleStageOutcome`, `rollSkillChallengeAttempt`/`recordSkillChallengeOutcome`, both confirmed current and already relayed end-to-end via `dungeon-remote.mjs`) already works completely — only a client-side trigger is missing. #822's own title is puzzle-only; investigation found skill-challenge tokens have the identical bug via the identical gap, and the user approved fixing both together.

**Architecture:** Two new small dialog modules (`scripts/ui/puzzle-stage-dialog.mjs`, `scripts/ui/skill-challenge-dialog.mjs`), each a near-exact structural mirror of #754's own `scripts/ui/trap-disable-dialog.mjs` (a pure choice-builder plus a `DialogV2.wait` prompt). The tracker form handlers' own existing roll-and-record logic (`DungeonApp.#onAttemptPuzzleStage`/`#onAttemptSkillChallenge`) is extracted into two small exported functions so the token-click path and the tracker form both call the same code, never duplicating it — mirroring how #754 extracted `attemptTrapDisableForScene` once and had both surfaces call it. `module.mjs`'s existing `triggerRoomFeatureToken` gains the one new step #611/#623 never added: after a successful reveal, immediately prompt the matching dialog for puzzle/skill-challenge kinds (treasure needs nothing further — its own claim already completes in one step).

**Tech Stack:** Vanilla ES modules, Vitest, Foundry `DialogV2`.

**Spec:** None — a bounded fix reusing an already-proven pattern (#754) and already-working server-side logic; the one real scope question (puzzle-only vs. puzzle+skill-challenge) was presented to and decided by the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real bug fix restoring a broken core interaction: minor bump (not patch — this is the actual functional restoration of #611/#623's own token-click feature, not a small polish fix). Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- No change to the server-side roll/record/relay logic for either puzzle stages or skill-challenge attempts, and no change to `templates/dungeon-tracker.hbs`'s own forms — both already work; this plan only adds a second way to trigger the same already-correct logic.
- A click still reveals first (unchanged #611/#623 behavior) — the dialog is offered immediately after, in the same click, not instead of the existing reveal step.
- The new dialogs trust the whole party exactly as the existing tracker forms already do (any party member may be picked from a plain dropdown, no extra ownership check) — matching, not tightening or loosening, today's actual trust level.
- Treasure tokens are unaffected — their own click-to-claim flow already completes in one step and needs no dialog.

## Review Focus

- **Clicking a puzzle token must actually let the player pick a character and attempt one of the puzzle's own not-yet-attempted stages** — the core bug.
- **Clicking a skill-challenge token must actually let the player pick a character and one of the challenge's own specialty skills** — the same bug, confirmed to exist in the identical shape.
- **The tracker's own existing forms must keep working completely unchanged** — the extraction in Task 1 must not alter `#onAttemptPuzzleStage`/`#onAttemptSkillChallenge`'s own observable behavior, only where the logic lives.
- **A puzzle/challenge with nothing left to attempt (already resolved, or no party characters available) must show a clear notice, never a crash or a silently empty dialog** — mirroring #754's own `DisableNoCharacters`/`CannotDisable` precedent exactly.
- **A treasure token's own click behavior must be completely unaffected** — only puzzle/skill-challenge kinds gain the new post-reveal prompt.

---

### Task 1: Extract the shared attempt logic

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs` (`#onAttemptPuzzleStage`, `#onAttemptSkillChallenge`, `skillLabel`)
- Test: wherever these handlers are already tested, if anywhere — `grep -rln "onAttemptPuzzleStage\|onAttemptSkillChallenge" tests/` first and read what's found before writing new tests, to match existing conventions exactly.

**Interfaces:**
- Produces: `export async function attemptPuzzleStageFor(sceneId, roomId, stageIndex, actorId): Promise<result|null>` and `export async function attemptSkillChallengeFor(sceneId, roomId, skill, actorId): Promise<result|null>` — each does exactly what the tracker handler's own existing roll-then-record-or-relay logic already does, extracted verbatim. `export function skillLabel(slug): string` (confirmed current, a private function, lines 123-127 — only its own `export` keyword changes). Consumed by Task 4.

- [x] **Step 1: Export `skillLabel`**

In `scripts/ui/dungeon-app.mjs`, change (confirmed current, line 123):

```js
function skillLabel(slug) {
```

to:

```js
export function skillLabel(slug) {
```

- [x] **Step 2: Extract `attemptPuzzleStageFor`**

Change `#onAttemptPuzzleStage` (confirmed current, lines 1441-1477) from:

```js
  static async #onAttemptPuzzleStage(event, target) {
    const sceneId = canvas?.scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentRoomId];
    if (!currentRoom?.puzzle) return;

    const stageIndex = Number(target?.dataset?.stageIndex);
    const stage = currentRoom.puzzle.stages[stageIndex];
    if (!stage || stage.attempted) return;

    const form = this.element.querySelector(
      `.pf2edc-dungeon__puzzle-stage-form[data-stage-index="${stageIndex}"]`,
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (!actor) return;

    const result = await rollPuzzleStageAttempt(actor, stage.skill, stage.dc);
    if (!result) return;

    if (game.user.isGM) {
      await recordPuzzleStageOutcome(
        sceneId,
        currentRoom.id,
        stageIndex,
        result.outcome,
      );
    } else {
      await requestDungeonAction("recordPuzzleStageOutcome", {
        sceneId,
        roomId: currentRoom.id,
        stageIndex,
        outcome: result.outcome,
      });
    }
    this.render();
  }
```

to:

```js
  static async #onAttemptPuzzleStage(event, target) {
    const sceneId = canvas?.scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentRoomId];
    if (!currentRoom?.puzzle) return;

    const stageIndex = Number(target?.dataset?.stageIndex);
    const form = this.element.querySelector(
      `.pf2edc-dungeon__puzzle-stage-form[data-stage-index="${stageIndex}"]`,
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    if (!actorId) return;

    const result = await attemptPuzzleStageFor(
      sceneId,
      currentRoom.id,
      stageIndex,
      actorId,
    );
    if (!result) return;
    this.render();
  }
```

Add, exported, directly above the class (or alongside `recordPuzzleStageOutcome`, whichever reads more naturally against this file's own layout):

```js
/**
 * #822: the roll-then-record-or-relay logic every puzzle-stage attempt
 * needs, extracted so both the tracker's own form (#onAttemptPuzzleStage)
 * and a room-feature token's click dialog (module.mjs, #822) share one
 * implementation rather than two copies drifting apart. Returns the roll
 * result, or null for every guard failure (no such room/puzzle/stage,
 * already attempted, unknown actor) -- the caller decides what "nothing
 * happened" means for its own UI.
 */
export async function attemptPuzzleStageFor(sceneId, roomId, stageIndex, actorId) {
  const state = sceneId ? getRunState(sceneId) : null;
  const room = state?.rooms[roomId];
  if (!room?.puzzle) return null;
  const stage = room.puzzle.stages[stageIndex];
  if (!stage || stage.attempted) return null;
  const actor = actorId ? game.actors.get(actorId) : null;
  if (!actor) return null;

  const result = await rollPuzzleStageAttempt(actor, stage.skill, stage.dc);
  if (!result) return null;

  if (game.user.isGM) {
    await recordPuzzleStageOutcome(sceneId, roomId, stageIndex, result.outcome);
  } else {
    await requestDungeonAction("recordPuzzleStageOutcome", {
      sceneId,
      roomId,
      stageIndex,
      outcome: result.outcome,
    });
  }
  return result;
}
```

- [x] **Step 3: Extract `attemptSkillChallengeFor`**

Change `#onAttemptSkillChallenge` (confirmed current, lines 1389-1427ish) from reading the form directly and inlining the roll/record logic to delegating, the same pattern as Step 2 — read its exact current body first (confirmed current through line ~1427) and apply the identical extraction shape:

```js
  static async #onAttemptSkillChallenge() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const form = this.element.querySelector(
      ".pf2edc-dungeon__skill-challenge-form",
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const skill = form?.querySelector('[name="skill"]')?.value;
    if (!actorId || !skill) return;

    const result = await attemptSkillChallengeFor(sceneId, actorId, skill);
    if (!result) return;
    this.render();
  }
```

Add, exported:

```js
/**
 * #822: the roll-then-record-or-relay logic every skill-challenge attempt
 * needs, extracted for the same reason attemptPuzzleStageFor is (shared
 * by the tracker form and a token's click dialog). `actorId`/`skill` are
 * read by the caller; this looks up the current room itself (mirrors
 * #onAttemptSkillChallenge's own prior inline logic exactly, including
 * the #553 specialty-skill restriction and the dcForAttempt call).
 */
export async function attemptSkillChallengeFor(sceneId, actorId, skill) {
  const state = sceneId ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentRoomId];
  if (!currentRoom?.challenge) return null;
  const actor = actorId ? game.actors.get(actorId) : null;
  if (!actor) return null;
  if (!currentRoom.challenge.specialtySkills.includes(skill)) return null;

  const dc = dcForAttempt({
    partyLevel: await makeFoundryApi().partyLevel(),
    difficulty: state.difficulty,
  });
  const result = await rollSkillChallengeAttempt(actor, skill, dc);
  if (!result) return null;

  if (game.user.isGM) {
    await recordSkillChallengeOutcome(sceneId, currentRoom.id, result.outcome);
  } else {
    await requestDungeonAction("recordSkillChallengeOutcome", {
      sceneId,
      roomId: currentRoom.id,
      outcome: result.outcome,
    });
  }
  return result;
}
```

(Confirm this matches the real current `#onAttemptSkillChallenge` body exactly before extracting — read it fresh first; the shape above is reconstructed from this session's own earlier reading and may need small adjustment to match verbatim, e.g. exact variable names.)

- [x] **Step 4: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — this step is a pure extraction with no behavior change; whatever existing coverage exercises the tracker's own puzzle/skill-challenge forms should pass unchanged.

- [x] **Step 5: Commit**

```bash
git add scripts/ui/dungeon-app.mjs
git commit -m "refactor(#822): extract shared puzzle-stage and skill-challenge attempt logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The puzzle-stage dialog

**Files:**
- Create: `scripts/ui/puzzle-stage-dialog.mjs`
- Test: `tests/puzzle-stage-dialog.test.mjs`

**Interfaces:**
- Produces: `buildPuzzleStageChoices(stages, characters)` (pure) and `promptPuzzleStage(stages, characters)` (DialogV2), mirroring `trap-disable-dialog.mjs`'s own two-function shape exactly. `promptPuzzleStage` resolves `{actorId, stageIndex}` or `null`.

- [x] **Step 1: Write the failing tests**

Create `tests/puzzle-stage-dialog.test.mjs`, mirroring `tests/trap-disable-dialog.test.mjs`'s own exact structure:

```js
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildPuzzleStageChoices } from "../scripts/ui/puzzle-stage-dialog.mjs";

const chars = [
  { id: "a1", name: "Amiri" },
  { id: "b2", name: "Seoni" },
];
const stages = [
  { index: 0, skill: "thievery", dc: 18, label: "Thievery", attempted: false },
  { index: 1, skill: "arcana", dc: 20, label: "Arcana", attempted: true },
  { index: 2, skill: "stealth", dc: 16, label: "Stealth", attempted: false },
];

describe("buildPuzzleStageChoices (#822)", () => {
  it("offers only not-yet-attempted stages, with label and DC", () => {
    const r = buildPuzzleStageChoices(stages, chars);
    expect(r.stages).toEqual([
      { index: 0, skill: "thievery", dc: 18, label: "Thievery" },
      { index: 2, skill: "stealth", dc: 16, label: "Stealth" },
    ]);
    expect(r.characters).toEqual(chars);
  });

  it("falls back to the skill slug when a stage has no label", () => {
    const r = buildPuzzleStageChoices(
      [{ index: 0, skill: "medicine", dc: 15, attempted: false }],
      chars,
    );
    expect(r.stages[0].label).toBe("medicine");
  });

  it("null when every stage is already attempted, or no stages, or no characters", () => {
    expect(buildPuzzleStageChoices([{ ...stages[1] }], chars)).toBeNull();
    expect(buildPuzzleStageChoices([], chars)).toBeNull();
    expect(buildPuzzleStageChoices(stages, [])).toBeNull();
  });
});

describe("puzzle-stage-dialog source", () => {
  const src = readFileSync(new URL("../scripts/ui/puzzle-stage-dialog.mjs", import.meta.url), "utf8");
  it("uses DialogV2 and the localized keys", () => {
    expect(src).toContain("DialogV2");
    for (const k of ["Title", "CharacterLabel", "StageOption", "Confirm", "Cancel"])
      expect(src).toContain(`PF2EDC.Dungeon.Puzzle.Dialog${k}`);
  });
});

describe("puzzle dialog lang keys", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  it("defines the new keys", () => {
    for (const k of ["DialogTitle", "DialogCharacterLabel", "DialogStageOption", "DialogConfirm", "DialogCancel", "DialogNoCharacters", "DialogNothingToAttempt"])
      expect(lang[`PF2EDC.Dungeon.Puzzle.${k}`]).toBeTruthy();
    expect(lang["PF2EDC.Dungeon.Puzzle.DialogStageOption"]).toContain("{dc}");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/puzzle-stage-dialog.test.mjs`
Expected: FAIL — module doesn't exist yet.

- [x] **Step 3: Write `scripts/ui/puzzle-stage-dialog.mjs`**

```js
/** #822: the prompt shown when a player clicks a puzzle room-feature
 * token — which of their party characters attempts which of the
 * puzzle's own not-yet-attempted stages (each stage's own skill is fixed,
 * #137, never the player's choice — only which stage and who). Mirrors
 * #754's trap-disable-dialog.mjs exactly. */

/** Pure: shape the dialog's options from the room's own persisted stage
 * list. Returns null when there is nothing left to attempt or no
 * characters to attempt it, so the caller shows a notice. */
export function buildPuzzleStageChoices(stages, characters) {
  if (!Array.isArray(characters) || characters.length === 0) return null;
  const remaining = (stages ?? [])
    .filter((s) => !s.attempted)
    .map(({ index, skill, dc, label }) => ({ index, skill, dc, label: label ?? skill }));
  if (remaining.length === 0) return null;
  return { stages: remaining, characters };
}

/** Resolves `{actorId, stageIndex}` or null (cancelled / nothing to choose). */
export async function promptPuzzleStage(stages, characters) {
  const choices = buildPuzzleStageChoices(stages, characters);
  if (!choices) return null;
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const who = choices.characters
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  const stageOptions = choices.stages
    .map(
      (s) =>
        `<option value="${s.index}">${esc(
          game.i18n.format("PF2EDC.Dungeon.Puzzle.DialogStageOption", {
            skill: s.label,
            dc: s.dc,
          }),
        )}</option>`,
    )
    .join("");
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogTitle") },
    content: `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogCharacterLabel")}</label>
          <select name="actorId" style="width:100%;">${who}</select>
        </div>
        <div class="form-group">
          <select name="stageIndex" style="width:100%;">${stageOptions}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: "attempt",
        label: game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogConfirm"),
        default: true,
        callback: (_e, _b, dialog) => ({
          actorId: dialog.element.querySelector('[name="actorId"]').value,
          stageIndex: Number(dialog.element.querySelector('[name="stageIndex"]').value),
        }),
      },
      {
        action: "cancel",
        label: game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogCancel"),
      },
    ],
    rejectClose: false,
  });
}
```

- [x] **Step 4: Add the new localization keys**

In `lang/en.json`, add near the existing `PF2EDC.Dungeon.Puzzle.*` keys:

```json
  "PF2EDC.Dungeon.Puzzle.DialogTitle": "Attempt Puzzle Stage",
  "PF2EDC.Dungeon.Puzzle.DialogCharacterLabel": "Who attempts?",
  "PF2EDC.Dungeon.Puzzle.DialogStageOption": "{skill} (DC {dc})",
  "PF2EDC.Dungeon.Puzzle.DialogConfirm": "Attempt",
  "PF2EDC.Dungeon.Puzzle.DialogCancel": "Cancel",
  "PF2EDC.Dungeon.Puzzle.DialogNoCharacters": "You have no party character to attempt this.",
  "PF2EDC.Dungeon.Puzzle.DialogNothingToAttempt": "Nothing left to attempt on this puzzle.",
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/puzzle-stage-dialog.test.mjs`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add scripts/ui/puzzle-stage-dialog.mjs tests/puzzle-stage-dialog.test.mjs lang/en.json
git commit -m "feat(#822): add the puzzle-stage click-to-attempt dialog

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: The skill-challenge dialog

**Files:**
- Create: `scripts/ui/skill-challenge-dialog.mjs`
- Test: `tests/skill-challenge-dialog.test.mjs`

**Interfaces:**
- Produces: `buildSkillChallengeChoices(specialtySkills, characters)` (pure) and `promptSkillChallenge(specialtySkills, characters)` (DialogV2), resolving `{actorId, skill}` or `null`.
- Consumes: `skillLabel` (Task 1).

- [x] **Step 1: Write the failing tests**

Create `tests/skill-challenge-dialog.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

vi.mock("../scripts/ui/dungeon-app.mjs", () => ({
  skillLabel: (slug) => ({ thievery: "Thievery", diplomacy: "Diplomacy", stealth: "Stealth" })[slug] ?? slug,
}));

import { buildSkillChallengeChoices } from "../scripts/ui/skill-challenge-dialog.mjs";

const chars = [
  { id: "a1", name: "Amiri" },
  { id: "b2", name: "Seoni" },
];

describe("buildSkillChallengeChoices (#822)", () => {
  it("one option per specialty skill, labeled; characters as given", () => {
    const r = buildSkillChallengeChoices(["thievery", "diplomacy", "stealth"], chars);
    expect(r.skills).toEqual([
      { slug: "thievery", label: "Thievery" },
      { slug: "diplomacy", label: "Diplomacy" },
      { slug: "stealth", label: "Stealth" },
    ]);
    expect(r.characters).toEqual(chars);
  });

  it("null for missing/empty skills or no characters", () => {
    expect(buildSkillChallengeChoices([], chars)).toBeNull();
    expect(buildSkillChallengeChoices(undefined, chars)).toBeNull();
    expect(buildSkillChallengeChoices(["thievery"], [])).toBeNull();
  });
});

describe("skill-challenge-dialog source", () => {
  const src = readFileSync(new URL("../scripts/ui/skill-challenge-dialog.mjs", import.meta.url), "utf8");
  it("uses DialogV2 and the localized keys", () => {
    expect(src).toContain("DialogV2");
    for (const k of ["Title", "CharacterLabel", "SkillLabel", "Confirm", "Cancel"])
      expect(src).toContain(`PF2EDC.Dungeon.SkillChallenge.Dialog${k}`);
  });
});

describe("skill-challenge dialog lang keys", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  it("defines the new keys", () => {
    for (const k of ["DialogTitle", "DialogCharacterLabel", "DialogSkillLabel", "DialogConfirm", "DialogCancel", "DialogNoCharacters"])
      expect(lang[`PF2EDC.Dungeon.SkillChallenge.${k}`]).toBeTruthy();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skill-challenge-dialog.test.mjs`
Expected: FAIL.

- [x] **Step 3: Write `scripts/ui/skill-challenge-dialog.mjs`**

```js
/** #822: the prompt shown when a player clicks a skill-challenge
 * room-feature token — which of their party characters attempts, and
 * with which of the challenge's own specialty skills (#553: the
 * player's choice, unlike a puzzle stage's fixed skill). Mirrors #754's
 * trap-disable-dialog.mjs and #822's own puzzle-stage-dialog.mjs. */
import { skillLabel } from "./dungeon-app.mjs";

/** Pure: shape the dialog's options. Returns null when there is nothing
 * to choose from, so the caller shows a notice. */
export function buildSkillChallengeChoices(specialtySkills, characters) {
  if (!Array.isArray(specialtySkills) || specialtySkills.length === 0) return null;
  if (!Array.isArray(characters) || characters.length === 0) return null;
  return {
    skills: specialtySkills.map((slug) => ({ slug, label: skillLabel(slug) })),
    characters,
  };
}

/** Resolves `{actorId, skill}` or null (cancelled / nothing to choose). */
export async function promptSkillChallenge(specialtySkills, characters) {
  const choices = buildSkillChallengeChoices(specialtySkills, characters);
  if (!choices) return null;
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const who = choices.characters
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  const skills = choices.skills
    .map((s) => `<option value="${esc(s.slug)}">${esc(s.label)}</option>`)
    .join("");
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogTitle") },
    content: `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogCharacterLabel")}</label>
          <select name="actorId" style="width:100%;">${who}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogSkillLabel")}</label>
          <select name="skill" style="width:100%;">${skills}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: "attempt",
        label: game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogConfirm"),
        default: true,
        callback: (_e, _b, dialog) => ({
          actorId: dialog.element.querySelector('[name="actorId"]').value,
          skill: dialog.element.querySelector('[name="skill"]').value,
        }),
      },
      {
        action: "cancel",
        label: game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogCancel"),
      },
    ],
    rejectClose: false,
  });
}
```

- [x] **Step 4: Add the new localization keys**

In `lang/en.json`, add near the existing `PF2EDC.Dungeon.SkillChallenge.*` keys:

```json
  "PF2EDC.Dungeon.SkillChallenge.DialogTitle": "Attempt Skill Challenge",
  "PF2EDC.Dungeon.SkillChallenge.DialogCharacterLabel": "Who attempts?",
  "PF2EDC.Dungeon.SkillChallenge.DialogSkillLabel": "Skill",
  "PF2EDC.Dungeon.SkillChallenge.DialogConfirm": "Attempt",
  "PF2EDC.Dungeon.SkillChallenge.DialogCancel": "Cancel",
  "PF2EDC.Dungeon.SkillChallenge.DialogNoCharacters": "You have no party character to attempt this.",
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/skill-challenge-dialog.test.mjs`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add scripts/ui/skill-challenge-dialog.mjs tests/skill-challenge-dialog.test.mjs lang/en.json
git commit -m "feat(#822): add the skill-challenge click-to-attempt dialog

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the dialogs into the token click, live-verify, version bump

**Files:**
- Modify: `scripts/module.mjs` (`triggerRoomFeatureToken`)
- Test: `tests/room-feature-click-binding.test.mjs` (confirmed current, covers this exact click-wiring area — read its conventions first)

**Interfaces:**
- Consumes: `promptPuzzleStage`/`attemptPuzzleStageFor` (Tasks 1-2), `promptSkillChallenge`/`attemptSkillChallengeFor` (Tasks 1-3).

- [x] **Step 1: Write the failing tests**

Read `tests/room-feature-click-binding.test.mjs` in full first to match its exact mocking conventions (it already covers `triggerRoomFeatureToken`'s current reveal-only behavior for puzzle/skill-challenge/treasure). Add cases:
- Clicking a puzzle token (as GM, puzzle not yet revealed, one not-yet-attempted stage, one party character) reveals it AND calls `attemptPuzzleStageFor` with the dialog's chosen `actorId`/`stageIndex` (mock `promptPuzzleStage` to resolve a fixed choice).
- Clicking a skill-challenge token behaves the same way for `promptSkillChallenge`/`attemptSkillChallengeFor`.
- Clicking either when the dialog resolves `null` (cancelled) still completes the reveal but calls neither attempt function.
- Clicking a treasure token is completely unaffected (still just reveals/claims, confirmed current — neither new dialog is ever imported into that branch).
- A non-GM client relays the attempt exactly as the existing tracker form does (reuse whatever this test file's own existing relay-mocking convention already is for `roomFeatureInteract`, extended for the new attempt relay).

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/room-feature-click-binding.test.mjs -t "#822"`
Expected: FAIL.

- [x] **Step 3: Wire it**

In `scripts/module.mjs`, change `triggerRoomFeatureToken` (confirmed current, lines 358-384) from:

```js
async function triggerRoomFeatureToken(user, token, targeted) {
  const doc = token?.document ?? token;
  const sceneId = doc?.parent?.id ?? token?.scene?.id;
  const route = routeTargetTokenEvent({
    userId: user?.id,
    gameUserId: game.user?.id,
    targeted,
    flags: doc?.flags?.[MODULE_ID],
    sceneId,
    state: sceneId ? getRunState(sceneId) : null,
  });
  if (!route) return;
  if (game.user.isGM) {
    try {
      await runRoomFeatureAction(route, {
        getRunState,
        claimTreasureFor,
        revealRoomFeature,
        applyUsedArt: applyRoomFeatureUsedArtForScene,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | room-feature interaction failed`, err);
    }
  } else {
    await requestDungeonAction("roomFeatureInteract", route);
  }
}
```

to:

```js
/** #822: after a puzzle/skill-challenge room-feature token's reveal
 * completes, immediately offer the matching check-attempt dialog -- the
 * step #611/#623 never added, which otherwise stranded the actual
 * skill-check behind the tracker window's own form. Treasure needs
 * nothing further; its own claim already completes in one step. */
async function promptRoomFeatureCheck(route) {
  const state = getRunState(route.sceneId);
  const room = state?.rooms[route.roomId];
  const characters = (game.actors?.party?.members ?? []).filter(
    (actor) => actor.type === "character",
  );
  if (route.kind === "puzzle") {
    if (!room?.puzzle) return;
    const choice = await promptPuzzleStage(room.puzzle.stages, characters);
    if (!choice) return;
    if (game.user.isGM) {
      await attemptPuzzleStageFor(route.sceneId, route.roomId, choice.stageIndex, choice.actorId);
    } else {
      await requestDungeonAction("recordPuzzleStageOutcome", {
        sceneId: route.sceneId,
        roomId: route.roomId,
        stageIndex: choice.stageIndex,
        // The non-GM path rolls locally and relays only the outcome,
        // exactly like the tracker form's own existing split -- recompute
        // here rather than route the roll itself through attemptPuzzleStageFor.
        outcome: (await (async () => {
          const stage = room.puzzle.stages[choice.stageIndex];
          const actor = game.actors.get(choice.actorId);
          const result = actor ? await rollPuzzleStageAttempt(actor, stage.skill, stage.dc) : null;
          return result?.outcome;
        })()),
      });
    }
  } else if (route.kind === "skill_challenge") {
    if (!room?.challenge) return;
    const choice = await promptSkillChallenge(room.challenge.specialtySkills, characters);
    if (!choice) return;
    if (game.user.isGM) {
      await attemptSkillChallengeFor(route.sceneId, choice.actorId, choice.skill);
    } else {
      await requestDungeonAction("recordSkillChallengeOutcome", {
        sceneId: route.sceneId,
        roomId: route.roomId,
        outcome: (await (async () => {
          const actor = game.actors.get(choice.actorId);
          const dc = dcForAttempt({
            partyLevel: await makeFoundryApi().partyLevel(),
            difficulty: state.difficulty,
          });
          const result = actor ? await rollSkillChallengeAttempt(actor, choice.skill, dc) : null;
          return result?.outcome;
        })()),
      });
    }
  }
}

async function triggerRoomFeatureToken(user, token, targeted) {
  const doc = token?.document ?? token;
  const sceneId = doc?.parent?.id ?? token?.scene?.id;
  const route = routeTargetTokenEvent({
    userId: user?.id,
    gameUserId: game.user?.id,
    targeted,
    flags: doc?.flags?.[MODULE_ID],
    sceneId,
    state: sceneId ? getRunState(sceneId) : null,
  });
  if (!route) return;
  if (game.user.isGM) {
    try {
      await runRoomFeatureAction(route, {
        getRunState,
        claimTreasureFor,
        revealRoomFeature,
        applyUsedArt: applyRoomFeatureUsedArtForScene,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | room-feature interaction failed`, err);
      return;
    }
  } else {
    await requestDungeonAction("roomFeatureInteract", route);
  }
  if (route.kind === "puzzle" || route.kind === "skill_challenge") {
    try {
      await promptRoomFeatureCheck(route);
    } catch (err) {
      console.error(`${MODULE_ID} | room-feature check prompt failed`, err);
    }
  }
}
```

Add the new imports this needs (`promptPuzzleStage`, `attemptPuzzleStageFor`, `rollPuzzleStageAttempt`, `promptSkillChallenge`, `attemptSkillChallengeFor`, `rollSkillChallengeAttempt`, `dcForAttempt`, `makeFoundryApi` — check which of these `module.mjs` already imports from `dungeon-app.mjs`/elsewhere before adding duplicates).

**Note for the implementer:** the inline `outcome` recomputation in the non-GM branches above duplicates one roll call already made inside `attemptPuzzleStageFor`/`attemptSkillChallengeFor` for the GM branch — a real wart worth a second look during implementation. If it reads better, consider instead exporting a small `rollOnly` variant of each attempt function (roll, return `{outcome}`, no record/relay) that both the GM and non-GM branches call identically before branching only on *who persists the result* — cleaner than the duplicated inline closures sketched here. Either shape is acceptable; keep whichever the implementer's own judgment finds clearer, since this plan's own job is pinning the *behavior*, not the exact internal shape.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/room-feature-click-binding.test.mjs`
Expected: PASS, old and new cases green.

- [x] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Live-verify via `foundry-rest`**

In a real dungeon run, reach a puzzle room and click its token: confirm the reveal happens AND a dialog immediately offers a character + stage picker, that confirming it rolls and records the attempt (room progress updates, and the room eventually resolves once enough stages succeed). Repeat for a skill-challenge room (character + skill picker). Confirm a treasure room's own click is unaffected. Repeat once each as a non-GM client (if available) to confirm the relay path works identically.

- [x] **Step 7: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (restoring a genuinely broken core interaction), using whatever the fetch above shows as current.

- [x] **Step 8: Commit**

```bash
git add scripts/module.mjs tests/room-feature-click-binding.test.mjs module.json
git commit -m "fix(#822): offer puzzle/skill-challenge checks from the token click

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #822's own ask (clicking the puzzle token starts the puzzle and offers its skill checks, feeding the existing resolution path) is fully covered, and the user-approved widened scope (skill-challenge, found to share the identical bug) is covered in parallel via the same pattern. #622/#623's own existing reveal step and the server-side roll/record/relay logic are confirmed unchanged and reused, not rebuilt.

**2. Placeholder scan:** No TBD/TODO. Task 4's own "Note for the implementer" is a deliberate, explicit flag about a real internal-shape wart in the sketched code (duplicated roll logic across GM/non-GM branches), not a placeholder — it names the exact concern and a concrete alternative, leaving the final shape to the implementer's own judgment rather than hand-waving the behavior itself.

**3. Type consistency:** `attemptPuzzleStageFor(sceneId, roomId, stageIndex, actorId)`/`attemptSkillChallengeFor(sceneId, actorId, skill)` (Task 1) are called with identical argument order and names in Task 4. `promptPuzzleStage`/`promptSkillChallenge`'s resolved shapes (`{actorId, stageIndex}`/`{actorId, skill}`, Tasks 2-3) are read with the same field names in Task 4.

**4. Review Focus:** All five items (puzzle attempt actually offered, skill-challenge attempt actually offered, tracker forms unchanged, a no-characters/nothing-left notice instead of a silent failure, treasure unaffected) each map to a specific test or step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-room-feature-check-dialogs.md`.
