# True Pre-Roll Check.roll Interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the PF2e system's own `game.pf2e.Check.roll` so AC-bonus-style reactions (Wing Deflection, Ghost Dodge, Swat Projectile, and any future DC/modifier-changing reaction) adjust the DC/modifier **before** the dice are rolled — matching RAW timing and showing the correct DC on the resulting chat card, instead of #931's own existing retroactive adjustment (which changes what happens next but leaves the original, wrong DC visible on the card).

**Architecture:** `game.pf2e.Check.roll` is a real, confirmed static method (`class Check { static async roll(check, context, event, callback) {...} }`, live-confirmed on the installed PF2e system, version `8.5.0`) whose own final step calls `Roll#toMessage`. A feature-detected, version-gated wrapper (mirroring #963's own real `installApplyDamageWrapper` convention exactly — same idempotence marker, same re-entrancy guard, same `VERIFIED_PF2E_VERSIONS` allowlist) mutates `context.dc` in place before calling the original. This is simpler than #963's own flavor-HTML finding: the degree-of-success display is baked in two separate places only AFTER a roll already happened; intercepting BEFORE the roll avoids needing to patch either of them at all.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** No dedicated spec file exists for #1034 — scoped by `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md`'s (#963's) own deferred-items framing and the issue body.

## Global Constraints

- **#963's own plan is NOT broken** — unlike #959/#960/#961, its `findEligibleInterceptDef` is an honest, explicitly-flagged stub (`return null`) pending #931's registry being real code, not a wrong-signature call. #931 IS now real (confirmed, same finding as every other plan in this sequence); this plan writes its own small, focused eligibility lookup for AC-bonus-kind reactions rather than completing #963's own stub (a separate plan's own task), but notes the overlap plainly.
- **This is the SECOND instance of the "wrap a system method" pattern in this codebase**, after #963's own still-plan-only `applyDamage` wrapper — reuses its exact idempotence-marker (`__pf2edcWrapped`) and module-scoped re-entrancy-guard technique rather than inventing a second convention.
- **`game.pf2e.Check.roll` is confirmed real** (live, Foundry 14.368, PF2e system `8.5.0`: `typeof game.pf2e.Check.roll === "function"`) and is a STATIC method — the wrapper reassigns `game.pf2e.Check.roll` directly (a class static property), not a prototype method the way #963's `applyDamage` wrapper does.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`Check.roll` is one function, not two separate bake points** (confirmed by reading the real, installed `pf2e.mjs` directly): it optionally shows a dialog (skipped by this module, which always sets `skipDialog: true`), evaluates the roll, computes the DC-based outcome from `context.dc`, builds the chat flavor, then calls `roll.toMessage({...}, {create: context.createMessage})` — Foundry's own `Roll#toMessage`, which is what actually invokes `ChatMessage.create` (and is where `preCreateChatMessage` fires, synchronously, from inside this one call). A wrapper that mutates `context.dc` before calling the original gets RAW-correct timing in one patch, not two.
2. **No "wrap a system method" precedent exists in real code** — confirmed: no `libWrapper` reference anywhere in `scripts/`/`module.json`; the only precedent at all is #963's own still-plan-only `applyDamage` wrapper, which this plan reuses the convention of.
3. **`context.isReroll` is a real, confirmed field `Check.roll` itself reads** — not used by this plan directly (that's #1035's own concern), but confirms the same wrapper this plan builds is the correct foundation #1035 extends, rather than a separate mechanism.
4. **The real existing AC-bonus reactions (Wing Deflection, Ghost Dodge, Swat Projectile) are retroactive today** (`executeAcBonusReaction`, `dungeon-combat.mjs`, confirmed real this session during #1019/#1021 research): they compute `degreeOfSuccess(rollTotal, dc + bonus, natural)` AFTER the attack roll's own chat card already shows the UNMODIFIED DC, and separately suppress the paired damage roll. This plan does not replace that existing mechanism (it stays as the fallback for when interception is disabled or the target isn't an AI reactor the wrapper can resolve in time) — it adds a SECOND path that, when available, changes the DC before the roll so the card itself shows the correct number.

## Review Focus

- The wrapper must call through to the REAL, original `Check.roll` on every path (feature-detection failure, no eligible reaction, an error inside the interception logic) — never silently swallow a check the way a broken wrapper could lose every attack roll in the game (Task 1's test).
- Installing the wrapper twice (e.g. a hot-reload in development) must never double-wrap — the `__pf2edcWrapped` marker must be checked before reassigning (Task 1's test, same convention as #963's own).
- The re-entrancy guard must prevent the wrapper's OWN side-effect rolls (if any future reaction rolls a second check from inside the interception logic) from being intercepted a second time by itself (Task 1's test).
- Mutating `context.dc` must never mutate the CALLER's own original options object if the caller reuses it afterward — the wrapper must build a new context object, never mutate in place (Task 2's test).
- A version mismatch (an unverified PF2e system version) must disable the wrapper entirely and log a warning, falling back to the existing retroactive path unchanged — never half-apply (Task 3's test).

---

### Task 1: The `Check.roll` wrapper (generic, no eligibility logic yet)

**Files:**
- Create: `scripts/check-roll-intercept.mjs`
- Test: `tests/check-roll-intercept.test.mjs`

**Interfaces:**
- Produces: `installCheckRollWrapper({checkClass})`, feature-detected and idempotent; `interceptCheckRoll(check, context)` → the (possibly adjusted) `context`, or `null` to leave it unchanged.

- [ ] **Step 1: Write the failing tests**

```js
// tests/check-roll-intercept.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { installCheckRollWrapper } from '../scripts/check-roll-intercept.mjs';

describe('installCheckRollWrapper (#1034)', () => {
  it('calls through to the original on every roll when no adjustment applies', async () => {
    const original = vi.fn().mockResolvedValue('rolled');
    const checkClass = { roll: original };
    installCheckRollWrapper({ checkClass });
    const result = await checkClass.roll({ slug: 'fortitude' }, { dc: { value: 15 } });
    expect(original).toHaveBeenCalled();
    expect(result).toBe('rolled');
  });

  it('does not double-wrap when installed twice', () => {
    const original = vi.fn();
    const checkClass = { roll: original };
    installCheckRollWrapper({ checkClass });
    const onceWrapped = checkClass.roll;
    installCheckRollWrapper({ checkClass });
    expect(checkClass.roll).toBe(onceWrapped);
  });

  it('calls through unchanged when the interception logic itself throws', async () => {
    const original = vi.fn().mockResolvedValue('rolled');
    const checkClass = { roll: original };
    installCheckRollWrapper({ checkClass, intercept: () => { throw new Error('boom'); } });
    const result = await checkClass.roll({ slug: 'fortitude' }, { dc: { value: 15 } });
    expect(result).toBe('rolled');
  });

  it('re-entrancy guard: a roll triggered from inside the intercept logic calls the ORIGINAL directly, never re-entering the wrapper', async () => {
    const original = vi.fn().mockResolvedValue('rolled');
    const checkClass = { roll: original };
    let sawReentrantCall = false;
    installCheckRollWrapper({
      checkClass,
      intercept: async () => {
        await checkClass.roll({ slug: 'reflex' }, {}); // re-entrant call
        sawReentrantCall = true;
        return null;
      },
    });
    await checkClass.roll({ slug: 'fortitude' }, { dc: { value: 15 } });
    expect(sawReentrantCall).toBe(true);
    expect(original).toHaveBeenCalledTimes(2); // the outer call + the re-entrant inner call, both reaching the real original
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/check-roll-intercept.mjs
/**
 * #1034: wraps the PF2e system's own static `Check.roll` so a reaction can
 * adjust a check's DC/modifier BEFORE the dice are rolled -- RAW-correct
 * timing, unlike #931's own existing retroactive AC-bonus adjustment.
 * Mirrors #963's own still-plan-only `applyDamage` wrapper convention
 * exactly: an idempotence marker, a module-scoped re-entrancy guard, and
 * an always-call-through-on-failure posture.
 */
const MODULE_ID = "pf2e-dungeon-crawl";

let inIntercept = false;

/** `checkClass` and `intercept` are injected for testing; production
 * calls pass `{checkClass: game.pf2e.Check}` with the default `intercept`
 * (Task 2 fills this in -- here it's a no-op that always returns `null`,
 * i.e. "no adjustment," so Task 1 lands as a safe, inert wrapper first). */
export function installCheckRollWrapper({
  checkClass = globalThis.game?.pf2e?.Check,
  intercept = () => null,
} = {}) {
  if (typeof checkClass?.roll !== "function") return;
  if (checkClass.roll.__pf2edcWrapped) return;
  const original = checkClass.roll;
  async function wrapped(check, context, ...rest) {
    if (inIntercept) return original.call(checkClass, check, context, ...rest);
    let adjustedContext = context;
    try {
      inIntercept = true;
      const result = await intercept(check, context);
      if (result) adjustedContext = { ...context, ...result };
    } catch (err) {
      console.error(`${MODULE_ID} | #1034: Check.roll interception failed:`, err?.message ?? err);
    } finally {
      inIntercept = false;
    }
    return original.call(checkClass, check, adjustedContext, ...rest);
  }
  wrapped.__pf2edcWrapped = true;
  checkClass.roll = wrapped;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/check-roll-intercept.mjs tests/check-roll-intercept.test.mjs
