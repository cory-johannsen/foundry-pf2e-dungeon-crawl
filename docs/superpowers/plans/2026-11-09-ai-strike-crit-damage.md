# Module-Rolled Strike Crit Damage Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every module-rolled Strike deal critical (doubled) damage on a critical hit, by routing all Strike damage through one helper that calls `strike.critical()` for a crit (#1284).

**Architecture:** PF2e's `strike.damage()` ignores any `outcome` argument and always rolls as a success; `strike.critical()` rolls as a critical success. A new import-free helper `rollStrikeDamage(strike, { target, outcome, createMessage })` picks the right function and never forwards `outcome`. The five call sites in `dungeon-combat.mjs` / `trap-combat.mjs`, plus the already-merged player auto-Strike in `defensive-advance.mjs`, use it. A source-guard test keeps `strike.damage({ ..., outcome })` from coming back.

**Tech Stack:** Foundry VTT v14 module, ES modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-ai-strike-crit-damage-design.md`

## Global Constraints

- A critical hit doubles damage (Player Core, "Critical Hits"); a plain hit and a miss behave exactly as before. (spec Summary)
- PF2e 8.5.0 / Foundry core 14: `strike.damage()` always rolls as `success`, `strike.critical()` always as `criticalSuccess`; neither reads an `outcome` argument. (spec Investigation findings)
- The helper never forwards `outcome`, and `createMessage` defaults to `true`. (spec Resolved decisions 1)
- Callers keep passing the outcome they already have to `applyDamage({ outcome })`, the crit deck and Shield Block; none of that changes. (spec Resolved decisions 2)
- Out of scope: the critical-hit deck redesign, `spell.rollDamage`, backfilling past combats. (spec Out of scope)
- Rend (`executeRend`, `outcome: "success"`) is routed through the helper as well, so the source guard has zero exceptions; its behaviour is unchanged.
- Every merge to `main` bumps `module.json` `version`; never reuse a number (`git fetch origin main` and read `origin/main:module.json` first). Run the `update-architecture-docs` skill in the same pass. (CLAUDE.md)
- Work in a git worktree off `origin/main`; `npm ci`, never symlink `node_modules`. (CLAUDE.md)

## Review Focus

- A critical hit at each of the five call sites calls `critical` and NOT `damage`; a plain hit calls `damage` and NOT `critical`; a miss calls neither. (Task 2)
- A Critical Hit Deck "triple damage" card on a crit: `alter(1.5, 0)` now scales an already-doubled roll (3x total); a "double damage" card adds nothing. Not unit-testable with fakes; covered by the live check. (Task 2)
- A future caller writing `strike.damage({ ..., outcome })` fails the suite. (Task 2 guard test)
- The helper handed a strike with only `damage` (a crit fake that forgot `critical`) throws a clear TypeError rather than silently rolling normal damage. (Task 1)
- The player auto-Strike from #1278 still rolls crit damage via the helper (its own tests stay green). (Task 2)

---

## File Structure

- Create `scripts/strike-damage.mjs`: the helper; zero imports.
- Modify `scripts/dungeon-combat.mjs` (four call sites, three comments), `scripts/trap-combat.mjs` (one call site, one import), `scripts/defensive-advance.mjs` (replace an inline ternary, one import).
- Modify test fixtures/tests that fake `strike.damage` so their fakes also have `critical`; add crit assertions.
- Create `tests/strike-damage.test.mjs`, `tests/strike-damage-guard.test.mjs`.
- Modify `docs/architecture.md`, `tools/generate-architecture-graph.mjs` (GROUPS), `module.json`.

---

### Task 1: The helper

**Files:**
- Create: `scripts/strike-damage.mjs`
- Test: `tests/strike-damage.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `rollStrikeDamage(strike, { target, outcome, createMessage = true } = {}) → Promise<Roll | null>` (named export of `scripts/strike-damage.mjs`).

- [x] **Step 1: Write the failing test**

