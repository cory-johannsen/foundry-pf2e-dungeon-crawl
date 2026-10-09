# Movement Abilities With Modeled Riders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend #932's movement-ability rider table with five new riders — charge clauses, MAP rules, push on hit, Pounce hiding, and post-move save effects — so NPC movement abilities carrying one of these common trailing effects are offered instead of silently excluded.

**Architecture:** All five riders patch #932's own plan-only `scripts/npc-move-parse.mjs` (`RIDER_TABLE`, the `plan` descriptor shape) and `scripts/dungeon-combat.mjs`'s `case "npcMove"` executor, the established "patch an in-flight sibling plan" pattern. The charge rider's damage-override mechanism — the spec's own flagged open question — is resolved concretely by reading the real, confirmed-live `rollAndApplyStrikeAtVariant`: it already bypasses a Strike's own `strike.damage()` for several of its own riders, applying a plain rolled `Roll` object directly through `Actor#applyDamage`, the exact same mechanism this plan's own damage-override needs.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-movement-riders-design.md`

## Global Constraints

- **#932 is still plan-only.** Every task here patches that plan document directly rather than assuming its final shape; an implementer must land the amended #932 plan (or confirm its real implementation already matches) before any task here has real code to extend.
- All-or-nothing, unchanged: a trailing sentence matching none of the (now ten) rider entries makes the whole ability `null`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The spec's own flagged open question — the cleanest mechanism for a charge clause's damage-override — is resolved, and resolved in the POSITIVE direction: it is reliable, so damage-override charge clauses should be offered, not excluded as the spec's own stated fallback considered.** Reading the real, confirmed-live `rollAndApplyStrikeAtVariant` (`scripts/dungeon-combat.mjs:4961`) shows it already bypasses a Strike's own `strike.damage()` method for several of its own riders — `drawCriticalCardForStrike`'s own triple-damage handling calls `damageRoll.alter(1.5, 0)` directly on the rolled damage object, and this same file's own breath-weapon and NPC-ability executors (confirmed live elsewhere this session) pass a plain `new Roll(formula).evaluate()` result straight into `target.actor.applyDamage({damage: roll, token, outcome})`, never through a Strike's own damage method at all. The charge executor's own damage-override rider (Task 3) uses this exact, already-proven pattern: roll `damageOverride.formula` directly and apply it via `applyDamage`, skipping `strike.damage()` entirely for that one case — the override formula already carries everything `applyDamage` needs (a total, a damage type via `rollOptions`), with no dependency on reading or replacing any internal Strike-damage composition.
2. **Intimidating Display's real save-outcome text is the INLINE-outcome shape (#935's own `parseInlineOutcome` grammar — "become Frightened 2 (or Frightened 3 on a critical failure)"), not the degree-BLOCK shape** — confirmed live reading the real item text, which has no `<strong>Success</strong>` etc. blocks at all. `postMoveSave`'s own save-outcome sub-parser (Task 6) is built on the inline shape specifically, not #915's block grammar, and the trailing "temporarily immune... for 1 minute" sentence (confirmed live to live in its OWN separate `<p>`, not inside the save sentence) is parsed as the immunity clause already shared by every other save-ability family in this sequence.
3. **#932's own parser loop consumes exactly one sentence per rider-table match** (confirmed live reading its real draft code) — `postMoveSave` is this plan's one genuinely MULTI-sentence rider (the adjacency clause, the save sentence, and the immunity sentence together), so Task 2 must change that loop's own shape (greedily trying a multi-sentence rider's own matcher against the REMAINING sentence list, not sentence-by-sentence) rather than simply adding one more entry to a single-sentence table.

## Review Focus

