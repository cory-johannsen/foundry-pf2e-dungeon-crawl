# Advanced AI Actors: Save Abilities That Depend on Creature-Specific Aura Entries (Focus Beauty, Focus Gaze)

**Issue:** #1097 — save abilities whose outcomes live in an aura or in "already affected" state, deferred from #987.

**Builds on:** #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (outcome kinds, `applyOutcomeEffects`, the override table), #935 (outcome grammar, all-or-nothing `mode`, immunity windows), #915 (save executor), #1021 / `docs/superpowers/specs/2026-10-09-ai-npc-spell-counteract-reactions-design.md` (`rollCounteract`), #914 (agent tagging).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

"Focus Beauty" (nymph queens) and "Focus Gaze" (medusae, giylea, evangelists, thanadaemons) make the target save and then apply a **greater effect if the target was already affected** by an aura or condition. The normal and greater outcomes are spread across the ability text and, for nymph queens, the creature's own aura entry. This spec adds a per-ability **link** to what "already affected" means and a **resolver** that reads the greater effect from a reviewed table entry or the referenced entry, so these abilities run automatically.

## Investigation findings

Real texts from `tests/fixtures/npc-save-ability-slice.json` (Monster Core 1–2, Bestiary data).

- **Condition-based "already affected"**: *Medusa* Focus Gaze: Fortitude DC 25 against petrifying gaze; "If the creature was already Slowed by petrifying gaze before attempting its save, a failed save causes it to be Petrified permanently." *Evangelist*: Will DC 21 against unnerving gaze; if already Frightened, a failed save makes the evangelist Concealed from the creature while it stays frightened. *Thanadaemon*: if not already Frightened, Will DC 33 against terrifying gaze; if already Frightened, Will DC 33 or Fleeing for 1d4 rounds (incapacitation). Each is currently `reportOnly`.
- **Aura-based "already affected"**: *Dryad Queen* / *Naiad Queen* / *Lampad Queen* / *Hesperid Queen* Focus Beauty: "must attempt a save against her nymph's beauty aura. If the creature fails and was already affected by the aura, it takes a greater effect described in the nymph queen's entry." The greater effect varies: Dryad Queen — can't use hostile actions against the queen for 1 hour; Naiad Queen — effectively blinded until vision is restored; Lampad Queen — no flat check to end the confusion on damage; Hesperid Queen — departs her domain for 1 hour then forgets. Currently `expected: None` (not offered).
- **One-offs**: *Giylea* Focus Gaze: Will DC 37; counteracts a disguise/shape-change effect on the target (counteract +29, 8th rank); temporary immunity until the start of the giylea's next turn. Nymph queens: "can Focus Beauty on a given creature only once per turn." Naiad Queen: "can Dismiss the effect."
- **Machinery that exists:** #987's outcome kinds and effect creation; the module's handling of creature auras (Aura items and effects tagged to the source); #1021's `rollCounteract`; #935's immunity windows.

## Resolved decisions

1. **"Already affected" is a per-ability link**: either a condition predicate on the target (Slowed, Frightened) or the presence of the referenced aura's effect (tagged with the source creature), evaluated before the save.
2. **Outcomes come from reviewed table entries plus a referenced-entry resolver**: the table maps each (creature, ability) to normal and greater outcomes in #987's outcome kinds; for abilities that point at the creature's own aura entry, a resolver reads that entry through the existing grammar and falls back to the table.
3. **Unmodelable pieces get a GM note**: apply what the outcome kinds and system conditions support (Petrified is a PF2e condition; Blinded with an "until restored" marker) and whisper the GM a note for pieces the module can't model. This is a **scoped exception to #935's all-or-nothing `mode` rule**, limited to entries in this table: an entry is `auto` when every piece is either applied or noted, and the note makes the gap visible.
4. **Also in scope:** Giylea's counteract of disguise effects, the once-per-turn-per-target limit (and the post-save temporary immunity), and Dismiss for lasting beauty-aura effects.
5. **Unselected option is filed:** the Lampad and Hesperid queens' ongoing effects (#1214).

## Design

### Outcome model additions

An ability entry gains an optional `priorState` and per-degree `greater` outcomes:

```
{
  priorState: { kind: "condition", slug: "slowed" | "frightened" }
           | { kind: "auraEffect", auraSlug: "nymphs-beauty", sourceId: "self" },
  degrees: { ... normal outcomes ... },
  greater: { failure: OutcomeBlock, criticalFailure?: OutcomeBlock },
  oncePerTurnPerTarget: boolean,
  counteract?: { rank: 8, modifier: 29, targets: "disguise" },
  dismissible?: boolean
}
```

