# Apply the DamageRoll.alter() Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make crit-deck "Triple damage" on a Strike crit and the #79 spell-attack crit scaling actually reach `applyDamage`, by applying the roll `DamageRoll#alter()` returns instead of discarding it (#1289).

**Architecture:** `DamageRoll#alter(m, a)` on an evaluated roll returns a NEW evaluated roll and leaves the original unchanged (verified live). Three sites in `scripts/dungeon-combat.mjs` call it as a bare statement and then apply the original roll. Each becomes `const finalRoll = <cond> ? await damageRoll.alter(...) : damageRoll`, with Shield Block and `applyDamage` using `finalRoll`. Tests get a fake `alter` that returns a distinct altered roll and assert which roll was applied; a source guard blocks discarded `alter()` results.

**Tech Stack:** Foundry VTT v14 module, ES modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-damage-roll-alter-result-design.md`

## Global Constraints

- The applied damage must equal the scaled roll: a "Triple damage" card on a Strike crit applies 3x the single roll (the roll is already 2x from `strike.critical()` after #1284, so `alter(1.5, 0)`); a spell-attack crit applies `Math.max(damageMultiplier, 2)` x the single roll. (spec Summary, Design)
- A "Double damage" card and a plain hit apply the original, unaltered roll; `alter()` is not called for them. (spec Resolved decisions 2)
- No new helper and no change to the multiplier rules; only apply the returned roll. (spec Resolved decisions 1)
- The damage chat message PF2e already posted shows the pre-scale roll; this is accepted and not fixed here. (spec Resolved decisions 4)
- Every other `alter()` caller (basic saves, `trap-combat.mjs`) already uses the returned roll; do not touch them.
- Every merge to `main` bumps `module.json` `version`; never reuse a number (`git fetch origin main` and read `origin/main:module.json` first). No imports change, so `docs/architecture.md` needs no update. (CLAUDE.md)
- Work in a git worktree off `origin/main`; `npm ci`, never symlink `node_modules`. (CLAUDE.md)

## Review Focus

- A Triple-damage card on a Strike crit: `applyDamage` receives the ALTERED roll, in both `rollAndApplyStrike` and `rollAndApplyStrikeAtVariant` (the reactive-strike path goes through the latter). (Task 1)
- Shield Block is computed from, and `applyDamage` receives, the same final roll, not the pre-scale one. (Task 1)
- A Double-damage card and a plain hit still apply the original roll with no `alter()` call. (Task 1)
- A spell-attack crit with no card still applies the doubled roll (`damageMultiplier` is 1 for a card-less crit, so `Math.max(1, 2)` scales by 2); a non-crit spell hit (`damageMultiplier` is `null`) is never altered. (Task 1)
- A future bare-statement `x.alter(...)` fails the suite. (Task 1 guard)

---

## File Structure

- Modify `scripts/dungeon-combat.mjs` (three sites, their comments).
- Modify `tests/dungeon-combat-cast-attack-spell.test.mjs`, `tests/dungeon-combat-reactive-strike.test.mjs` (fakes + assertions); fix any other test the full suite shows relying on the old behaviour.
- Create `tests/damage-roll-alter-guard.test.mjs`.
- Modify `module.json`.

---

### Task 1: Apply the altered roll at the three sites

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (near lines 5474, 7851, 8253 and the comments immediately above each)
- Test: `tests/dungeon-combat-cast-attack-spell.test.mjs`, `tests/dungeon-combat-reactive-strike.test.mjs`, `tests/damage-roll-alter-guard.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports.

- [ ] **Step 1: Write the failing guard test**

