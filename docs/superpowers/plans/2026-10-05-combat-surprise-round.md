# Combat Surprise Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A combat room's opening door gives the party a real chance at a surprise round — hostiles who weren't noticed get no action in round 1 — by letting the real `pf2e-avoid-notice` module do the actual Stealth-vs-Perception detection math, and adding new bridge logic to translate its results into a skipped hostile turn.

**Architecture:** `startCombat()` (`scripts/dungeon-combat.mjs`) temporarily grants each party actor the real "Avoid Notice" item and forces Stealth-for-initiative, rolls initiative as usual (now Stealth-aware for the party), starts combat (triggering `pf2e-avoid-notice`'s own detection logic as a side effect), waits a tunable delay, reads the resulting PF2e conditions off each party actor, and flags every hostile combatant `surprised` if the party's own aggregation rule says so — then reverts every temporary change regardless of outcome. `autoPlayCombatantTurnIfDue` skips a surprised hostile's round-1 turn via the combat's existing turn-skip mechanism.

**Tech Stack:** Vanilla ES modules, Vitest for the one pure-logic piece, the `foundry-rest` skill for every Foundry-glue task, the third-party `pf2e-avoid-notice` Foundry module (new dependency).

**Spec:** `docs/superpowers/specs/2026-10-05-combat-surprise-round-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). This adds a new cross-system dependency and a genuine new combat mechanic: minor bump. Current version at plan-writing time is `0.59.2` — re-check immediately before committing, since concurrent sessions push to this repo.
- The aggregation rule is fixed (already approved, not re-litigated here): the party achieves surprise iff **no** party member ends up with the `observed` condition. `unnoticed`/`undetected`/`hidden`/no-condition-at-all all count toward achieving surprise.
- The `surprised` flag (`flags["pf2e-dungeon-crawl"].surprised`) is only ever set on hostile combatants, never party combatants.
- Every temporary change to a party actor (`system.exploration`, `system.initiative.statistic`, a granted Avoid Notice item) must be reverted after the surprise check resolves, regardless of whether surprise succeeded — restoring each actor's own original values, never a shared default.
- `pf2e-avoid-notice` is not installed in this world today. Task 2's first step installs it — nothing in Tasks 2-4 can be live-verified before that.

## Review Focus

- **A party actor that already owns a real "Avoid Notice" item must not get a second, duplicate copy** — and the revert step must never delete an item the actor already legitimately owned before this feature touched it. Covered by Task 2's explicit "actor already owns Avoid Notice" test.
- **`system.exploration`'s original contents must come back exactly as they were**, including when it already held other activities — confirmed live this session that a real party member's array is never empty by default. Covered by Task 2's explicit non-empty-array round-trip test.
- **The revert must run even if something after the grant step throws** — a party actor must never get stuck with a permanently-forced Stealth initiative statistic because, say, `rollInitiative` failed. Covered by Task 2's explicit "revert still runs after an error" test, via try/finally.
- **A hostile that's `defeated` before its own surprised round-1 turn comes up must still go through the existing `isDefeated` branch first**, not the new surprised check — order matters, since a defeated surprised combatant should still be skipped for the right (defeated) reason, not silently fall through either check. Covered by Task 4's explicit ordering test.
- **Round 2 must play normally even for a combatant that was surprised in round 1** — the flag must never need explicit clearing, but this needs its own live check to confirm `combat.round` actually reads `2` by the time that combatant's turn comes up again, not still `1` due to some off-by-one in Foundry's own round numbering. Covered by Task 4's explicit round-2 live check.

---

### Task 1: `determinePartySurprise` — the pure aggregation rule

**Files:**
- Create: `scripts/surprise-round.mjs`
- Test: `tests/surprise-round.test.mjs`

**Interfaces:**
- Produces: `export function determinePartySurprise(conditionSlugs: Array<string|null>): boolean`. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/surprise-round.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { determinePartySurprise } from "../scripts/surprise-round.mjs";

describe("determinePartySurprise", () => {
  it("is true when every party member is unnoticed", () => {
    expect(determinePartySurprise(["unnoticed", "unnoticed"])).toBe(true);
  });

  it("is true for a mix of unnoticed/undetected/hidden", () => {
    expect(determinePartySurprise(["unnoticed", "undetected", "hidden"])).toBe(
      true,
    );
  });

  it("is false if even one party member ends up observed", () => {
    expect(determinePartySurprise(["unnoticed", "observed"])).toBe(false);
  });

  it("is false if every party member ends up observed", () => {
    expect(determinePartySurprise(["observed", "observed"])).toBe(false);
  });

  it("treats a null/no-condition entry as achieving surprise (not an observed failure)", () => {
    expect(determinePartySurprise(["unnoticed", null])).toBe(true);
  });

  it("is true for an empty party (vacuously -- no one was observed)", () => {
    expect(determinePartySurprise([])).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/surprise-round.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/surprise-round.mjs'`.

- [ ] **Step 3: Write `scripts/surprise-round.mjs`**

```js
/**
 * The party's own aggregation rule for #616: pf2e-avoid-notice applies one
 * of unnoticed/undetected/hidden/observed per party member (never a single
 * party-wide result -- PF2e itself has no one rule for that), so this
 * module decides what "the party achieved surprise" means from those
 * individual results. Deliberately simple and all-or-nothing: surprise
 * succeeds only if nobody in the party was flatly `observed` -- any of
 * unnoticed/undetected/hidden (or no condition at all, e.g. a party member
 * who wasn't avoiding notice) counts as achieving it. A real, named
 * simplification of RAW's actual per-character-vs-per-enemy granularity
 * (see the design spec) -- not an attempt at full fidelity.
 */
export function determinePartySurprise(conditionSlugs) {
  return !conditionSlugs.includes("observed");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/surprise-round.test.mjs`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/surprise-round.mjs tests/surprise-round.test.mjs
git commit -m "feat(#616): add determinePartySurprise aggregation rule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Grant Avoid Notice + force Stealth initiative, with revert

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (new functions `grantAvoidNotice`/`revertAvoidNotice`, wired into `startCombat`, lines ~143-169 — re-locate via your editor before editing)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `grantAvoidNotice(partyActors)` returning an array of revert-record objects `{actor, originalExploration, originalInitiativeStatistic, createdItemId}`; `revertAvoidNotice(records)` undoing them. Consumed by Task 3's wiring (both called from inside `startCombat`, in the same task's own code — Task 3 only adds what happens *between* the grant and the revert).

