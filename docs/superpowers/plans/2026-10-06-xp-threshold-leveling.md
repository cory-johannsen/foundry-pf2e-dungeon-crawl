# XP Threshold And Level-Up Carry-Over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #853 — the module only ever adds XP and never reacts to a character crossing the 1,000-XP threshold or actually leveling up, leaving characters sitting at e.g. 1848/1000 XP forever.

**Owner decision (resolved this session via AskUserQuestion):** **Prompt only, never auto-raise the level.** The module flags a character as ready and announces it in chat when their XP reaches `xp.max`; the GM/player still raises the level via PF2e Leveler or manually. The XP-subtraction hook reacts to `system.details.level.value` increasing regardless of who/what raised it, so it works the same whether Leveler or a manual edit did the raising.

**Root cause (confirmed by direct code reading, `scripts/foundry-api.mjs:659-676`, current `main`):** `grantPartyXp` unconditionally does `xp.value + totalXp` and nothing else — no code anywhere in the module reads `xp.max`, flags a character as ready, or reacts to a level increase. PF2e itself does not auto-level or subtract (confirmed per the issue's own text and this project's own "PF2e rules are the source of truth" CLAUDE.md section) — in PF2e RAW, every level costs exactly 1,000 XP and earned XP past that threshold carries over to the next level, uncapped (so a jump of several levels' worth of earned XP, while unusual, must still carry over the right multiple of 1,000, not just a flat one).

**Architecture:** Two independent, composable pieces:
1. **Ready-to-level announcement** — added inline to `grantPartyXp` (the only place `xp.value` ever increases), since that is exactly where crossing the threshold is naturally observable. A per-character flag (`readyToLevelUp`) makes the chat announcement fire once per threshold-crossing, not on every subsequent XP grant while still unleveled.
2. **XP carry-over subtraction** — a new `scripts/dungeon-leveling.mjs`, wired into the existing shared `Hooks.on("updateActor", ...)` dispatcher in `scripts/module.mjs` (matching the established one-handler/many-named-functions pattern `autoDefeatZeroHpNpcs` already uses there). Reacts whenever `changes.system.details.level.value` increases, subtracts `xp.max * levelsGained` (never negative), clears the `readyToLevelUp` flag, and records the level it last processed (`xpSubtractedThroughLevel`) so a later, unrelated actor update can never re-fire the subtraction for a level change already handled.

**Tech Stack:** Vanilla ES modules, Vitest, Foundry VTT hooks.

**Spec:** None — a bounded bug fix with one owner decision already resolved above.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real behavioral fix, contained to one new file plus two existing call sites: patch bump.
- Adding `scripts/dungeon-leveling.mjs` and wiring it into `scripts/module.mjs` rewires a `scripts/` file's imports — CLAUDE.md requires running the `update-architecture-docs` skill in the same pass (Task 3).
- Per PF2e RAW (CLAUDE.md's own "Game rules" section: PF2e rules are the source of truth), every level costs a flat 1,000 XP (`xp.max`, read dynamically, never hardcoded) and carry-over is uncapped — the subtraction must scale with however many levels were actually gained in one update (`xp.max * levelsGained`), not an assumed flat `1000`.
- The module **never auto-raises a character's level** (the owner's own resolved decision, above) — `system.details.level.value` is only ever read, never written, by this fix.
- The one-off live cleanup for characters already over threshold (the issue's own explicit example: 1848 → 848) is **not** performed by this plan or by the planner — CLAUDE.md: "do not touch actor data live without the owner's approval." It is a separate, explicitly gated implementation step (Task 4) that requires the owner's go-ahead at execution time, immediately before it runs against the real live world.

## Review Focus

- **A character whose XP reaches or exceeds `xp.max` from a single grant must be flagged and announced exactly once**, not re-announced on every subsequent XP grant while they remain unleveled.
- **A multi-level jump in one `updateActor` event (an uncommon but real PF2e possibility — a large XP grant followed by Leveler applying several levels in one update, or a manual multi-level edit) must subtract `xp.max` once per level gained, not just once** — the issue's own text only describes a single-level case, but the fix must not silently assume levels always change one at a time.
- **The subtraction must never run twice for the same level change** — a later, unrelated `updateActor` event for the same actor (e.g. an HP change, an item grant) must not re-subtract, since `changes` on that later event never carries `system.details.level.value` and the stored `xpSubtractedThroughLevel` flag guards against any re-processing of an already-handled level.
- **`xp.value` must never go negative** — a character leveled up through some other means (not this module's own grant) with less accumulated XP than a full `xp.max` per level must clamp to 0, not underflow.
- **An NPC actor's `updateActor`/XP changes must never be touched** — both the ready-flag and the subtraction logic are gated on `actor.type === "character"`, matching `grantPartyXp`'s own existing party filter.

---

### Task 1: Ready-to-level-up flag and chat announcement

**Files:**
- Modify: `scripts/foundry-api.mjs:659-676` (`grantPartyXp`)
- Modify: `lang/en.json` (new i18n key)
- Test: `tests/foundry-api-grant-party-xp.test.mjs`

**Interfaces:**
- Consumes: `actor.getFlag(MODULE_ID, key)` / `actor.setFlag(MODULE_ID, key, value)` (standard Foundry Actor API, already used elsewhere in this codebase — e.g. `scripts/dungeon-combat.mjs`'s own hook-registered functions).
- Produces: no signature change to `grantPartyXp(totalXp, source)` — purely additive internal behavior.

- [ ] **Step 1: Extend the test fixture and write the failing tests**

The existing `member()` helper (confirmed current, `tests/foundry-api-grant-party-xp.test.mjs:6-15`) has no `xp.max` and no flag methods. Change it to:

```js
function member(id, type = "character", xp = 0, max = 1000) {
  const flags = {};
  return {
    id,
    type,
    system: { details: { xp: { value: xp, max } } },
    update: vi.fn(async function (changes) {
      this.system.details.xp.value = changes["system.details.xp.value"];
    }),
    getFlag: (_m, k) => flags[k],
    setFlag: vi.fn(async function (_m, k, v) {
      flags[k] = v;
    }),
  };
}
```

Add to the `describe("grantPartyXp announcement (#626, #782)", ...)` block:

```js
describe("#853 grantPartyXp flags a character ready to level up at the XP threshold", () => {
  beforeEach(() => install([]));

  it("flags and announces once a character's XP reaches xp.max", async () => {
    const a = member("a", "character", 960, 1000);
    install([a]);
    await makeFoundryApi().grantPartyXp(40, "combat");
    expect(a.system.details.xp.value).toBe(1000);
    expect(a.setFlag).toHaveBeenCalledWith("pf2e-dungeon-crawl", "readyToLevelUp", true);
    expect(chat).toHaveLength(2); // the existing XpAwarded message, plus the new ready-to-level one
    expect(chat[1].content).toContain("PF2EDC.Dungeon.ReadyToLevelUp");
  });

  it("does not re-announce on a later grant while still unleveled", async () => {
    const a = member("a", "character", 1000, 1000); // already over, already flagged from a prior grant
    a.getFlag = (_m, k) => (k === "readyToLevelUp" ? true : undefined);
    install([a]);
    await makeFoundryApi().grantPartyXp(50, "combat");
    expect(a.setFlag).not.toHaveBeenCalled();
    expect(chat).toHaveLength(1); // only the XpAwarded message
  });

  it("does not flag a character still under the threshold", async () => {
    const a = member("a", "character", 100, 1000);
    install([a]);
    await makeFoundryApi().grantPartyXp(40, "combat");
    expect(a.setFlag).not.toHaveBeenCalled();
    expect(chat).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/foundry-api-grant-party-xp.test.mjs`
Expected: FAIL — `grantPartyXp` never calls `setFlag` or posts a second chat message today.

- [ ] **Step 3: Add the i18n key**

In `lang/en.json`, alongside the existing `PF2EDC.Dungeon.XpAwarded`/`XpSource.*` keys (confirmed current, lines 116-121):

```json
  "PF2EDC.Dungeon.ReadyToLevelUp": "{names} reached enough XP to level up!",
```

- [ ] **Step 4: Fix `grantPartyXp`**

Change (confirmed current, `scripts/foundry-api.mjs:659-676`):

```js
    async grantPartyXp(totalXp, source = null) {
      const party = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      for (const member of party) {
        await member.update({
          "system.details.xp.value":
            (member.system.details.xp.value ?? 0) + totalXp,
        });
      }
      if (party.length === 0) return;
      await ChatMessage.create({
        content: game.i18n.format("PF2EDC.Dungeon.XpAwarded", {
          source: game.i18n.localize(`PF2EDC.Dungeon.XpSource.${source ?? "other"}`),
          total: totalXp,
        }),
      });
    },
```

to:

```js
    async grantPartyXp(totalXp, source = null) {
      const party = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      const readyNow = [];
      for (const member of party) {
        const newXp = (member.system.details.xp.value ?? 0) + totalXp;
        await member.update({ "system.details.xp.value": newXp });
        // #853: flag once per threshold-crossing -- never re-announced on a
        // later grant while the character remains unleveled (the module
        // never auto-levels; see dungeon-leveling.mjs for the subtraction
        // that fires once Leveler/a GM actually raises the level).
        const xpMax = member.system.details.xp?.max ?? 1000;
        if (newXp >= xpMax && !member.getFlag(MODULE_ID, "readyToLevelUp")) {
          await member.setFlag(MODULE_ID, "readyToLevelUp", true);
          readyNow.push(member.name);
        }
      }
      if (party.length === 0) return;
      await ChatMessage.create({
        content: game.i18n.format("PF2EDC.Dungeon.XpAwarded", {
          source: game.i18n.localize(`PF2EDC.Dungeon.XpSource.${source ?? "other"}`),
          total: totalXp,
        }),
      });
      if (readyNow.length) {
        await ChatMessage.create({
          content: game.i18n.format("PF2EDC.Dungeon.ReadyToLevelUp", {
            names: readyNow.join(", "),
          }),
        });
      }
    },
```

Check whether `MODULE_ID` is already defined/imported in `scripts/foundry-api.mjs` (`grep -n "MODULE_ID" scripts/foundry-api.mjs`); if not, add the same local `const MODULE_ID = "pf2e-dungeon-crawl";` convention every sibling file in this codebase already uses (e.g. `scripts/room-feature-tokens.mjs:15`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/foundry-api-grant-party-xp.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/foundry-api.mjs lang/en.json tests/foundry-api-grant-party-xp.test.mjs
git commit -m "feat(#853): flag and announce a character ready to level up at the XP threshold

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Subtract XP carry-over when a level actually increases

**Files:**
- Create: `scripts/dungeon-leveling.mjs`
- Modify: `scripts/module.mjs` (wire into the existing shared `updateActor` hook)
- Test: `tests/dungeon-leveling.test.mjs`

**Interfaces:**
- Produces: `export async function subtractXpOnLevelUp(actor, changes)` — called from `scripts/module.mjs`'s existing `Hooks.on("updateActor", ...)`, matching the exact calling convention `autoDefeatZeroHpNpcs(actor)` already uses there (confirmed current, `scripts/module.mjs:615-618`).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { subtractXpOnLevelUp } from "../scripts/dungeon-leveling.mjs";

function actor({ type = "character", level = 2, xp = 1848, max = 1000, flags = {} } = {}) {
  const a = {
    type,
    system: { details: { level: { value: level }, xp: { value: xp, max } } },
    getFlag: (_m, k) => flags[k],
    update: async function (changes) {
      Object.assign(a._lastUpdate = {}, changes);
      if ("system.details.xp.value" in changes) a.system.details.xp.value = changes["system.details.xp.value"];
      for (const [k, v] of Object.entries(changes)) {
        const m = /^flags\.pf2e-dungeon-crawl\.(.+)$/.exec(k);
        if (m) flags[m[1]] = v;
      }
    },
  };
  return a;
}

describe("#853 subtractXpOnLevelUp", () => {
  it("subtracts one xp.max on a single level increase, carry-over remains", async () => {
    const a = actor({ level: 2, xp: 1848, max: 1000 });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a.system.details.xp.value).toBe(848);
  });

  it("subtracts xp.max per level on a multi-level jump in one update", async () => {
    const a = actor({ level: 3, xp: 2500, max: 1000, flags: { xpSubtractedThroughLevel: 1 } });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 3 } } } });
    expect(a.system.details.xp.value).toBe(500); // 2500 - 1000*2
  });

  it("clamps to 0, never negative", async () => {
    const a = actor({ level: 2, xp: 400, max: 1000 });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a.system.details.xp.value).toBe(0);
  });

  it("clears the readyToLevelUp flag and records the handled level", async () => {
    const a = actor({ level: 2, xp: 1200, max: 1000, flags: { readyToLevelUp: true } });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a.getFlag("pf2e-dungeon-crawl", "readyToLevelUp")).toBe(false);
    expect(a.getFlag("pf2e-dungeon-crawl", "xpSubtractedThroughLevel")).toBe(2);
  });

  it("is a no-op when changes has no level field (an unrelated actor update)", async () => {
    const a = actor({ level: 2, xp: 1848 });
    let updated = false;
    a.update = async () => { updated = true; };
    await subtractXpOnLevelUp(a, { system: { attributes: { hp: { value: 10 } } } });
    expect(updated).toBe(false);
  });

  it("is a no-op for an already-handled level (no re-subtraction on a later, unrelated update)", async () => {
    const a = actor({ level: 2, xp: 848, flags: { xpSubtractedThroughLevel: 2 } });
    let updated = false;
    a.update = async () => { updated = true; };
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(updated).toBe(false);
  });

  it("ignores a non-character actor", async () => {
    const a = actor({ type: "npc", level: 2, xp: 1848 });
    let updated = false;
    a.update = async () => { updated = true; };
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(updated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-leveling.test.mjs`
Expected: FAIL — `scripts/dungeon-leveling.mjs` does not exist yet.

- [ ] **Step 3: Write `scripts/dungeon-leveling.mjs`**

```js
const MODULE_ID = "pf2e-dungeon-crawl";

/**
 * #853: PF2e itself never subtracts XP or auto-levels. Reacts to
 * `system.details.level.value` increasing (raised by PF2e Leveler or a
 * manual GM edit -- this module never auto-levels, per the owner's own
 * decision on #853) and subtracts `xp.max` once per level actually
 * gained, carry-over remaining, clamped at 0. `xpSubtractedThroughLevel`
 * (a flag on the actor) records the highest level this has already run
 * for, so a later, unrelated updateActor event (an HP change, an item
 * grant -- anything whose own `changes` carries no level field, or whose
 * level was already handled) can never re-trigger the subtraction.
 */
export async function subtractXpOnLevelUp(actor, changes) {
  if (actor.type !== "character") return;
  const newLevel = changes?.system?.details?.level?.value;
  if (newLevel === undefined) return;
  const lastHandled = actor.getFlag(MODULE_ID, "xpSubtractedThroughLevel") ?? newLevel - 1;
  const levelsGained = newLevel - lastHandled;
  if (levelsGained <= 0) return;
  const xpValue = actor.system.details.xp?.value ?? 0;
  const xpMax = actor.system.details.xp?.max ?? 1000;
  await actor.update({
    "system.details.xp.value": Math.max(0, xpValue - xpMax * levelsGained),
    [`flags.${MODULE_ID}.xpSubtractedThroughLevel`]: newLevel,
    [`flags.${MODULE_ID}.readyToLevelUp`]: false,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-leveling.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire into the shared `updateActor` hook**

In `scripts/module.mjs`, add to the import block that already brings in `autoDefeatZeroHpNpcs` (confirmed current, lines 49-63 — a new import statement, since `dungeon-leveling.mjs` is a new file, not an addition to `dungeon-combat.mjs`'s own import):

```js
import { subtractXpOnLevelUp } from "./dungeon-leveling.mjs";
```

Change (confirmed current, `scripts/module.mjs:615-618`):

```js
Hooks.on("updateActor", async (actor) => {
  await autoDefeatZeroHpNpcs(actor);
  onCombatAutoResolved(await maybeResolveCombatForActor(actor));
});
```

to:

```js
Hooks.on("updateActor", async (actor, changes) => {
  await autoDefeatZeroHpNpcs(actor);
  onCombatAutoResolved(await maybeResolveCombatForActor(actor));
  await subtractXpOnLevelUp(actor, changes);
});
```

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS across the board.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-leveling.mjs scripts/module.mjs tests/dungeon-leveling.test.mjs
git commit -m "feat(#853): subtract XP carry-over when a character's level increases

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Architecture docs

- [ ] **Step 1: Run the `update-architecture-docs` skill**

CLAUDE.md requires this in the same pass as any merge that adds, removes, or rewires a `scripts/` file's imports — this plan adds `scripts/dungeon-leveling.mjs` and adds an import to `scripts/module.mjs`. Invoke the `update-architecture-docs` skill now and commit its output (likely `docs/architecture.md`) in this same task.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(#853): refresh architecture docs for dungeon-leveling.mjs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: One-off live cleanup (owner-gated, not performed by this plan's own author)

This task touches real actor data in the live world. CLAUDE.md: "do not touch actor data live without the owner's approval." The implementer must get the owner's explicit go-ahead immediately before running this, separately from this plan's own approval — planning and writing the fix is not approval to run it against live data.

- [ ] **Step 1: Get the owner's explicit go-ahead to run this against the live world**

Confirm which characters are currently over-threshold and by how much, and get an explicit yes before writing anything.

```bash
echo 'const party = (game.actors?.party?.members ?? []).filter(m => m.type === "character"); return party.map(m => ({ id: m.id, name: m.name, level: m.system.details.level.value, xp: m.system.details.xp.value, max: m.system.details.xp.max }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

- [ ] **Step 2: Apply the carry-over subtraction to each already-over character, once approved**

For a character already at level N with `xp.value` reflecting K full thresholds already crossed before this fix shipped (the issue's own example: level 2, 1848 XP, one threshold already crossed, 1000 unsubtracted) — set `xp.value` to `xp.value - xp.max * K` and set `flags.pf2e-dungeon-crawl.xpSubtractedThroughLevel` to their current level, so this fix's own hook never re-fires for a level change that already happened before the module could see it. Confirm `K` per character from Step 1's own output (do not assume every character needs exactly one subtraction — check each one's actual numbers).

```bash
echo 'const updates = [/* fill in from Step 1 output: {id, newXp, level} per character needing cleanup */]; const results = []; for (const u of updates) { const a = game.actors.get(u.id); await a.update({ "system.details.xp.value": u.newXp, "flags.pf2e-dungeon-crawl.xpSubtractedThroughLevel": u.level }); results.push({ id: u.id, name: a.name, newXp: a.system.details.xp.value }); } return results;' | .claude/skills/foundry-rest/foundry-exec.sh
```

- [ ] **Step 3: Verify**

Re-run Step 1's own read-only query and confirm every previously-over character now shows the correct carried-over `xp.value`.

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a contained bug fix), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#853): bump version for the XP threshold and level-up fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** Every bullet in #853's own "Expected" section is covered: flag + chat on reaching `xp.max` (Task 1), subtract on level increase guarded to fire once and never go negative (Task 2), the owner decision on auto-raise-vs-prompt resolved and recorded (prompt only, per this session's own AskUserQuestion), and the one-off live cleanup scoped as its own explicitly-gated task (Task 4) rather than silently folded into the code fix.

**2. Placeholder scan:** No TBD. Task 4's own cleanup script has one explicit, honest placeholder comment (`/* fill in from Step 1 output */`) — this is correct, not a plan failure, since the real values can only come from Step 1's own live read against the actual current world state, not from this plan written in advance of that read.

**3. Type consistency:** `subtractXpOnLevelUp(actor, changes)`'s own signature matches exactly how `scripts/module.mjs`'s existing hook already calls its sibling functions (`autoDefeatZeroHpNpcs(actor)`, `maybeResolveCombatForActor(actor)`) with the addition of `changes`, which the hook's own callback signature already receives from Foundry but previously discarded.

**4. Review Focus:** All five items (single-crossing announcement, multi-level carry-over, no double-subtraction, no negative XP, NPCs untouched) each map to a specific test in Task 1 or Task 2. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-xp-threshold-leveling.md`.