Create `tests/damage-roll-alter-guard.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// #1289: PF2e's DamageRoll#alter() returns a NEW roll and leaves the original
// untouched. A statement-position `await roll.alter(...)` throws the scaled
// roll away, so the original, unscaled roll is what gets applied.
const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const PATTERN = /^[ \t]*(?:await[ \t]+)?[\w.?]+\.alter\([^;]*\);[ \t]*$/gm;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".mjs")) yield full;
  }
}

describe("DamageRoll.alter() result is never discarded (#1289)", () => {
  it("no statement-position .alter() call in scripts/", () => {
    const hits = [];
    for (const file of walk(SCRIPTS)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(PATTERN)) {
        hits.push(`${file.slice(SCRIPTS.length)}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(hits, "use the roll alter() returns: `const finalRoll = await roll.alter(...)`").toEqual([]);
  });

  it("the pattern matches the bug shape and not the correct shapes (guard against a vacuous test)", () => {
    expect("          await damageRoll.alter(1.5, 0);".match(PATTERN)).not.toBeNull();
    expect("    damageRoll.alter(2, 0);".match(PATTERN)).not.toBeNull();
    expect("const finalRoll = await damageRoll.alter(1.5, 0);".match(PATTERN)).toBeNull();
    expect("      ? await damageRoll.alter(0.5, 0)".match(PATTERN)).toBeNull();
    expect("damage: multiplier === 1 ? damageRoll : damageRoll.alter(multiplier, 0),".match(PATTERN)).toBeNull();
  });
});
```

- [ ] **Step 2: Update the tests so they fail on the old behaviour**

(a) `tests/dungeon-combat-cast-attack-spell.test.mjs` — replace `makeDamageRoll` with a roll whose `alter` returns a distinct altered roll:

```js
function makeDamageRoll(alterCalls) {
  const original = { total: 4 };
  original.alter = async (multiplier, addend) => {
    alterCalls.push({ multiplier, addend });
    return { total: 4 * multiplier, altered: true };
  };
  return original;
}
```

Then in every test that asserts `expect(alterCalls).toEqual([{ multiplier: M, addend: 0 }])`, add directly after it:

```js
    expect(target.applyDamageCalls[0].damage).toMatchObject({ altered: true, total: 4 * M });
```

(use the literal 3 or 2 for `M` as in that test), and in the test that asserts `expect(alterCalls).toEqual([])`, add after it:

```js
    expect(target.applyDamageCalls[0].damage).toEqual(expect.objectContaining({ total: 4 }));
    expect(target.applyDamageCalls[0].damage.altered).toBeUndefined();
```

(b) `tests/dungeon-combat-reactive-strike.test.mjs` — in the Triple-damage test (near line 423), change the stubbed `strike.damage` to return a distinct altered roll and assert it is the applied one:

```js
    const alterCalls = [];
    const altered = { total: 6, altered: true };
    const strike = makeStrikeAction({ outcome: "criticalSuccess" });
    strike.item.system.damage = { damageType: "slashing" };
    strike.damage = async () => ({
      total: 4,
      alter: async (multiplier, addend) => {
        alterCalls.push({ multiplier, addend });
        return altered;
      },
    });
```

and after `expect(alterCalls).toEqual([{ multiplier: 1.5, addend: 0 }]);` add `expect(mover.applyDamageCalls[0].damage).toBe(altered);`. In the Double-damage test (near line 458) make its stub `alter` return `{ total: 99, altered: true }` and after `expect(alterCalls).toEqual([]);` add:

```js
    expect(mover.applyDamageCalls[0].damage.total).toBe(4);
    expect(mover.applyDamageCalls[0].damage.altered).toBeUndefined();
```

If a test's fakes use different local names than the above, keep the same assertions against that test's own applied-damage list; do not weaken them.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/damage-roll-alter-guard.test.mjs tests/dungeon-combat-cast-attack-spell.test.mjs tests/dungeon-combat-reactive-strike.test.mjs`
Expected: FAIL. The guard lists `dungeon-combat.mjs` at the three sites; the Triple, spell-crit assertions fail because `applyDamage` got the original roll (no `altered`).

- [ ] **Step 4: Apply the returned roll at the three sites**

`scripts/dungeon-combat.mjs`, `rollAndApplyStrike` (~5474). Replace

```js
          if (damageMultiplier === 3) {
            await damageRoll.alter(1.5, 0);
          }
          // #931: Shield Block -- the system applies Hardness itself.
          const shieldBlock = await resolveShieldBlockForHit(combat, combatant, target, damageRoll);
          await target.actor.applyDamage({
            damage: damageRoll,
```

