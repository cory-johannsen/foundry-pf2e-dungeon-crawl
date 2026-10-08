# Advanced AI Actors: NPC Save-Based Special Abilities

**Issue:** #915 — NPC/monster special-ability action modeling.

**Builds on:** #909 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuvers-design.md` (the `/v1/combat-candidates` reasoning pipeline and vocabulary/validation shape) and the existing breath-weapon machinery in `scripts/agent-candidates.mjs` / `scripts/dungeon-combat.mjs` (`parseBreathWeaponEffect`, `buildBreathWeaponCandidates`, the per-ability recharge store). This spec adds a third vocabulary `type` and generalizes the breath-weapon placement/recharge code; it adds no new endpoint and no second reasoning mechanism.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions"). First slice: **save-based NPC abilities that inflict conditions, with no damage**.

## Summary

NPC/monster special abilities are mostly prose with inline Foundry enrichers. Today an AI-controlled monster uses strikes, multi-strike bundles (e.g. Rend), strike-rider reminders (Grab, Knockdown) and breath weapons (damage + template + basic save + recharge). Abilities such as Bloodcurdling Screech, Petrifying Gaze, Hungry Winds, Terrifying Display and Frightful Moan — a targeted or area effect with a saving throw that applies a condition — are never used.

This spec adds those abilities as a new `npcAbility` vocabulary entry. Foundry deterministically recognizes them from structured data only (inline `@Check`, `@Template`, degree-of-success blocks and condition links in the ability's own description), computes legal targets, and the #909 reasoning endpoint picks among the offered entries. Execution is fully automatic when the outcome text parses cleanly (roll each target's save through the system, adjust for the incapacitation rule, apply the inflicted conditions with their durations, track "temporarily immune" windows on the game clock); otherwise the ability is still offered but executes as **roll-and-report** (saves rolled, the monster's own outcome text whispered to the GM to apply by hand).

## Investigation findings

Confirmed against the repo, the installed PF2e system and the local PF2e source data (`~/pf2e-data/packs/pf2e`: Monster Core 1–2, Bestiary 1–3 — 1,433 NPCs, 2,703 active (1–3 action or free) action items).

- **What the module already does for NPC actions.** Breath weapons (`@Damage` + `@Template` + basic `@Check` + optional `[[/gmr ... #Recharge]]`) are parsed by `parseBreathWeaponEffect` and offered via `buildBreathWeaponCandidates`, with best-placement selection over precomputed template placements and a per-combat `abilityRecharge` flag (`getAbilityRecharge`/`setAbilityRecharge`, `dungeon-combat.mjs`). Multi-strike bundles and strike-rider reminders (`dungeon-strike-riders.mjs`: Grab as a real Athletics rider; Knockdown etc. as GM reminders) exist. Nothing handles a save-based ability that applies a condition and deals no damage.
- **Breakdown of the 2,703 active NPC actions by structure** (save = has a `@Check[fortitude|reflex|will|…]`, dmg = has `@Damage`, tmpl = has `@Template`): no save, no damage, single target 1,474 (mostly Strike-like/interaction actions); save + dmg + template 319 (breath-weapon family); save + dmg single 248; **save, no damage, single target 226; save, no damage, template 106;** no save + dmg 174; plus small groups with the structured `inflicts:` check option (45 + 20 + 17 + 15).
- **The target slice: 369 save-based, no-damage active abilities.** Of these: 112 have separate `<strong>Critical Success/Success/Failure/Critical Failure</strong>` blocks; 168 contain at least one condition link (`@UUID[Compendium.pf2e.conditionitems.Item.<slug>]{Name N}`); **74 have both** (the cleanly parseable core); 37 use the structured `@Check[...|inflicts:<condition>]` option; **71 carry the `incapacitation` trait**. Roughly one in five of the slice is automatable by parsing alone; the rest need the roll-and-report fallback (and a follow-up for coverage, #935).
- **Examples of the parseable shape.** *Radiant Wings* (Quetz Coatl): emanation 30 ft, `@Check[will|dc:29]`; "Critical Success: unaffected and temporarily immune to Radiant Wings for 24 hours. Success: Dazzled for 1 round. Failure: dazzled for 1 minute. Critical Failure: as failure, but ...". *Vanth's Curse*: Frequency three times per day, single target, `@Check[will|dc:25]`; outcomes with Stupefied 1 for 1 minute etc. *Terrifying Display* (Megaprimatus): emanation 50 ft, will DC 27, Frightened with a rider ("While frightened by this ability it is Off-Guard to...").
- **The system provides the save roll, not the application.** `target.actor.saves[<save>]`/`actor.system.saves` statistics roll against a DC and report the degree of success (the same mechanism `resolveAthleticsRider` reads from the created chat message's `flags.pf2e.context.outcome`). The system does not apply a monster ability's conditions for the module; that is the caller's job.
- **Timed conditions have no existing module precedent.** `applyConditionOnSuccess` in `dungeon-strike-riders.mjs` calls `actor.increaseCondition(slug)` with no duration. Timed application must be introduced here (see "Applying inflicted conditions").
- **The game clock exists** (#785): `game.time.worldTime` supports the "temporarily immune ... for 24 hours" windows, matching how #909's Demoralize immunity is tracked.
- **The incapacitation rule (PF2e):** if a creature of higher level than the effect's level is targeted by an incapacitation effect, the result of its save is one degree better; for a monster ability the effect's level is the monster's level. **Correction (verified in `pf2e.mjs`, `Check#roll`):** the system already applies this degree adjustment itself when the roll carries the incapacitation trait (`incapacitation` / `item:trait:incapacitation` roll option) and has a numeric DC; the effect level is taken from the roll context's origin actor (`origin?.actor ?? roller`), so the module's job is to supply that context, not to reimplement the shift. If the origin is omitted the effect level defaults to the roller's own level and no adjustment happens.

## Resolved decisions

1. **Recognition: structured data only.** Foundry enumerates an ability only when it carries parseable inline data (a `@Check` save, a template or an explicit range, degree-of-success blocks, condition links). The reasoning model never reads prose. Prose-only abilities are never offered.
2. **First slice: save-based effects** — targeted or area abilities with a saving throw that inflict conditions and deal no damage. Movement abilities, strike-plus abilities and self-buff/heal abilities are deferred (#932, #933, #934).
3. **Execution: fully automatic when parseable, roll-and-report otherwise.** A parseable ability is applied fully (saves, incapacitation, conditions with durations, immunity). An ability with a recognizable save but unparseable outcomes is still offered; its saves are rolled and the monster's own outcome text is whispered to the GM. Expanding automatic coverage for the rest is #935.
4. **Reactions are out of scope** (#931).
5. **"Temporarily immune" windows are tracked on the game clock** (`worldTime` timestamp, keyed by ability + target), as in #909's Demoralize design.
6. **The incapacitation rule follows PF2e RAW** — by giving the system's own `Check#roll` the context it needs (origin actor, DC, trait), not by reimplementing the shift.

## Architecture

### 1. Recognition and parsing (`scripts/npc-ability-parse.mjs`, pure)

`parseSaveAbility(item)` returns `null` when the item is not in scope, otherwise a descriptor. An item is in scope when **all** hold: `type: "action"` on an NPC actor; `actionType` is `action` or `free`; `system.description.value` contains an `@Check[fortitude|reflex|will|dc:N...]`; no `@Damage` enricher (damaging abilities stay with the breath-weapon/strike code); not a passive/aura or reaction.

Descriptor fields:
- `save` and `dc` from the first `@Check`.
- `shape`: from an `@Template[emanation|burst|cone|line|…|distance:N]` (area, with `areaType`, `distanceFeet`), else single-target with `rangeFeet` parsed from "within N feet" / "up to N feet" / a gaze/touch convention; if neither a template nor a range is found the ability is not offered (no guessing).
- `traits` (notably `incapacitation`), `cost` (`actions.value`, 0 for free), `frequency` (`system.frequency`) and `rechargeFormula` (reusing `parseBreathWeaponEffect`'s recharge regex).
- `degrees`: for each of criticalSuccess/success/failure/criticalFailure, parsed from the `<strong>`-labelled blocks into `{ none: boolean, asFailure: boolean, conditions: [{ slug, value }], durationSeconds, immuneSeconds }`. Conditions come from `@UUID[Compendium.pf2e.conditionitems.Item.<slug>]{<Name> <N>}` links and the structured `inflicts:<slug>` option; durations from "for N round(s)/minute(s)/hour(s)/day(s)" and "until the end of its next turn"; immunity from "temporarily immune ... for N hours/days"; `none` from "unaffected"/"no effect".
- `mode`: `"auto"` when every degree block parses into the grammar above with nothing left over; otherwise `"reportOnly"` (the monster's outcome text per degree is kept verbatim for the GM whisper). Parsing is all-or-nothing per ability.

### 2. Vocabulary enumeration (`buildNpcAbilityVocabulary`, `scripts/agent-candidates.mjs`)

Called from `getPendingAgentTurn` next to the maneuver and feat vocabulary builders, for AI-controlled NPC combatants. For each item with a non-null descriptor:

- Skip if cost exceeds actions remaining; if `system.frequency.value` is 0; if the recharge store says it is not yet available (existing `getAbilityRecharge`).
- **Area shape:** reuse the breath-weapon best-placement machinery to select the origin that catches the most enemies and the fewest allies (an emanation is centered on the actor and has one placement); skip the entry when no enemy is affected or when allies would be affected and no better placement exists.
- **Single target:** one entry per opponent within `rangeFeet` with line of sight and not currently immune (immunity window not expired).
- Entry: `{ type: "npcAbility", itemId, slug, name, mode, cost, targetId?, placement?, affectedIds, summary }` where `summary` is a deterministic one-line description (e.g. "will DC 29 emanation 30 ft: dazzled 1 round/1 minute") built from the descriptor.

If the combined vocabulary (maneuvers, feats, NPC abilities) is empty the reasoning call is skipped, as in #909. Entries are capped per turn (proposed: 8) by affected-enemy count.

### 3. Reasoning call and validation

The #909 endpoint's vocabulary and response schema gain `type: "npcAbility"` with `itemId`/`targetId` as free strings. Picks are validated by literal membership on `(type, itemId, targetId?)`; mismatches are dropped. Surviving picks become candidates `{ id: "npcAbility:<itemId>[:<targetId>]", type: "npcAbility", ... }` appended before the existing `/v1/combat-decision` call, which is unchanged.

### 4. Execution (`applyAgentDecision`, new `case "npcAbility"`)

1. Spend the action cost through the existing `turnState` accounting; record frequency/recharge using the existing stores (`system.frequency.value` decrement as the system does; `setAbilityRecharge` when a recharge formula exists).
2. Post the ability's usage message (`item.toMessage()`).
3. For each affected target: roll the save through the system against the ability DC (`target.actor.saves[save].roll({ dc: { value: dc }, createMessage: true })`), reading the degree of success from the created message (`flags.pf2e.context.outcome`).
4. **Incapacitation:** roll each save with the monster as the roll's **origin actor**, a numeric DC, and the incapacitation roll option when the ability has the `incapacitation` trait (e.g. via the item context or `extraRollOptions`); the system then shifts the degree of success itself for higher-level targets. The module reads the (already adjusted) outcome from the created message. The exact parameter shape for supplying the origin to the save statistic's `check.roll` is confirmed during planning.
5. **`mode: "auto"`:** apply the parsed degree's conditions with durations (below), and when the degree carries `immuneSeconds` write the immunity timestamp `abilityImmunity[itemId][targetId] = game.time.worldTime + immuneSeconds`. **`mode: "reportOnly"`:** apply nothing.
6. Whisper a GM summary per target (save result, degree after incapacitation, what was applied, or for `reportOnly` the monster's own outcome text for that degree) via the existing `whisperGm` convention.

### Applying inflicted conditions with durations

The module has no timed-condition precedent, so this spec adds one helper, `applyTimedCondition(target, { slug, value, durationSeconds, originItem })`. Proposed mechanism: create a single effect item on the target named after the ability, with a `system.duration` matching the parsed duration and a rule element that grants the condition, so the system's own duration handling removes it on expiry and the token shows it; the exact effect/rule-element shape is verified during planning against the installed system (the fallback is `increaseCondition` plus a game-clock expiry the module processes on turn start). Durations expressed in rounds map to `unit: "rounds"`; "until the end of its next turn" maps to the system's turn-end expiry.

## Error handling

- `/v1/combat-candidates` unconfigured, failing or malformed → no NPC-ability candidates that turn; the existing strike/spell/breath/maneuver/feat sets proceed unchanged.
- A descriptor that fails to parse is simply `null` (not offered) or `reportOnly`; parse failure never throws into the turn.
- A save roll that throws for one target is logged and skipped for that target; the remaining targets still resolve.
- Applying a timed condition that throws is logged and reported to the GM; the save outcome and other targets are unaffected.
- An ability with unreadable frequency/recharge data is excluded rather than assumed available.

## Testing

- **Parser (pure):** fixtures drawn from real data for each shape — emanation with full degree blocks and immunity (Radiant Wings), single target with frequency (Vanth's Curse), the `inflicts:` option, "as failure" crit failure, a descriptor with an unparseable block (→ `reportOnly`), no template and no range (→ not offered), damaging ability (→ out of scope).
- **Data-driven coverage audit:** a snapshot test over a fixture of the 369-ability slice asserting counts of `auto` / `reportOnly` / not-offered, so changes to parsing or to the compendium are visible; also the basis for measuring #935's progress.
- **Vocabulary builder:** cost vs remaining actions, frequency 0, recharge unavailable, immunity window active, placement choosing the best origin, no enemies affected, allies in the area.
- **Executor (mocked Foundry):** save rolled per target; the save roll is made with the monster as origin, a numeric DC and the incapacitation option for incapacitation abilities (assert the arguments; the shift itself is the system's); auto mode applies conditions/durations/immunity; reportOnly applies nothing and whispers the text; one failing target does not stop the others.
- Live verification: a monster with Bloodcurdling Screech-style and Radiant-Wings-style abilities in a real fight; confirm conditions appear with the right durations, expire, and immunity blocks a re-use.

## Explicitly out of scope

- Reactions (#931), movement abilities (#932), strike-plus abilities (#933), self-buff/heal abilities (#934).
- Expanding automatic parsing coverage beyond the structured subset (#935).
- Damaging save abilities (breath-weapon family and others) — the existing breath-weapon code owns them.
- Passive abilities and auras (handled by the PF2e system's own rule elements).
- Prose interpretation by the reasoning model.
- A GM on/off toggle (always-on, matching #909 and #785).

## Open questions

None remaining; scope questions were resolved with the owner on 2026-10-08 (decisions 1–6). Implementation details left to planning: the exact timed-condition mechanism (see above), the per-turn entry cap, and the single-target range convention for gaze/touch abilities.
