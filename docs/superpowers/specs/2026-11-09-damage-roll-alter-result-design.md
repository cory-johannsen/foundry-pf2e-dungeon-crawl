# Fix: Critical-Deck Triple Damage and Spell-Attack Crit Scaling Are Discarded

**Issue:** #1289 — three call sites await `DamageRoll#alter()` and ignore its return value, then apply the original, unscaled roll.

**Builds on:** #61 (critical-hit deck damage multiplier for Strikes), #75 / #79 (spell-attack crit scaling), #1284 (`strike.critical()` for crit Strikes, which made the Triple-damage 1.5× the right amount to add).

**Status:** Approved. The rules answer is unambiguous (a "Triple damage" card means 3× the damage roll; a spell-attack critical hit doubles damage, Player Core "Critical Hits") and so is the fix; no design questions are open.

## Summary

In PF2e 8.5.0, `DamageRoll#alter(multiplier, addend)` on an evaluated roll does not change the roll in place. It returns a **new** evaluated roll and leaves the original untouched. Three places in `scripts/dungeon-combat.mjs` call `await damageRoll.alter(...)` as a bare statement and then apply `damageRoll`, so the scaling never reaches `applyDamage`. The fix is to apply the roll that `alter()` returns.

## Investigation findings

Verified 2026-11-09 against the live world (PF2e 8.5.0, Foundry core 14.368).

- **Live probe.** A real evaluated `DamageRoll("2d6 + 4[slashing]")`, then `roll.alter(m, 0)`: for `m` of 1.5, 2 and 0.5 the returned value is a different `DamageRoll` object, `_evaluated === true`, with formula `1.5 * (2d6 + 4)` / `2 * (2d6 + 4)` / `0.5 * (2d6 + 4)` and a scaled total (e.g. 7 → 10, 9 → 18, 12 → 6). The original roll's `total` and `formula` are unchanged after the call.
- **Source.** `pf2e.mjs` ~1293-1329: on an evaluated roll with instances, `alter` builds new instances and `return DamageRoll.fromTerms([InstancePool.fromRolls(i)])`. Only an unevaluated roll falls through to `super.alter` (Foundry core's, which also returns a roll); in no case does it mutate in place and return nothing.
- **The three broken sites** (all `await damageRoll.alter(...)` with the result unused, then `applyDamage({ damage: damageRoll })`):
  1. `rollAndApplyStrike`, `scripts/dungeon-combat.mjs` ~5474: `alter(1.5, 0)` for a hit-deck "Triple damage" card on a crit (#61).
  2. `rollAndApplyStrikeAtVariant`, ~7851: the same.
  3. `castAttackSpellAndApplyRoll`, ~8253: `alter(Math.max(damageMultiplier, 2), 0)`, the #79 crit floor for a spell-attack crit.
- **Effect today.** A Strike crit with a Triple card applies 2× (3× intended; after #1284), a spell-attack crit applies 1× (2×/3× intended), because `spell.rollDamage()` does not pre-double.
- **Every other `alter()` caller is correct** and uses the returned roll: basic-save halving/doubling (~7932-7934, ~8137-8139, ~8775-8777, ~8848-8850) and `trap-combat.mjs` ~277.
- **Why the tests missed it.** The affected tests give the fake roll an `alter` that records its arguments and returns `undefined` (as if it mutated in place), then assert only that `alter` was called with the right multiplier (`tests/dungeon-combat-cast-attack-spell.test.mjs` ~104-124, `tests/dungeon-combat-reactive-strike.test.mjs` ~423-445, ~458-474). Nothing checks which roll reaches `applyDamage`.

## Resolved decisions

1. **Apply the returned roll.** At each site: `const finalRoll = multiplier ? await damageRoll.alter(...) : damageRoll`, then Shield Block (Strikes) and `applyDamage` use `finalRoll`. No new helper; three small edits, each next to its own multiplier rule (the #75 comment already argues that this math differs per caller and should stay at the call site).
2. **Fix the tests, not just the code.** The fake `alter` returns a distinct altered roll; assertions check that `applyDamage` received that altered roll for a Triple card and a spell crit, and the **original** roll when no scaling applies (Double card, plain hit).
3. **Source guard.** A test fails on any statement-position `alter()` whose result is discarded (`^\s*(await )?x.alter(...);`), so the mistake cannot return. It matches exactly the three current sites and none of the correct callers.
4. **Known, accepted limitation:** the damage chat message PF2e already posted shows the pre-scale roll (it is created before `alter`), so on a Triple card or a spell crit the card shows 2× / 1× while the applied amount is 3× / 2×. Basic-save scaling already behaves this way. Re-posting a corrected message is out of scope.
5. **Correct the #61/#75/#1284 comments** that describe the scaling so they match the code.

## Design

Strike sites (both), replacing

```js
if (damageMultiplier === 3) {
  await damageRoll.alter(1.5, 0);
}
```

with

```js
const finalRoll = damageMultiplier === 3 ? await damageRoll.alter(1.5, 0) : damageRoll;
```

and passing `finalRoll` to `resolveShieldBlockForHit(...)` and `applyDamage({ damage: finalRoll, ... })` in place of `damageRoll`.

Spell-attack site, replacing

```js
if (damageMultiplier != null) {
  await damageRoll.alter(Math.max(damageMultiplier, 2), 0);
}
```

with

```js
const finalRoll = damageMultiplier != null ? await damageRoll.alter(Math.max(damageMultiplier, 2), 0) : damageRoll;
```

and applying `finalRoll`.

## Testing

- **Existing tests updated** (`dungeon-combat-cast-attack-spell`, `dungeon-combat-reactive-strike`, plus any that fail): fake `alter` returns `{ total: ..., altered: true, from: <original> }`; Triple/spell-crit assertions add `expect(applyDamageCalls[0].damage).toBe(<the altered roll>)`; the Double-card and plain-hit assertions add `damage` is the original roll and `alter` was not called. These assertions must fail on the old code.
- **Source guard (`tests/damage-roll-alter-guard.test.mjs`):** reads `scripts/**/*.mjs` and fails on any statement-position `.alter()` call; includes a positive self-check that the pattern matches the bug shape and does not match `const x = await r.alter(...)` or a ternary.
- **Live check (required before closing):** on the live world, (a) an AI NPC crit that draws a Triple-damage card ("Disembowel") loses HP equal to 3× the single roll; (b) an AI spell attack that crits loses 2× the single roll. The issue moves to `verification` after merge.

## Out of scope

- Re-posting a corrected damage chat message (decision 4).
- The critical-hit deck content or draw rules; spell damage that is not an attack roll.
- Backfilling damage in past combats.
