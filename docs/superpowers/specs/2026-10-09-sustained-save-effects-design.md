# Advanced AI Actors: Sustained Save-Ability Effects

**Issue:** #1102 — save abilities whose effect lasts until the end of the source's next turn unless it Sustains (Haunting Melody and "can Sustain it" effects), deferred from #988.

**Builds on:** #988 / `docs/superpowers/specs/2026-10-09-ai-npc-remaining-save-abilities-design.md` (the remainder inventory and the reviewed override-table pattern), #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (outcome kinds, `applyOutcomeEffects`, forced movement), #935 (outcome model, `applyTimedEffect`, immunity windows), #915 (save executor, area membership), #914 (agent tagging and combat-end cleanup), the duration helper in `scripts/dungeon-combat.mjs` (`actorNextTurnEnd` / `actorNextTurnStart` expiries).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Several save abilities create an effect that **lapses at the end of the source's next turn unless the source Sustains it**, or that the source can Sustain to keep repeating. This spec adds the **sustainable save-ability** shape: target effects with a source-turn expiry, a **Sustain** action the AI source can choose, per-ability targeting rules, a round cap, compelled movement for fascinated targets, Dismiss and ally-designation riders, and escalating condition values on repeated failed saves.

## Investigation findings

Real texts from `tests/fixtures/npc-save-ability-slice.json`.

- **Haunting Melody** (Nosoi): 60-ft emanation, each living or undead creature saves (Will DC 18). "The effect lasts until the end of the nosoi's next turn, but the nosoi can Sustain it. A creature that succeeds at its save is temporarily immune for 24 hours. Despite being a mental effect, this ability affects mindless undead. Psychopomps are immune." Failure: Fascinated with the nosoi. Critical failure: also must spend each action moving closer to the nosoi; adjacent, it stays still and doesn't act; ends if attacked. Currently `reportOnly`.
- **Soul Scream** (Irnakurse): 10-ft emanation, non-aberration creatures save (Will DC 28). "The irnakurse can Sustain Soul Scream for up to 6 rounds; each time it does, it repeats the effect without a new save." Critical success: unaffected and immune 24 hours. Success: Stupefied 1 for 1 round. Failure: stupefied 1; further failed saves increase the value by 1 to a maximum of 4; critical failure increases by 2. Currently `reportOnly`.
- **Hypnosis** (Lunar Naga): 30-ft emanation, Will DC 21 or Fascinated until the end of the naga's next turn; critical failure also drops carried items. "If the naga moves, affected creatures are compelled to remain within 30 feet and must spend each of its actions moving closer… If a creature is unable to end its turn within 30 feet, the effect ends for that creature." Sustained via the naga's Sustain a Spell.
- **Mark Target** (Venator): Reflex DC 30; marked target takes –1 status to attacks against the venator and other aeons and to saves against their effects; "The venator can Sustain this effect to designate up to 5 other creatures as trusted allies… The venator can Dismiss the mark. Otherwise, it fades away naturally after 1 day."
- **Machinery that exists:** `dungeon-combat.mjs` already maps `durationSeconds: "actorNextTurnEnd"` / `"actorNextTurnStart"` to `{ unit: "rounds", expiry: "turn-end" | "turn-start" }`, treats `duration.sustained` effects specially, and has agent-tagged effect creation and combat-end cleanup; #987 adds forced movement and the outcome kinds; #1094 integrates with the PF2E Automated Action Tracker for human-driven turns.

## Resolved decisions

