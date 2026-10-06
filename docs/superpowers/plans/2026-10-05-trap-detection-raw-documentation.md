# Trap Detection per PF2e RAW Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

(This file replaces the withdrawn documentation-only plan of the same name — same path on purpose, one source of truth.)

**Goal:** Trap detection follows PF2e rules as written: one secret Perception check per character per hazard when first within 30 ft; hazards that list a minimum proficiency are only checked for characters who are Searching and meet the rank; players only see successes.

**Architecture:** Three small pure functions in `scripts/trap-mechanics.mjs`; `rollTrapDetection` and `handleTrapTokenMove` in `scripts/trap-combat.mjs` use them; once-per-character memory is an actor flag on the hazard written by the GM client.

**Tech Stack:** Vanilla ES modules, Vitest (dependency-injected fake-Foundry tests).

**Spec:** `docs/superpowers/specs/2026-10-06-trap-detection-raw-design.md` (read it first: it carries the rules text, the compendium data, and the named out-of-scope items).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version`: a real behavior change is a **minor** bump above whatever `origin/main` has at commit time.
- `scripts/trap-mechanics.mjs` stays pure (no Foundry globals). `classifyTrapMove` is **unchanged** (the walk-over trigger and the click-to-disable flow keep working exactly as before); the handler simply stops using its `"detect"` result.
- The walk-over **trigger** branch, `markTrapSpent`, the in-flight lock, the party-only filter, GM-client-only rule, and unhide-on-detect behavior are unchanged.
- A non-GM client can never read the hazard actor; all state this feature writes lives on the **hazard actor** (written by the GM client only), never on tokens that players read.
- No detection rolls while any module combat is active on the scene.
- PF2e rank numbers: untrained 0, trained 1, expert 2, master 3, legendary 4 (`actor.perception.rank`); the Search activity is an owned item with slug `search` whose id is in `actor.system.exploration`; grid distance is `scene.grid.distance` per square (5 ft), so 30 ft = `30 / scene.grid.distance` squares.
- Never touch live Foundry in implementer tasks; the controller verifies live.

## Review Focus

- **No more per-step re-rolls:** the same character moving around the same hazard rolls at most once (test: repeated moves → one roll).
- **Minimum-proficiency hazards are never rolled for a character who is not Searching or who lacks the rank** — and that does NOT consume their roll (they can roll later once eligible).
- **No-minimum hazards give every party character one automatic check**, Search or not.
- **A failed roll is silent to players** (no public card, no public line); a GM-whispered line exists for every roll; a success posts the public "notices" line, sets `trapDetected`, unhides the token.
- **No rolls during combat.**
- **Odd `stealth.details` strings** (`@Check[...]`, `(or 0 if ...)`, `or <em>detect magic</em>`, empty, HTML wrappers) never produce a wrong rank: anything not a clean `(rank)` is "no minimum".
- **The walk-over trigger and disable flow are untouched** (existing tests green, unmodified).

---

### Task 1: Pure rules in `scripts/trap-mechanics.mjs`

**Files:** Modify `scripts/trap-mechanics.mjs`; Test `tests/trap-mechanics.test.mjs`.

**Interfaces (Produces — keep these exact names/signatures):**
- `trapMinProficiencyRank(stealthDetailsHtml)` → `0|1|2|3|4|null`: strips HTML tags, trims; matches only a clean parenthesised rank `(untrained|trained|expert|master|legendary)` (case-insensitive, the whole trimmed text) → rank number; anything else (empty, undefined, `@Check[...]`, `(or 0 if ...)`, `or <em>detect magic</em>`) → `null`.
- `detectionEligibility({ minRank, searching, perceptionRank })` → `boolean`: `minRank == null` → `true` (automatic check for everyone); otherwise `searching === true && perceptionRank >= minRank`.
- `withinSearchRange(trapFootprint, moverFootprint, rangeSquares)` → `boolean`: Chebyshev distance between the two `{gx,gy,gw,gh}` footprints (0 when overlapping) `<= rangeSquares`.

- [x] **Step 1:** Write failing tests for all three (every odd details string listed in Review Focus; eligibility truth table incl. null minRank with searching false, minRank 1 with rank 0/1/2, searching false with high rank; range: overlap, adjacent, exactly at range, one beyond, multi-cell footprints, negative-coordinate-safe).
- [x] **Step 2:** Run `npx vitest run tests/trap-mechanics.test.mjs`, confirm failures are for the right reason.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Run the whole `tests/trap-mechanics.test.mjs` file, confirm green.
- [x] **Step 5:** Commit.

### Task 2: Secret roll and range-based detection in `scripts/trap-combat.mjs`

**Files:** Modify `scripts/trap-combat.mjs`, `lang/en.json`; Test `tests/trap-token-move.test.mjs` (extend/adjust), new `tests/trap-detection-raw.test.mjs`.

**Interfaces:**
- Consumes: Task 1 exports; `footprint`; existing `withDialogsSuppressed`, `announceTrap`, in-flight lock.
- Produces: `rollTrapDetection(hazardActor, seeker, deps?)` → `{ detected, dc, outcome, total }` (secret: `perception.roll({ dc: { value }, createMessage: false })` under `withDialogsSuppressed`; read the outcome from the **returned roll's** `degreeOfSuccess` mapped to `criticalSuccess|success|failure|criticalFailure`, never from the last chat message); handler detect branch: for each undetected, untriggered hazard, for the moving party character: skip if a module combat is active; skip if the character already rolled (`hazardActor.getFlag(MODULE_ID, "trapDetectionRolls")` includes the actor id); skip if not within `30 / scene.grid.distance` squares of the hazard; compute `minRank = trapMinProficiencyRank(hazardActor.system?.attributes?.stealth?.details)`, `searching` = the character owns an item slug `search` whose id is in `actor.system.exploration`, `perceptionRank = actor.perception?.rank ?? 0`; skip (WITHOUT recording) if `!detectionEligibility(...)`; otherwise record the actor id in `trapDetectionRolls` **before** rolling, roll, whisper a GM line (new lang key under `PF2EDC.Dungeon.Trap.*`, e.g. `DetectionRollGM`: character, total, DC, outcome) via `ChatMessage.create` with `whisper: ChatMessage.getWhisperRecipients("GM")`, and on success set `trapDetected`, unhide, and post the existing public `DetectedChat` line.

- [ ] **Step 1:** Write failing tests (DI style from `tests/trap-token-move.test.mjs`): same character moving repeatedly near the same hazard rolls once; a min-proficiency hazard: Searching + sufficient rank rolls, not Searching does not roll and is not recorded (and rolls later once Searching), insufficient rank does not roll; a no-minimum hazard: any character rolls once; out of range (7 squares) does not roll, exactly at 6 squares does; active combat → no roll; failure → no public line, GM whisper line posted, `trapDetected` unset, token still hidden; success → public line, `trapDetected` set, token unhidden; the roll is made with `createMessage: false` (no public card); outcome read from the returned roll; the walk-over trigger path and disabled/spent behavior unchanged (existing tests unmodified and green); `rollTrapDetection` maps all four degrees. Add lang-key tests (non-empty, placeholders used by the code).
- [ ] **Step 2:** Run the affected test files, confirm the new tests fail for the right reasons.
- [ ] **Step 3:** Implement; update the doc comments of `rollTrapDetection` and `handleTrapTokenMove` to state the RAW rule and the three named out-of-scope items (Seek in encounters, hazard XP, complex-hazard initiative nuance) and to point to the spec.
- [ ] **Step 4:** Run affected files (`trap*`, `dungeon-follow*`, `stealth*`, lang-related), confirm green; prove at least the once-only and the min-proficiency tests can fail (revert the relevant condition, see red, restore).
- [ ] **Step 5:** Commit.

### Task 3: Docs, version, full verification

**Files:** `module.json`; `docs/architecture.md` only if imports changed (run `node tools/generate-architecture-graph.mjs`, replace the mermaid block verbatim).

- [ ] **Step 1:** Run the full suite once (`npx vitest run`; known flaky `tests/dungeon-reseed-sweep.test.mjs` timing, passes alone) and fix anything legitimately broken.
- [ ] **Step 2:** Architecture graph check; bump `module.json` minor above `origin/main`; commit.
- [ ] **Step 3 (controller, live):** with the party in a run: a min-proficiency trap is NOT found by a non-Searching party but is found by a Searching Trained+ character within 30 ft (secret roll: no public card; GM whisper present; public line only on success); a no-minimum trap gets one automatic roll per character; repeated movement does not re-roll; combat suppresses rolls; click-to-disable and walk-over trigger still work.
