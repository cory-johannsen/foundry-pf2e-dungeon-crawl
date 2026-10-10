# Advanced AI NPCs: Spell-Counteracting Reactions

**Issue:** #1021 — spell-counteracting NPC reactions (Capture Spell, Canceling Rune, Reflect Spell, Retune, Counterspell, Alter Dweomer), deferred from #960.

**Builds on:** #960 / `docs/superpowers/specs/2026-10-09-ai-npc-save-spell-reactions-design.md` (save- and spell-triggered reactions, deterministic save adjustments), #963 / `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md` (synchronous interception hooks and the guarded wrapper, kill switch, `commitId`), #931 (`REACTION_DEFS`, `resolveReactions`, `markReactionUsed`), #915/#935 (save executor, timed effects), #925 (result descriptor).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#960 limits spell-related reactions to adjusting save outcomes. This spec adds reactions that **counteract or redirect a spell**: **Capture Spell**, **Canceling Rune**, **Reflect Spell**, **Retune**, **Counterspell** and **Alter Dweomer**. It introduces a **rules-as-written counteract helper** (rank and degree of success), a **spell-effect cancel/redirect step** that acts before the spell's effects are applied, and reuses #963's interception hooks so the reactions work on **both AI-cast spells and player-cast spells**.

## Investigation findings

- **Counteract rules** (Player Core p. 431, in the GM-screen journal): the counteractor adds the relevant modifier to a check against the target's DC (for a spell, the caster's spell DC). Counteract rank is the spell's rank (otherwise half the effect's level, rounded up, minimum 0). Critical success: counteract if the target's rank is at most **3** higher than the counteractor's rank; success: at most **1** higher; failure: only if the target's rank is **lower**; critical failure: no counteract.
- **The six reactions** (from the compendium):
  - *Capture Spell* (fortune dragon, spellcaster): trigger "succeeds or critically succeeds on a saving throw against a spell"; counteract rank 5, modifier `+20`; on success the dragon is unaffected and regains one expended spontaneous slot; other subjects are affected normally.
  - *Canceling Rune* (rune dragon): trigger "the target of a spell that requires a saving throw"; counteract rank 10, modifier `+33`; on success unaffected; recharge `1d4` rounds.
  - *Reflect Spell* (silver dragon): trigger "critically succeeds at a saving throw against a spell, or a caster targeting the dragon critically fails their attack roll"; the spell is reflected back on the caster "with the effect of Spell Turning".
  - *Retune* (melody on the wind): trigger "targeted by a spell with the auditory trait"; counteract; on success the spell is swept back and affects the caster; other targets are affected normally.
  - *Counterspell* (lich): trigger "a creature casts a spell the lich has prepared"; expend the matching prepared spell and counteract the **casting** itself.
  - *Alter Dweomer* (dweomercat): trigger "targeted by a spell or within the area of a spell as it's cast"; gains a tradition-keyed effect for 1 minute that occurs **before** the spell affects it (arcane: feedback damage `4d6` force, basic Reflex save, to the caster; divine: +1 status bonuses; ...).
