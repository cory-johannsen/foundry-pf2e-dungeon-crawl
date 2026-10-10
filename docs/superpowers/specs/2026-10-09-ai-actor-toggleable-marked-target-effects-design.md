# Advanced AI Actors: Toggleable Action-Conditional Marked-Target Effects

**Issue:** #1046 — toggleable action-conditional marked-target effects (Harsh Judgement, Nothing Personal).

**Builds on:** #946 / `docs/superpowers/specs/2026-10-08-ai-actor-marked-target-widening-design.md` (`classifyTargetEffect`, `targetedSelfEffect` vocabulary, the `unsupported` bucket for toggleable effects), #922 (marked-target entries, TokenMark `uuid` pre-fill), #990 / `docs/superpowers/specs/2026-10-09-ai-actor-devise-stratagems-design.md` (the RollOption selection precedent), #909/#911 (Seek, Demoralize, skill-check actions), #914 (agent-effect tagging).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#946 classifies any marked-target effect that carries a `toggleable: true` `RollOption` as `unsupported`, because binding the mark without ever flipping the toggle leaves the actor *worse off* (Harsh Judgement's standing −1). This spec makes those effects offerable: the module **automatically sets the toggle on whenever the action it benefits is chosen against the marked target** (deterministic wiring, no model choice), and **offers the effect only when a toggle-benefiting action is plausibly available**. A population audit of `feat-effects` finds every toggleable marked effect and handles the ones whose toggle maps cleanly onto one action type.

## Investigation findings

Read from the compendium.

- **Harsh Judgement** (`effect-harsh-judgement`): duration unlimited. Rules: a toggleable `RollOption` `harsh-judgement:seek-condemned-foe` (domain `perception`); a `FlatModifier` −1 on `perception` when `action:seek` (slug `harsh-judgement-seek`); an `AdjustModifier` +2 on that modifier when the toggle is on; a `TokenMark` `harsh-judgement`; a `FlatModifier` −1 on `intimidation` for `action:demoralize` and an `AdjustModifier` +2 when `target:mark:harsh-judgement`. So **Demoralize is automatic** against the marked creature (the mark predicate), while **Seek needs the toggle** to cancel its −1 (net +1 against the marked foe). Not flipping the toggle means every Seek costs −1.
- **Nothing Personal** (`effect-nothing-personal`): duration 1 hour, `turn-start` expiry. Rules: `TokenMark` `nothing-personal`; a toggleable `RollOption` `nothing-personal-first-strike` (domain `strike-damage`); `DamageDice` on `weapon-damage` when `target:mark:nothing-personal` **and** the option is on. The extra weapon die applies only to the **first Strike of the round** against the impediment, via the toggle.
- **Population.** `feat-effects` contains 48 effects with `toggleable: true`; the 13 marked (`TokenMark`) effects include these two. The audit determines how many other marked effects carry toggles and whether each toggle maps to a single action type.
- **Toggle mechanism.** The PF2e system exposes `ActorPF2e#toggleRollOption(domain, option, itemId, value, suboption)` (it appears in `pf2e.mjs`) which sets the item's rule-element toggle state; the roll-option is then in the roll's option set for later rolls in that domain. Setting it for one action and clearing it afterwards keeps the effect's other behavior unchanged.
- **Related precedent.** #990 pre-sets a RollOption `selection` on the effect source because the stratagem choice is a *creation-time* choice; these toggles are *per-action* flags that must be flipped around individual rolls.

## Resolved decisions

1. **Automatic toggle wiring, no model choice.** The toggle has no downside when applied only to the action it is for, so it is a deterministic effect of choosing that action against the marked target.
2. **Offer rule:** the effect is offered only when a toggle-benefiting action against that target is plausibly available this turn (for Harsh Judgement, a Seek/Demoralize candidate vs the target; for Nothing Personal, a Strike candidate vs the target and the first-strike condition not yet used). The entry's summary states the standing penalty (Harsh Judgement: −1 on every Seek).
3. **Audit-driven coverage:** every toggleable marked effect the audit finds whose toggle maps cleanly onto one action type is handled via a declarative table; the others stay `unsupported`.

## Design

### Declarative toggle table (`scripts/marked-toggle-effects.mjs`)

