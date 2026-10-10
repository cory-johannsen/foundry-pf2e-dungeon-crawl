# Advanced AI NPCs: Check-Then-Heal (Morlock Tinker)

**Issue:** #1176 — a check-then-heal executor for NPC heals that use a skill check, deferred from #1056.

**Builds on:** #1056 / `docs/superpowers/specs/2026-10-09-ai-npc-ally-heal-dero-medicine-design.md` (the self-or-adjacent-ally heal executor, `npcAllyHeal` vocabulary, ranking), #981 (ally enumeration), #909 (skill-check candidates and rolls), #935 (degree outcome grammar and `applyTimedEffect`), #934 (heal application, requirement predicates), #928 (self-heal executor), #914 (agent tagging), #925 (result descriptor), #1019 / #1156 (the `afterDamageApplied` seam style).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#1056 added a general self-or-adjacent-ally heal and modeled Dero Medicine, a flat heal. It deferred the **check-based** variant because it believed no compendium ability used one. That is no longer true: the **Morlock Tinker family** rolls a Crafting check against a construct's or hazard's Fortitude DC and heals (or, for the engineer, damages) by degree. This spec adds a **check-then-heal executor** built around those abilities: it enumerates legal targets and modes, rolls the check through the system, applies the degree outcome (healing, damage, a timed attack bonus, or self-damage), and enforces the target-level gate and the "once until Repaired" limit.

## Investigation findings

Real texts from `tests/fixtures/npc-self-ability-slice.json`. All are 2-action abilities with no traits and no frequency.

- **Instinctual Tinker** (Morlock, Warped Brew Morlock, Vool): the morlock tinkers with an adjacent construct or mechanical hazard and attempts a Crafting check against its Fortitude DC. "The morlock can't succeed if the target's level is more than double the morlock's." Critical success: target gains **4d6** HP and a **+1 circumstance bonus to attack rolls for 1 minute**; success: **2d6** HP; critical failure: the morlock takes **2d6** untyped damage (typically bludgeoning, piercing or slashing). Linked effect: *Effect: Instinctual Tinker (Critical Success)*.
- **Uncanny Tinker** (Morlock Engineer): same check; "can't get an outcome **better than failure** if the target's level is more than double the morlock's." Critical success: **8d6** HP and the +1 attack bonus for 1 minute, **or** the morlock deals **8d6** untyped damage (bludgeoning, piercing or slashing as chosen) to the construct or hazard; success: as critical success but **4d6** HP or 4d6 damage; critical failure: the morlock takes **3d6**. "This ability reflects hasty battlefield repairs; once a construct or hazard regains Hit Points from this ability, it can't do so again until it's been Repaired." Linked effect: *Effect: Uncanny Tinker*.
- **Not part of this spec:** Vool's extra use (repair a broken wooden stake pick, Crafting DC 20) is #1249.
- **Existing pieces.** #1056's executor, ally enumeration/ranking and heal application (capped at max HP); #909's pattern for rolling a skill check through the system and reading the degree; #935's degree grammar and timed effects; native `Effect` items in `bestiary-effects` for the +1 bonus; the module's hazard handling for tokens that are hazards (HP, Fortitude DC).

## Resolved decisions