Create `tests/strike-damage.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import { rollStrikeDamage } from "../scripts/strike-damage.mjs";

const mkStrike = () => ({
  damage: vi.fn(async () => ({ total: 7 })),
  critical: vi.fn(async () => ({ total: 14 })),
});
const target = { document: { id: "t" } };

describe("rollStrikeDamage (#1284)", () => {
  it("a critical success rolls strike.critical, not strike.damage", async () => {
    const s = mkStrike();
    const roll = await rollStrikeDamage(s, { target, outcome: "criticalSuccess", createMessage: true });
    expect(s.critical).toHaveBeenCalledTimes(1);
    expect(s.damage).not.toHaveBeenCalled();
    expect(roll).toEqual({ total: 14 });
  });

  it("a success rolls strike.damage, not strike.critical", async () => {
    const s = mkStrike();
    const roll = await rollStrikeDamage(s, { target, outcome: "success", createMessage: true });
    expect(s.damage).toHaveBeenCalledTimes(1);
    expect(s.critical).not.toHaveBeenCalled();
    expect(roll).toEqual({ total: 7 });
  });

  it("never forwards outcome to PF2e (it would be silently ignored)", async () => {
    const s = mkStrike();
    await rollStrikeDamage(s, { target, outcome: "criticalSuccess" });
    await rollStrikeDamage(s, { target, outcome: "success" });
    expect(s.critical.mock.calls[0][0]).toEqual({ target, createMessage: true });
    expect(s.damage.mock.calls[0][0]).toEqual({ target, createMessage: true });
    expect(s.critical.mock.calls[0][0]).not.toHaveProperty("outcome");
    expect(s.damage.mock.calls[0][0]).not.toHaveProperty("outcome");
  });

  it("createMessage defaults to true and can be turned off", async () => {
    const s = mkStrike();
    await rollStrikeDamage(s, { target, outcome: "success" });
    await rollStrikeDamage(s, { target, outcome: "success", createMessage: false });
    expect(s.damage.mock.calls[0][0].createMessage).toBe(true);
    expect(s.damage.mock.calls[1][0].createMessage).toBe(false);
  });

  it("an unknown or missing outcome rolls plain damage (callers only reach here on a hit)", async () => {
    const s = mkStrike();
    await rollStrikeDamage(s, { target });
    expect(s.damage).toHaveBeenCalledTimes(1);
    expect(s.critical).not.toHaveBeenCalled();
  });

  it("a strike object lacking critical() throws a TypeError on a crit instead of silently rolling normal damage", () => {
    const s = { damage: vi.fn(async () => ({ total: 7 })) };
    expect(() => rollStrikeDamage(s, { target, outcome: "criticalSuccess" })).toThrow(TypeError);
    expect(s.damage).not.toHaveBeenCalled();
  });

  it("propagates a null roll (PF2e returns null for a weapon that deals no damage)", async () => {
    const s = { damage: vi.fn(async () => null), critical: vi.fn(async () => null) };
    expect(await rollStrikeDamage(s, { target, outcome: "criticalSuccess" })).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/strike-damage.test.mjs`
Expected: FAIL — cannot resolve `../scripts/strike-damage.mjs`.

- [x] **Step 3: Write the implementation**

Create `scripts/strike-damage.mjs`:

```js
/**
 * #1284: one place that knows how to roll a Strike's damage for a given hit
 * outcome. PF2e's strike object exposes two damage functions: `damage()`
 * always rolls as a success and `critical()` always rolls as a critical
 * success (pf2e 8.5.0; verified live). Neither reads an `outcome` argument,
 * so passing `outcome` to `strike.damage()` silently rolls single damage on a
 * critical hit. This helper picks the right function and never forwards
 * `outcome`. Zero imports so any module can use it.
 */
export function rollStrikeDamage(strike, { target, outcome, createMessage = true } = {}) {
  const args = { target, createMessage };
  return outcome === "criticalSuccess" ? strike.critical(args) : strike.damage(args);
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/strike-damage.test.mjs`
Expected: PASS (7 tests).

- [x] **Step 5: Commit**

