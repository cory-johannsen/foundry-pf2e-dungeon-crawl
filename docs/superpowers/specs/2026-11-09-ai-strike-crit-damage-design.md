# Fix: Module-Rolled Strikes Deal Non-Critical Damage on a Critical Hit

**Issue:** #1284 — `rollAndApplyStrike` and three other module call sites pass `outcome: "criticalSuccess"` to `strike.damage()`, which PF2e ignores, so a critical hit deals normal damage.

**Builds on:** #61 (critical-hit deck and its `damageMultiplier` handling), #931 (Shield Block on the damage roll), #1278 / `scripts/defensive-advance.mjs` (the player auto-Strike, which already uses `strike.critical()` for a crit).

**Status:** Approved. The fix is unambiguous (rules: a critical hit doubles damage, Player Core "Critical Hits"); no design questions are open.

## Summary

PF2e's strike object exposes two damage functions, `strike.damage()` (always rolls as a success) and `strike.critical()` (always rolls as a critical success). Neither reads an `outcome` argument. The module calls `strike.damage({ outcome })` and then applies the resulting roll, so on a critical hit it rolls and applies **single** damage. The fix routes every module-rolled Strike damage through one helper that picks `critical()` on a critical success.

## Investigation findings

Verified 2026-11-09 against the live world (PF2e 8.5.0, Foundry core 14.368).

- **Source.** Character strikes: `for (let t of ["damage","critical"]) D[t] = async (n = {}) => { ... outcome: t === "damage" ? "success" : "criticalSuccess" ... }` (`pf2e.mjs` ~34674). NPC strikes: `createDamageRollFunctions` returns `{ damage: createDamageRoll("success"), critical: createDamageRoll("criticalSuccess") }`. The call-time `n.outcome` / `c.outcome` is never read.
- **Live probe (read-only, `getFormula: true`).** Herman's +1 Morningstar: `damage()` → `1d6 + 4 bludgeoning`; `damage({ outcome: "criticalSuccess" })` → `1d6 + 4 bludgeoning`; `critical()` → `2 * (1d6 + 4) bludgeoning`. The same shape for two NPCs (Afflicted Irnakurse's Jaws, Aller Rosk's Claw).
- **`applyDamage` does not compensate.** `ActorPF2e#applyDamage({ damage, outcome })` uses `outcome` only to filter crit-conditional damage modifiers/dice; the amount applied is the roll's own total.
- **Affected call sites** (all pass `outcome` to `strike.damage`): `rollAndApplyStrike` (`scripts/dungeon-combat.mjs` ~5456), the NPC strike-like action path (`~7554`, `outcome: degree`, which can be a crit), `rollAndApplyStrikeAtVariant` (`~7840`), `triggerTrap` (`scripts/trap-combat.mjs` ~192). `executeRend` (`~7677`) passes `"success"` only and is correct.
- **The crit-deck arithmetic is wrong too.** The `damageMultiplier` comments (#61) say the roll is already doubled on a crit, so a "double damage" card adds nothing and a "triple damage" card scales by 1.5×. With a 1× roll that gives 1× and 1.5×. With the fix the comments become true.
- **Old chat history is not evidence.** The world's chat has no AI turn cards, so earlier doubled NPC crits are most likely a GM clicking the system's Crit button. The tests and the live check below are the evidence.

## Resolved decisions

1. **One helper, not four inline ternaries.** `rollStrikeDamage(strike, { target, outcome, createMessage })` in a new `scripts/strike-damage.mjs`: `criticalSuccess` → `strike.critical({ target, createMessage })`, anything else → `strike.damage({ target, createMessage })`. It never forwards `outcome`, so a future caller cannot repeat the mistake.
2. **Callers pass the outcome they already have.** The surrounding code (crit deck, `applyDamage({ outcome })`, Shield Block) is unchanged.
3. **The player auto-Strike (#1278) uses the helper too**, replacing its inline ternary, so there is one place that knows the rule.
4. **Fix the misleading comments** at the #61 sites instead of leaving them to contradict the code.
5. **No behaviour change for a plain hit or a miss.**

## Design

`scripts/strike-damage.mjs` (no imports):

```js
export function rollStrikeDamage(strike, { target, outcome, createMessage = true } = {}) {
  const args = { target, createMessage };
  return outcome === "criticalSuccess" ? strike.critical(args) : strike.damage(args);
}
```

The four call sites become `await rollStrikeDamage(strike, { target: targetRef, outcome, createMessage: true })` (the NPC path passes `action.action` and `outcome: degree`). `scripts/defensive-advance.mjs` calls the helper where it now has the inline ternary.

## Testing

- **Unit (`tests/strike-damage.test.mjs`):** critical → `critical` called once with `{ target, createMessage }`, `damage` not called; success → `damage` called, `critical` not; no `outcome` key is forwarded in either case; `createMessage` defaults to true; the strike's resolved value is returned.
- **Call-site tests:** the existing `rollAndApplyStrike` / `rollAndApplyStrikeAtVariant` / `triggerTrap` / NPC-path tests gain a critical case asserting `critical` (not `damage`) was used; their fakes gain a `critical` function.
- **Source guard:** a test that reads `scripts/*.mjs` and fails on any `.damage({` call whose argument object contains `outcome` (a `strike.damage` that carries `outcome` is the bug pattern; the `getFormula` calls and the spell `rollDamage` path do not match). This keeps the mistake from returning.
- **Live check (required before closing):** on the live world, an AI-controlled NPC that scores a critical hit produces a damage message with `context.outcome === "criticalSuccess"` and a `2 * (...)` formula, and the target's HP drops by the doubled total. The issue moves to `verification` after merge.

## Out of scope

- Redesigning the critical-hit deck, or the `damageMultiplier === 3` rule (it becomes correct once the base roll is doubled).
- Spell damage (`spell.rollDamage`), which has its own outcome handling (#81).
- Backfilling or correcting damage already applied in past combats.