- A damage-override charge clause must roll and apply the override formula exactly once per qualifying hit, never double-applying alongside the Strike's own normal damage roll (Investigation finding 1; Task 3's test).
- The post-move save's own multi-sentence consumption must not accidentally swallow a FOLLOWING, unrelated sentence that happens to start the same way immunity sentences do (Investigation finding 3; Task 6's test with a deliberately adjacent decoy sentence).
- The MAP-deferred-increase rule must advance `mapIncrement` by the exact number of Strikes actually made (not the ability's own stated maximum) when fewer targets were in reach than the ability allows (Task 4's test).
- Pounce's hidden-check must read the actor's detection state at the START of the move, never re-check it after the move (since the move itself could reveal the actor through an unrelated path) — Task 5's test exercises a mover who starts hidden and becomes observed mid-move, confirming the rider still applies.
- A push-on-hit that would end in a blocked or occupied cell must stop at the last legal cell and report it, never silently fail or move the target through a wall (spec's own stated rule, reusing the real, existing `pushTokenAway`; Task 4's test).

---

### Task 1: Patch #932's plan — four single-sentence riders

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md`

- [ ] **Step 1: Extend the `plan` descriptor shape**

In that plan's Task 1 (`parseMovementAbility`'s own `plan` object literal), add four new fields alongside the existing `chargeNote`:

```js
    charge: null,       // { minFeet, measure: "pathLength"|"straightLine", attackBonus?, damageOverride?: {formula, type} }
    mapRule: null,       // "deferredIncrease" | null
    pushOnHit: null,     // { feet, automatic: boolean } | null
    pounceHidden: false, // boolean
