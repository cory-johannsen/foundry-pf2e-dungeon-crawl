# Advanced AI NPCs: Transformation and Form-Change Abilities

**Issue:** #1077 — transformation and form-change NPC abilities (Rushed Transformation, Revert Form, Crystalline Dust Form), deferred from #984.

**Builds on:** #984 / `docs/superpowers/specs/2026-10-09-ai-npc-prose-abilities-design.md` (the reviewed declarative table for prose-only abilities, fixture hashes, zone primitives), #934 (the closed requirement-predicate set, which left `inForm` unreadable), #935 (timed effects), #914 (effect tagging and cleanup), #910 (frequency store), #1052 (IWR adjustments, if a form changes resistances), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

About 52 prose-only NPC abilities change the actor's form: stat, size, speed and trait changes (*Rushed Transformation*), reverting from an assumed form with a bonus (*Revert Form*), turning into a cloud (*Crystalline Dust Form*). This spec adds a **transform primitive** to #984's declarative table built on **PF2e effects and rule elements**, a way to **read and record the actor's current form** (so the `inForm` requirement predicate works), and a **ranked audit** to add the clean abilities by frequency.

## Investigation findings

From the compendium.

- **Rushed Transformation** (six dragon stat blocks such as the conspirator dragon; 3 actions, occult/polymorph, once per hour): reshapes the body into a generic humanoid figure with the effects of *Humanoid Form* except it lasts only **1 minute** and the dragon doesn't gain the +4 status bonus to Deception; the dragon can Dismiss it; whenever it ends the dragon leaves behind scraps of magically conjured flesh.
- **Revert Form** (ugothol; free action): requirement — the ugothol is in an assumed form; it resumes its true form and, until the start of its next turn, gains a **+2 status bonus** to attack rolls, damage rolls, saving throws and skill checks (a linked `bestiary-effects` item "Effect: Revert Form").
- **Crystalline Dust Form** (axiomite; 1 action, polymorph): shifts into a cloud of crystalline dust, gains a **fly Speed of 40 feet** and can fit through tiny apertures (like vapor form); can cast spells but **can't make melee or ranged attacks**; can Dismiss to return to humanoid form.
- **The population.** #984 counted ~52 transformations among its prose-only abilities (frequency-ranked: Rushed Transformation 6, and many singletons).
- **Native building blocks.** PF2e effect items support `CreatureSize`, `BaseSpeed`, `ActorTraits`, `Resistance`, `Weakness`, `FlatModifier`, `Sense` and `RollOption` rule elements; spells like *Humanoid Form* and *Vapor Form* have spell-effect items in `spell-effects` that already encode such changes; `BattleForm` replaces the stat block and is not apt for these.
- **No form state exists.** #934 left `inForm` unreadable because the module records nothing about an actor's current form.

## Resolved decisions

1. **Mechanism:** a transform primitive in #984's declarative table that creates a PF2e effect item (with native rule elements) and records a **form flag**; the `inForm` predicate reads the flag. `BattleForm` is not used.
2. **First entries:** Rushed Transformation, Revert Form, Crystalline Dust Form, and a ranked audit of the ~52 transformation abilities, adding the clean ones by frequency.

## Design

### Form state (`scripts/form-state.mjs`)

