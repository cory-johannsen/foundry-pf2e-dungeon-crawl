# Advanced AI Actors: Mythic Point Tracking and Mythic Feat Actions

**Issue:** #1117 — mythic point tracking for mythic feat actions, deferred from #998.

**Builds on:** #998 / `docs/superpowers/specs/2026-10-09-ai-actor-archetype-mythic-feat-actions-design.md` (the reviewed `ARCHETYPE_MYTHIC_ALLOWLIST`, the audit script, the "mythic point text → not offered" gate this spec relaxes), #947 / `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md` (feat-action shapes), #1034 / `docs/superpowers/specs/2026-10-09-ai-reaction-check-roll-wrapper-design.md` and #1035 / `docs/superpowers/specs/2026-10-09-ai-reaction-async-reroll-interception-design.md` (the `Check.roll` wrapper, `decide`/`commit`, reroll mechanics), #953 (AI history), #925 (result descriptor), `scripts/dungeon-scene.mjs`'s rest flow (`game.pf2e.actions.restForTheNight`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#998 lets AI actors use archetype and mythic targeted feat actions but deliberately excludes any mythic feat whose text spends a **Mythic Point**, because the module does not track them. This spec makes AI actors **read and spend the PF2e system's own mythic-point resource**, so point-spending mythic feats can be offered, spent on, and reasoned about; it also adds **Rewrite Fate rerolls**, **calling-specific point gain triggers**, a **daily refill** through the module's rest flow, and **points in the AI action history**.

## Investigation findings

Confirmed against the installed PF2e system (v8.5.0) and the Paizo/Archives of Nethys mythic material.

- **The system already tracks the counter.** Character actors have `system.resources.mythicPoints` with `value` and `max`; `max` is 3 when the actor has the `mythic` trait and 0 otherwise (`prepareBaseData`: `max: traits.value.includes("mythic") ? 3 : 0`, `value` defaulting to 3). The character sheet shows it as a header resource, and the chat card menu offers a **mythic point reroll** (`canMythicPointReroll`) when `mythicPoints.value > 0`. No new storage is needed.
- **Mythic rules (Paizo).** A mythic **Calling** defines how its character spends and regains points, grants **Rewrite Fate** (spend a point to reroll a check or save made at mythic proficiency) and edicts/anathema. Mythic proficiency is +10 (above legendary). Mythic feats carry the `mythic` trait and can be taken only by mythic characters. No character can have more than 3 Mythic Points. Feats extend spending: *Telling Blow* — "Spend a Mythic Point" to make a mythic-proficiency Strike and spend more points for extra damage dice; *Avenger of Envy* grants a point the first time each day you critically fail a skill check or saving throw.
- **#998's gate.** Any mythic feat text that spends or refers to Mythic Points is "not offered"; this spec is the follow-up that lifts it for reviewed slugs.
- **Rest flow.** The module's dungeon rest calls `game.pf2e.actions.restForTheNight({ actors, skipDialog: true })`; the system's rest does not restore mythic points, because regaining is calling-defined.
- **Reroll plumbing exists.** #1034/#1035's wrapper holds and rerolls checks and saves via the system's `Check.rerollFromMessage`, which already supports a resource-specific reroll for hero points; the mythic-point menu entry shows the system accepts the same for mythic points.

## Resolved decisions

1. **Counter source:** the system's own `system.resources.mythicPoints`; no module-owned counter.
2. **Variable spend:** one candidate per affordable spend level, with deterministic summaries, and the model picks.
3. **Which feats:** extend #998's reviewed allowlist with owner-approved point-spending slugs, ranked by the audit; shapes only, all-or-nothing as in #998.
4. **All four extras are in scope** (no follow-up tickets): Rewrite Fate rerolls for AI actors, calling-specific point gain triggers, a daily refill through the rest flow, and points in the AI action history.

## Design

### Reading and spending (`scripts/mythic-points.mjs`)

```js
mythicPoints(actor) → { value, max }            // reads system.resources.mythicPoints
canSpendMythic(actor, n) → boolean              // actor is a character with value >= n
spendMythic(actor, n, { reason }) → { before, after }
gainMythic(actor, n, { reason }) → { before, after } // clamped to max
```

Spending and gaining write `system.resources.mythicPoints.value` through `actor.update`, clamped to `0..max`, and are no-ops for actors without the resource or with `max === 0`. Only character-type actors with the `mythic` trait are mythic; other actors never see mythic candidates.

### Point-spending mythic feats (extends #998)

