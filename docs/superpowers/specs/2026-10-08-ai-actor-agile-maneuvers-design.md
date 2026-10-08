# Advanced AI Actors: Agile Maneuvers (Lower MAP on Maneuvers)

**Issue:** #919 — AI actors: Agile Maneuvers (lower multiple attack penalty on maneuvers).

**Builds on:** #940 (maneuver MAP accounting — the foundation this spec modifies), #911 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuver-variants-design.md` (the feat-modifier table), and #909 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuvers-design.md` (the maneuver executor).

**Status:** Approved. Scope questions were answered by the owner on 2026-10-08 (see "Resolved decisions"). This spec cannot be implemented before #940, which supplies the baseline penalty it lowers.

## Summary

Agile Maneuvers (Swashbuckler, level 6, prerequisite: expert in Athletics) lowers the multiple attack penalty (MAP) on the Disarm, Grapple, Reposition, Shove and Trip actions: –4 on the second attack of the turn and –8 on the third or later, even if the weapon is not agile; and when the weapon or unarmed attack **is** agile and the actor has **panache**, –3 and –6. The PF2e system has no handling for it: the feat has `rules: []` and its slug appears nowhere in `pf2e.mjs`.

#940 adds baseline MAP accounting for the AI's maneuvers: a modifier computed from the turn's `mapIncrement` (–5/–10, or –4/–8 for an agile weapon) passed to the maneuver macro, and `mapIncrement` bumped after each `attack`-trait maneuver. This spec adds one entry to the #911 modifier table that replaces that penalty with the lower Agile Maneuvers values, including the panache branch.

## Investigation findings

Confirmed against this repo, the installed PF2e system (`pf2e.mjs`) and the local PF2e source data.

- **Feat text.** "Your Disarm, Grapple, Reposition, Shove, and Trip actions have a lower multiple attack penalty. Even if your weapon or unarmed attack doesn't have the agile trait, the penalty is –4 if the action is your second attack on your turn, or –8 if it's your third or subsequent attack. If your weapon or unarmed attack is agile and you have panache, the penalty is reduced further, to –3 if it's the second attack on your turn or –6 if it's the third or subsequent." No rule elements; prerequisite expert in Athletics.
- **The system's own MAP mechanism for strikes** is `calculateMAPs(item, { domains, options })`: –5/–10 by default, –4/–8 when the item (action, melee or weapon) has the `agile` trait, and it takes the highest (least negative) of that default and any `MultipleAttackPenalty` rule-element synthetics for the roll's domains. The `MultipleAttackPenalty` rule element exists for feats to lower MAP on specific selectors, but Agile Maneuvers does not use it.
- **Action macros apply no MAP on their own.** `game.pf2e.actions.disarm/trip/grapple/shove(...)` build a check context from the actor's statistic and forward only caller-supplied `modifiers`. `ActionUse#use` also accepts a `multipleAttackPenalty` count (it converts to –5/–10 itself and ignores agile). So for these macros the caller supplies the penalty; hence #940.
- **The weapon used for a maneuver** is chosen by the system's own `getBestEquippedItemForAction(actor, [slug], statisticSlug)` (the same helper `disarmCheckContext`/`grappleCheckContext` call). Its result carries the `agile` trait if relevant. The module should call or mirror this helper, not pick a weapon itself (#909's existing guidance).
- **Panache** is an effect item (`feat-effects/effect-panache`, slug `effect-panache`) present on the actor while active. Checking for it is an `actor.itemTypes.effect` slug lookup.
- **Existing module MAP state:** `turnState.mapIncrement` counts attacks this turn (0 = first attack). Strikes use the system's variant index; maneuvers currently neither suffer nor increment (the gap #940 fixes).

## Resolved decisions