`flags.pf2e-dungeon-crawl.form = { slug, source, enteredAtWorldTime, expiresAtWorldTime|null, effectUuid, restricts?: ["melee-attack","ranged-attack"] }` on the actor. Helpers: `currentForm(actor)`, `enterForm`, `leaveForm` (idempotent). The `inForm` requirement predicate (added to #934's closed set) is true when a form record exists whose `slug` is an *assumed* form (anything other than the true form); `inForm:<slug>` tests a specific form.

The effect item carries the form's rule elements; the flag is the module's own handle for predicates and cleanup. Both are removed together.

### Transform entries (extends #984's table)

```js
{ id: "rushed-transformation", match: { name: "Rushed Transformation" }, fixtureHash: "…",
  transform: { slug: "humanoid-form-rushed", base: "Compendium.pf2e.spell-effects.Item.Spell Effect: Humanoid Form",
               remove: [{ rule: "FlatModifier", selector: "deception" }],   // no +4 Deception
               durationSeconds: 60, dismissible: true, sideEffects: ["leaveScraps"], frequency: { per: "hour", max: 1 } } }
```

- **Rushed Transformation:** clone the *Humanoid Form* spell effect, strip the Deception bonus rule, set a 1-minute duration, tag it (`agentSelfEffect`, #914), set the form flag, apply `frequency` through #910's store. **Scraps:** whenever the effect ends (expiry, Dismiss or revert), place a small "scraps of magically conjured flesh" marker (a note in chat and a flag on the actor/scene) that the GM sees; mechanically it only reveals presence (a planning detail: a chat whisper or a visual token note).
- **Crystalline Dust Form:** an effect with `BaseSpeed fly 40`, a note that it can fit through tiny apertures (the module's pathfinder treats the token as `tiny` for squeeze costs via `CreatureSize`), and an attack restriction (`restricts: ["melee-attack","ranged-attack"]`) honored by the Strike vocabulary: while the form is active, Strike candidates are removed (spells remain). Dismiss returns to humanoid form.
- **Revert Form:** `requires: ["inForm"]`, a free action; ends the current form (removes the form effect and flag) and creates the linked "Effect: Revert Form" (+2 status bonus until the start of the next turn).

All entries are exact-match reviewed (fixture hash of the item text); a changed item disables its entry.

### Vocabulary

Transforms become `npcSelf` entries (`kind: "transform"` / `"revert"`) with deterministic summaries ("assume humanoid form for 1 minute: +…; can't use some abilities"; "revert: +2 status bonus to everything until next turn"). A creature in a form also gets a **Dismiss** entry (free or 1 action as the item states) generated from the form record.

The reasoning model sees the form restrictions in the candidate context (e.g. "in dust form: cannot Strike"). The Strike builder consults `currentForm(actor).restricts`.

### Ranked audit and growth path

`tools/audit-transformations.mjs` lists all transformation abilities (traits `polymorph` or text matching "transform", "shifts into", "assumes the form"), classifies each as `table-clean` (a spell effect or a short list of native rule elements captures it), `needs-battleform`, or `unsupported`, and ranks by creatures sharing the name × encounter frequency. The clean ones are added as reviewed table entries in frequency order, with the same fixture hashes; the others are listed with reasons in the golden file (monotonic count ratchet as #984).

### Reporting

#925 records the transform ("assumes humanoid form for 1 minute") and the revert.

## Error handling

- Base spell-effect item missing: the entry is not offered.
- Effect creation failure: no form flag written; the action is unspent.
- Effect expiring (system expiry) clears the flag via the item-delete hook; combat end cleanup removes tagged leftovers.
- A form record with no effect (effect deleted manually) is treated as not in form and cleaned.

## Testing

- **Form state:** enter/leave idempotence; `inForm` predicates; cleanup on effect deletion.
- **Entries:** Rushed Transformation strips the Deception rule and sets the duration; dust form gives fly 40, size handling and the Strike restriction; Revert Form requires a form and applies the linked effect.
- **Vocabulary:** Dismiss entry generation; restricted Strikes removed; frequency.
- **Audit:** fixture classification and ratchet.
- **Live verification:** a conspirator dragon assumes humanoid form for a minute; an ugothol reverts and gets the +2 bonus.

## Explicitly out of scope

- `BattleForm`-based transformations and wholesale stat-block replacement.
- Transformations of player characters.
- Illusory disguises without mechanical changes (covered by #984's other primitives).

## Open questions

None. Planning-time details: how "scraps" is surfaced (chat note vs token marker) and the audit's frequency cutoffs.
