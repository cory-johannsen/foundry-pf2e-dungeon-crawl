# Advanced AI Actors: Save-Triggered NPC Reactions (Save Adjustments, Other Creatures' Saves, Condition Negation)

**Issue:** #960 — save- and spell-triggered NPC reactions (Cat's Luck, Reality Twist, Capture Spell, Slough Skin, ...), deferred from #931.

**Builds on:** #931 / `docs/superpowers/specs/2026-10-08-ai-npc-reactions-design.md` (the reaction registry, `resolveReactions`, the hybrid decision, the reaction-used economy, the retroactive-adjustment approach and the "automatic in GM-less, GM-confirm card otherwise" rule for flows the module does not own), #959 / `docs/superpowers/specs/2026-10-09-ai-npc-death-reactions-design.md` (trigger kinds and the seam-plus-fallback pattern), #915 / #935 (the module-owned save executor and timed-condition helper), and #925's reporting.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Many monsters have a reaction that fires around a **saving throw**: a lucky reroll, a one-degree improvement, a bonus for an ally, or shedding a condition about to be applied. This spec adds two trigger kinds to #931's reaction registry — `saveRolled` and `conditionIncoming` — and models three families: **own-save outcome adjustments** (Golden Luck, Reality Twist, Cat's Luck, Abrogation of Consequences), **other creatures' save modifiers** (Shift Fate, Free Mind, Distracting Frolic), and **condition negation** (Slough Skin). Spell-counteracting reactions are deferred (#1021), as are the remaining bespoke ones (#1022).