1. **Target effect items carry the state.** Each affected creature gets an agent-tagged effect (origin = source) expiring at the end of the source's next turn; a Sustain by the source refreshes the expiry of every still-affected target without a new save. If the source does not Sustain, the effects lapse on their own.
2. **AI Sustain is a cost-1 candidate scored by affected enemies**: offered whenever the source has a live sustainable effect with at least one affected enemy; the existing candidate scoring weighs it against other actions, with a bonus per still-affected enemy and a penalty at the round cap.
3. **Targeting exceptions are reviewed per-ability table fields** (type/trait include and exclude, mindless-undead override, and #935's `immuneSeconds`), applied before the save.
4. **All four extras are in scope:** the maximum-rounds counter (Soul Scream), compelled movement for fascinated targets, Dismiss and ally-designation riders (Mark Target), and escalating condition values on repeated failed saves. Nothing is filed as a follow-up.

## Design

### Descriptor additions (extends #935/#915's save descriptor)

```
sustain: {
  expiry: "actorNextTurnEnd",
  maxRounds?: number,          // Soul Scream: 6
  repeatsWithoutSave: boolean, // Soul Scream: true; Haunting Melody: true
  actionName: "Sustain",       // or "Sustain a Spell" for Hypnosis
  dismissible?: boolean,       // Mark Target
  allyDesignation?: { max: 5 } // Mark Target
},
targeting: {
  includeTypes?: string[], excludeTypes?: string[], excludeTraits?: string[],
  affectsMindless?: boolean,
  immuneSeconds?: number
},
escalation?: { condition: "stupefied", perFail: 1, perCritFail: 2, max: 4 },
compulsion?: { kind: "moveToward", stayWithin?: 30, criticalFailureOnly?: boolean, endsOnAttack: boolean }
```

All fields come from the reviewed table; the grammar is unchanged. The table entries are Haunting Melody, Soul Scream, Hypnosis and Mark Target.

### Application (extends #915's executor)

1. Spend the cost, record frequency/recharge, post the usage message.
2. Filter the area's creatures with `targeting` (a Psychopomp is dropped; mindless undead are kept despite mental immunity).
3. Roll each save. Apply the degree's outcome through #987/#935 helpers, with the effect's duration set to `actorNextTurnEnd`, origin = source, and flags `{ sustainable: true, sourceTokenId, roundsSustained: 0, maxRounds }`.
4. **Escalation.** Where `escalation` is set and the target already has the condition from this ability, raise the value by `perFail` (or `perCritFail`) up to `max` instead of re-adding; a success applies the 1-round form and a critical success the 24-hour immunity.
5. Record the live sustainable use on the source (`flags.pf2e-dungeon-crawl.sustaining[abilitySlug]` = `{ targetIds, roundsSustained }`) so the AI knows what it can Sustain.

### Sustain

- **Candidate.** On the source's turn, `buildSustainCandidates` offers a cost-1 `Sustain <ability>` candidate for each live `sustaining` entry with `roundsSustained < maxRounds` (or no cap), scoring it by the number of still-affected enemies.
- **Execution.** Sustaining spends the action, then for each target still affected and alive refreshes the effect's expiry to the end of the source's *next* turn (and increments `roundsSustained`), re-applying a `repeatsWithoutSave` effect without a new save (Soul Scream restores its Stupefied 1 for the round). A target that left the area or died is dropped from the entry.
- **Cap.** At `maxRounds` the entry stops being offered and the effects lapse naturally.
- **Lapse.** If the source does not Sustain, the target effects expire by the existing turn-end expiry; if the source dies, is dismissed or is unconscious at its turn end, the effects are removed immediately.

### Compelled movement

- **Fascinated, crit-fail targets** (Haunting Melody) and **Hypnosis** targets with a `compulsion`: on the target's turn, an AI-controlled target spends its actions on Stride candidates toward the source (via #987's forced-movement path-finding rules, avoiding obvious dangers); adjacent to the source it takes no actions; the compulsion ends when the creature is attacked (a damage-applied hook removes the effect), or, for Hypnosis, ends for a creature that cannot finish a turn within the stay-within range.
- **Human-driven targets** get a clear turn-start reminder, and #1094's enforcement where available.

### Dismiss and ally designation (Mark Target)

- **Dismiss.** The source's Dismiss action is a cost-0/1 candidate and a GM context-menu action on the effect; it removes the mark effect from the target.
- **Ally designation.** Sustaining a Mark Target use may designate up to 5 allies: the mark effect gains a `trustedAllies` list (token ids) and the –1 penalties extend to attacks against, and saves against effects from, those allies. The AI picks allies in view, nearest first; the GM can edit the list from the effect.
- **Duration.** The mark lasts 1 day (or until combat end) and is not subject to the turn-end lapse.

## Error handling

- An effect whose source token is gone lapses at the next turn change.
- A refresh failure on one target is logged and reported; other targets are still refreshed.
- A compulsion with no legal path toward the source reports "can't reach" and takes no action rather than stalling the turn.
- A malformed table entry disables the ability (the #984 fixture-hash rule) and the audit reports it.
- Hooks never throw into the combat turn.

## Testing

- **Table/parser:** the four abilities load, validate and become `auto`; a near-miss stays `reportOnly`.
- **Targeting:** psychopomps excluded, mindless undead included, non-aberration filter, 24-hour immunity on success.
- **Application (mocked):** per-degree outcomes, `actorNextTurnEnd` expiry, source/target flags.
- **Escalation:** failure raises stupefied by 1, critical failure by 2, cap at 4, success gives the 1-round form; independent per target.
- **Sustain:** candidate offered/not offered (no live entry, cap reached, no affected enemies); refresh extends every live target, `roundsSustained` increments, `repeatsWithoutSave` restores the effect without a roll; stopping to Sustain lets effects lapse; source death removes them.
- **Compulsion:** AI target strides toward the source, stands still adjacent, ends when attacked, Hypnosis range-end rule; human target reminder.
- **Mark Target:** Dismiss; ally designation up to 5 and penalty extension.
- **Regression:** #915/#935/#987/#988 parser, executor and audit tests keep passing; the golden file and ratchet count the new `auto` abilities.
- **Live verification:** a nosoi's Haunting Melody fascinating creatures then a Sustain keeping them for another round, an irnakurse Soul Scream escalating stupefied across Sustains to the cap, a lunar naga's Hypnosis compelling an AI creature toward it, a venator's mark extended to allies and dismissed.

## Explicitly out of scope

- Afflictions (#1103), area forced movement and mixed zone-plus-save abilities (#1104), random outcomes that cast spells (#1105).
- Sustaining spells the module already handles elsewhere.
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the exact shape of the `sustaining` source flag, how the damage-applied hook identifies an attack on a compelled target, and the AI heuristic for choosing allies to designate.