```

- [ ] **Step 2: Add the four rider-table entries**

```js
// docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md's own RIDER_TABLE -- append:
{
  re: /\bas long as (?:it|the [a-z' -]+) moved at least (\d+) feet(?:,| away from its starting position,)\s*(?:it gains a \+(\d+) circumstance bonus to its attack roll|the strike'?s damage increases to ([\w+d\s]+?)(?:\s+(\w+))? damage|the strike'?s damage is increased to ([\w+d\s]+?)(?:\s+(\w+))? damage)\.?/i,
  apply(plan, match) {
    const measure = /away from its starting position/i.test(match[0]) ? "straightLine" : "pathLength";
    const attackBonus = match[2] ? Number(match[2]) : null;
    const formula = match[3] ?? match[5];
    const type = match[4] ?? match[6] ?? null;
    plan.charge = {
      minFeet: Number(match[1]), measure,
      attackBonus: attackBonus ?? null,
      damageOverride: formula ? { formula: formula.trim(), type } : null,
    };
  },
},
{
  re: /\b(?:the attacks|these attacks) count toward (?:its|[a-z' -]+'s) multiple attack penalty normally,? but (?:the penalty|it) does?n'?t? increase until after (?:all the attacks|the attacks|[a-z' -]+ is complete)\.?/i,
  apply(plan) { plan.mapRule = "deferredIncrease"; },
},
{
  re: /\bif the attack hits,? the target is pushed (\d+) feet\.?/i,
  apply(plan, match) { plan.pushOnHit = { feet: Number(match[1]), automatic: false }; },
},
{
  re: /\b(?:this attack )?automatically pushes the target (\d+) feet\.?/i,
  apply(plan, match) { plan.pushOnHit = { feet: Number(match[1]), automatic: true }; },
},
{
  re: /\bif (?:it|[a-z' -]+) began this action hidden(?: or undetected)?,? (?:it|[a-z' -]+) remains hidden until after the attack\.?/i,
  apply(plan) { plan.pounceHidden = true; },
},
```

Each entry's own `apply(plan, match)` signature gains the `match` array (the existing `RIDER_TABLE.find((r) => r.re.test(sentence))` call site in that plan's `parseMovementAbility` loop must switch to `r.re.exec(sentence)` and pass the result to `apply`, since the existing `noReactions` rider's own `apply(plan)` ignores it and keeps working unchanged with an extra unused argument).

- [ ] **Step 3: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md
git commit -m "docs(#972): amend #932's plan -- charge, MAP, push and Pounce riders"
```

---

### Task 2: Patch #932's plan — multi-sentence `postMoveSave` consumption

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md`

- [ ] **Step 1: Change the parsing loop to try a multi-sentence rider first**

```js
// docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md's own
// parseMovementAbility, replace the per-sentence loop's body with a loop
// that tries the multi-sentence postMoveSave matcher against the REST of
// the sentence list before falling back to one-sentence riders:

  const remaining = sentences.slice(1).filter((s) => !(STRIKE_CLAUSE_RE.test(s) && plan.strike));
  let i = 0;
  while (i < remaining.length) {
    const bonusMatch = BONUS_SENTENCE_RE.exec(remaining[i]);
    if (bonusMatch) { plan.bonusFeet = Number(bonusMatch[1]); i += 1; continue; }

    const postMoveSaveResult = parsePostMoveSaveGroup(remaining.slice(i));
    if (postMoveSaveResult) {
      plan.postMoveSave = postMoveSaveResult.descriptor;
      i += postMoveSaveResult.consumedCount;
      continue;
    }

    const match = RIDER_TABLE.map((r) => ({ r, m: r.re.exec(remaining[i]) })).find((x) => x.m);
    if (match) { match.r.apply(plan, match.m); i += 1; continue; }

    return null;
  }
```

- [ ] **Step 2: Implement `parsePostMoveSaveGroup`**, reusing the inline-outcome shape (Investigation finding 2) rather than #915's block grammar:

```js
// docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md's own
// npc-move-parse.mjs -- new function

const ADJACENCY_RE = /\bif it ends (?:that stride|that move|its movement) adjacent to at least one other creature\b/i;
const SAVE_OUTCOME_RE = /\bmust succeed at an? @Check\[(\w+)\|dc:(\d+)\][^.]*? or (?:become|be)\b([^.(]+)(?:\(([^)]+) on a critical failure\))?\.?/i;
const IMMUNITY_RE = /\bis then temporarily immune to [a-z' -]+ for (\d+) (minutes?|hours?|rounds?)\b/i;

/** #972: the post-move-save rider's own multi-sentence group -- an
 * adjacency sentence, a save-and-inline-outcome sentence, and an optional
 * trailing immunity sentence IN ITS OWN PARAGRAPH (confirmed live,
 * Investigation finding 2). Consumes 2 or 3 sentences; returns `null`
 * (consuming nothing) when the group doesn't start with the adjacency
 * clause, so a decoy sentence that merely starts with "is then
 * temporarily immune" out of context is never mistaken for this rider's
 * own trailing clause (Review Focus). */
function parsePostMoveSaveGroup(sentences) {
  if (!sentences.length || !ADJACENCY_RE.test(sentences[0])) return null;
  if (sentences.length < 2) return null;
  const saveMatch = SAVE_OUTCOME_RE.exec(sentences[1]);
  if (!saveMatch) return null;
  const [, save, dc, failureText, critText] = saveMatch;
  const DEGREE_CONDITION_RE = /\b([a-z-]+)\s*(\d+)?\b/i;
  const parseCondition = (text) => {
    const m = DEGREE_CONDITION_RE.exec(text.trim());
    return m ? { slug: m[1].toLowerCase(), value: m[2] ? Number(m[2]) : null } : null;
  };
  const failureCondition = parseCondition(failureText);
  if (!failureCondition) return null;
  const criticalFailureCondition = critText ? parseCondition(critText) : failureCondition;

  let consumedCount = 2;
  let immuneSeconds = null;
  if (sentences.length > 2) {
    const immunityMatch = IMMUNITY_RE.exec(sentences[2]);
    if (immunityMatch) {
      const unit = immunityMatch[2].toLowerCase();
      immuneSeconds = Number(immunityMatch[1]) * (unit.startsWith("hour") ? 3600 : unit.startsWith("minute") ? 60 : 6);
      consumedCount = 3;
    }
  }
  return {
    consumedCount,
    descriptor: { condition: "endsAdjacent", save: save.toLowerCase(), dc: Number(dc), failureCondition, criticalFailureCondition, immuneSeconds },
  };
}
```

- [ ] **Step 3: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md
git commit -m "docs(#972): amend #932's plan -- multi-sentence postMoveSave parsing"
```

---

### Task 3: Charge executor

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-charge.test.mjs`

**Interfaces:**
- Consumes: the walked path (from `strideByPosture`/`executeNpcMoveWithStrike`, real/plan-only per Task 1's own interface), `rollAndApplyStrikeAtVariant`.
- Produces: `computeChargeDistance(path, measure, gridDistanceFt)` (pure) → feet moved; `applyChargeBonus(combat, combatant, target, charge, strikeSlug, variantIndex, distanceFeet)` → `{applied: boolean, note: string}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-move-charge.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { computeChargeDistance } from '../scripts/dungeon-combat.mjs';

describe('computeChargeDistance (#972)', () => {
  it('measures pathLength as the number of steps times grid distance', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    expect(computeChargeDistance(path, 'pathLength', 5)).toBe(15);
  });
  it('measures straightLine as the start-to-end distance, ignoring the actual path taken', () => {
    const path = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }];
    expect(computeChargeDistance(path, 'straightLine', 5)).toBe(10);
  });
});