No unit test: this is real Foundry-document-mutating glue (actor updates, embedded item creation/deletion) with no existing unit-test harness anywhere in this file. Verified live in Step 2.

- [ ] **Step 1: Install `pf2e-avoid-notice` in this world**

This is a real prerequisite, not yet done — confirmed this session's active-modules list does not include it. In the Foundry world's Setup → Add-on Modules screen (or via the manifest URL from its listing at https://foundryvtt.com/packages/pf2e-avoid-notice), install and activate `pf2e-avoid-notice`. Confirm it's active:

```bash
echo 'return Array.from(game.modules.entries()).filter(([id,m]) => m.active).map(([id]) => id);' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: the returned list now includes `"pf2e-avoid-notice"` (its own dependency, `socketlib`, is already active on this world).

- [ ] **Step 2: Write `grantAvoidNotice`/`revertAvoidNotice`**

Add to `scripts/dungeon-combat.mjs`, directly above `startCombat`:

```js
const AVOID_NOTICE_PACK = "pf2e.actionspf2e";
const AVOID_NOTICE_SLUG = "avoid-notice";

/**
 * Temporarily sets up each party actor to roll Stealth for initiative and
 * be recognized by pf2e-avoid-notice as avoiding notice (#616) -- grants
 * the real "Avoid Notice" item (unless the actor already owns one) and
 * points `system.exploration` at it, forces `system.initiative.statistic`
 * to "stealth". Returns one revert record per actor; `revertAvoidNotice`
 * undoes exactly this and nothing else.
 */
async function grantAvoidNotice(partyActors) {
  const records = [];
  for (const actor of partyActors) {
    const originalExploration = foundry.utils.deepClone(
      actor.system.exploration ?? [],
    );
    const originalInitiativeStatistic = actor.system.initiative?.statistic ?? null;

    let avoidNoticeId = actor.itemTypes.action.find(
      (i) => i.system.slug === AVOID_NOTICE_SLUG,
    )?.id;
    let createdItemId = null;
    if (!avoidNoticeId) {
      const pack = game.packs.get(AVOID_NOTICE_PACK);
      const idx = await pack.getIndex({ fields: ["type"] });
      const entry = idx.find((e) => e.name === "Avoid Notice");
      const source = await pack.getDocument(entry._id);
      const [created] = await actor.createEmbeddedDocuments("Item", [
        source.toObject(),
      ]);
      avoidNoticeId = created.id;
      createdItemId = created.id;
    }

    await actor.update({
      "system.exploration": [avoidNoticeId],
      "system.initiative.statistic": "stealth",
    });

    records.push({
      actor,
      originalExploration,
      originalInitiativeStatistic,
      createdItemId,
    });
  }
  return records;
}

/** Undoes exactly what grantAvoidNotice did, per actor -- always run in a
 * `finally`, regardless of whether the surprise check itself succeeded. */
async function revertAvoidNotice(records) {
  for (const { actor, originalExploration, originalInitiativeStatistic, createdItemId } of records) {
    await actor.update({
      "system.exploration": originalExploration,
      "system.initiative.statistic": originalInitiativeStatistic,
    });
    if (createdItemId) {
      await actor.deleteEmbeddedDocuments("Item", [createdItemId]);
    }
  }
}
```

- [ ] **Step 3: Live-verify with `foundry-rest`**

```bash
cat > /tmp/verify-grant-avoid-notice.js <<'EOF'
// Read-only-safe round trip: grant, inspect, revert, confirm restored.
const actor = game.actors.party?.members?.[0];
if (!actor) return { error: "no party member found" };

const beforeExploration = foundry.utils.deepClone(actor.system.exploration ?? []);
const beforeStatistic = actor.system.initiative?.statistic ?? null;
const beforeOwnsAvoidNotice = actor.itemTypes.action.some((i) => i.system.slug === "avoid-notice");

// Inline the exact grant/revert logic this task adds (import is not
// reachable from a foundry-rest script, which can't `import`).
const pack = game.packs.get("pf2e.actionspf2e");
const idx = await pack.getIndex({ fields: ["type"] });
const entry = idx.find((e) => e.name === "Avoid Notice");
const source = await pack.getDocument(entry._id);
let avoidNoticeId = actor.itemTypes.action.find((i) => i.system.slug === "avoid-notice")?.id;
let createdItemId = null;
if (!avoidNoticeId) {
  const [created] = await actor.createEmbeddedDocuments("Item", [source.toObject()]);
  avoidNoticeId = created.id;
  createdItemId = created.id;
}
await actor.update({ "system.exploration": [avoidNoticeId], "system.initiative.statistic": "stealth" });

const duringExploration = foundry.utils.deepClone(actor.system.exploration ?? []);
const duringStatistic = actor.system.initiative?.statistic ?? null;

await actor.update({ "system.exploration": beforeExploration, "system.initiative.statistic": beforeStatistic });
if (createdItemId) await actor.deleteEmbeddedDocuments("Item", [createdItemId]);

const afterExploration = foundry.utils.deepClone(actor.system.exploration ?? []);
const afterStatistic = actor.system.initiative?.statistic ?? null;
const afterOwnsAvoidNotice = actor.itemTypes.action.some((i) => i.system.slug === "avoid-notice");

return {
  beforeExploration, beforeStatistic, beforeOwnsAvoidNotice,
  duringExploration, duringStatistic,
  afterExploration, afterStatistic, afterOwnsAvoidNotice,
  restoredCorrectly: JSON.stringify(afterExploration) === JSON.stringify(beforeExploration)
    && afterStatistic === beforeStatistic
    && afterOwnsAvoidNotice === beforeOwnsAvoidNotice,
};
EOF
.claude/skills/foundry-rest/foundry-exec.sh /tmp/verify-grant-avoid-notice.js
rm /tmp/verify-grant-avoid-notice.js
```

Expected: `duringStatistic: "stealth"`, `duringExploration` is exactly `[avoidNoticeId]`, and `restoredCorrectly: true`. Also manually re-run this against a party member who, before starting, already owns a real Avoid Notice item (temporarily grant one by hand first) to confirm `createdItemId` stays `null` and the pre-existing item is never deleted.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "feat(#616): add grantAvoidNotice/revertAvoidNotice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the surprise check into `startCombat`

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`startCombat`, between `createEmbeddedDocuments("Combatant", ...)` and `rollInitiative`, and between `startCombat()` and `return combat`)
- Modify: `scripts/module.mjs` (new `surpriseCheckDelayMs` world setting)

**Interfaces:**
- Consumes: `grantAvoidNotice`/`revertAvoidNotice` (Task 2), `determinePartySurprise` (Task 1), `readPacingSetting` (already imported from `./token-walk.mjs`).
- Produces: `flags["pf2e-dungeon-crawl"].surprised = true` on hostile combatants — consumed by Task 4.

No unit test: real Combat/Combatant document glue. Verified live in Step 3.

- [ ] **Step 1: Add the new world setting**

In `scripts/module.mjs`, add directly after the existing `actionPaceDelayMs` registration:

```js
  game.settings.register(MODULE_ID, "surpriseCheckDelayMs", {
    name: "PF2EDC.Settings.SurpriseCheckDelayMs.Name",
    hint: "PF2EDC.Settings.SurpriseCheckDelayMs.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 5000, step: 100 },
    default: 1000,
  });
```

Add the matching `lang/en.json` keys (placed alphabetically near the existing `PF2EDC.Settings.*` keys — re-check the file fresh for the exact current surrounding keys before inserting):

```json
"PF2EDC.Settings.SurpriseCheckDelayMs.Hint": "Milliseconds to wait after combat starts before checking whether the party achieved surprise, giving the Avoid Notice module's own async processing time to finish.",
"PF2EDC.Settings.SurpriseCheckDelayMs.Name": "Surprise check delay after combat starts (ms)",
```

- [ ] **Step 2: Wire the check into `startCombat`**

In `scripts/dungeon-combat.mjs`, add this constant near the existing `ACTION_PACE_DELAY_MS`:

```js
const SURPRISE_CHECK_DELAY_MS = 1000;
const surpriseCheckDelayMs = () =>
  readPacingSetting("surpriseCheckDelayMs", SURPRISE_CHECK_DELAY_MS);
```

Change `startCombat` from:

```js
  const combatants = await combat.createEmbeddedDocuments(
    "Combatant",
    tokens.map((t) => ({
      tokenId: t.id,
      sceneId: scene.id,
      ...(isAgentEligible(t.actor?.id, partyIds, aiControlledIds)
        ? { flags: { [MODULE_ID]: { agentControlled: true } } }
        : {}),
    })),
  );
  await combat.rollInitiative(
    combatants.map((c) => c.id),
    { skipDialog: true },
  );
  await combat.startCombat();
  unpauseIfGmLessRun(scene.id);
  return combat;
}
```

to:

```js
  const combatants = await combat.createEmbeddedDocuments(
    "Combatant",
    tokens.map((t) => ({
      tokenId: t.id,
      sceneId: scene.id,
      ...(isAgentEligible(t.actor?.id, partyIds, aiControlledIds)
        ? { flags: { [MODULE_ID]: { agentControlled: true } } }
        : {}),
    })),
  );

  const partyCombatantActors = combatants
    .filter((c) => partyIds.has(c.actor?.id))
    .map((c) => c.actor)
    .filter((a) => !!a);
  const hostileCombatants = combatants.filter((c) => !partyIds.has(c.actor?.id));
  const avoidNoticeRecords = await grantAvoidNotice(partyCombatantActors);

  try {
    await combat.rollInitiative(
      combatants.map((c) => c.id),
      { skipDialog: true },
    );
    await combat.startCombat();
    await new Promise((resolve) => setTimeout(resolve, surpriseCheckDelayMs()));

    const conditionSlugs = partyCombatantActors.map(
      (actor) =>
        actor.itemTypes.condition.find((c) =>
          ["unnoticed", "undetected", "hidden", "observed"].includes(c.system.slug),
        )?.system.slug ?? null,
    );
    if (determinePartySurprise(conditionSlugs)) {
      await Promise.all(
        hostileCombatants.map((c) =>
          c.setFlag(MODULE_ID, "surprised", true),
        ),
      );
    }
  } finally {
    await revertAvoidNotice(avoidNoticeRecords);
  }

  unpauseIfGmLessRun(scene.id);
  return combat;
}
```

Add the two new imports at the top of `scripts/dungeon-combat.mjs`:

```js
import { determinePartySurprise } from "./surprise-round.mjs";
```

- [ ] **Step 3: Live-verify with `foundry-rest`**

With `pf2e-avoid-notice` active (Task 2), start a real dungeon run with a combat room built, open its door (triggering `startCombatForRoom` → `startCombat`), and confirm:

```bash
echo 'const combat = game.combats.active; return combat ? combat.combatants.contents.map(c => ({name: c.name, isParty: game.actors.party.members.some(m => m.id === c.actor?.id), surprised: c.getFlag("pf2e-dungeon-crawl", "surprised") ?? false, condition: c.actor?.itemTypes.condition.map(i => i.system.slug) ?? []})) : "no active combat";' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: every hostile combatant shows `surprised: true` and every party member shows `isParty: true` with a `condition` array containing one of `unnoticed`/`undetected`/`hidden` (not `observed`) — in a scenario where the party realistically would have snuck up on the room. Repeat with the party positioned somewhere they'd realistically be spotted (e.g. right next to a hostile with a high Perception modifier) and confirm `surprised: false` on every hostile and at least one party member shows `observed`. In both cases, immediately after, confirm every party actor's `system.exploration`/`system.initiative.statistic` were actually reverted (reuse Task 2's own verification script's read-back pattern against the real actors involved) — the live run is the integration test that Task 2's isolated revert check didn't cover: confirming the revert still happens correctly when it's wired into the full `startCombat` sequence, not just called standalone.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs lang/en.json
git commit -m "feat(#616): wire surprise-round check into startCombat

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Skip a surprised hostile's round-1 turn

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`autoPlayCombatantTurnIfDue`, directly after its existing `isDefeated` check, ~line 2972 — re-locate via your editor before editing)

