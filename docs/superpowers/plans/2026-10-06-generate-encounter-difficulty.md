# Generate Encounter Difficulty Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #831 — the standalone "Generate Encounter" macro's dialog gets a difficulty selector (GM Core's five encounter severities: trivial, low, moderate, severe, extreme), defaulting to moderate, instead of the macro's current fixed, unconfigurable Severe cap.

**Architecture:** No new XP-budget machinery — `resolveEncounterRoster`'s existing cap mechanism (`xpCeilingTierForDepth(depthBias)` → `xpBudget(tier, partySize)`, confirmed current in `scripts/encounter-roster.mjs`) already enforces exactly the five tiers this issue asks for; it's just driven today by a dungeon room's own depth bias, and the standalone macro never supplies one (`generateEncounter`'s own `depthBias` param defaults to `null`, which `xpCeilingTierForDepth` resolves to `"severe"` — confirmed current, the exact "no way to choose difficulty, always capped" bug #831 describes). The fix adds one new, small inverse function (`depthBiasForDifficultyTier`, the exact mirror of the already-existing `xpCeilingTierForDepth`) and a difficulty `<select>` on the macro's own theme dialog (`chooseThemeAndSize` in `scripts/encounter-generator.mjs`) — chosen there specifically because `skipThemeDialog: true` (the dungeon-room path, which already supplies its own real depth-based bias from the room itself) never shows this dialog at all, so the new selector only ever appears for the standalone macro, exactly where #831 wants it.

**Tech Stack:** Vanilla ES modules, Vitest, Foundry `DialogV2`.

**Spec:** None — a bounded addition reusing an already-built, already-tested cap mechanism; the five tier names/labels and the "default to moderate" behavior are both explicitly stated in the issue itself, leaving no open design question.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new GM-facing option: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- The dungeon-room encounter path (`populateSlotEncounter`'s own call into `generateEncounter({skipThemeDialog: true, depthBias: ..., ...})`) is completely unaffected — it never shows `chooseThemeAndSize`'s dialog, so the new selector never appears there, and its own depth-based bias keeps working exactly as today.
- The five tier names, their relative strictness ordering, and "moderate" as the default are GM Core's own real encounter-building severities (already codified in this file's own `XP_BUDGET_TIERS`/`xpCeilingTierForDepth`, confirmed current) — nothing new to verify against the rules here, only wiring.
- New localization keys live under the `PF2EDC.Encounter.*` namespace (the macro/generator's own existing namespace), not `PF2EDC.Dungeon.Difficulty.*` (the Start Dungeon dialog's own, semantically different "shift the whole dungeon's depth ramp" concept, confirmed current in `scripts/ui/dungeon-app.mjs`) — reusing that dialog's labels verbatim would mislabel what this selector actually does (cap one encounter's own XP budget, not reshape a dungeon).

## Review Focus