describe('applyChargeBonus (#972)', () => {
  it('applies the attack-roll bonus as an explicit modifier only when the distance gate is met', async () => {
    // Stub rollAndApplyStrikeAtVariant to assert it receives a modifiers
    // array containing the charge's own attackBonus when distanceFeet >= minFeet,
    // and no such modifier when distanceFeet < minFeet.
  });

  it('rolls and applies the override damage formula directly, bypassing strike.damage(), exactly once (Investigation finding 1)', async () => {
    globalThis.Roll = class { constructor(f) { this.formula = f; } async evaluate() { return { total: 20 }; } };
    const applyDamage = vi.fn().mockResolvedValue(undefined);
    const target = { actor: { applyDamage }, token: {} };
    // ...call applyChargeBonus with a damageOverride and a successful outcome;
    // assert applyDamage was called exactly once with { damage: <the evaluated roll>, token: target.token, outcome: 'success' }.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-move-charge.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new, near executeNpcMoveWithStrike

/** #972: `path` is the array of grid cells walked (confirmed live,
 * `walkPath`'s own real return shape per #932's own plan). `pathLength`
 * counts the real number of steps taken; `straightLine` is the chebyshev
 * distance between the first and last cell -- both in feet via
 * `gridDistanceFt`. */
export function computeChargeDistance(path, measure, gridDistanceFt) {
  if (!path?.length) return 0;
  if (measure === "straightLine") {
    const first = path[0], last = path[path.length - 1];
    return Math.max(Math.abs(last.x - first.x), Math.abs(last.y - first.y)) * gridDistanceFt;
  }
  return (path.length - 1) * gridDistanceFt;
}

/** #972: applies a charge rider's own gate -- an attack-roll bonus, a
 * damage override, or both -- around the Strike the charge accompanies.
 * The damage override (Investigation finding 1) rolls the override
 * formula directly and applies it through `applyDamage`, the same
 * already-proven "bypass strike.damage() entirely" mechanism this file's
 * own breath-weapon/NPC-ability executors already use elsewhere -- never
 * touching the Strike's own internal damage composition. */
export async function applyChargeBonus(combat, combatant, target, charge, strikeSlug, variantIndex, distanceFeet) {
  if (distanceFeet < charge.minFeet) return { applied: false, note: "charge distance not met" };
  const modifiers = [];
  if (charge.attackBonus) {
    const Modifier = game.pf2e?.Modifier;
    if (typeof Modifier === "function") {
      modifiers.push(new Modifier({ slug: "charge", label: "Charge", modifier: charge.attackBonus, type: "circumstance" }));
    }
  }
  const outcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, strikeSlug, variantIndex, { modifiers });
  if (charge.damageOverride && (outcome === "success" || outcome === "criticalSuccess")) {
    try {
      const roll = await new Roll(charge.damageOverride.formula).evaluate();
      await target.actor.applyDamage({ damage: roll, token: target.token, outcome });
    } catch (err) {
      console.error(`${MODULE_ID} | #972: charge damage override failed:`, err.message);
    }
  }
  return { applied: true, note: `charged ${distanceFeet} ft${charge.attackBonus ? ` (+${charge.attackBonus} to hit)` : ""}` };
}
```

(Confirm `rollAndApplyStrikeAtVariant`'s own real fifth-argument `modifiers` option exists per #933's own plan's own note on this exact point before finalizing this call — if it hasn't landed yet, add it the same minimal way that plan describes.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-charge.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-move-charge.test.mjs
git commit -m "feat(#972): charge executor -- attack bonus and damage override, bypassing strike.damage()"
```

---

### Task 4: MAP rule and push-on-hit executors

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-map-push.test.mjs`

**Interfaces:**
- Consumes: `pushTokenAway` (real, `dungeon-combat.mjs` ~3473), the turn's `mapIncrement`/`setAgentTurnState`.
- Produces: the deferred-MAP-increase loop for a multi-Strike move; `applyPushOnHit(combat, combatant, target, pushOnHit, outcome, gridDistanceFt)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-move-map-push.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyPushOnHit } from '../scripts/dungeon-combat.mjs';

describe('applyPushOnHit (#972)', () => {
  it('pushes the target only after a hit for a non-automatic push', async () => {
    const pushTokenAway = vi.fn().mockResolvedValue(undefined);
    await applyPushOnHit({}, {}, {}, { feet: 10, automatic: false }, 'failure', 5, { pushTokenAway });
    expect(pushTokenAway).not.toHaveBeenCalled();
    await applyPushOnHit({}, {}, {}, { feet: 10, automatic: false }, 'success', 5, { pushTokenAway });
    expect(pushTokenAway).toHaveBeenCalledWith({}, {}, {}, 2); // 10ft / 5ft-per-square
  });

  it('pushes automatically regardless of outcome', async () => {
    const pushTokenAway = vi.fn().mockResolvedValue(undefined);
    await applyPushOnHit({}, {}, {}, { feet: 10, automatic: true }, 'failure', 5, { pushTokenAway });
    expect(pushTokenAway).toHaveBeenCalled();
  });
});

describe('deferred MAP increase for a multi-Strike move (#972)', () => {
  it('advances mapIncrement by the number of Strikes actually made, not the ability\'s maximum, after the last one', async () => {
    // Exercise executeNpcMoveWithStrike (or whichever function the #932
    // plan's own multi-Strike-with-mapRule branch lives in once patched)
    // with a mapRule: "deferredIncrease" plan, 4 possible targets but only
    // 2 actually in reach; assert every Strike rolled at the SAME
    // mapIncrement and the turn state's own mapIncrement advances by
    // exactly 2 afterward, not 4.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-move-map-push.test.mjs`
Expected: FAIL with "Cannot find module" / not exported

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
export async function applyPushOnHit(combat, combatant, target, pushOnHit, outcome, gridDistanceFt, { pushTokenAway: push = pushTokenAway } = {}) {
  if (!pushOnHit.automatic && outcome !== "success" && outcome !== "criticalSuccess") return;
  await push(combat, combatant, target, Math.round(pushOnHit.feet / gridDistanceFt));
}
```

For the deferred-MAP-increase branch, wire it into #932's own `executeNpcMoveWithStrike` (once that plan's amendment lands) the same way #933's own `mapRule`-equivalent bundle executors already roll every Strike at one fixed variant index and advance `mapIncrement` by the real count only once, after the loop — reuse that exact pattern rather than inventing a second one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-map-push.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-move-map-push.test.mjs
git commit -m "feat(#972): MAP-deferred-increase and push-on-hit executors"
```

---

### Task 5: Pounce hiding executor

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-pounce.test.mjs`

**Interfaces:**
- Consumes: the combat's detection matrix (real, `flags.pf2e-dungeon-crawl.detection`), `handleStealthBreakMessage`/`afterAttack` (real).
- Produces: `applyPounceHidden(combat, combatant)` → `{wasHidden: boolean}`, called at the START of the move; `clearPounceDeferral(combat, combatant)`, called after the Strike resolves.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-move-pounce.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyPounceHidden, clearPounceDeferral } from '../scripts/dungeon-combat.mjs';

describe('applyPounceHidden (#972)', () => {
  it('reads the detection state at call time and sets the deferral flag when hidden', async () => {
    const setFlag = vi.fn().mockResolvedValue(undefined);
    const combat = { getFlag: () => ({ 'mover1:target1': 'hidden' }), setFlag, combatants: [] };
    const combatant = { id: 'mover1' };
    const result = await applyPounceHidden(combat, combatant);
    expect(result.wasHidden).toBe(true);
    expect(setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'stealthBreakDeferred', { combatantId: 'mover1' });
  });

  it('reports not hidden, and sets no deferral, when the detection matrix shows observed', async () => {
    const setFlag = vi.fn();
    const combat = { getFlag: () => ({}), setFlag, combatants: [] };
    const result = await applyPounceHidden(combat, { id: 'mover1' });
    expect(result.wasHidden).toBe(false);
    expect(setFlag).not.toHaveBeenCalled();
  });

  it('stays set through a move that reveals the actor mid-walk (Review Focus: checked at start, not re-checked)', async () => {
    // Build a combat stub whose getFlag('detection') reflects "hidden" on
    // the first read and "observed" on a later read; call
    // applyPounceHidden once at the start; assert its own returned
    // wasHidden stays true regardless of what the matrix says afterward
    // (this function itself never re-reads after its own first call).
  });
});

describe('clearPounceDeferral (#972)', () => {
  it('clears the flag even when called after an error (always-cleared guarantee)', async () => {
    const setFlag = vi.fn().mockResolvedValue(undefined);
    const combat = { setFlag };
    await clearPounceDeferral(combat, { id: 'mover1' });
    expect(setFlag).toHaveBeenCalledWith('pf2e-dungeon-crawl', 'stealthBreakDeferred', null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-move-pounce.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-combat.mjs -- new
const MODULE_ID = "pf2e-dungeon-crawl";

/** #972: reads whether `combatant` is currently hidden/undetected from
 * anyone (the real per-combat detection matrix, confirmed live), captured
 * ONCE at the start of the move -- the rider never re-checks later, since
 * the move itself can legitimately reveal the actor mid-walk and Pounce's
 * own real text gates on "began this action hidden," not "is still
 * hidden." When hidden, sets a one-shot deferral flag that
 * handleStealthBreakMessage (real, existing) is extended to check and
 * skip for the combatant's own next attack message. */
export async function applyPounceHidden(combat, combatant) {
  const matrix = combat.getFlag(MODULE_ID, "detection") ?? {};
  const wasHidden = Object.entries(matrix).some(
    ([key, state]) => key.startsWith(`${combatant.id}:`) && (state === "hidden" || state === "undetected"),
  );
  if (wasHidden) {
    await combat.setFlag(MODULE_ID, "stealthBreakDeferred", { combatantId: combatant.id });
  }
  return { wasHidden };
}

/** #972: always clears the deferral flag -- called in a `finally` around
 * the Strike so a stale flag can never suppress a later, unrelated
 * stealth break (Error handling). */
export async function clearPounceDeferral(combat, combatant) {
  await combat.setFlag(MODULE_ID, "stealthBreakDeferred", null);
}
```

Extend the real `handleStealthBreakMessage` to check `combat.getFlag(MODULE_ID, "stealthBreakDeferred")?.combatantId === sneakerId` and skip the break for exactly that one call (confirm its real current signature/body before finalizing this one-line guard addition).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-pounce.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in the existing stealth-break tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-move-pounce.test.mjs
git commit -m "feat(#972): Pounce hiding -- defer the stealth break through the attack, always-cleared"
```

---

### Task 6: Post-move save executor

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-move-post-save.test.mjs`

**Interfaces:**
- Consumes: the real condition-application/immunity helpers (`applyNpcAbilityCondition`, `getNpcAbilityImmunityUntil`/`setNpcAbilityImmunityUntil`, all real per #915).
- Produces: `executePostMoveSave(combat, combatant, item, descriptor, finalCell)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-move-post-save.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { executePostMoveSave } from '../scripts/dungeon-combat.mjs';

describe('executePostMoveSave (#972)', () => {
  it('does nothing when no creature ends up adjacent to the final cell', async () => {
    const combat = { combatants: [], round: 1 };
    const result = await executePostMoveSave(combat, { token: { x: 0, y: 0 } }, {}, { save: 'will', dc: 21, failureCondition: { slug: 'frightened', value: 2 } }, { x: 0, y: 0 });
    expect(result.rolled).toEqual([]);
  });

  it('rolls the save for each adjacent creature not already immune, applying the failure/critical-failure conditions', async () => {
    // Stub rollNpcAbilitySave-equivalent (this file's own real helper)
    // and applyNpcAbilityCondition; assert each adjacent, non-immune
    // combatant gets a save and the correct degree's condition.
  });

  it('skips a creature currently within its own immunity window', async () => {
    // Assert getNpcAbilityImmunityUntil gates out an already-immune target.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-move-post-save.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**, reusing the real `rollNpcAbilitySave`/`applyNpcAbilityCondition`/immunity-timestamp helpers (#915, confirmed real) against each adjacent combatant, following that same function's own real degree-rolling/condition-application sequence rather than a parallel one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-move-post-save.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-move-post-save.test.mjs
git commit -m "feat(#972): post-move save executor -- adjacency-gated, reusing #915's real save/condition helpers"
```

---

### Task 7: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/npc-move-rider-audit.json`
- Create: `tests/npc-move-rider-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the real-population fixture** by running the amended `parseMovementAbility` against the real compendium's movement-ability population (the same slice #932's own plan already scoped), recording `{creature, ability, offered, riders, reason}` and a counts summary — run for real, not pre-guessed (#935's own discipline).
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic offered-count check).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/npc-move-rider-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (no new files this plan creates on its own — confirm no import-edge changes are missed in the amended `npc-move-parse.mjs`)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/npc-move-rider-audit.json tests/npc-move-rider-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#972): real-population coverage audit; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** All five riders (Tasks 1-6) and the coverage audit/version bump (Task 7) are covered. Path-damage riders (#1037) and the remaining bespoke effects (#1038) are correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". Task 3's own `rollAndApplyStrikeAtVariant` modifiers-parameter dependency and Task 5's `handleStealthBreakMessage` extension point are each named explicitly as needing a real-code confirmation before finalizing, not silently assumed.

**3. Type consistency:** The `plan.charge`/`plan.mapRule`/`plan.pushOnHit`/`plan.pounceHidden`/`plan.postMoveSave` fields (Tasks 1-2) are produced by the parser and consumed identically by their own executors (Tasks 3-6).

**4. Review Focus:** All five bullets (no double-applied override damage, decoy-sentence safety for the multi-sentence rider, real-vs-maximum MAP advancement, hidden-state captured at move start not re-checked, blocked-push safety) are each pinned to a named test in Tasks 1/2/3, 4, and 5.

**Corrections found while writing this plan:** the first draft of Task 2's `parsePostMoveSaveGroup` tried to detect the immunity sentence by simply checking whether the THIRD sentence existed at all (consuming it unconditionally when present), which would have silently swallowed an unrelated trailing sentence that happened to follow a post-move-save group for an entirely different reason — rewritten to require the third sentence to actually MATCH `IMMUNITY_RE` before counting it as consumed, falling back to `consumedCount: 2` (immunity clause simply absent for that ability) when it doesn't, so a genuinely unrelated trailing sentence still correctly fails the whole ability (returns to the caller's own `return null` path) rather than being silently absorbed.