`OutcomeBlock` is #987's `{ none, asFailure, conditions[], penalties[], durationSeconds, immuneSeconds, effects[] }` plus `gmNote?: string` for the unmodelable parts.

### Evaluation (extends #915's executor)

1. **Once-per-turn guard.** If `oncePerTurnPerTarget` and the source already used the ability on this target this turn (state on the agent turn record), refuse the use and report why.
2. **Prior state.** Evaluate `priorState` against the target *before* rolling: a condition predicate reads the actor's conditions; an `auraEffect` predicate looks for the aura's effect item on the target with the source creature as origin. Record the boolean on the use.
3. **Counteract.** If the entry has `counteract`, call `rollCounteract` against the target's disguise/shape-change effect (identified by trait or slug in planning) before the save.
4. **Save and outcome.** Roll the save as usual. On a degree that has a `greater` block and `priorState` held, apply the greater block; otherwise the normal block. For aura-based entries the *normal* failure outcome applies the aura's effect itself (so the next use finds it).
5. **Notes and immunity.** Send `gmNote` text to the GM whisper; apply `immuneSeconds` per #935 (Giylea: until the start of its next turn).

### Referenced-entry resolver

For aura-based entries without a complete table entry, the resolver locates the creature's own aura/ability entry by name (the text says "nymph's beauty aura" / "the nymph queen's entry"), runs the #935/#987 grammar over it to produce the aura's effect and greater block, and falls back to the reviewed table where parsing is partial. Anything the resolver cannot map keeps the ability `reportOnly` with the verbatim text whispered.

### Table and audit

The reviewed table lives with #935's overrides and contains the known entries (Medusa, Evangelist, Thanadaemon, Giylea, and the four nymph queens). The golden-file audit gains a counter for "aura-linked" and a list of `gmNote`d pieces so remaining gaps stay visible. The nymph-queen greater effects are mapped as follows: Dryad Queen — a `hostileActionBlock` marker effect of 1 hour on the target against the queen (note only; enforcement is the GM's); Naiad Queen — Blinded with an `untilVisionRestored` marker (unlimited, removed by the GM); Lampad and Hesperid greater effects — a `gmNote` pending #1214.

### Dismiss

Aura effects created by Focus Beauty carry the source creature as origin and `dismissible: true`. The queen's **Dismiss** is offered as an AI candidate (cost 1, concentrate) when it would end an effect the AI created, and as a GM context-menu action on the effect for any creature.

## Error handling

- Prior-state evaluation errors treat the target as "not already affected" and warn the GM, so a failed lookup never applies a greater effect by mistake.
- A missing referenced entry or unparsable aura text keeps the ability `reportOnly` with the verbatim outcome text whispered.
- A counteract that cannot find a disguise effect to counter does nothing and says so.
- A refused once-per-turn use is reported, not an error.
- Hooks and the executor never throw into the combat turn.

## Testing

- **Table and parser:** Medusa, Evangelist, Thanadaemon, Giylea and the four queens become `auto` with the expected normal/greater blocks (golden); a near-miss keeps `reportOnly`.
- **Prior state:** a condition predicate true/false; an aura-effect predicate with the right and wrong origin; evaluation happens before the save; an evaluation error defaults to "not affected".
- **Greater effect (stubbed save degrees):** failure with prior state → greater; failure without → normal and the aura applied; success/critical success unaffected; incapacitation trait respected (Thanadaemon's Fleeing).
- **Once-per-turn:** a second use on the same target in the same turn is refused; a different target or next turn works; temporary immunity applied.
- **Counteract:** Giylea attempts to counteract a disguise effect before the save; no-op without one.
- **Dismiss:** AI candidate availability; GM action removes the effect.
- **GM notes:** unmodelable pieces produce a whisper with the exact text.
- **Regression:** #935/#987 abilities unchanged; the all-or-nothing rule still holds outside this table.
- **Live verification:** a medusa Focus Gaze on a Slowed target petrifies on a failed save; a nymph queen's Focus Beauty twice on one target applies the aura then the greater effect; Giylea strips a disguise spell; a second Focus Beauty in the same turn is refused.

## Explicitly out of scope

- The Lampad Queen's lasting confusion rule and the Hesperid Queen's departure-and-forgetting (#1214).
- Prose interpretation by the reasoning model; enforcing the Dryad Queen's hostile-action block mechanically.
- Other creatures' aura-referencing abilities not in the table (they stay `reportOnly` until audited).

## Open questions

None blocking. Left to planning: how a disguise/shape-change effect is identified for the counteract (traits versus slugs), where the per-turn "used on target" record lives in the agent turn state, and the exact marker-effect names.