**Interfaces:**
- Consumes: the `surprised` combatant flag (Task 3).
- Produces: nothing further in this plan consumes it — this is the feature's final visible behavior.

No unit test: `autoPlayCombatantTurnIfDue` has no existing unit-test harness anywhere in this codebase (it reads `combat.combatant`, calls `combat.nextTurn()`, and dispatches into the live agent-decision/heuristic pipelines — pure Foundry-document glue throughout). Verified live in Step 2.

- [ ] **Step 1: Add the skip check**

Change `autoPlayCombatantTurnIfDue` from:

```js
  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  if (combatant.getFlag(MODULE_ID, "agentControlled")) {
```

to:

```js
  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  // #616: an unaware hostile gets no action at all during the surprise
  // round. Gating on round === 1 (rather than clearing the flag after use)
  // means this never needs to fire again once round 2 begins.
  if (combat.round === 1 && combatant.getFlag(MODULE_ID, "surprised")) {
    await combat.nextTurn();
    return;
  }

  if (combatant.getFlag(MODULE_ID, "agentControlled")) {
```

- [ ] **Step 2: Live-verify with `foundry-rest`**

Using the same surprised combat from Task 3's own live verification (or a fresh one), confirm:

```bash
echo 'const combat = game.combats.active; return { round: combat?.round, currentCombatantName: combat?.combatant?.name, currentIsSurprised: combat?.combatant?.getFlag("pf2e-dungeon-crawl", "surprised") ?? false };' | .claude/skills/foundry-rest/foundry-exec.sh
```