Saves reach the module two ways. Saves the **module rolls** (AI spell saves, #915 ability saves) go through a new wrapper that offers reactions between the roll and the application of its consequences. Saves the **system rolls** (a player's spell against a monster) are seen afterward through the chat message, and the reaction adjusts the outcome retroactively, as #931 does for AC bonuses, with the GM-confirm rule when a human GM is present. In GM-less runs everything is automatic.

## Investigation findings

Confirmed against the repo, the installed PF2e system and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **Population.** 58 save- or spell-triggered NPC reactions across 42 names. By trigger: the reactor's own save (23), a spell (24), another creature's save (4), a condition/adverse effect (1), other (6). Representative abilities and their text:
  - *Golden Luck* (Gold Dragon): trigger — fails a saving throw; effect — improves the result by one degree (failure → success, critical failure → failure); recharge 1d4 rounds.
  - *Reality Twist* (Pleroma): critical failure on a save becomes a normal failure.
  - *Cat's Luck* (Catfolk Pouncer): fails or critically fails a **Reflex** save; reroll and take the better result; once per day.
  - *Abrogation of Consequences* (Hellbound Attorney): rolls a success or critical failure on a save against a **linguistic** effect; success → critical success, critical failure → failure.
  - *Shift Fate* (Norn): a creature within 120 feet attempts a saving throw; it rolls twice and the norn decides which applies (lower = misfortune, higher = fortune).
  - *Distracting Frolic* (Caligni Dancer): an ally within 10 feet saves against a **mental or illusion** effect; the ally rolls twice and takes the better result (and a linked effect item is applied).
  - *Free Mind* (Yamah): an ally attempts a save against a **mental** effect; +4 status bonus, and a success becomes a critical success.
  - *Slough Skin* (Benthic Worm): would be affected by a condition or adverse effect; negates it (once per day; artifacts, deities and similarly powerful sources cannot be avoided this way).
- **Saves arrive in two ways.** The module rolls saves itself in `castSpellAndApplySave` / `castAreaSpellAndApplySaves` (`dungeon-combat.mjs`, `target.actor.saves[save].roll({ dc })`, then applies damage/conditions from the outcome) and, by #915's design, for save-based NPC abilities. A player's spell against a monster is rolled by the system when the GM clicks the save button on the spell card; the module sees only the resulting `saving-throw` chat message.
- **A save chat message carries what the triggers need.** `flags.pf2e.context` holds the type (`saving-throw`), the roll `outcome`, the DC, the rolling actor, the origin (the spell or ability and its caster) and the roll **options**, which include the effect's traits (`item:trait:mental`, `…:linguistic`, `…:auditory`, `damaging-effect`), so trait-conditioned triggers ("against a mental effect") can be tested from the message.
- **The system already has fortune/misfortune and degree-adjustment machinery** (`RollTwice`, degree-of-success adjustments applied inside `Check#roll`), but only for rules configured before a roll; nothing re-rolls or re-adjusts a roll that has already happened, so a reactive adjustment is the module's job.
- **Retroactive adjustment is already the approved approach** (#931): re-evaluate the roll total against the DC with the bonus or the improvement, write the adjusted outcome back onto the message context with a module flag, and make the module's own damage application honor it. Whether the system's spell cards read an edited outcome when applying damage is verified at planning (the fallback is a GM-visible note and manual application, as in #931).
- **Conditions arrive in two ways too.** The module applies conditions itself (`increaseCondition`, #915's timed-condition helper); the system applies conditions from player spells and effects, which surface only as a `createItem` of a condition on the reactor.
- **The reaction economy and recharge stores exist** (`getReactionUsed`/`markReactionUsed`, `abilityRecharge`, `system.frequency`).

## Resolved decisions

1. **First slice: own-save outcome adjustments, other creatures' save modifiers, and condition negation.** Spell counteracting is #1021; the remaining bespoke ones are #1022.
2. **Spells the module resolves only (for cancel/redirect effects):** counteract-style reactions wait for #963's interception mechanism; the save-outcome adjustments in this slice apply retroactively and do not need it.
3. **Always automatic in GM-less runs; GM-confirm card when a human GM is present for flows the module does not own** — the same rule #931 adopted.

## Design

### New trigger kinds

- **`saveRolled`** — event `{ saver, outcome, total, dc, saveSlug, traits[], origin, owned }` where `owned` says whether the module rolled the save (and will apply its consequences) or the system did. The reactor is either the saver (own-save definitions) or a creature related to the saver by allegiance and distance (other-creature definitions).
- **`conditionIncoming`** — event `{ target, conditionSlug, value, durationSeconds?, origin, owned }`.

Both feed #931's `resolveReactions`, with the same shared gates (the reactor is agent-controlled and not defeated, has the matching reaction item, has not used its reaction this round, observed what it reacts to) and the same hybrid decision (deterministic policy for one eligible reaction; the agent service with a 5-second timeout when several are eligible; deterministic priority fallback).

### Registry definitions (initial table)

| Reaction | Trigger | Subject | Condition on the event | Effect | Policy |
|---|---|---|---|---|---|
| Golden Luck | `saveRolled` | self | outcome is failure or critical failure | improve by one degree | use when it changes failure → success or critical failure → failure (always true on trigger) |
| Reality Twist | `saveRolled` | self | outcome is critical failure | critical failure → failure | always |
| Abrogation of Consequences | `saveRolled` | self | traits include `linguistic` and outcome is success or critical failure | success → critical success, critical failure → failure | always |
| Cat's Luck | `saveRolled` | self | save is Reflex and outcome is failure or critical failure | reroll the save, take the better | always |
| Shift Fate | `saveRolled` | other (any creature within 120 ft) | any save | the saver rolls twice; apply the lower for an opponent of the reactor, the higher for an ally | always |
| Distracting Frolic | `saveRolled` | ally within 10 ft | traits include `mental` or `illusion` | roll twice, take the better; apply the linked effect | always |
| Free Mind | `saveRolled` | ally | traits include `mental` | +4 status bonus to the roll; a success becomes a critical success | when the +4 improves the degree |
| Slough Skin | `conditionIncoming` | self | the condition is a harmful one | negate it (do not apply / delete it) | always |

All entries are all-or-nothing: a reaction whose item text has more than the modeled clause (for example the Distracting Frolic effect link not resolving) is not offered. Triggers that need subjects beyond this table (the matching `Requirements`, "within N feet" distances) are read from structured fields where present and otherwise from the closed phrasings above; anything unrecognized means the reaction is not offered.

### Adjustment semantics (pure functions in `scripts/npc-reactions-saves.mjs`)

- `improveOneDegree(outcome)` (critical failure → failure, failure → success, success → critical success, critical success unchanged).
- `degreeFor(total, dc)` with the PF2e rules (±10 steps, natural 20/natural 1 shifting one step), used by `+4 status` recomputation.
- `better(a, b)` / `worse(a, b)` for reroll and two-roll reactions; ties follow the definition's rule.
- Each definition's `adjust(event, rolls)` returns `{ outcome, newRoll?, note }`; none of these touch Foundry.

### Module-owned saves: `rollSaveWithReactions`

A single wrapper replaces the direct `target.actor.saves[save].roll(...)` calls in `castSpellAndApplySave`, `castAreaSpellAndApplySaves` and #915's save/degree executor:

1. Roll the save as before (same dialogs suppressed, same DC and options, with the spell/ability as origin so traits and the system's incapacitation handling still apply).
2. Build the `saveRolled` event with `owned: true` and call `resolveReactions`.
3. Apply the adjusted outcome to the caller, which then applies damage/conditions from it exactly as today. A reroll or second roll posts the extra save message(s) with the existing chat helpers; the adjusted outcome is what the caller sees.
4. Report the reaction publicly ("the dragon twists luck…") and through #925's result descriptor.

### System-owned saves

A `createChatMessage` handler for `saving-throw` messages (GM client, module combats only) builds the event with `owned: false` and calls `resolveReactions`. A winning reaction is applied retroactively: the adjusted outcome is written to the message context with a module flag (`flags.pf2e-dungeon-crawl.reactionAdjustedOutcome`), a rerolled save posts a second message for the saver (rolled from the GM client against the same DC) and the better/worse result is recorded, and a public line announces the reaction. With a human GM present the module first posts #931's one-click confirm card; in GM-less runs it applies immediately. Verifying that the system's spell cards honor an edited outcome (so a downgraded save actually changes the damage applied) is a planning step; if not, the adjustment is announced and the GM or players apply the consequence by hand as today.

### Condition negation

- **Module-owned:** `applyTimedCondition` / `increaseCondition` call sites for NPC targets go through `applyConditionWithReactions`, which emits `conditionIncoming` (`owned: true`) before applying; a Slough Skin match skips the application and announces it.
- **System-owned:** a `createItem` hook for a condition on an NPC reactor emits the event with `owned: false`; a match deletes the new condition item (the system-applied effect) after the fact, with the same GM-confirm / automatic split as above. Slough Skin's text excludes effects from artifacts, deities and similarly powerful sources; the module cannot see a source's power, so it treats every condition as avoidable and notes the limitation in the GM report.

### Frequency, recharge and economy

Reactions with `system.frequency` (Cat's Luck, Slough Skin) decrement it; Golden Luck uses the existing recharge store with its parsed 1d4-round formula; every definition consumes the one-reaction-per-round economy through `markReactionUsed`.

## Error handling

- Failures in the save hook, reroll or message update are logged and the original outcome stands; a reaction never blocks or delays a save result.
- A reroll that cannot be made (the saver's actor or statistic missing) leaves the original roll in place and reports to the GM.
- If the reaction-used flag cannot be recorded, the reaction is skipped.
- A `createItem` deletion that fails leaves the condition in place and notes it to the GM.
- A reaction whose parsed clause is incomplete is never offered.

## Testing

- **Pure adjustment functions:** `improveOneDegree`, `degreeFor` around every boundary and natural 20/1, `better`/`worse`, each definition's `adjust` for every input outcome including the cases where the trigger condition is not met.
- **Registry:** match rules, subject/allegiance/distance filters, trait predicates (`mental`, `illusion`, `linguistic`), frequency/recharge/economy, priority and the hybrid decision with the service mocked (single reaction → no service call; several → one call with decline; timeout/error → deterministic).
- **Module-owned saves:** `rollSaveWithReactions` returns the adjusted outcome to `castSpellAndApplySave` and #915's executor, posts reroll messages, and leaves callers unchanged when no reaction applies.
- **System-owned saves:** the message handler adjusts retroactively (outcome flag written, reroll message posted), GM-confirm card vs automatic by mode, idempotence per message.
- **Conditions:** module-owned negation skips application; system-owned negation deletes the new condition; harmless conditions are not negated.
- **Regression:** existing save/spell tests, #915's executor tests and #931's registry tests keep passing.
- **Live verification:** a Cat's Luck or Golden Luck monster failing an AI-cast spell save and a player spell save, a Free Mind or Distracting Frolic monster boosting an ally's save, and a Slough Skin worm hit by a condition; in both a human-GM run and a GM-less run.

## Explicitly out of scope

- Spell-counteracting reactions (Capture Spell, Canceling Rune, Reflect Spell, Retune, Counterspell, Alter Dweomer) — #1021.
- Dual Mind, Spell Break, Drowning Drone, Savor Anguish, Electric Reflexes, Reflective Scales — #1022.
- Attack-triggered reactions (Icy Deflection, Deflecting Lie, Vengeful Spite, Trip Up) — #961 (noted there) and #931's AC family.
- Intercepting a player's save or spell before it resolves — #963.
- AI-controlled party characters' save reactions — #962.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: whether the system's spell and damage cards honor an edited save outcome, the exact `saving-throw` roll-option names for traits on the installed version, how the second save message is rolled for a player character from the GM client, and the wrapper's signature at the existing call sites.