- **Interception mechanism (#963).** `preCreateChatMessage` for attack and save cards, `preCreateItem` for conditions, and a guarded `applyDamage` wrapper exist; a `Check.roll` wrapper is #1034. Counteract and redirect need an additional point *before* a spell's effects are applied: for AI-cast spells the module's own spell executor is the choke point; for player-cast spells the spell cast message (`preCreateChatMessage` with `flags.pf2e.origin.type === "spell"`) identifies the spell, caster and targets before saves are rolled.
- **Module spell executor.** AI-cast spells resolve through the module's spell/save executors (#909/#915), which already know the spell, caster, targets, rank and DC.

## Resolved decisions

1. **All six reactions** are modeled: counteract-style (Capture Spell, Canceling Rune, Reflect Spell, Retune, Counterspell) and the tradition pre-effect (Alter Dweomer).
2. **Both AI-cast spells and player spells**, using #963's hooks (with the module's own executor for AI spells); a spell that cannot be intercepted is simply not affected (feature-detected, fallback = no reaction).
3. **A rules-as-written counteract helper**, shared and pure.
4. **Deterministic policy** in intercepted flows (no model call), as #963.

## Design

### Counteract helper (`scripts/counteract.mjs`, pure)

```js
counteractRank(effect) // spell: rank; other: max(0, ceil(level/2))
counteractOutcome({ degree, counteractorRank, targetRank }) // → "counteracted" | "failed"
// crit success: targetRank <= counteractorRank + 3; success: <= +1; failure: targetRank < counteractorRank; crit failure: fail
```

`rollCounteract({ modifier, dc, counteractorRank, targetRank, rng })` rolls `1d20 + modifier`, derives the degree against `dc` with natural-20/1 adjustments (`degreeFor`), and returns `{ roll, total, degree, counteracted }`. A test suite checks the helper against the Counteract Table (ranks 0–10). The DC is the caster's spell DC from the spell's origin data (or the reaction's stated DC for monster-cast spells).

### Spell interception point

`scripts/spell-intercept.mjs` provides `interceptSpellCast({ caster, spell, rank, targets, area, phase })`:

- **AI-cast spells:** called by the module's spell executor before saves and damage are resolved.
- **Player-cast spells:** called from a `preCreateChatMessage` handler on spell cast messages (`flags.pf2e.origin.type === "spell"`), synchronously; it only **decides** and marks the message with `flags.pf2e-dungeon-crawl.spellReaction = { commitId, outcome }`, and a `createChatMessage`-time GM handler applies the cancel/redirect. If the system rolls saves for each target as separate messages, the per-target handler consults the mark to cancel the save card for a counteracted target.

The decision functions return one of `{ kind: "none" }`, `{ kind: "cancelForReactor", reactorId }` (the reactor alone is unaffected), `{ kind: "cancelCasting" }`, `{ kind: "redirectToCaster", reactorId }`, or `{ kind: "preEffect", reactorId, tradition }`.

### The reactions (registry kinds)

| Reaction | Kind | Trigger phase | Behavior |
|---|---|---|---|
| Capture Spell | `counteractForSelf` | after the reactor's save, success or crit success | Roll counteract (rank 5, +20 from the item); success: the reactor takes no effect and regains one expended spontaneous slot (if any) |
| Canceling Rune | `counteractForSelf` | when the reactor is targeted by a save spell | As above (rank 10, +33); sets the recharge from the item's `1d4` |
| Reflect Spell | `redirect` | after crit success on a save against a spell, or when a caster crit-fails an attack roll against the reactor | Resolve the spell's effects against the caster instead (the effect of Spell Turning: same spell, same rank and DC, with the caster as target) |
| Retune | `counteractRedirect` | targeted by a spell with the `auditory` trait | Roll counteract; success: the spell's effects are applied to the caster in place of the reactor; other targets unaffected |
| Counterspell | `counterCasting` | a creature casts a spell the reactor has prepared | Expend the matching prepared spell slot; roll counteract against the casting; success: the entire casting is cancelled |
| Alter Dweomer | `traditionPreEffect` | targeted by a spell or in its area | Apply the tradition's effect before the spell's effects (arcane feedback damage to the caster with a basic Reflex save; divine/other traditions per the item) for up to 1 minute |

Each is a reviewed exact-match definition: item name and trigger text are fixture-checked, and every sentence must be consumed by its parser (all-or-nothing), as in #959.

### Cancel and redirect effects

- **cancelForReactor:** the reactor is removed from the spell's target list (AI-cast), or its save card/damage application is suppressed (player-cast: the targeted `applyDamage` for that reactor is skipped through #963's wrapper, conditions are cancelled via `preCreateItem`). Other targets are unaffected.
- **cancelCasting:** the spell's remaining effects do not execute; the cast message is left in place with a "countered" note and the caster's slot is still spent (RAW).
- **redirect:** the spell resolves against the caster using the same executors (module-cast) or by posting a GM-resolved "reflected" note with the spell link when it is a player spell the module cannot re-run.
- **preEffect:** Alter Dweomer's tradition effects are created as effects with the `agentSelfEffect` tag (#914) so combat-end cleanup applies; arcane feedback damage is rolled through the existing damage helper.

### Commit and bookkeeping

As #963: decide synchronously, then commit asynchronously on the GM client with the `commitId` — `markReactionUsed`, recharge, slot expenditure/regain, and the public announcement ("The dragon snatches the spell out of the air!"). A rejected commit (race) posts a GM note.

### Policy

Deterministic: a reactor reacts when eligible (reaction unused, perceives the caster, item present). Counteract reactions always attempt (there is no downside). Counterspell attempts only if the reactor has the spell prepared and the caster is hostile.

## Error handling

- Spell data missing (rank/DC unknown): reaction not offered; no partial effects.
- Interception unavailable (feature detection failed): falls back to #960 behavior, no reaction.
- Re-entrancy guard shared with #963; a redirect cannot trigger a further reaction on the caster in the same cast.
- Slot accounting failure for Counterspell: the reaction is skipped before any change.

## Testing

- **Counteract helper:** the full Counteract Table, degree boundaries, nat 1/20, crit failure.
- **Decision functions:** each reaction's eligibility and outcome on fixtures; multiple reactors; the auditory/save/area gates.
- **Effects:** cancel-for-reactor leaves other targets affected; casting cancel; redirect resolves on the caster; Alter Dweomer pre-effect then spell; slot/recharge bookkeeping and idempotent commits.
- **Interception:** mark-and-commit on player spell messages; no-op fallback when hooks unavailable.
- **Fixtures:** the six items match; changed text disables the definition.
- **Live verification:** an AI lich counterspells a player's prepared-spell casting; a silver dragon reflects a spell it crit-saves; a player cast against a rune dragon is counteracted for the dragon only.

## Explicitly out of scope

- A `Check.roll` wrapper (#1034) and reroll-type reactions (#1035).
- Counteracting non-spell effects (afflictions, conditions) beyond what these items require.
- Reactions by AI-controlled player characters (#962).

## Open questions

None. Planning-time details: how the system structures per-target save messages for player-cast spells, and where prepared-spell slots are stored for the lich's `Counterspell`.