Run this repeatedly as the combat's automated turns proceed (or step through manually). Expected: while `round` is `1`, any combatant with `surprised: true` is skipped over without acting (its turn advances immediately — confirm via the Combat Tracker UI or by checking no strike/spell chat message was created for it); once `round` reaches `2`, that same combatant takes a normal turn. Also confirm a combatant that is both `defeated` and `surprised` is skipped via the pre-existing `isDefeated` branch (order matters only in that both branches produce the same visible result — a skipped turn — so this is a defensive check that the two conditions don't conflict, not that one visibly differs from the other).

- [ ] **Step 3: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "feat(#616): skip a surprised hostile's round-1 turn

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Declare the dependency and document it

**Files:**
- Modify: `module.json` (new `relationships.requires` entry)
- Modify: `README.md` (Install section)

**Interfaces:** None.

- [ ] **Step 1: Confirm the real installed version**

```bash
echo 'return game.modules.get("pf2e-avoid-notice")?.version ?? null;' | .claude/skills/foundry-rest/foundry-exec.sh
```

Use whatever this returns as the `compatibility.minimum` value below (do not guess a version string).

- [ ] **Step 2: Add the module.json dependency**

Change `module.json`'s `relationships` object from:

```json
  "relationships": {
    "systems": [
      {
        "id": "pf2e",
        "type": "system",
        "compatibility": { "minimum": "6.0.0" }
      }
    ]
  },
```