1. **Proceed now,** treating the Tinker family as the concrete target and generalizing it into a reusable check-then-heal executor.
2. **Foundry enumerates legal targets and modes; the model chooses.** Candidates are "Tinker: repair <ally>" and, for the engineer, "Tinker: damage <enemy>", with the level gate and repair limit checked up front.
3. **The repair limit is a flag on the target,** cleared by the Repair action (or a GM action).
4. **Extras in scope:** the target-level gate (each variant's wording), the +1 circumstance attack bonus effect, and critical-failure self-damage. **Filed:** Vool's wooden stake pick repair (#1249).

## Design

### Recognition (`scripts/npc-check-heal.mjs`, pure)

`parseCheckHeal(item)` returns `null` or:

```js
{
  cost, skill: "crafting", against: "fortitudeDC",
  targetKinds: ["construct", "hazard"], reach: 5,
  levelGate: { factor: 2, mode: "noSuccess" | "noBetterThanFailure" },
  repairLimit: boolean,
  degrees: {
    criticalSuccess: { heal?: formula, damage?: { formula, types[] , choice: boolean }, effectUuid?, durationSeconds? },
    success:         { heal?, damage? },
    failure:         null,
    criticalFailure: { selfDamage: { formula, type } }
  }
}
```

- The item must be an action (1–3 actions) whose text matches the closed phrase "tinkers with an adjacent construct or mechanical hazard … attempt a `@Check[<skill>|defense:fortitude]` check against the construct's or hazard's Fortitude DC", then a level-gate sentence in one of the two closed wordings, optionally the repair-limit sentence, and the four degree blocks parsed with #935's degree grammar (`@Damage[…[healing]]` as heal, `@Damage[…[untyped]]` damage, "Alternately, the morlock can deal …" as the damage mode, the `@UUID` of a `bestiary-effects` item as the timed effect, "the morlock injures themself, taking …" as self-damage).
- All-or-nothing: every sentence must be consumed. Variants with other wording stay not offered. The abilities in the fixture (Instinctual Tinker ×4, Uncanny Tinker) are pinned by fixtures.

### Vocabulary

New `npcCheckHeal` entries per legal target and mode (`heal` | `damage`):

- **Heal mode:** adjacent (reach 5 ft) allied constructs and hazards (creatures with the `construct` trait, or hazard tokens) that are below max HP, not dead or broken beyond repair, and not carrying the `tinkerRepaired` flag. Ranked lowest HP fraction first, capped at 3 (the #1056 rule).
- **Damage mode** (only when the parsed item has a damage option): adjacent enemy constructs and hazards. Ranked highest remaining HP fraction first, capped at 3.
- **Level gate.** Entries are filtered up front: with `mode: "noSuccess"`, a target whose level is more than double the actor's is not offered; with `mode: "noBetterThanFailure"`, the entry is offered with a summary note ("can't do better than failure: target level 9 > 2×4") and the check still rolls, with any better outcome downgraded to failure.
- **Summary:** "Tinker: repair <name> (Crafting vs Fortitude DC 22) — heal 2d6/4d6, +1 attack on crit" or "Tinker: damage <name> …", deterministic, listing the dice and the gate note.

### Execution (`applyAgentDecision`, `npcCheckHeal` branch)

1. Re-check requirements: adjacency, target legality, not repaired-flagged, level gate.
2. **Roll the check** through the system as #909 does: the actor's `crafting` skill against the target's Fortitude DC, with the target passed as the roll context; read the degree of success. Apply the level-gate downgrade (`noSuccess`: success and critical success become failure; `noBetterThanFailure`: any outcome better than failure becomes failure; a critical failure stays).
3. **Apply the degree** through existing helpers:
   - `heal`: roll the healing and apply it capped at max HP (#1056/#928 path); set `flags.pf2e-dungeon-crawl.tinkerRepaired = true` on the target when `repairLimit` and HP was actually restored.
   - `damage`: roll the untyped damage; for an engineer the type is chosen by the executor as bludgeoning (its default) unless the target's weaknesses make another type better, then applied through the normal damage path (so resistances apply and the #1156-style post-damage seams fire).
   - `effectUuid`: create the linked effect (`Effect: Instinctual Tinker (Critical Success)` / `Effect: Uncanny Tinker`) on the healed target for the stated duration (1 minute), agent-tagged and removed at combat end.
   - `selfDamage` on a critical failure: roll and apply untyped damage to the actor, defaulting the type to bludgeoning (the GM-discretion type is announced as "typically bludgeoning, piercing or slashing").
4. Announce publicly and return a #925 descriptor `{ degree, target, healed | damaged, effect, selfDamage }`.

### Repair limit

`flags.pf2e-dungeon-crawl.tinkerRepaired = { round, sourceId }` is set on a healed construct or hazard. It is cleared when the target is **Repaired**: the module listens for the system's Repair action result (the chat message for the *Repair* action from `pf2e.actionspf2e` on the target) and clears the flag on a success or critical success; a GM context action "Clear Tinker limit" does the same. The flag is not cleared at combat end, since the rule ties it to repair, not time.

### Effects

The +1 circumstance bonus to attack rolls uses the linked bestiary effect items. If the effect cannot be resolved from the compendium, the module builds an equivalent timed effect (a `FlatModifier` +1 circumstance to attack rolls, 1 minute) and says so in the debug log.

## Error handling

- A target that became illegal between listing and execution (killed, moved, flagged) rejects the candidate and the action is not spent.
- A check that fails to roll leaves the action unspent and reports; healing never exceeds max HP.
- Effect creation failures are logged and the rest of the degree still applies.
- Self-damage on a critical failure applies even if the target was destroyed meanwhile.
- A malformed parse leaves the ability not offered; the audit reports why.
- Hooks never throw into the combat turn.

## Testing

- **Parser (pure), real-text fixtures:** Instinctual Tinker (Morlock, Warped Brew Morlock, Vool) and Uncanny Tinker parse to the expected degree table and gate mode; the wording variants (`noSuccess` vs `noBetterThanFailure`), the repair-limit sentence, the damage option; near-misses stay `null`.
- **Vocabulary:** heal and damage targets, adjacency, construct/hazard filter, repaired-flag exclusion, level-gate filtering and the note, ranking and cap, deterministic summaries.
- **Execution (mocked Foundry):** degree outcomes for each variant, healing capped, the repair flag set only when HP was restored, damage through the normal path, effect creation, self-damage on critical failure, level-gate downgrades, failure to roll leaves the action unspent.
- **Repair limit:** the Repair action result clears the flag; the GM action clears it; the flag survives combat end.
- **Effects:** the linked bestiary effect applied, the fallback effect built when it is missing.
- **Regression:** #1056's flat heals and #909's skill checks unchanged; #935 grammar tests keep passing.
- **Live verification:** a morlock engineer repairs an allied construct (heal, +1 attack effect, repair flag) and damages an enemy construct; a morlock's tinker fails critically and takes self-damage; a target above double level is not offered or is downgraded; a Repair action clears the limit.

## Explicitly out of scope

- Vool's wooden stake pick repair (#1249).
- Check-based heals that use other skills or DCs beyond what the parser's closed phrase covers (they can be added as new phrases).
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: how hazard tokens expose HP and Fortitude DC in this module, the exact message shape of the system's Repair action result, and the heuristic for choosing a damage type against a target's weaknesses.