```js
export const MARKED_TOGGLE_EFFECTS = {
  "harsh-judgement":  { option: "harsh-judgement:seek-condemned-foe", domain: "perception",     action: "seek",   scope: "perAction", penaltyNote: "-1 to every Seek (+2 vs the marked foe with the toggle)" },
  "nothing-personal": { option: "nothing-personal-first-strike",     domain: "strike-damage", action: "strike", scope: "firstPerRound", penaltyNote: null },
};
```

`scope: "perAction"` means set before the action's roll and clear after; `scope: "firstPerRound"` means set only for the first matching action of the round (the table also names the per-round counter key). Entries are generated from the audit and reviewed once; a fixture asserts each entry matches the effect's rule elements, so an upstream change disables it.

### Classification (`classifyTargetEffect` change in #946)

A marked effect with toggleable `RollOption` rules is `marked` (offerable) when **every** toggle belongs to an entry in `MARKED_TOGGLE_EFFECTS` and no other unresolved toggles exist; otherwise it stays `unsupported`. The vocabulary entry's `effectSummary` includes the `penaltyNote`.

### Offer gating (`buildFeatVocabulary`)

For toggle effects, the `targetedSelfEffect` entry for target `T` is offered only if the actor has a plausible beneficiary: an in-turn Seek or Demoralize candidate whose target is `T` (Harsh Judgement), or a Strike candidate against `T` (Nothing Personal). The check reads the same candidate lists the turn is built from, so no extra computation.

### Executing the toggle (`applyAgentDecision`)

Before executing a skill-check action, a maneuver or a Strike candidate whose target is the marked creature:

1. Look up the actor's active marked-toggle effects (effects tagged `agentSelfEffect` with a slug in the table).
2. For each whose `action` matches the candidate's action type and whose scope allows it (`firstPerRound` uses a per-round counter in the turn state), call `actor.toggleRollOption(domain, option, effectItemId, true)`.
3. Execute the action (the roll's option set now contains the toggle).
4. In a `finally`, call `toggleRollOption(domain, option, effectItemId, false)` and, for `firstPerRound`, mark the round counter consumed on the first Strike that actually resolves.

The mark itself binds at creation, as #922/#946. Demoralize against the marked creature needs no toggle for Harsh Judgement (the `target:mark` predicate applies automatically).

### Result reporting

#925's descriptor reports the toggle as a rider ("Harsh Judgement toggle applied") so the log shows why the roll had the adjusted modifier.

### Audit (`tools/audit-toggle-marked-effects.mjs`)

Lists every `feat-effects` entry with a `TokenMark` and at least one toggleable `RollOption`, the toggle's domain and option, and the actions whose rolls the toggle's modifiers predicate on; classifies each as `table` (cleanly one action type), or `unsupported` (needs suboptions or multiple actions). Output is a fixture; the table's entries are exactly the `table` rows.

## Error handling

- `toggleRollOption` missing or failing: the toggle is skipped, the action still executes, and a GM note is logged (the penalty then applies as RAW).
- The effect expires between candidate build and execution: no toggle.
- Cleanup always runs in `finally`; stale toggles are also cleared at turn end and combat end (#914 cleanup).
- Not marked (the target differs): no toggle.

## Testing

- **Classifier:** toggleable marked effects in the table become `marked`; others remain `unsupported`.
- **Gating:** Harsh Judgement offered only with a Seek/Demoralize candidate vs the target; Nothing Personal only with a Strike candidate and an unused first strike.
- **Executor (mocked Foundry):** toggle set before and cleared after Seek/Strike; `firstPerRound` counter; failure paths leave the action running.
- **Rules check:** with the toggle the Seek modifier vs the marked target is +1 net, without it −1; Demoralize automatic.
- **Audit fixture:** table entries match the audited rows; changed rules disable an entry.
- **Live verification:** an AI actor with Harsh Judgement Seeks the marked foe (card shows the adjusted modifier) and Seeks another (−1 as RAW).

## Explicitly out of scope

- Toggle effects without a TokenMark (covered by #914/#946's other paths) and effects whose toggles carry suboptions (Devise's choice is #990).
- Model-chosen toggling (rejected; the toggle is deterministic).

## Open questions

None. Planning-time details: the exact `toggleRollOption` signature in the installed system and how the first-strike round counter is stored.