to:

```json
  "relationships": {
    "systems": [
      {
        "id": "pf2e",
        "type": "system",
        "compatibility": { "minimum": "6.0.0" }
      }
    ],
    "requires": [
      {
        "id": "pf2e-avoid-notice",
        "type": "module",
        "compatibility": { "minimum": "<version from Step 1>" }
      }
    ]
  },
```

- [ ] **Step 3: Update the README**

Change `README.md`'s Install section from:

```markdown
Requires the `pf2e` system (minimum v6.0.0) and Foundry v14. No other
module is required.
```

to:

```markdown
Requires the `pf2e` system (minimum v6.0.0), Foundry v14, and the
[PF2e Avoid Notice](https://foundryvtt.com/packages/pf2e-avoid-notice)
module (used to resolve whether the party achieves surprise when a
combat room's door opens — see #616). Foundry's own dependency
resolution will prompt to install it automatically.
```

- [ ] **Step 4: Commit**

```bash
git add module.json README.md
git commit -m "docs(#616): declare the pf2e-avoid-notice dependency

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

Apply a **minor** bump (new cross-system dependency and a genuine new combat mechanic), e.g. `0.59.2` → `0.60.0`, using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #616 combat surprise round

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** The spec's four concrete deliverables — adopt `pf2e-avoid-notice` rather than hand-roll detection, the self-contained grant/revert sequence, the hook-timing delay, and the aggregation rule + skip-turn bridge — map onto Task 2 (grant/revert), Task 3 (delay + wiring + dependency declaration via Task 5), Task 1 (aggregation rule), and Task 4 (skip bridge). No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling," no "similar to Task N." Task 5's Step 1 explicitly tells the implementer to read a real value live rather than guessing a version string — an instruction to verify, not a placeholder for missing code.

**3. Type consistency:** `determinePartySurprise(conditionSlugs: Array<string|null>): boolean` (Task 1) is invoked with the identical shape in Task 3's wiring (`partyCombatantActors.map(...)` producing exactly that array type). `grantAvoidNotice(partyActors)`/`revertAvoidNotice(records)` (Task 2) are invoked with the identical names and argument shapes in Task 3. The `surprised` flag key and its `flags["pf2e-dungeon-crawl"]` namespace are identical between Task 3 (where it's set) and Task 4 (where it's read).

**4. Review Focus:** All five items (duplicate-Avoid-Notice-item guard, non-empty-exploration-array round-trip, revert-runs-even-after-an-error, isDefeated-vs-surprised ordering, round-2-plays-normally) each have a dedicated test or explicit live-verification step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-combat-surprise-round.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because Tasks 2-4 chain through a third-party module's undocumented real behavior with one genuinely unverified timing risk (the `combatStart` hook delay) — a fresh reviewer checking Task 3's actual live results before Task 4 builds the skip-turn behavior on top of them is worth more here than the cost of separate contexts. Does the plan capture what you want, and which approach should we use?