1. **Foundation first.** The baseline maneuver MAP accounting is a separate issue (#940); this spec only modifies the penalty amount, so it is small and depends on #940.
2. **The panache branch is in scope.** Use –3/–6 when the weapon (or unarmed attack) used is agile and the actor has the Panache effect; –4/–8 otherwise.
3. **Coverage:** the four maneuvers the AI performs that carry the `attack` trait — Trip, Shove, Grapple, Disarm. Reposition is not one of #909's maneuvers, so it is not modeled here. Demoralize has no `attack` trait and no MAP.

## Design

### Where it plugs in

The #911 modifier table (`scripts/maneuver-feat-modifiers.mjs`) gains a third modifier kind alongside `eligibility` and `rider`: **`mapPenalty`**. #940 introduces a pure function that returns the MAP modifier for an attack number; this spec makes that function consult the table.

```
maneuverMapPenalty({ attackNumber, weaponIsAgile, featSlugs, hasPanache }) -> number
```

- `attackNumber` is the turn's `mapIncrement` + 1 before the maneuver (1 = first attack, no penalty; 2 = second; 3+ = third or later).
- Base (#940): first attack 0; second –5 (–4 agile); third+ –10 (–8 agile).
- With Agile Maneuvers in `featSlugs`: second –4 / third+ –8 regardless of the weapon; if `weaponIsAgile` **and** `hasPanache`: second –3 / third+ –6.
- The function takes the least negative of the base and the Agile Maneuvers result, so the feat can only ever help.

### Feat detection

`featSlugs` is read once per turn from `actor.itemTypes.feat` slugs, as in #911's `maneuverEligibilityFor`. `hasPanache` is `actor.itemTypes.effect.some((e) => e.slug === "effect-panache")`. `weaponIsAgile` comes from the weapon returned by the system's `getBestEquippedItemForAction` for the chosen maneuver (`item.traits.has("agile")`), or `true` for an unarmed attack that has the agile trait (e.g. a monk-style fist); if no item is returned (unarmed, no special attack), `false`.

### Execution

`applyAgentDecision`'s `maneuver` branch (as amended by #940) computes `maneuverMapPenalty(...)` before rolling, passes it as an explicit `modifiers` entry (label "Multiple Attack Penalty", numeric modifier) to `game.pf2e.actions[slug]({ ... modifiers })`, and bumps `turnState.mapIncrement` after the roll. This spec changes only the number passed in.

### Reporting

The GM whisper for the maneuver names the penalty applied and, when it differs from the baseline, that Agile Maneuvers (and panache) changed it.

## Error handling

- Feat or effect data unreadable → treat as absent (baseline penalty applies); never default to the more favorable value.
- No weapon returned by the system helper → `weaponIsAgile = false`.
- A failure computing the penalty falls back to the baseline #940 value and is logged; the maneuver still proceeds.

## Testing

- `maneuverMapPenalty` (pure): first attack (0); second/third attack, with and without the agile weapon, with and without Agile Maneuvers, with and without panache (every combination); the result is never more negative than the baseline; unknown/unreadable inputs fall back to baseline.
- Executor (mocked Foundry): the explicit modifier passed to `game.pf2e.actions.trip/shove/grapple/disarm` equals the computed value for each combination; `mapIncrement` increments exactly once per maneuver; Demoralize gets no modifier and no increment.
- Live verification on an AI Swashbuckler with Agile Maneuvers: a Trip as the second attack shows –4 in the roll breakdown (and –3 with an agile weapon and Panache active).

## Explicitly out of scope

- The baseline MAP accounting itself (#940).
- Reposition (not one of #909's five maneuvers).
- Other MAP-reducing feats and the `MultipleAttackPenalty` rule element (the system already honors those for strikes; maneuvers can be extended to read synthetics later).
- Granting or maintaining Panache (the AI only reads whether the effect is present).

## Open questions

None. Implementation details left to planning: the exact shape of #940's helper signature this spec extends, and whether `weaponIsAgile` for unarmed attacks should read the unarmed item's traits via the same helper or a direct lookup.
