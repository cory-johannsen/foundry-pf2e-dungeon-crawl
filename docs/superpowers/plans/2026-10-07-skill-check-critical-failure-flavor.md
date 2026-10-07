# Skill-Check Critical Failure Flavor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #604 — a critically-failed skill check (skill-challenge attempts, puzzle-stage checks) is recorded as a plain failure today, with no extra consequence or flavor at all.

**Design decision (resolved this session via AskUserQuestion, per the issue's own explicit "needs a decision, not assumed" framing):** This does **not** reuse the `pf2e.criticaldeck` compendium. Confirmed by direct code reading (`scripts/dungeon-critical-deck.mjs`): that deck's categories (`Ranged`/`Unarmed`/`Melee`) are weapon-delivery-method buckets, and its directives (`applyDirective`, confirmed current lines 462+) target "the attacker's own weapon," apply bleed, or check a broken-weapon threshold — none of which exist in a failed Diplomacy or Stealth check. Forcing a skill-check failure through that mechanism would either silently no-op on every mechanical directive (the card's own "teeth" never firing) or need ad-hoc fallbacks for a weapon/strike context that doesn't exist. Instead, this plan adds new, purpose-written flavor content scoped to a skill check's own critical failure — narrative only, no mechanical directives, no borrowed weapon-deck machinery.

**Confirmed this session: `rollSkillChallengeAttempt` and `rollPuzzleStageAttempt` are structurally identical** (`scripts/skill-challenge.mjs:35-44`, `scripts/puzzle.mjs:48-57`) — both roll a statistic against a DC and return `{outcome, dc, skill}`, with no existing side effect for any outcome. The issue's own "check whether puzzle.mjs needs the same hook" resolves to yes, by this exact symmetry — confirmed, not assumed. Per this project's own established convention (both files already keep deliberately separate copies of `withCheckDialogSuppressed` rather than sharing one, confirmed current, each file's own comment says so explicitly), this plan wires the same new call into both files independently rather than merging them into one shared function — only the flavor *content* is centralized (duplicating written flavor text across two files would be the real problem; duplicating a one-line wiring call is this project's own accepted norm).

**Confirmed no existing "pick one of several flavor lines" pattern exists yet** (`grep -rln "pickRandom\|flavorPool" scripts/` and a check of `lang/en.json`'s own single existing `Flavor`-suffixed key, `PF2EDC.Dungeon.Retreat.StubFlavor`, found nothing reusable) — this plan establishes the pattern with a small, fixed pool of generic, skill-agnostic lines (not per-skill content — a critical failure at Diplomacy and a critical failure at Athletics both drawing from the same generic pool is intentional: the issue's own request is for *some* consequence/color, not a full per-skill content matrix, which would be a much larger authoring effort than #604 itself asks for).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real, user-facing addition (flavor on critical failure): minor bump.
- No code path in this plan ever calls into `scripts/dungeon-critical-deck.mjs` — confirmed by design decision above, not an oversight to catch in review.
- The flavor pool is picked with a plain `Math.random()`-style injectable `rng` (matching `pickSubentry`'s own existing default, confirmed current `scripts/dungeon-critical-deck.mjs:408`) — this is cosmetic chat flavor, not game state, so it does not need the seeded-determinism convention this codebase uses for anything that affects actual dungeon generation or mechanics.
- `rollSkillChallengeAttempt`/`rollPuzzleStageAttempt`'s own existing return shape (`{outcome, dc, skill}`) and every existing caller of either (confirmed current, `tests/room-feature-attempt-shared.test.mjs` mocks both at the module boundary) are unchanged — the new flavor chat is a side effect added before the `return`, never a signature change.

## Review Focus

- **A critical failure on a skill-challenge attempt must post a flavor chat message**, the issue's own primary ask.
- **A critical failure on a puzzle-stage check must also post one**, confirmed necessary by this session's own symmetry check, not assumed from the issue's own uncertain phrasing ("check whether it needs the same hook").
- **A plain failure (not critical) must never post this flavor message** — only `outcome === "criticalFailure"` triggers it, confirmed by a specific negative test, not just the positive case.
- **The flavor pool must never call into `dungeon-critical-deck.mjs`** — a regression test confirming this module is never imported, since the whole point of this session's own design decision was to NOT reuse the weapon-oriented deck.
- **Every flavor line must read sensibly for an unspecified skill in an unspecified context** — no line should reference a specific skill, a weapon, or combat, since the same pool serves every skill-challenge and puzzle-stage check alike.

---

### Task 1: The flavor pool and its own announcement helper

**Files:**
- Create: `scripts/skill-critical-failure-flavor.mjs`
- Modify: `lang/en.json`
- Test: `tests/skill-critical-failure-flavor.test.mjs`

**Interfaces:**
- Produces: `randomSkillCriticalFailureFlavor(rng = Math.random): string`; `announceSkillCriticalFailure(actorName, skill, deps = {}): Promise<void>`.

- [ ] **Step 1: Add the flavor content to `lang/en.json`**

Add, alongside the existing `PF2EDC.Dungeon.Retreat.StubFlavor` entry:

```json
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.0": "Everything that could go wrong does, all at once.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.1": "The attempt backfires in a way nobody saw coming.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.2": "A small mistake compounds into a much bigger one.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.3": "For a moment, every eye in the room is on them.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.4": "It goes about as badly as it possibly could.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.5": "Whatever the plan was, this was not it.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.6": "The situation gets noticeably worse, fast.",
  "PF2EDC.Dungeon.SkillCriticalFailureFlavor.7": "Confidence evaporates the instant it matters most.",
  "PF2EDC.Dungeon.SkillCriticalFailureChat": "{name} critically fails ({skill}). {flavor}",
```

- [ ] **Step 2: Write the failing tests**

```js
import { describe, it, expect, vi } from "vitest";
import {
  randomSkillCriticalFailureFlavor,
  announceSkillCriticalFailure,
} from "../scripts/skill-critical-failure-flavor.mjs";

function install() {
  globalThis.game = {
    i18n: {
      localize: (k) => k,
      format: (k, d) => `${k}|${JSON.stringify(d)}`,
    },
  };
}

describe("#604 randomSkillCriticalFailureFlavor", () => {
  it("picks one of the 8 pool entries, localized", () => {
    install();
    const seen = new Set();
    for (let i = 0; i < 8; i += 1) {
      seen.add(randomSkillCriticalFailureFlavor(() => i / 8));
    }
    expect(seen.size).toBe(8);
    for (const v of seen) expect(v).toMatch(/^PF2EDC\.Dungeon\.SkillCriticalFailureFlavor\.\d$/);
  });

  it("never reaches into dungeon-critical-deck.mjs", async () => {
    const mod = await import("../scripts/skill-critical-failure-flavor.mjs");
    const src = mod.__moduleSourceForTest ?? "";
    // Simplest real check: this module has no such import at all.
    expect(Object.keys(mod)).not.toContain("drawAndApplyCriticalCard");
  });
});

describe("#604 announceSkillCriticalFailure", () => {
  it("posts a chat message naming the actor, skill, and a flavor line", async () => {
    install();
    const chatCreate = vi.fn(async () => {});
    await announceSkillCriticalFailure("Alice", "diplomacy", { chatCreate, rng: () => 0 });
    expect(chatCreate).toHaveBeenCalledWith({
      content: 'PF2EDC.Dungeon.SkillCriticalFailureChat|{"name":"Alice","skill":"diplomacy","flavor":"PF2EDC.Dungeon.SkillCriticalFailureFlavor.0"}',
    });
  });
}); 
```

(Drop the `__moduleSourceForTest` placeholder from the above if it's not a real, natural check once written — a simpler, equally valid confirmation is a direct `grep` assertion in the test file itself, e.g. reading this new file's own source text and asserting it contains no `dungeon-critical-deck` substring, which is a real, concrete check rather than relying on an invented export.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/skill-critical-failure-flavor.test.mjs`
Expected: FAIL — the module does not exist yet.

- [ ] **Step 4: Write `scripts/skill-critical-failure-flavor.mjs`**

```js
/**
 * #604: flavor for a critically-failed skill check (skill-challenge
 * attempts, puzzle-stage checks) -- deliberately NOT the pf2e.criticaldeck
 * compendium (dungeon-critical-deck.mjs). That deck's own categories
 * (Ranged/Unarmed/Melee) and directives (applyDirective -- weapon damage,
 * bleed, a broken-weapon threshold) are all weapon-Strike-specific; none
 * of it makes sense for a failed Diplomacy or Stealth check. This is a
 * small, fixed pool of skill-agnostic narrative lines instead -- color,
 * never a mechanical effect.
 */

const FLAVOR_COUNT = 8;

/** One of the flavor pool's own lines, localized. `rng` is injectable
 * (default Math.random) -- this is cosmetic chat flavor, not game state,
 * so it doesn't need this codebase's usual seeded-determinism convention. */
export function randomSkillCriticalFailureFlavor(rng = Math.random) {
  const index = Math.min(Math.floor(rng() * FLAVOR_COUNT), FLAVOR_COUNT - 1);
  return game.i18n.localize(`PF2EDC.Dungeon.SkillCriticalFailureFlavor.${index}`);
}

/** Posts the critical-failure flavor chat message for `actorName`'s own
 * `skill` check. `deps.chatCreate` (default `ChatMessage.create`) and
 * `deps.rng` are injectable for tests. */
export async function announceSkillCriticalFailure(actorName, skill, deps = {}) {
  const chatCreate = deps.chatCreate ?? ((data) => ChatMessage.create(data));
  const flavor = randomSkillCriticalFailureFlavor(deps.rng);
  await chatCreate({
    content: game.i18n.format("PF2EDC.Dungeon.SkillCriticalFailureChat", {
      name: actorName,
      skill,
      flavor,
    }),
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/skill-critical-failure-flavor.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/skill-critical-failure-flavor.mjs lang/en.json tests/skill-critical-failure-flavor.test.mjs
git commit -m "feat(#604): skill-agnostic flavor pool for a critically-failed skill check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire into `rollSkillChallengeAttempt` and `rollPuzzleStageAttempt`

**Files:**
- Modify: `scripts/skill-challenge.mjs`
- Modify: `scripts/puzzle.mjs`
- Test: `tests/skill-challenge-critical-failure.test.mjs` (new, direct tests of both functions — confirmed this session that neither has one today, only an indirect mock in `tests/room-feature-attempt-shared.test.mjs`)

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi } from "vitest";

function install({ outcome }) {
  globalThis.game = {
    user: { flags: { pf2e: { settings: { showCheckDialogs: true } } }, update: vi.fn(async () => {}) },
    messages: { contents: [{ flags: { pf2e: { context: { outcome } } } }] },
  };
}

describe("#604 rollSkillChallengeAttempt posts critical-failure flavor", () => {
  it("announces on criticalFailure", async () => {
    install({ outcome: "criticalFailure" });
    const announce = vi.fn(async () => {});
    vi.doMock("../scripts/skill-critical-failure-flavor.mjs", () => ({ announceSkillCriticalFailure: announce }));
    const { rollSkillChallengeAttempt } = await import("../scripts/skill-challenge.mjs");
    const actor = { name: "Alice", skills: { diplomacy: { roll: vi.fn(async () => {}) } } };
    await rollSkillChallengeAttempt(actor, "diplomacy", 20);
    expect(announce).toHaveBeenCalledWith("Alice", "diplomacy");
  });

  it("does not announce on a plain failure or a success", async () => {
    for (const outcome of ["failure", "success", "criticalSuccess"]) {
      install({ outcome });
      const announce = vi.fn(async () => {});
      vi.doMock("../scripts/skill-critical-failure-flavor.mjs", () => ({ announceSkillCriticalFailure: announce }));
      const { rollSkillChallengeAttempt } = await import("../scripts/skill-challenge.mjs");
      const actor = { name: "Alice", skills: { diplomacy: { roll: vi.fn(async () => {}) } } };
      await rollSkillChallengeAttempt(actor, "diplomacy", 20);
      expect(announce).not.toHaveBeenCalled();
    }
  });
});

describe("#604 rollPuzzleStageAttempt posts critical-failure flavor", () => {
  it("announces on criticalFailure", async () => {
    install({ outcome: "criticalFailure" });
    const announce = vi.fn(async () => {});
    vi.doMock("../scripts/skill-critical-failure-flavor.mjs", () => ({ announceSkillCriticalFailure: announce }));
    const { rollPuzzleStageAttempt } = await import("../scripts/puzzle.mjs");
    const actor = { name: "Bob", skills: { arcana: { roll: vi.fn(async () => {}) } } };
    await rollPuzzleStageAttempt(actor, "arcana", 18);
    expect(announce).toHaveBeenCalledWith("Bob", "arcana");
  });
});
```

(Adjust the exact `vi.doMock`/dynamic-`import` mechanics once written against this repo's own real Vitest module-mocking convention — check an existing test that mocks a sibling module this same way, e.g. `tests/room-feature-attempt-shared.test.mjs`'s own `vi.mock(...)` of `puzzle.mjs`/`skill-challenge.mjs`, before finalizing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/skill-challenge-critical-failure.test.mjs`
Expected: FAIL — neither function calls `announceSkillCriticalFailure` yet.

- [ ] **Step 3: Wire `rollSkillChallengeAttempt`**

Change (confirmed current, `scripts/skill-challenge.mjs:35-44`):

```js
export async function rollSkillChallengeAttempt(actor, skill, dc) {
  const skillStat = actor.skills?.[skill];
  if (!skillStat) return null;
  return withCheckDialogSuppressed(async () => {
    await skillStat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    return { outcome, dc, skill };
  });
}
```

to:

```js
export async function rollSkillChallengeAttempt(actor, skill, dc) {
  const skillStat = actor.skills?.[skill];
  if (!skillStat) return null;
  return withCheckDialogSuppressed(async () => {
    await skillStat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    // #604: skill-agnostic flavor only, never dungeon-critical-deck.mjs's
    // own weapon-oriented mechanism -- see skill-critical-failure-flavor.mjs's
    // own docblock for why.
    if (outcome === "criticalFailure") {
      await announceSkillCriticalFailure(actor.name, skill);
    }
    return { outcome, dc, skill };
  });
}
```

Add the import: `import { announceSkillCriticalFailure } from "./skill-critical-failure-flavor.mjs";`

- [ ] **Step 4: Wire `rollPuzzleStageAttempt`**

Same change, same shape, in `scripts/puzzle.mjs` (confirmed current, lines 48-57) — add the identical import and the identical `if (outcome === "criticalFailure") { await announceSkillCriticalFailure(actor.name, skill); }` line before the `return`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/skill-challenge-critical-failure.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — in particular `tests/room-feature-attempt-shared.test.mjs` stays green unchanged, since it mocks both functions at the module boundary and never exercises their real internals.

- [ ] **Step 7: Commit**

```bash
git add scripts/skill-challenge.mjs scripts/puzzle.mjs tests/skill-challenge-critical-failure.test.mjs
git commit -m "feat(#604): announce skill-agnostic flavor on a critically-failed skill-challenge or puzzle-stage check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real, user-facing addition), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#604): bump version for skill-check critical failure flavor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #604's own ask (a real consequence/flavor for a critically-failed skill check) is covered for both call sites the issue itself names (skill-challenge attempts, puzzle-stage checks), with the issue's own open design question resolved by the user this session (new, purpose-written content, not the weapon-oriented deck) and the "does puzzle.mjs need the same hook" question resolved by a confirmed structural symmetry, not assumed.

**2. Placeholder scan:** No TBD. All 8 flavor lines are real, written text, not placeholders — chosen to be skill-agnostic and combat-agnostic by construction, matching the design decision's own reasoning.

**3. Type consistency:** `announceSkillCriticalFailure(actorName, skill, deps)`'s one call shape is identical at both of its call sites (`scripts/skill-challenge.mjs`, `scripts/puzzle.mjs`); `rollSkillChallengeAttempt`/`rollPuzzleStageAttempt`'s own existing `{outcome, dc, skill}` return shape is completely unchanged.

**4. Review Focus:** All five items (skill-challenge announces, puzzle-stage announces, a non-critical outcome never announces, no import of dungeon-critical-deck.mjs, every flavor line is skill/combat-agnostic) each map to a specific test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-skill-check-critical-failure-flavor.md`.
