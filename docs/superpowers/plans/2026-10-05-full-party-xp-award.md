# Full-Party XP Award Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #782 — grant every party character the full XP amount PF2e's own rules award, instead of splitting it across the party.

**Architecture:** One function, `grantPartyXp` (`scripts/foundry-api.mjs`), is the single place every XP grant (combat, skill challenge, puzzle, trap) goes through. It currently divides the total via `xpPerSurvivor` (`scripts/combat-rewards.mjs`) before writing each character's `system.details.xp.value`. The values it's dividing are already PF2e's correct per-character RAW amounts — `xpFor` (`scripts/encounter-roster.mjs:58`) returns PF2e's own relative-level XP table (10/15/20/.../160), the exact table GM Core says to award in full to every PC per defeated creature or hazard. The fix removes the division; no caller and no XP value needs to change.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a one-function bug fix with a single correct resolution, no open design question. This plan implements GitHub issue #782 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). This is a routine fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- No caller of `grantPartyXp` (`dungeon-combat.mjs:370` for combat, `scripts/ui/dungeon-app.mjs:187/698/720` for trap/skillChallenge/puzzle) changes — each already passes PF2e's correct full per-character RAW amount (`totalCombatXp`'s sum of `xpFor(level - partyLevel)` per defeated hostile, or a bare `xpFor(...)` call for the other three room kinds). Per #782's own request to check this: confirmed live in this investigation — `xpFor` is PF2e's own relative-level table (`RELATIVE_XP`), not a module-invented total that assumed a later split, so no non-combat XP amount needs retuning.
- `scripts/combat-rewards.mjs`'s `totalCombatXp` is unaffected — it already computes the correct full-award sum; only the post-computation division in `grantPartyXp` is wrong.

## Review Focus

- **Every party character (not just the first, not an average) must receive the exact same full `totalXp` amount** — the fix must write `totalXp` itself to each member's `system.details.xp.value`, not a value derived from `party.length` in any way.
- **The chat announcement must stop implying a split happened** — the current string ("the party earns {total} XP ({share} each)") reads as a division statement; once `share` always equals `total`, the message must say so plainly rather than showing the same number twice.
- **A zero-member party and a zero-XP grant must both still behave exactly as today** (no announcement for an empty party; a zero grant still announces) — these aren't part of the bug, and the fix must not regress them.
- **`xpPerSurvivor` must be fully removed, not left as unused dead code** — #782 explicitly asks to replace/remove it; a partial fix that stops calling it but leaves it exported invites a future caller to reintroduce the bug.

---

### Task 1: Remove the split in `grantPartyXp`, delete `xpPerSurvivor`