with

```js
          // #1289: alter() returns a NEW roll (the original is untouched), so
          // the scaled roll is what Shield Block and applyDamage must see.
          const finalRoll = damageMultiplier === 3 ? await damageRoll.alter(1.5, 0) : damageRoll;
          // #931: Shield Block -- the system applies Hardness itself.
          const shieldBlock = await resolveShieldBlockForHit(combat, combatant, target, finalRoll);
          await target.actor.applyDamage({
            damage: finalRoll,
```

`rollAndApplyStrikeAtVariant` (~7851): the identical replacement (same four lines before and after, same indentation).

Spell-attack crit, `castAttackSpellAndApplyRoll` (~8253). Replace

```js
        if (damageMultiplier != null) {
          await damageRoll.alter(Math.max(damageMultiplier, 2), 0);
        }
        await target.actor.applyDamage({
          damage: damageRoll,
```

with

```js
        // #1289: alter() returns a NEW roll; apply that one.
        const finalRoll = damageMultiplier != null ? await damageRoll.alter(Math.max(damageMultiplier, 2), 0) : damageRoll;
        await target.actor.applyDamage({
          damage: finalRoll,
```

Comments: in the two Strike sites, append to the existing #61 comment a sentence `// #1289: the 1.5x is applied via the roll alter() returns (finalRoll below).`; at the top of the doc block near line 5309 (the `drawHitCardMultiplier` comment), after the sentence ending `... "Triple damage."` add `The scaled roll is the value alter() RETURNS (#1289).`. Do not otherwise reword.

- [ ] **Step 5: Run the focused tests**

Run: `npx vitest run tests/damage-roll-alter-guard.test.mjs tests/dungeon-combat-cast-attack-spell.test.mjs tests/dungeon-combat-reactive-strike.test.mjs`
Expected: PASS.

- [ ] **Step 6: Full suite, fix other fakes**

Run: `npm test`
Expected: PASS. A test whose fake `alter` returns `undefined` (mutating-style) will now apply `undefined`; for any such failure change the fake to `return { total: <scaled>, altered: true }` and assert the applied roll, never weaken an assertion. Report every test you touched.

- [ ] **Step 7: Version and commit**

`git fetch origin main`, read `origin/main:module.json`'s version and set `module.json` to the next unused patch version. No imports changed, so no architecture-docs update.

```bash
git add scripts/dungeon-combat.mjs tests/ module.json docs/superpowers/plans/2026-11-09-damage-roll-alter-result.md
git commit -m "#1289: apply the roll DamageRoll.alter() returns

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Open the PR and merge, keeping the issue open**

The fix needs a live check, so merge with an explicit subject/body (no closing keyword):

```bash
git push -u origin HEAD
gh pr create --title "#1289: apply the roll DamageRoll.alter() returns" --body "Implements docs/superpowers/plans/2026-11-09-damage-roll-alter-result.md. Refs #1289 (stays open for the live check).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --subject "#1289: apply the roll DamageRoll.alter() returns (#<PR number>)" --body "Issue stays open pending live verification."
```

Then on #1289: add `verification`, remove `in progress` and `claimed`.

---

### Task 2: Live verification (owner-attended)

**Files:** none.

- [ ] **Step 1: Confirm the build is live** (`game.modules.get("pf2e-dungeon-crawl").version` equals `module.json`).
- [ ] **Step 2: Triple card.** With the Critical Hit Deck on, an AI NPC crits with a card reading "Triple damage" (e.g. Disembowel): the target's HP loss equals 3x the single roll (the damage chat message will show 2x; that is the accepted limitation).
- [ ] **Step 3: Double card / plain crit.** A "Double damage" card or no card: HP loss equals the 2x roll in the chat message. A plain hit: single damage.
- [ ] **Step 4: Spell attack crit.** An AI caster's spell-attack roll crits: HP loss is 2x (or the card's multiplier) the single roll; a non-crit hit is single.
- [ ] **Step 5: Record the result on #1289** (terse). Close only if all pass; on failure remove `verification` and re-claim.