- **Choosing "trivial" through "extreme" must actually change the generated roster's own XP cap**, not just cosmetically appear in the dialog — the whole point of the issue.
- **No selection (closing/accepting without touching the dropdown) must default to moderate**, matching the issue's own explicit "defaulting to moderate."
- **The dungeon-room encounter path must be completely unaffected** — its own `depthBias` (from the room's real depth) must keep driving its cap exactly as today, never overridden by this new macro-only selector.
- **An invalid/unrecognized difficulty value must not crash** — `depthBiasForDifficultyTier` needs the same safe-fallback behavior `xpCeilingTierForDepth` already has for an out-of-range input.
- **The new inverse function must stay in lockstep with `xpCeilingTierForDepth`** — a future change to one without the other would silently break the round-trip; pinned by a dedicated test, not left to chance.

---

### Task 1: The inverse tier-to-bias function

**Files:**
- Modify: `scripts/encounter-roster.mjs`
- Test: `tests/encounter-roster.test.mjs`

**Interfaces:**
- Produces: `depthBiasForDifficultyTier(tier: string): number` — the exact inverse of `xpCeilingTierForDepth`. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `tests/encounter-roster.test.mjs`, alongside the existing `xpCeilingTierForDepth` tests (confirmed current, lines 553-562):

```js
describe('depthBiasForDifficultyTier', () => {
  it('is the exact inverse of xpCeilingTierForDepth for every real tier', () => {
    for (const tier of ['trivial', 'low', 'moderate', 'severe', 'extreme']) {
      expect(xpCeilingTierForDepth(depthBiasForDifficultyTier(tier))).toBe(tier);
    }
  });

  it('maps each tier to its documented bias', () => {
    expect(depthBiasForDifficultyTier('trivial')).toBe(-1);
    expect(depthBiasForDifficultyTier('low')).toBe(0);
    expect(depthBiasForDifficultyTier('moderate')).toBe(1);
    expect(depthBiasForDifficultyTier('severe')).toBe(2);
    expect(depthBiasForDifficultyTier('extreme')).toBe(3);
  });

  it('falls back to moderate for an unrecognized or missing tier', () => {
    expect(depthBiasForDifficultyTier('nonsense')).toBe(1);
    expect(depthBiasForDifficultyTier(undefined)).toBe(1);
    expect(depthBiasForDifficultyTier(null)).toBe(1);
  });
});
```

Add `depthBiasForDifficultyTier` to this test file's existing import from `../scripts/encounter-roster.mjs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/encounter-roster.test.mjs -t "depthBiasForDifficultyTier"`
Expected: FAIL — not a function yet.

- [ ] **Step 3: Write `depthBiasForDifficultyTier`**

In `scripts/encounter-roster.mjs`, add directly after `xpCeilingTierForDepth` (confirmed current, ends line 102):

```js
/**
 * #831: the exact inverse of `xpCeilingTierForDepth` above — maps a GM
 * Core difficulty tier name straight back to the depth bias that produces
 * it, so a direct tier picker (the standalone "Generate Encounter" macro,
 * which has no dungeon room/depth to derive one from) can drive the same
 * cap mechanism dungeon rooms already use, with no new XP-budget logic.
 * An unrecognized or missing tier falls back to Moderate (bias 1),
 * matching this file's own "default to Moderate" convention.
 */
const DIFFICULTY_TIER_TO_BIAS = {
  trivial: -1,
  low: 0,
  moderate: 1,
  severe: 2,
  extreme: 3,
};

export function depthBiasForDifficultyTier(tier) {
  return DIFFICULTY_TIER_TO_BIAS[tier] ?? DIFFICULTY_TIER_TO_BIAS.moderate;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/encounter-roster.test.mjs -t "depthBiasForDifficultyTier"`
Expected: PASS, all three cases green.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/encounter-roster.mjs tests/encounter-roster.test.mjs
git commit -m "feat(#831): add depthBiasForDifficultyTier, the inverse of xpCeilingTierForDepth

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The difficulty selector on the macro's own dialog

**Files:**
- Modify: `scripts/encounter-generator.mjs` (`chooseThemeAndSize`, `generateEncounter`)
- Modify: `lang/en.json` (new `PF2EDC.Encounter.Difficulty*` keys)
- Test: `tests/encounter-generator.test.mjs`

**Interfaces:**
- Consumes: `depthBiasForDifficultyTier` (Task 1).
- Produces: `chooseThemeAndSize`'s own resolved value gains a `difficulty` field (e.g. `{traits, excludeTraits, difficulty}`); `generateEncounter` uses it to compute the effective `depthBias` passed into `generateEncounterRoster` for the macro path only.

- [ ] **Step 1: Write the failing tests**

Add to `tests/encounter-generator.test.mjs`, inside the existing `describe("generateEncounter (no approval gate)", ...)` block (reusing its own `installFoundryStubs` fixture, extending the `DialogV2.wait` stub's returned object):

```js
  it("#831: passes the chosen difficulty tier through as the encounter's own depth bias", async () => {
    const dialogShownRef = { shown: false };
    installFoundryStubs({ dialogShownRef });
    globalThis.foundry.applications.api.DialogV2.wait = vi.fn(async () => ({
      traits: [],
      excludeTraits: [],
      difficulty: "trivial",
    }));
    const generateEncounterRoster = vi.fn(async () => ({
      foes: [], friend: null, twins: null, lurker: null,
    }));
    vi.mocked(getGenerator).mockReturnValueOnce({ generateEncounterRoster });

    await generateEncounter({ scene: { id: "scene1" } });

    expect(generateEncounterRoster).toHaveBeenCalledWith(
      expect.objectContaining({ depthBias: -1 }),
    );
  });

  it("#831: defaults to moderate when the dialog's difficulty field is left untouched", async () => {
    const dialogShownRef = { shown: false };
    installFoundryStubs({ dialogShownRef });
    globalThis.foundry.applications.api.DialogV2.wait = vi.fn(async () => ({
      traits: [],
      excludeTraits: [],
      difficulty: "moderate",
    }));
    const generateEncounterRoster = vi.fn(async () => ({
      foes: [], friend: null, twins: null, lurker: null,
    }));
    vi.mocked(getGenerator).mockReturnValueOnce({ generateEncounterRoster });

    await generateEncounter({ scene: { id: "scene1" } });

    expect(generateEncounterRoster).toHaveBeenCalledWith(
      expect.objectContaining({ depthBias: 1 }),
    );
  });

  it("#831: a dungeon room (skipThemeDialog) keeps using its own supplied depthBias, never the macro's selector", async () => {
    const dialogShownRef = { shown: false };
    installFoundryStubs({ dialogShownRef });
    const generateEncounterRoster = vi.fn(async () => ({
      foes: [], friend: null, twins: null, lurker: null,
    }));
    vi.mocked(getGenerator).mockReturnValueOnce({ generateEncounterRoster });

    await generateEncounter({
      skipThemeDialog: true,
      scene: { id: "scene1" },
      depthBias: 2,
    });

    expect(globalThis.foundry.applications.api.DialogV2.wait).not.toHaveBeenCalled();
    expect(generateEncounterRoster).toHaveBeenCalledWith(
      expect.objectContaining({ depthBias: 2 }),
    );
  });
```

(Check this test file's own existing import of `getGenerator`/`generator-registry.mjs` mock first — confirmed current, it already `vi.mock`s `../scripts/generator-registry.mjs`; adapt the exact `vi.mocked(getGenerator)` call shape to however that mock is already set up in this file rather than assuming the above verbatim.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/encounter-generator.test.mjs -t "#831"`
Expected: FAIL — `difficulty`/`depthBias` aren't wired yet; the dungeon-room case may already pass incidentally (it's today's existing behavior), confirming the test targets only the intended change.

- [ ] **Step 3: Add the selector to the dialog**

In `scripts/encounter-generator.mjs`, change `chooseThemeAndSize` (confirmed current, lines 29-68):

```js
async function chooseThemeAndSize({
  api,
  prefillTraits = [],
  prefillExcludeTraits = [],
} = {}) {
  const { DialogV2 } = foundry.applications.api;
  const traits = await api.listCreatureTraits();
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Encounter.Title") },
    content: `
      <form>
        ${traitFieldHtml({
          name: "traits",
          label: game.i18n.localize("PF2EDC.Encounter.ThemeLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
          selected: prefillTraits,
        })}
        ${traitFieldHtml({
          name: "excludeTraits",
          label: game.i18n.localize("PF2EDC.Encounter.ExcludeTraitsLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
          selected: prefillExcludeTraits,
        })}
      </form>`,
    render: (_event, dialog) => wireTraitPickerButtons(dialog.element, traits),
    buttons: [
      {
        action: "generate",
        label: game.i18n.localize("PF2EDC.Encounter.GenerateButton"),
        default: true,
        callback: (_event, _button, dialog) => ({
          traits: readTraitField(dialog.element, "traits"),
          excludeTraits: readTraitField(dialog.element, "excludeTraits"),
        }),
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
}
```

to:

```js
async function chooseThemeAndSize({
  api,
  prefillTraits = [],
  prefillExcludeTraits = [],
} = {}) {
  const { DialogV2 } = foundry.applications.api;
  const traits = await api.listCreatureTraits();
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Encounter.Title") },
    content: `
      <form>
        <label>
          ${game.i18n.localize("PF2EDC.Encounter.DifficultyLabel")}
          <select name="difficulty">
            <option value="trivial">${game.i18n.localize("PF2EDC.Encounter.Difficulty.Trivial")}</option>
            <option value="low">${game.i18n.localize("PF2EDC.Encounter.Difficulty.Low")}</option>
            <option value="moderate" selected>${game.i18n.localize("PF2EDC.Encounter.Difficulty.Moderate")}</option>
            <option value="severe">${game.i18n.localize("PF2EDC.Encounter.Difficulty.Severe")}</option>
            <option value="extreme">${game.i18n.localize("PF2EDC.Encounter.Difficulty.Extreme")}</option>
          </select>
        </label>
        ${traitFieldHtml({
          name: "traits",
          label: game.i18n.localize("PF2EDC.Encounter.ThemeLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
          selected: prefillTraits,
        })}
        ${traitFieldHtml({
          name: "excludeTraits",
          label: game.i18n.localize("PF2EDC.Encounter.ExcludeTraitsLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
          selected: prefillExcludeTraits,
        })}
      </form>`,
    render: (_event, dialog) => wireTraitPickerButtons(dialog.element, traits),
    buttons: [
      {
        action: "generate",
        label: game.i18n.localize("PF2EDC.Encounter.GenerateButton"),
        default: true,
        callback: (_event, _button, dialog) => ({
          traits: readTraitField(dialog.element, "traits"),
          excludeTraits: readTraitField(dialog.element, "excludeTraits"),
          // Mirrors the Start Dungeon dialog's own identical fallback
          // (scripts/ui/dungeon-app.mjs, confirmed current) -- a <select>
          // with a `selected` default option always has a value, so this
          // only ever matters if the element is somehow missing.
          difficulty: dialog.element.querySelector('[name="difficulty"]')?.value ?? "moderate",
        }),
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
}
```

- [ ] **Step 4: Use the chosen difficulty for the macro path only**

In `generateEncounter`, change (confirmed current):

```js
  const theme = skipThemeDialog
    ? { traits: prefillTraits, excludeTraits: prefillExcludeTraits }
    : await chooseThemeAndSize({ api, prefillTraits, prefillExcludeTraits });
  if (!theme || theme === "cancel") return;
```

and the later `generateEncounterRoster` call's `depthBias` field (confirmed current):

```js
  const roster = await getGenerator().generateEncounterRoster({
    resolved: dealt.resolved,
    api,
    partyLevel,
    traits: theme.traits,
    excludeTraits: theme.excludeTraits,
    levelOffsetBias,
    requireTrait: locationTag,
    partySize,
    isBoss,
    depthBias,
  });
```

to (only the `depthBias` line changes):

```js
  const theme = skipThemeDialog
    ? { traits: prefillTraits, excludeTraits: prefillExcludeTraits }
    : await chooseThemeAndSize({ api, prefillTraits, prefillExcludeTraits });
  if (!theme || theme === "cancel") return;
  // #831: a dungeon room (skipThemeDialog) already supplies its own real
  // depth-based bias; the standalone macro has none, so its own dialog's
  // difficulty choice drives the identical cap mechanism instead.
  const effectiveDepthBias = skipThemeDialog
    ? depthBias
    : depthBiasForDifficultyTier(theme.difficulty);
```

```js
  const roster = await getGenerator().generateEncounterRoster({
    resolved: dealt.resolved,
    api,
    partyLevel,
    traits: theme.traits,
    excludeTraits: theme.excludeTraits,
    levelOffsetBias,
    requireTrait: locationTag,
    partySize,
    isBoss,
    depthBias: effectiveDepthBias,
  });
```

Add `depthBiasForDifficultyTier` to this file's existing import from `./encounter-roster.mjs`.

- [ ] **Step 5: Add the localization keys**

In `lang/en.json`, add near the existing `PF2EDC.Encounter.*` keys:

```json
  "PF2EDC.Encounter.DifficultyLabel": "Difficulty",
  "PF2EDC.Encounter.Difficulty.Trivial": "Trivial",
  "PF2EDC.Encounter.Difficulty.Low": "Low",
  "PF2EDC.Encounter.Difficulty.Moderate": "Moderate (default)",
  "PF2EDC.Encounter.Difficulty.Severe": "Severe",
  "PF2EDC.Encounter.Difficulty.Extreme": "Extreme",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/encounter-generator.test.mjs -t "#831"`
Expected: PASS, all three cases green.

- [ ] **Step 7: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Live-verify via `foundry-rest`**

Run the real "PF2EDC: Generate Encounter" macro, confirm the dialog now shows a Difficulty dropdown defaulting to Moderate, and that picking Trivial vs. Extreme produces a visibly smaller vs. larger roster for the same party (cross-check the GM-only roster chat card's own total XP against `xpBudget(tier, partySize)` for the chosen tier). Separately, generate a real dungeon run and confirm a combat room's own encounter is completely unaffected (no difficulty dialog ever appears for it, and its roster still scales with the room's own depth as before).

- [ ] **Step 9: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real new GM-facing option), using whatever the fetch above shows as current.

- [ ] **Step 10: Commit**

```bash
git add scripts/encounter-generator.mjs lang/en.json tests/encounter-generator.test.mjs module.json
git commit -m "feat(#831): add a difficulty selector to the Generate Encounter dialog

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #831's own ask (a difficulty selector using PF2e's five encounter severities, defaulting to moderate, for the Generate Encounter macro specifically) is fully covered: Task 1 provides the tier→bias mapping reusing the exact existing cap mechanism named in the issue's own "Related" section (`xpCeilingTierForDepth`); Task 2 adds the selector to the one dialog this issue is about, confirmed never shown for the dungeon-room path. #412 (the Start Dungeon dialog's own, differently-scoped difficulty concept) is referenced for UI-pattern precedent only, not reused verbatim, since its labels describe a different mechanic.

**2. Placeholder scan:** No TBD/TODO. Every code block and localization string is the complete real text.

**3. Type consistency:** `depthBiasForDifficultyTier(tier): number` (Task 1) is consumed with the identical name and return type in Task 2's `generateEncounter` change; `chooseThemeAndSize`'s new `difficulty` field is produced and consumed with the same name in both places that touch it.

**4. Review Focus:** All five items (the selection actually changes the cap, untouched defaults to moderate, the dungeon-room path is unaffected, an invalid tier doesn't crash, the two functions can't silently drift apart) each map to a specific test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-generate-encounter-difficulty.md`.