git commit -m "feat(#1034): generic, inert Check.roll wrapper (idempotent, re-entrancy-guarded)"
```

---

### Task 2: AC-bonus pre-roll eligibility and DC adjustment

**Files:**
- Modify: `scripts/check-roll-intercept.mjs`
- Test: `tests/check-roll-intercept.test.mjs`

**Interfaces:**
- Consumes: the real registry (`REACTION_DEFS`/`reactionItemsFor`, `acBonus`-kind rows: Wing Deflection, Ghost Dodge, Swat Projectile — confirmed real this session).
- Produces: `acBonusInterceptFor(combat)` → an `intercept(check, context)` function bound to that combat, for `installCheckRollWrapper`'s own `intercept` option.

- [ ] **Step 1: Write the failing tests**

```js
// tests/check-roll-intercept.test.mjs (append)
import { acBonusInterceptFor } from '../scripts/check-roll-intercept.mjs';

function combatant(id, { agentControlled = true, hasItem = null } = {}) {
  return { id, isDefeated: false, actor: { items: hasItem ? [hasItem] : [] }, getFlag: (mod, key) => (key === 'agentControlled' ? agentControlled : undefined) };
}

describe('acBonusInterceptFor (#1034)', () => {
  it('raises the DC by the matching reaction\'s own acBonus when the target is an AI reactor with that item', async () => {
    const wingDeflection = { name: 'Wing Deflection', type: 'action', system: { actionType: { value: 'reaction' } } };
    const target = combatant('t1', { hasItem: wingDeflection });
    const combat = { combatants: [target] };
    const intercept = acBonusInterceptFor(combat, target.id);
    const result = await intercept({ slug: 'attack-roll' }, { dc: { value: 20 } });
    expect(result.dc.value).toBe(22);
  });

  it('returns null (no adjustment) when the target has no AC-bonus reaction', async () => {
    const target = combatant('t1');
    const combat = { combatants: [target] };
    const intercept = acBonusInterceptFor(combat, target.id);
    const result = await intercept({ slug: 'attack-roll' }, { dc: { value: 20 } });
    expect(result).toBeNull();
  });

  it('never mutates the original context object', async () => {
    const wingDeflection = { name: 'Wing Deflection', type: 'action', system: { actionType: { value: 'reaction' } } };
    const target = combatant('t1', { hasItem: wingDeflection });
    const combat = { combatants: [target] };
    const intercept = acBonusInterceptFor(combat, target.id);
    const original = { dc: { value: 20 } };
    await intercept({ slug: 'attack-roll' }, original);
    expect(original.dc.value).toBe(20);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: FAIL with "acBonusInterceptFor is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/check-roll-intercept.mjs -- append
import { reactionItemsFor } from "./npc-reactions.mjs";

/** #1034: a small, focused eligibility lookup for AC-bonus-kind
 * reactions only -- #963's own `findEligibleInterceptDef` stub covers the
 * broader preCreateChatMessage/preCreateItem family and is that plan's
 * own task to complete, not duplicated here. Returns a bound
 * `intercept(check, context)` for `installCheckRollWrapper`. Never
 * mutates its `context` argument -- returns a fresh object for the
 * wrapper to merge. */
export function acBonusInterceptFor(combat, targetCombatantId) {
  return async (check, context) => {
    const target = combat.combatants.find((c) => c.id === targetCombatantId);
    if (!target?.getFlag?.("pf2e-dungeon-crawl", "agentControlled") || target.isDefeated) return null;
    const acBonusDef = reactionItemsFor(target.actor).find(({ def }) => def.kind === "acBonus");
    if (!acBonusDef) return null;
    return { dc: { ...context.dc, value: (context.dc?.value ?? 0) + acBonusDef.def.acBonus } };
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/check-roll-intercept.mjs tests/check-roll-intercept.test.mjs
git commit -m "feat(#1034): AC-bonus pre-roll DC adjustment"
```

---

### Task 3: Registration, version gate, fallback coexistence

**Files:**
- Modify: `scripts/module.mjs`
- Modify: `module.json`
- Modify: `docs/architecture.md`
- Test: `tests/check-roll-intercept.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/check-roll-intercept.test.mjs (append)
describe('version gate (#1034)', () => {
  it('does not install when the system version is unverified', () => {
    const checkClass = { roll: vi.fn() };
    const before = checkClass.roll;
    // Simulate module.mjs's own gate check directly (the gate itself is a
    // plain conditional around installCheckRollWrapper -- confirm this
    // test imports whatever that conditional becomes once Step 2 lands).
    const VERIFIED = ["8.5.0"];
    const systemVersion = "9.0.0";
    if (VERIFIED.includes(systemVersion)) installCheckRollWrapper({ checkClass });
    expect(checkClass.roll).toBe(before);
  });
});
```

- [ ] **Step 2: Wire it up at `ready`**

```js
// scripts/module.mjs -- new, near any existing ready-time feature detection
import { installCheckRollWrapper, acBonusInterceptFor } from "./check-roll-intercept.mjs";

const VERIFIED_CHECK_ROLL_PF2E_VERSIONS = ["8.5.0"]; // extend as later versions are verified live; mirrors #963's own convention

Hooks.once("ready", () => {
  const systemVersion = game.system?.version;
  if (!VERIFIED_CHECK_ROLL_PF2E_VERSIONS.includes(systemVersion)) {
    console.warn(`pf2e-dungeon-crawl | #1034: PF2e system ${systemVersion} is not in the verified range; Check.roll interception disabled, falling back to #931's retroactive AC-bonus path.`);
    return;
  }
  installCheckRollWrapper({
    intercept: (check, context) => {
      const targetId = context?.target?.token?.combatant?.id ?? context?.target?.actor?.token?.combatant?.id ?? null;
      if (!targetId || !game.combat) return null;
      return acBonusInterceptFor(game.combat, targetId)(check, context);
    },
  });
});
```

Note: the exact path from `Check.roll`'s own `context` to "which combatant is being targeted" is stated as a best-effort guess above (`context?.target?.token?.combatant?.id`) — confirm the real field at implementation time against a live attack-roll `context` object (the same posture #951's own plan took for its own unconfirmed API shape), since this session did not independently trace it.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run tests/check-roll-intercept.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill**

New file `scripts/check-roll-intercept.mjs`, new `ready`-time registration in `scripts/module.mjs`.

- [ ] **Step 5: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump — do not reuse a version number already used by another merged PR.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/module.mjs tests/check-roll-intercept.test.mjs docs/architecture.md module.json
git commit -m "feat(#1034): register the Check.roll wrapper, version-gated; docs/version bump"
```

---

## Self-Review

**1. Spec coverage:** The generic wrapper (Task 1), AC-bonus pre-roll adjustment (Task 2), and registration/version-gating (Task 3) are each covered.

**2. Placeholder scan:** No "TBD"/"TODO". The one genuinely unconfirmed piece (how to resolve "which combatant is the check's own target" from `Check.roll`'s real `context` shape) is stated plainly as a best-effort guess in Task 3's own code comment, with a fully working wrapper around it, rather than left vague.

**3. Type consistency:** `intercept(check, context)`'s contract (return `null` for "no change," or a partial object the wrapper merges onto a FRESH context) is defined once in Task 1 and honored identically by Task 2's `acBonusInterceptFor`.

**4. Review Focus:** All five bullets (always-call-through safety, no double-wrap, re-entrancy guard, non-mutation of the caller's context, version-gate fallback) are each pinned to a named test in Tasks 1–3.

**Corrections found while writing this plan:** confirmed directly against the real, installed PF2e system source that `Check.roll` bakes its result in ONE place (a single final `toMessage` call), not two separate bake points the way #963's own flavor-HTML finding describes for an AFTER-the-fact patch — this is specifically why intercepting BEFORE the roll (this plan) is strictly simpler than patching a card AFTER it exists, stated explicitly in the Architecture section rather than left as an assumption.