**Files:**
- Modify: `scripts/foundry-api.mjs` (`grantPartyXp`, its `xpPerSurvivor` import)
- Modify: `scripts/combat-rewards.mjs` (remove `xpPerSurvivor`)
- Modify: `lang/en.json` (`PF2EDC.Dungeon.XpAwarded`)
- Test: `tests/foundry-api-grant-party-xp.test.mjs`, `tests/combat-rewards.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `grantPartyXp(totalXp, source)` now writes `totalXp` to every party character's XP directly. No other file calls `xpPerSurvivor` after this task (confirmed via this session's own repo-wide search — `scripts/combat-rewards.mjs:14` is its only definition and `scripts/foundry-api.mjs:49/664` its only use).

- [x] **Step 1: Update the failing tests first**

Replace `tests/foundry-api-grant-party-xp.test.mjs`'s five tests with:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFoundryApi } from "../scripts/foundry-api.mjs";

// #626: grantPartyXp announces what it granted. #782: PF2e awards the full
// XP total to every character, not a split.
function member(id, type = "character", xp = 0) {
  return {
    id,
    type,
    system: { details: { xp: { value: xp } } },
    update: vi.fn(async function (changes) {
      this.system.details.xp.value = changes["system.details.xp.value"];
    }),
  };
}

let chat;
function install(members) {
  chat = [];
  globalThis.game = {
    actors: { party: { members } },
    i18n: {
      localize: (k) => k,
      format: (k, d) => `${k}|${JSON.stringify(d)}`,
    },
  };
  globalThis.ChatMessage = { create: vi.fn(async (d) => chat.push(d)) };
}

describe("grantPartyXp announcement (#626, #782)", () => {
  beforeEach(() => install([]));

  it("grants the full total to every party character, not a split", async () => {
    const a = member("a");
    const b = member("b");
    install([a, b, member("npc", "npc")]);
    await makeFoundryApi().grantPartyXp(40, "skillChallenge");
    expect(a.system.details.xp.value).toBe(40);
    expect(b.system.details.xp.value).toBe(40);
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toBe(
      'PF2EDC.Dungeon.XpAwarded|{"source":"PF2EDC.Dungeon.XpSource.skillChallenge","total":40}',
    );
  });

  it("grants the same full total regardless of party size", async () => {
    install([member("a"), member("b"), member("c")]);
    await makeFoundryApi().grantPartyXp(10, "combat");
    expect(chat[0].content).toContain('"total":10');
  });

  it("still announces a zero grant (e.g. a victory over nothing actually defeated)", async () => {
    install([member("a"), member("b")]);
    await makeFoundryApi().grantPartyXp(0, "combat");
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toContain('"total":0');
  });

  it("does nothing, and says nothing, with no party characters", async () => {
    install([member("npc", "npc")]);
    await makeFoundryApi().grantPartyXp(40, "trap");
    expect(chat).toHaveLength(0);
  });

  it("an unknown or missing source still posts, without throwing", async () => {
    install([member("a")]);
    await expect(makeFoundryApi().grantPartyXp(5)).resolves.not.toThrow();
    expect(chat).toHaveLength(1);
  });
});
```