- **Audit.** The #998 audit script gains a `spendsMythicPoints` column and, for each such feat, the **base cost** and whether the text lets the actor **spend more** (and what the extra buys), parsed from the closed phrases `Spend a Mythic Point`, `Spend 1 Mythic Point`, and `spend one or more additional Mythic Points`; rows the phrases don't consume stay `unsupported`.
- **Allowlist.** Approved slugs join `ARCHETYPE_MYTHIC_ALLOWLIST` with metadata `{ mythicCost: n, extraSpend?: { max, per: <effect> } }`. The #998 gate becomes: point-referencing text is not offered **unless** the slug is allowlisted with `mythicCost`.
- **Vocabulary.** For an allowlisted feat, the candidate list includes one entry per affordable spend level `k` from `mythicCost` to `min(points on hand, mythicCost + extraSpend.max)`: ids `feat:<slug>:<targetId>:spend<k>`, summaries naming the points ("Telling Blow (2 Mythic Points): mythic-proficiency Strike, +1 extra damage die"). A feat is dropped from the list if `canSpendMythic` fails.
- **Execution.** `applyAgentDecision` validates the id by literal membership, re-checks `canSpendMythic(actor, k)`, spends the points **before** the effect (so a failed effect refunds them), runs the feat through its #947 shape with `extra: k − mythicCost` extra-spend units applied (for example extra damage dice through the shape's `extraDice` input), and reports `{ spent: k, before, after }` in the result descriptor.
- **Refund on failure.** If the shape fails before resolving (no legal target, a missing rule), the points are returned with `gainMythic` and the action is not spent, matching #998's failure path.

### Rewrite Fate (extends #1034/#1035)

A mythic AI actor's failed or critically failed check or save made **at mythic proficiency** may be rerolled by spending a point. Eligibility: the actor is a mythic character with `value ≥ 1`, the roll's proficiency rank is mythic (the roll context's proficiency modifier shows the +10 bonus), and the actor has the Rewrite Fate ability item. The decision follows #1034's `decide`/`commit` path: after the failed roll the wrapper asks `decideRewriteFate(rollContext, actor)` which accepts when the failure matters (a save with a damaging or incapacitating effect, or a check whose failure would waste a resource) and always when the roll is a critical failure; if accepted, `commit` spends one point and calls the system's reroll with the mythic-point resource (`Check.rerollFromMessage(message, { resource: "mythic-points" })`), keeping the system's own keep-higher/lower semantics. The AI never rerolls twice per roll, and the hold uses #1035's timeout.

### Calling-specific point gains

A small reviewed table `data/mythic-point-gains.json` lists in-play gain triggers by feat slug, for example `{ slug: "avenger-of-envy", trigger: "firstCritFailPerDay", amount: 1, kind: "check|save" }`. A hook on the system's check/save outcome messages evaluates the table for the actor's feats and calls `gainMythic` once per trigger window (per-day windows are tracked in an actor flag cleared by the rest flow). Slugs outside the table are ignored; the table is chosen and approved at planning time from the audit.

### Daily refill

After `restForTheNight` completes in the module's rest path, the module restores each mythic party member's points to the **starting value its calling grants**, read from the calling item's rules when present (a `ResourceRule`/flag), else to the system's `max` (3). It also clears the per-day gain-trigger flags. Actors that are not mythic are untouched. Failure to read the calling falls back to `max` and notes it to the GM.

### AI history

The #953 action record gains `{ mythicSpent, mythicBefore, mythicAfter }` for any action that spent or gained points (feats, Rewrite Fate, gain triggers); the formatter appends "(spent N mythic points, M left)" and the GM journal page shows the full record.

## Error handling

- A point write that fails leaves the action unspent and reports to the GM; no partial spend.
- An actor with `max === 0` or without the `mythic` trait never gets mythic candidates; a forged pick fails literal membership.
- A candidate that was affordable at list time but not at execution (a reaction spent a point in between) is rejected and the action is not spent.
- A refund is idempotent per use id; a double refund is ignored.
- A calling item that can't be read falls back to the system default and says so.
- Hooks never throw into the combat turn.

## Testing

- **`mythicPoints` helpers:** read, spend, gain with clamping; no-ops for non-mythic/NPC actors; refund idempotence.
- **Audit/allowlist:** point-spending rows classified with base and extra spend; the allowlist test asserts every slug parses and carries `mythicCost`; text referring to points but not allowlisted stays not offered.
- **Vocabulary:** one entry per affordable spend level, none when unaffordable, ids and literal validation, summaries.
- **Execution (mocked Foundry):** points spent before the effect, refunded on shape failure, extra spend units applied, result descriptor contents.
- **Rewrite Fate:** eligibility (mythic proficiency, ability, points), accept/decline rules, one reroll per roll, spend on commit, system reroll called with the mythic resource, timeout fallback.
- **Gain triggers:** table-driven gain once per day window, clamped at 3, window cleared by rest.
- **Daily refill:** restores to the calling's starting value or `max`, clears flags, leaves non-mythic actors alone.
- **AI history:** record fields and formatter output.
- **Regression:** #998/#947 behavior for non-mythic feats unchanged; hero-point and reaction-reroll paths unchanged.
- **Live verification:** an AI mythic character spending points on an allowlisted mythic feat at two spend levels, rerolling a failed save with Rewrite Fate, gaining a point from a trigger, and refilling after the party rests; sheet and chat reflect the counts.

## Explicitly out of scope

- Mythic point use by human players beyond the system's own controls.
- Archetype override entries (#1118) and kinetic/spellshape state (#1120).
- Mythic proficiency math and mythic callings' other features (edicts, hard-to-kill) — the system's rule elements handle numbers; the module adds no new rules.
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the exact allowlist (chosen from the audit by the owner), how the roll context exposes mythic proficiency, where calling regain data lives on the calling item, and the gain-trigger table's first entries.
