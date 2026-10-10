# Advanced AI Actors: Affliction Save Abilities (Poison and Disease Exposure)

**Issue:** #1103 — abilities that expose creatures to a poison, disease or venom on a failed save, deferred from #988.

**Builds on:** #988 / `docs/superpowers/specs/2026-10-09-ai-npc-remaining-save-abilities-design.md` (the remainder inventory and reviewed override-table pattern), #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (outcome kinds, `applyOutcomeEffects`), #935 (outcome model, immunity), #915 (save executor, area membership), #1094 (human-turn prompts), #1096 (counteract detection), #914 (agent tagging).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

Some NPC abilities do not apply damage or conditions directly; they **expose** a target to a named poison or disease ("exposed to jungle drake venom") that is then a PF2e affliction with onset, stages and recurring saves. This spec adds the **exposure** outcome: resolve the named affliction (from the source creature or the compendium, with a reviewed fallback), apply it as the PF2e system's own affliction item, run the initial save, and keep the module out of the way afterward except for AI-controlled targets' recurring saves.

## Investigation findings

- **Affected abilities (real texts, `tests/fixtures/npc-save-ability-slice.json`).**
  - *Spit Venom* (Jungle Drake; poison trait): 50-ft range, 10-ft burst, Reflex DC 24 "or be exposed to jungle drake venom". `expected: None` (not offered); recharge 1d6 rounds.
  - *Flash Web* (Shriezyx): Reflex DC 20 or Immobilized *and* exposed to numbing toxin; also Sickened 1 that can't be reduced until it Escapes (DC 20). `reportOnly`.
  - *Steal Breath* (Kurobozu; incapacitation, occult): requires an adjacent Paralyzed/Slowed/Stunned/Unconscious living creature; Fortitude DC 22; "regardless of the result… exposed to black apoxia" plus degree outcomes (can't speak, Sickened 2…). `expected: None`.
- **The PF2e system supports afflictions natively.** The `affliction` item type has `system.stage`, `system.stages` (each with `conditions`, `damage`, `duration`), `system.onset`, `system.save`, with `increase()`/`decrease()` stage methods. A stage change applies the stage's conditions (linked to the affliction) and posts the stage damage; `createStageMessage()` posts the stage chat card. The module does not have to implement stage mechanics.
- **Exposure is not infection.** Per the rules, exposure grants the affliction's initial saving throw; the affliction only begins on a failure, at stage 1 (or the stage matching the degree). The ability's own save (Reflex DC 24 in Spit Venom) decides whether the target is exposed at all.
- **Machinery that exists:** #915's save executor and area membership, #987's `applyOutcomeEffects`, agent tagging, the compendium index for `bestiary-effects` and venom items, and (via #1094/#1096) action-tracker integration and counteract detection.

## Resolved decisions

1. **Affliction definition:** link the named affliction to an item on the source creature or its compendium entry and copy it to the target; for names that can't be resolved, a reviewed per-venom table entry authors the stages.
2. **Initial save:** create the system's affliction item on the target; AI-controlled targets roll the initial save automatically; for player characters the module posts the system's save prompt instead of rolling for them.
3. **Advancement:** system-driven — onset, stage timing and stage messages stay with the PF2e system; for AI-controlled targets the module rolls each recurring save and applies the result through `increase()` / `decrease()`; players use the system's prompts.
4. **All four extras are in scope** (so no follow-up tickets): other "exposed to" abilities (Flash Web's numbing toxin, Steal Breath's black apoxia), immunity and repeat-exposure rules, counteract/treat integration, and affliction display in the AI log and effect list.

## Design

### Outcome kind `expose` (extends #987's `effects[]`)

`{ kind: "expose", affliction: "<name>", slug?, source: "sourceItem" | "compendium" | "table", saveOnExposure: true }` joins the closed discriminated outcome list. The grammar adds the closed patterns `be exposed to <name>`, `becomes <condition> and exposed to <name>`, and `Regardless of the result of its save, the creature is exposed to <name>` (an unconditional `expose` on every degree). Everything else in the ability text parses through the existing grammars; the all-or-nothing rule applies.

### Resolving the affliction

1. **Source item.** Look for an item on the source actor whose name matches `<name>` case-insensitively (creatures usually carry their venom as a separate item, for example "Jungle Drake Venom").
2. **Compendium.** Look in the PF2e `bestiary-effects` / affliction index for the same name; copy the item data.
3. **Reviewed table.** `data/npc-afflictions.json` (reviewed, with a fixture hash that disables the entry if the source text changes) defines the stages for names that neither lookup resolves: `{ name, traits, save: { type, dc }, onset, stages: [{ conditions, damage, duration }] }`. The table also holds the rows for Jungle Drake Venom, numbing toxin and black apoxia if neither lookup finds them.
4. An unresolved name leaves the ability `reportOnly` with the verbatim text whispered; the audit lists the blocker.

### Applying exposure (extends #915/#987's executor)

1. Run the ability's own save (when it has one); on the degrees that say "exposed", continue.
2. **Immunity.** If the target is immune to the affliction's traits (`poison`, `disease`), post "unaffected" and stop. If it already carries an affliction with the same slug, the repeat-exposure rule applies: the existing affliction is not restarted (the PF2e rule), and a note is posted; a source-specific "worsens on repeat exposure" flag is honored when the affliction defines it.
3. **Create the affliction** on the target with the copied data, origin = source, agent tag, `system.stage` set to 0 (exposed, awaiting the initial save).
4. **Initial save.** AI-controlled target: the module rolls the affliction's save through the system and sets the stage by degree (success: no affliction, remove the pending item; failure: stage 1 after the onset; critical failure: stage 2 where the affliction defines it). Player character: the module whispers the owner and GM the system's save prompt (chat card with a save button) and applies the result when the system updates the item.
5. Other outcome pieces (Immobilized, Sickened, can't speak) apply through the normal helpers on the same use.

### Recurring saves and stages (AI targets only)

- On each AI-controlled affected combatant's turn change (and at the affliction's stage-duration boundary), the module rolls the recurring save through the system, then calls `increase()` on a failure (twice on a critical failure) or `decrease()` on a success (twice on a critical success). The system applies the new stage's conditions and damage. Player characters use the system's own stage prompts.
- Outside combat the existing time-advance flow (the module's rest/exploration clock) triggers the same checks; an affliction that survives combat end stays on the actor (it is not combat-scoped), while exposures that never started are cleaned up at combat end.

### Counteract and treat integration

The #1096 counteract auto-detector also recognizes counteract results aimed at an affliction item (counteract level and DC from the affliction) and removes it on success. A Treat Disease/Treat Poison skill-action result from the system's chat message is read and applied as a ±1 stage change or a save bonus per the rules (success: +2 circumstance to the next save; critical success: +4; critical failure: –2, per the action's own text). Anything not recognized is left to the GM.

### Display

The AI action history (#953) and the affliction's effect row show: affliction name, stage, next save and onset. The effect row uses the system's own affliction rendering; the AI log line is a one-sentence summary appended to the usage record.

## Error handling

- Resolution failures keep the ability `reportOnly`; a table entry whose fixture hash mismatches is disabled until re-reviewed.
- A save roll failure leaves the pending affliction and posts a "roll again" prompt.
- Counteract and treat parsing failures are ignored and logged; the GM can edit the stage by hand.
- Hooks never throw into the combat turn, and an affliction in an unreadable state is skipped, not deleted.
- A repeat exposure never resets stage or duration unless the affliction says so.

## Testing

- **Parser:** Spit Venom, Flash Web, Steal Breath; `be exposed to`, `and exposed to`, `Regardless of the result… exposed to` patterns; a near-miss stays `reportOnly`.
- **Resolution:** source-item hit, compendium hit, reviewed-table fallback, unresolved name; fixture-hash disabling.
- **Application (mocked):** immunity short-circuit, repeat-exposure no-restart, pending affliction creation, AI initial save by degree, player prompt posted.
- **Recurring saves:** stage increases on failure (two on critical), decreases on success, stage conditions/damage applied by the system (stubbed), players untouched.
- **Combined outcomes:** Flash Web's Immobilized and Sickened plus exposure; Steal Breath's unconditional exposure with degree effects and its adjacency requirement.
- **Counteract/treat:** a counteract success removes the affliction; a Treat Poison result adjusts the save; unknown results are ignored.
- **Display:** the AI log summary line and effect row content.
- **Regression:** #915/#935/#987/#988 tests and the audit ratchet; abilities that were `auto` stay `auto`.
- **Live verification:** a jungle drake's Spit Venom on an AI creature (initial save, stages, recurring saves) and on a player character (prompt), a counteract removing it, an immune target ignoring it.

## Explicitly out of scope

- Sustained effects (#1102), area forced movement and mixed zone-plus-save abilities (#1104), random outcomes that cast spells (#1105).
- Authoring afflictions beyond the table's reviewed entries; poison items in a player's inventory; curse-style afflictions.
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the exact fields of the affliction item the module copies (matched against the installed PF2e 8.5.0 schema), how the initial-save degree maps to the starting stage for each affliction, and where the recurring-save hook sits in the existing turn hooks.
