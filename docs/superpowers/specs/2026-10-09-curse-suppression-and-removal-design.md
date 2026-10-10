# Advanced AI Actors: Curse Suppression, Removal and Unmodeled Curse Traits

**Issue:** #1096 — suppression, remove-curse/counteract integration and non-mechanical curse effects (Curse of Darkness), deferred from #987.

**Builds on:** #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (`damageTypeCurse` outcome, the native `DamageAlteration` effect, `suppressible`), #1021 / `docs/superpowers/specs/2026-10-09-ai-npc-spell-counteract-reactions-design.md` (`rollCounteract`), #935 (`applyTimedEffect`, immunity windows), #914 (agent tagging and combat-end cleanup), #1094 (action-tracker integration for human-driven turns).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#987 applies curse outcomes as timed effects. This spec adds the three things it left out: the cursed creature's **option to suppress** the curse (All Becomes Flame), **ending curses through counteracting** (including auto-detecting counteract results from the PF2e system), and **curses that grant unmodeled traits** with an unlimited duration (Curse of Darkness: Light Blindness plus a grayscale appearance), including the variant that **no counteract can remove**.

## Investigation findings

- **All Becomes Flame** (Cinder Dragon): "The cursed creature can temporarily suppress the curse for 1 round as an action." Parsed by #987 as `damageTypeCurse` with `suppressible: true`; the suppression action itself is #1096.
- **Curse of Darkness** (Owb and Owb Prophet; fixture `tests/fixtures/npc-save-ability-slice.json`): "The owb inflicts a curse on one creature taking persistent cold damage from their burning cold Strike… Fortitude (DC 23 / 32). On a failure, the creature gains Light Blindness and its coloration turns to washed out shades of gray, along with all equipment it carries, wields, or wears. These effects have an unlimited duration. Regardless of the result of its save, the creature is temporarily immune for 1 minute. If the owb uses this ability on a caligni, the curse can't be removed short of a Wish ritual or similar powerful magic." Currently `expected: null` in the audit fixture (not auto).
- **Light Blindness** is an ability item in `pf2e.bestiary-ability-glossary-srd`; granting it is an item add, removable when the curse ends.
- **Counteracting** is a PF2e system flow (a counteract check against the effect's level/rank). #1021 already provides `rollCounteract` for NPC reactions; the system posts counteract chat messages with the roll's context that can be read.
- **Human-driven turns:** spending the suppression action uses #1094's action-tracker integration.

## Resolved decisions

1. **Suppression:** AI-controlled cursed creatures get a cost-1 "suppress curse" candidate; players (and the GM) get a button on the curse effect. Either pauses the curse's rule elements for 1 round and spends an action.
2. **Removal:** curse effects record a counteract level and DC; the module **auto-detects the PF2e system's counteract results** aimed at the cursed creature and removes the curse when the check beats the curse's level/DC, plus a GM context-menu "Counteract curse" action that runs `rollCounteract` for cases the system flow doesn't cover.
3. **Curse of Darkness traits:** add Light Blindness as an item for the curse's duration and apply a grayscale filter to the token art; equipment coloration stays descriptive.
4. **Unremovable variant is in scope:** a curse flagged `removableOnlyBy: "wish"` ignores ordinary counteract results and ends only by GM action or a Wish-ritual counteract.
5. **Unselected options are filed:** equipment coloration rendering (#1208), a GM active-curses panel (#1209), a curse-immunity-window display (#1210), and portrait recoloring (#1211).

## Design

### Curse effect shape (extends #987's synthesized effect)

A curse effect gains flags under `flags.pf2e-dungeon-crawl.curse`: `{ sourceAbility, counteractLevel, counteractDC, suppressible, suppressedUntil, removableOnlyBy }`. `counteractLevel` is the source creature's level (or the ability's stated rank) and `counteractDC` its save DC; both are read from the originating actor at application time. `removableOnlyBy` is `null` for ordinary curses and `"wish"` for the caligni variant. Unlimited duration is `system.duration.unit: "unlimited"`; unlimited curses are not removed at combat end (an agent-tagged curse with `unlimited` is excluded from #914's cleanup).

### Suppression

- **Effect.** Suppressing sets `suppressedUntil` to the start of the creature's next turn and disables the rule elements via a native toggle (`ToggleProperty` / `Effect.system.unidentified`-style disable, chosen in planning) so the damage alteration stops applying; the item stays.
- **AI.** A `suppressCurse` candidate (cost 1, available when the actor has a `suppressible` curse not already suppressed) joins the candidate list. The decision loop picks it when the curse is currently harmful; a simple heuristic (the curse applies a damage type the creature's best Strike/spell would use or that it is vulnerable to) is the default and planning refines it.
- **Humans.** The curse effect shows a "Suppress curse (1 action)" button. Clicking it applies the suppression and, through #1094's integration, logs the action in the action tracker.
- **Expiry.** The suppression ends at the next turn start; the module re-enables the rule elements.

### Removal

- **Auto-detect.** A `createChatMessage` hook recognizes the system's counteract results (message context `type: "counteract-check"` or equivalent; exact shape verified in planning) whose target is a creature with a curse effect; compare the counteract check's result against `counteractDC` and its rank/level against `counteractLevel` per the PF2e counteract rules (success vs. a lower or equal level, or critical success beating a higher-level); on success remove the curse and its granted items.
- **GM action.** The curse effect's context menu gains "Counteract curse", which calls #1021's `rollCounteract` with the GM-chosen counteract modifier and applies the same rule.
- **`removableOnlyBy: "wish"`.** Ordinary counteract results are ignored with a note; only a GM "Remove (Wish)" action or a counteract message whose source is a Wish-ritual spell item removes it.

### Curse of Darkness

Grammar and table: the outcome gains two entries — `grantsItem: { uuid: "Compendium.pf2e.bestiary-ability-glossary-srd.Item.Light Blindness" }` and `tokenFilter: "grayscale"` — attached to the failure degree, plus `durationSeconds: null` (unlimited) and `immuneSeconds: 60`. The owb abilities move from `expected: null` to `auto`, with the caligni variant a reviewed override that sets `removableOnlyBy: "wish"` when the target actor has the `caligni` trait.

The token filter is applied with the token's `texture.tint` / a PIXI desaturate filter via the module's token-appearance helper (planning chooses the least invasive approach); it is removed when the curse ends. Equipment coloration is descriptive only and stays in the effect's description.

## Error handling

- A counteract message that can't be read is ignored and logged; the GM action remains the fallback.
- If Light Blindness can't be resolved from the compendium, the curse still applies (without the item) and the GM is told.
- A suppression that fails to disable the rule elements leaves the curse active and reports why; the action is not spent.
- A token-filter failure is logged and does not block the curse.
- Hooks never throw into the combat turn.

## Testing

- **Parser/table:** the Owb and Owb Prophet texts become `auto`; the caligni override sets `removableOnlyBy`; a near-miss stays `reportOnly`.
- **Curse flags:** `counteractLevel` / `counteractDC` read from the originating actor; unlimited durations survive combat-end cleanup.
- **Suppression (mocked):** AI candidate availability and cost; heuristic picks vs. skips; human button applies and re-enables at next turn start; the action is logged via the tracker integration.
- **Removal (mocked messages):** counteract success removes the curse and granted items; failure leaves it; rank/level comparison edge cases; `removableOnlyBy: "wish"` ignores ordinary results and accepts the Wish source; GM action runs `rollCounteract`.
- **Regression:** #987 curse effects (timed ones, All Becomes Flame) unchanged when not suppressed or counteracted.
- **Live verification:** All Becomes Flame suppressed by an AI creature and by a player; a spell's counteract result removing an "until removed" curse; a Curse of Darkness failure granting Light Blindness and a grayscale token that clears when counteracted; a caligni target ignoring a successful ordinary counteract.

## Explicitly out of scope

- Equipment coloration rendering (#1208), an active-curses panel (#1209), a curse-immunity-window display (#1210), portrait recoloring (#1211).
- Counteracting non-curse effects; Wish ritual automation beyond recognizing its spell item as the source.
- Re-cursing rules beyond the existing immunity windows.

## Open questions

None blocking. Left to planning: the exact counteract chat-message shape in the installed PF2e (8.5.0), the least invasive mechanism for toggling a rule-element effect off for a round, the token-grayscale mechanism, and the AI heuristic for choosing to suppress.
