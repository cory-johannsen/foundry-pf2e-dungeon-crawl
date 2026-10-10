# Advanced AI Actors: Complete PF2e Drowning Rules

**Issue:** #1095 — the rest of Player Core's drowning and suffocating rules, deferred from #987.

**Builds on:** #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (the `breath` outcome kind, `Effect: Remaining Air`, the end-of-turn air hook in `scripts/save-outcome-hooks.mjs`, monster suffocation saves), #935 (`applyTimedEffect`), #914 (agent tagging and combat-end cleanup).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#987 models holding breath, end-of-turn air loss and DC 20 +5 suffocation saves for AI/monster creatures. This spec adds the rules it left out: **losing air on critical hits and critical save failures**, **losing all air on speaking or casting**, **suffocation saves for player characters** (GM-confirmed by default), **air-extending feats** (Breath Control), and **restoring air** when a creature regains access to it.

## Investigation findings

Rules text from Archives of Nethys (*Drowning and Suffocating*), consistent with the Player Core wording quoted in #987.

- You can hold your breath for **5 + Con modifier rounds**. Reduce remaining air by 1 round at the end of each of your turns, or 2 if you attacked or cast a spell that turn. *(in #987)*
- **You lose 1 round of air each time you are critically hit or critically fail a save against a damaging effect.** *(this spec)*
- **If you speak (including Casting a Spell) you lose all remaining air.** *(this spec)*
- At 0 air you fall Unconscious and start suffocating: a **DC 20 Fortitude save at the end of each of your turns**; failure deals 1d10, critical failure kills; each later check raises the DC by 5 and the damage by 1d10, cumulatively. *(monsters in #987; player characters in this spec)*
- **Once access to air is restored, you stop suffocating and are no longer Unconscious** (unless at 0 HP). *(this spec)*
- *Breath Control* (feat) multiplies how long a character can hold its breath. *(this spec)*
- Speech cannot be detected by the module, but spell casts can (the PF2e system posts a spell-cast chat message), and strike outcomes and save degrees are carried on the system's roll and message flags.

## Resolved decisions

1. **Critical air loss is automatic from damage and save outcomes**, for AI-controlled and player-driven creatures alike.
2. **Speaking and casting:** spell casts zero the air automatically; a GM-side "spoke" button on the air effect covers other speech.
3. **Player-character suffocation saves roll automatically with a GM confirmation**; a world setting can turn the confirmation off, which makes the flow identical to monsters'.
4. **Also in scope:** air-extending feats (Breath Control) and restoring air when the creature regains access to it.
5. **Unselected options are filed:** underwater scene regions that start creatures holding their breath (#1201) and a player-facing remaining-air display (#1202).

## Design

All behavior lives in `scripts/save-outcome-hooks.mjs`'s air section (or a new `scripts/breath-hooks.mjs` if planning finds the file too large), reading and writing the one `Effect: Remaining Air` item per creature. Air arithmetic is a pure module (`breathMath`) so each rule is unit-testable.

### Critical air loss

- **Hit side:** when damage from a Strike is applied to a token whose actor has a `Remaining Air` effect and the attack's degree of success was `criticalSuccess`, subtract 1 round. The hook reads the outcome from the damage message's flags (`flags.pf2e.context.outcome`) at damage-taken time.
- **Save side:** when a creature with `Remaining Air` makes a saving throw and the degree is `criticalFailure` and the originating effect deals damage (the roll's context declares damaging traits or the origin item has damage), subtract 1 round.
- Each event subtracts at most 1 round per source (a multi-hit area effect from one cast subtracts once per creature).
- If the subtraction reaches 0, the creature falls Unconscious and starts suffocating exactly as at the end-of-turn path in #987.

### Speaking and casting

- A `pf2e` spell-cast chat message from a creature with `Remaining Air` sets its remaining air to 0 (it then falls Unconscious and starts suffocating, per #987). A creature that can't cast while holding its breath is the GM's call; the module follows the rule as written.
- The `Remaining Air` effect's GM context menu gains **"Spoke (lose all air)"**, which does the same.

### Player-character suffocation saves

At the end of a suffocating player character's turn (the same turn-end hook as monsters):

1. Compute the DC (20 + 5 per prior check) and damage (1d10 per prior check, cumulative) from the effect's counters.
2. Whisper the GM a confirmation card ("Roll <name>'s DC <n> Fortitude save vs suffocation — Roll / Skip"), unless the world setting `suffocationConfirm` is off.
3. On Roll: perform the system's Fortitude save (with the character's modifiers) and apply the outcome — failure deals the damage as untyped damage, critical failure marks the character dead — then post the result card.
4. On Skip: no roll this turn and the counters are not advanced; a note is posted so the GM can resolve manually.

The world setting `suffocationConfirm` (default on) controls step 2.

### Air-extending feats

The maximum-air computation (`5 + Con mod` rounds) multiplies by the character's air-extension factor. Planning determines how to read it from the system: a rule-element flag or item slug on the actor (Breath Control: 25×). The factor applies at the moment the effect is first created; an effect already running is not retroactively resized.

### Restoring air

When a creature regains access to air, the module removes `Remaining Air` and the suffocation marker and, if Unconscious solely from suffocation, removes Unconscious (a creature at 0 HP stays Unconscious). Triggers: a GM context-menu action **"Breathes again"** on the effect; the effect's own expiry; and the end of the source ability's duration (for example Drown ending when its Fortitude escape succeeds, already handled in #987). Detecting "reached air" from token position is #1201's territory, so this spec does not automate it.

## Error handling

- Parsing a damage or save outcome that lacks a degree reads as "no event" and never throws.
- A hook failure is logged and never blocks damage application, the save or the combat turn.
- If the Fortitude save roll fails to execute, the confirmation card remains and offers Roll again.
- A skipped player suffocation save is visible in chat so a missed save is never silent.
- Air arithmetic clamps at 0; the Unconscious / suffocating transition happens exactly once per drop to 0.

## Testing

- **`breathMath` (pure):** max air with Con and extension factor; subtraction clamping; the 1-vs-2 end-of-turn rule; the DC/damage progression over several checks.
- **Critical air loss (mocked messages):** critical Strike hit subtracts 1; a normal hit and a hit on a non-breath-holding creature do nothing; critical save failure vs a damaging effect subtracts 1; critical failure vs a non-damaging effect does nothing; the drop to 0 transitions once.
- **Speaking/casting:** a spell-cast message zeros air; the "Spoke" action does the same; a creature without `Remaining Air` is unaffected.
- **Player saves:** confirmation card posted by default and skipped when the setting is off; Roll applies damage and counter advance; critical failure marks dead; Skip does not advance counters.
- **Restoring air:** "Breathes again" clears the effect and suffocation; Unconscious removed only when not at 0 HP.
- **Regression:** #987's monster air and suffocation behavior unchanged.
- **Live verification:** a player character hit critically while holding breath loses a round; casting a spell zeros air; a suffocating character gets the GM confirmation card and the roll applies damage; Breath Control lengthens the starting air; "Breathes again" clears suffocation.

## Explicitly out of scope

- Underwater scene regions that automatically start breath-holding (#1201) and a player-facing air display (#1202).
- Detecting that a creature reached air by moving; speech detection beyond spell casts.
- The wasted/restricted action enforcement on human turns (#1094).

## Open questions

None blocking. Left to planning: the exact hook points for "damage applied" and "saving throw rolled" in the installed PF2e system, how the air-extension factor is read from the actor, and whether the air logic warrants its own file.