Remove `tests/combat-rewards.test.mjs`'s `describe('xpPerSurvivor', ...)` block (lines 22-34) and its now-unused `xpPerSurvivor` import on line 2 (keep `totalCombatXp`).

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/foundry-api-grant-party-xp.test.mjs`
Expected: FAIL — `a.system.details.xp.value`/`b.system.details.xp.value` are still `20` (40 split two ways), and the chat content still includes a `"share"` field.

- [x] **Step 3: Remove `xpPerSurvivor`**

In `scripts/combat-rewards.mjs`, delete:

```js
export function xpPerSurvivor(totalXp, partySize) {
  return partySize > 0 ? Math.floor(totalXp / partySize) : 0;
}
```

- [x] **Step 4: Stop dividing in `grantPartyXp`**

In `scripts/foundry-api.mjs`, remove the now-dead import:

```js
import { xpPerSurvivor } from "./combat-rewards.mjs";
```

Change `grantPartyXp` (currently):

```js
    async grantPartyXp(totalXp, source = null) {
      const party = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      const share = xpPerSurvivor(totalXp, party.length);
      for (const member of party) {
        await member.update({
          "system.details.xp.value":
            (member.system.details.xp.value ?? 0) + share,
        });
      }
      if (party.length === 0) return;
      await ChatMessage.create({
        content: game.i18n.format("PF2EDC.Dungeon.XpAwarded", {
          source: game.i18n.localize(`PF2EDC.Dungeon.XpSource.${source ?? "other"}`),
          total: totalXp,
          share,
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

Update its doc comment immediately above (currently describes the removed split):

```js
     * resolveCombat, extracted here so combat and the non-combat room kinds
     * (skill challenge, puzzle, trap) all go through one place instead of
     * three duplicated copies of this loop.
     *
     * #626: announces the grant in chat -- `source` (`combat`,
     * `skillChallenge`, `puzzle` or `trap`) names where it came from, and
     * the line states the total and the actual per-character share (an
     * uneven total floors, so share * party size can be less than total).
     * A zero grant is announced too. Says nothing with no party characters.
     */
```

to:

```js
     * resolveCombat, extracted here so combat and the non-combat room kinds
     * (skill challenge, puzzle, trap) all go through one place instead of
     * three duplicated copies of this loop.
     *
     * #626/#782: announces the grant in chat -- `source` (`combat`,
     * `skillChallenge`, `puzzle` or `trap`) names where it came from. PF2e
     * awards an encounter's full XP to every character, not a split
     * (#782) -- `totalXp` is added to each party character's own XP
     * unchanged. A zero grant is announced too. Says nothing with no party
     * characters.
     */
```

- [x] **Step 5: Update the locale string**

In `lang/en.json`, change:

```json
  "PF2EDC.Dungeon.XpAwarded": "{source}: the party earns {total} XP ({share} each).",
```

to:

```json
  "PF2EDC.Dungeon.XpAwarded": "{source}: each party member earns {total} XP.",
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/foundry-api-grant-party-xp.test.mjs tests/combat-rewards.test.mjs`
Expected: PASS, all tests green.

- [x] **Step 7: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — in particular `tests/dungeon-combat-auto-defeat.test.mjs` (the other file this session's search found referencing `grantPartyXp`) stays green, since it exercises `resolveCombat`'s call site, not the division logic itself.

- [x] **Step 8: Commit**

```bash
git add scripts/foundry-api.mjs scripts/combat-rewards.mjs lang/en.json tests/foundry-api-grant-party-xp.test.mjs tests/combat-rewards.test.mjs
git commit -m "fix(#782): award the full XP total to every party character

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live verification, version bump

**Files:**
- Modify: `module.json`

No code changes in this task — verification and the version bump only.

- [ ] **Step 1: Live-verify via `foundry-rest`**

With a real party in a live world, run a short combat (or read back a recent one) and confirm every character's `system.details.xp.value` increased by the full `totalCombatXp` amount, not a fraction of it — e.g., a 2-PC party defeating a single at-level hostile (`xpFor(0)` = 40 XP) should show **both** characters gaining 40, not 20 each. Also trigger (or inspect a recent) trap/skill-challenge/puzzle resolution and confirm the chat card now reads "each party member earns N XP" with no second number.

```bash
echo 'const party = (game.actors?.party?.members ?? []).filter(m => m.type === "character"); return party.map(c => ({ name: c.name, xp: c.system.details.xp.value }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

- [x] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (routine fix), using whatever the fetch above shows as current.

- [x] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#782): bump version for full-party XP fix

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #782's own ask (grant full XP to every character; replace/remove `xpPerSurvivor`; update its tests; check whether non-combat amounts were tuned assuming a split) is fully covered: Task 1 removes the function and the division, updates both affected test files, and the Global Constraints section records the live confirmation that `xpFor`'s values are PF2e's own RAW per-character table, needing no retuning. #782's own "implement after or together" note on #626 is moot — #626 is already closed/merged (confirmed this session), so no sequencing is needed.

**2. Placeholder scan:** No TBD/TODO. Every code block shown is the complete real change, not a description of one.

**3. Type consistency:** `grantPartyXp(totalXp, source)`'s signature is unchanged (no caller needs touching); the only removed symbol, `xpPerSurvivor`, has exactly one other reference anywhere in the repo (its own import in `foundry-api.mjs`), both removed together in Task 1.

**4. Review Focus:** All four items (every member gets the identical full total, the chat message stops implying a split, zero-party/zero-grant behavior is preserved, `xpPerSurvivor` is fully deleted not just unused) are each pinned by a specific test or step in Task 1. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-full-party-xp-award.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because this is a tiny, fully-scoped one-function fix with a single correct resolution and no cross-task interface risk — independent subagents have nothing to diverge on here. Does the plan capture what you want, and which approach should we use?