```bash
git add scripts/strike-damage.mjs tests/strike-damage.test.mjs
git commit -m "#1284: rollStrikeDamage helper (critical vs damage)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Route every call site through the helper

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (call sites near lines 5456, 7554, 7677, 7840; comments near 5340-5349, 5465-5470, 7848; add one import)
- Modify: `scripts/trap-combat.mjs` (call site near line 192; add one import)
- Modify: `scripts/defensive-advance.mjs` (lines near 189-192; add one import)
- Modify: `tests/helpers/feat-execution-fixture.mjs` (`makeStrike`, line ~70), `tests/dungeon-combat-npc-strike-execution.test.mjs` (`strike()` helper line ~60, the Wide Swing crit test line ~297, the Rend test line ~372), `tests/dungeon-combat-targeted-action.test.mjs` (line ~112), `tests/trap-combat-basic-save-trigger.test.mjs` (line ~424), `tests/dungeon-combat-strike-reach.test.mjs` (new crit case), and any other fake that the full suite shows lacking `critical`
- Create: `tests/strike-damage-guard.test.mjs`
- Modify: `docs/architecture.md`, `tools/generate-architecture-graph.mjs`, `module.json`

**Interfaces:**
- Consumes (Task 1): `rollStrikeDamage(strike, { target, outcome, createMessage })`.
- Produces: no new exports.

- [x] **Step 1: Write the failing guard test**

Create `tests/strike-damage-guard.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// #1284: PF2e's strike.damage() ignores `outcome` (it always rolls as a
// success). A `.damage({ ..., outcome })` call therefore rolls single damage
// on a critical hit while looking correct. Use rollStrikeDamage() instead.
const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const PATTERN = /\.damage\(\s*\{(?:[^{}]|\{[^{}]*\})*?\boutcome\b/g;

describe("no strike.damage({ outcome }) calls (#1284)", () => {
  it("scripts/*.mjs never passes outcome to .damage()", () => {
    const hits = [];
    for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
      const text = readFileSync(join(SCRIPTS, file), "utf8");
      for (const m of text.matchAll(PATTERN)) {
        hits.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(hits, "use rollStrikeDamage() from scripts/strike-damage.mjs").toEqual([]);
  });

  it("the pattern really matches the bug shape (guard against a vacuous test)", () => {
    expect("await strike.damage({\n target: targetRef,\n outcome,\n createMessage: true })".match(PATTERN)).not.toBeNull();
    expect("a.damage({ target: { document: t }, outcome: degree, createMessage: true })".match(PATTERN)).not.toBeNull();
    expect("strike.damage({ target: targetRef, createMessage: true })".match(PATTERN)).toBeNull();
  });
});
```

- [x] **Step 2: Write the failing crit assertions**

(a) In `tests/helpers/feat-execution-fixture.mjs` `makeStrike`, add a `critical` next to `damage`:

```js
    damage: vi.fn(async () => null),
    critical: vi.fn(async () => null),
```

(b) In `tests/dungeon-combat-npc-strike-execution.test.mjs`, in the `strike()` helper after `s.damage = ...` add:

```js
  s.critical = vi.fn(async () => ({ total: 14, alter: async () => ({ total: 28 }) }));
```

and replace the body of the test `"Wide Swing: the same natural 20 is a critical hit on one AC and only a hit on a much higher one"` assertions (keep its setup) with:

```js
    // 22 vs AC 30 is a failure; the natural 20 raises it to a hit.
    // pc (AC 18, the primary target) is a critical hit: strike.critical, not strike.damage.
    expect(greataxe.critical).toHaveBeenCalledTimes(1);
    expect(greataxe.critical).toHaveBeenCalledWith({ target: { document: pc.token }, createMessage: true });
    // tank (AC 30) is only a hit: strike.damage, and no outcome argument.
    expect(greataxe.damage).toHaveBeenCalledTimes(1);
    expect(greataxe.damage).toHaveBeenCalledWith({ target: { document: tank.token }, createMessage: true });
    expect(tank.actor.applyDamage).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1).result.text).toBe("pc: critical hit; tank: hit");
```

(c) In `tests/trap-combat-basic-save-trigger.test.mjs`, in `"#839 triggerTrap strike path is unchanged"`, give the fake strike a `critical` and update the assertion that `strike.damage` was called, then add a crit case. Replace the `strike` object and the damage assertion:

```js
    const strike = {
      type: "strike",
      ready: true,
      variants: [{ roll: vi.fn(async () => {}) }],
      damage: vi.fn(async () => damageRoll),
      critical: vi.fn(async () => ({ total: 14 })),
    };
```

```js
    expect(strike.damage).toHaveBeenCalledWith({ target: { document: token }, createMessage: true });
    expect(strike.critical).not.toHaveBeenCalled();
```

and add a second `it` in that describe:

```js
  it("a critical hit rolls strike.critical and applies that roll as a crit", async () => {
    const alice = actor("p1", "Alice");
    const critRoll = { total: 14 };
    const strike = {
      type: "strike",
      ready: true,
      variants: [{ roll: vi.fn(async () => {}) }],
      damage: vi.fn(async () => ({ total: 7 })),
      critical: vi.fn(async () => critRoll),
    };
    globalThis.game.messages.contents = [{ flags: { pf2e: { context: { outcome: "criticalSuccess" } } }, }];
    const h = hazardActor({ actions: [strike], items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    const token = { id: "t" };
    const result = await triggerTrap(h, { actor: alice, token });
    expect(result).toBe("criticalSuccess");
    expect(strike.critical).toHaveBeenCalledWith({ target: { document: token }, createMessage: true });
    expect(strike.damage).not.toHaveBeenCalled();
    expect(alice.applyDamage).toHaveBeenCalledWith({ damage: critRoll, token, outcome: "criticalSuccess" });
  });
```

(d) In `tests/dungeon-combat-strike-reach.test.mjs`, add (after the existing `"rolls when the melee target is adjacent"` test, inside the same `describe`) a crit case for `rollAndApplyStrike`. If the minimal fakes throw somewhere downstream of the damage call (crit deck, reactions, Shield Block), extend the **fakes in this test** until the assertions below can run; do not change the assertions:

```js
  it("a critical hit rolls strike.critical (doubled), not strike.damage, and applies that roll (#1284)", async () => {
    const critRoll = { total: 28 };
    const claw = strikeAction();
    claw.variants[0].roll = vi.fn(async () => {
      game.messages.contents.push({
        flags: { pf2e: { context: { outcome: "criticalSuccess" } } },
        rolls: [{ total: 30, dice: [{ faces: 20, results: [{ result: 15, active: true }] }] }],
      });
    });
    claw.damage = vi.fn(async () => ({ total: 14 }));
    claw.critical = vi.fn(async () => critRoll);
    const me = mk("atk", 0, 0, -1, [claw]);
    const foe = mk("foe", 1, 0, 1);
    foe.actor.applyDamage = vi.fn(async () => {});
    const combat = mkCombat([me, foe], me);

    await rollAndApplyStrike(combat, me, foe);

    expect(claw.critical).toHaveBeenCalledTimes(1);
    expect(claw.critical.mock.calls[0][0]).toEqual({ target: { document: foe.token }, createMessage: true });
    expect(claw.damage).not.toHaveBeenCalled();
    expect(foe.actor.applyDamage).toHaveBeenCalledWith(expect.objectContaining({ damage: critRoll, outcome: "criticalSuccess" }));
  });
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/strike-damage-guard.test.mjs tests/dungeon-combat-npc-strike-execution.test.mjs tests/trap-combat-basic-save-trigger.test.mjs tests/dungeon-combat-strike-reach.test.mjs`
Expected: FAIL — the guard lists `dungeon-combat.mjs` (4 sites incl. Rend) and `trap-combat.mjs`; the Wide Swing, trap crit and `rollAndApplyStrike` crit tests fail because `critical` is never called.

- [x] **Step 4: Route the call sites through the helper**

Add `import { rollStrikeDamage } from "./strike-damage.mjs";` beside the other relative imports in each of `scripts/dungeon-combat.mjs`, `scripts/trap-combat.mjs`, `scripts/defensive-advance.mjs`.

`scripts/dungeon-combat.mjs`, `rollAndApplyStrike` (~5456) — replace

```js
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
```

with

```js
        const damageRoll = await rollStrikeDamage(strike, {
          target: targetRef,
          outcome,
          createMessage: true,
        });
```

`rollAndApplyStrikeAtVariant` (~7840): the identical replacement (`strike.damage({ target: targetRef, outcome, createMessage: true })` → `rollStrikeDamage(strike, { target: targetRef, outcome, createMessage: true })`).

`executeSingleRollMultiAC` (~7554) — replace

```js
          action.action.damage({ target: { document: target.token }, outcome: degree, createMessage: true }),
```

with

```js
          rollStrikeDamage(action.action, { target: { document: target.token }, outcome: degree, createMessage: true }),
```

`executeRend` (~7677) — replace

```js
      action.action.damage({ target: { document: target.token }, outcome: "success", createMessage: true }),
```

with

```js
      rollStrikeDamage(action.action, { target: { document: target.token }, outcome: "success", createMessage: true }),
```

`scripts/trap-combat.mjs` `triggerTrap` (~192) — replace `await strike.damage({ target: targetRef, outcome, createMessage: true })` (the multi-line form) with `await rollStrikeDamage(strike, { target: targetRef, outcome, createMessage: true })`.

`scripts/defensive-advance.mjs` (~189-192) — replace

```js
      // PF2e's strike.damage() ignores `outcome` and always rolls as a success;
      // strike.critical() is the critical-success roll.
      if (outcome === "criticalSuccess") await strike.critical({ target: targetRef, createMessage: true });
      else if (outcome === "success") await strike.damage({ target: targetRef, createMessage: true });
```

with

```js
      if (outcome) await rollStrikeDamage(strike, { target: targetRef, outcome, createMessage: true });
```

- [x] **Step 5: Correct the misleading #61 comments in `dungeon-combat.mjs`**

Near 5465-5470 (inside `rollAndApplyStrike`) replace the sentence claiming `strike.damage()` "already applied PF2e's own crit doubling ... (confirmed live strike.damage(), unlike spell.rollDamage() -- see #81 -- DOES pre-double on a crit)" with:

```js
          // #1284: on a crit the roll above came from strike.critical() (via
          // rollStrikeDamage), so PF2e's own doubling is already in it; a
          // card's "double damage" (damageMultiplier 2) is therefore exactly
          // that doubling, no extra scaling needed.
```

Near 7848 (`rollAndApplyStrikeAtVariant`) replace "the crit doubling strike.damage() already applied" with "the crit doubling strike.critical() already applied (#1284)". Near 5340-5349 (the doc block that says `strike.damage()`'s pre-doubling) replace each `strike.damage()` with `strike.critical()` where it describes the doubled crit roll, keeping the rest of the text.

- [x] **Step 6: Run the focused tests**

Run: `npx vitest run tests/strike-damage.test.mjs tests/strike-damage-guard.test.mjs tests/dungeon-combat-npc-strike-execution.test.mjs tests/trap-combat-basic-save-trigger.test.mjs tests/dungeon-combat-strike-reach.test.mjs tests/defensive-advance.test.mjs`
Expected: PASS. If the Rend test (`"Rend: ... deals the claw's damage again"`) or any test asserting `damage` was called with an `outcome` key fails, change that assertion to the new argument shape `{ target, createMessage: true }`; it must not assert `outcome`.

- [x] **Step 7: Full suite, fix fakes**

Run: `npm test`
Expected: PASS. For any failure of the form "strike.critical is not a function" in a test whose strike fake defines `damage`, add `critical` to that fake mirroring its `damage` (known: `tests/dungeon-combat-targeted-action.test.mjs` ~112, `tests/dungeon-combat-reactive-strike.test.mjs` ~307, `tests/dungeon-combat-npc-reactions.test.mjs` ~93, `tests/dungeon-combat-stealth-targeting.test.mjs` ~46, `tests/dungeon-combat-stealth-seek.test.mjs` ~54). Change fakes only, never production code or assertions, to get green. Report every fake you touched.

- [x] **Step 8: Architecture docs and version**

Run the `update-architecture-docs` skill (new import-free file `strike-damage.mjs`; imported by `dungeon-combat.mjs`, `trap-combat.mjs`, `defensive-advance.mjs`). Add `strike-damage.mjs` to the GROUPS table in `tools/generate-architecture-graph.mjs` beside `defensive-advance-logic.mjs` so it does not land in "Other", and add a one-line description in `docs/architecture.md`. Then `git fetch origin main`, read `origin/main:module.json`'s version and set `module.json` to the next unused patch version.

- [x] **Step 9: Commit**

```bash
git add scripts/ tests/ docs/architecture.md tools/generate-architecture-graph.mjs module.json
git commit -m "#1284: roll Strike crit damage via strike.critical()

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Open the PR and merge, keeping the issue open**

The fix needs a live check, so merge with an explicit subject/body (no closing keyword):

```bash
git push -u origin HEAD
gh pr create --title "#1284: roll Strike crit damage via strike.critical()" --body "Implements docs/superpowers/plans/2026-11-09-ai-strike-crit-damage.md. Refs #1284 (stays open for the live check).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --subject "#1284: roll Strike crit damage via strike.critical() (#<PR number>)" --body "Issue stays open pending live verification."
```

Then on #1284: add `verification`, remove `in progress` and `claimed`.

---

### Task 3: Live verification (owner-attended)

**Files:** none.

- [ ] **Step 1: Confirm the build is live** (`game.modules.get("pf2e-dungeon-crawl").version` equals `module.json`).
- [ ] **Step 2: AI crit.** Run a combat with an AI-controlled NPC until it scores a critical hit. Expected: its damage chat message shows a `2 * (...)` formula and `context.outcome === "criticalSuccess"`, and the target's HP drops by the doubled total.
- [ ] **Step 3: Crit deck.** With the Critical Hit Deck on, a "double damage" card on a crit does not change the total (already doubled); a "triple damage" card yields 3x the single roll.
- [ ] **Step 4: Plain hit and trap.** A plain hit deals single damage; a Strike-type trap that crits deals doubled damage.
- [ ] **Step 5: Record the result on #1284** (terse). Close only if all pass; on failure remove `verification` and re-claim.
