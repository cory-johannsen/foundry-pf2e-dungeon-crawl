# Advanced AI NPCs: Self-or-Ally Heals (Dero Medicine)

**Issue:** #1056 — NPC heals that target the actor or an ally (Dero Medicine and check-based heals).

**Builds on:** #981 / `docs/superpowers/specs/2026-10-09-ai-npc-ally-buffs-design.md` (ally-targeting buffs and heals: Foundry enumerates, the model chooses; subject filters; ranking), #934 (heal application and requirement predicates), #928 (NPC self-heals), #909 (candidate pipeline), #935 (timed effects, outcome model), #925 (result descriptor), #1052 / `docs/superpowers/specs/2026-10-09-ai-npc-iwr-adjustments-design.md` (weakness adjustments).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#981 left heals that target the actor *or one adjacent ally* for later. The ability named in the issue, **Dero Medicine**, appears in seven dero stat blocks. This spec adds a **general self-or-adjacent-ally heal executor** and models Dero Medicine as it is actually written in the compendium. A check-then-heal executor (the issue's speculative second half) is filed as #1176 because no current ability uses it.

## Investigation findings

- **Dero Medicine** (dero stalker, strangler, magister and four others; 1 action, healing/manipulate): requirement — the dero is wearing a cytillesh toolkit and has a hand free; effect — the dero heals itself or an ally in reach for `2d8` Hit Points; for 1 hour the target has **slashing weakness 2** and is **immune to Dero Medicine**. It links the effect "Effect: Dero Medicine" (which carries the weakness and immunity).
- **No check.** The issue assumed "a Medicine check against a DC, with the amount healed varying by degree". In the compendium the ability is a flat heal; no current NPC heal found in Monster Core, Monster Core 2 and the Bestiaries uses a check with degree outcomes. The text's requirement (toolkit worn, hand free) is a closed-set predicate (#934 style: `wearing` an item, `handFree`).
- **Existing pieces.** #928's self-heal executor (healing roll, capped at max HP, announcements), #981's ally enumeration and ranking, #934's requirement predicates, #935's timed effects (the weakness and immunity as an effect with a 1-hour duration), #1052's weakness view for the weakness (the effect carries a native `Weakness` rule, so no registry is needed).

## Resolved decisions

1. **Model Dero Medicine as written**, plus a **general self-or-adjacent-ally heal executor**; the check-based variant is filed as #1176.
2. **Target choice:** Foundry enumerates the actor plus each adjacent willing ally that is not immune; ranks them lowest HP fraction first; the model chooses among the best few (as #981).

## Design

### Recognition (`scripts/npc-ally-heal.mjs`, pure)

`parseAllyHeal(item)` returns `null` or `{ cost, requirements[], reach, heal: { formula }, rider: { effectUuid, durationSeconds }, immunityWindow }`:

- The item must be an action (1–3 actions) with the `healing` trait whose text matches "heals themself or an ally in reach for <@Damage[...healing]>" (the closed phrase), optionally followed by sentences consumed by the rider grammar: "For N hours/minutes/rounds, the target has <weakness|resistance> X and is immune to <this ability's name>". A linked effect is read from the `@UUID` of a `bestiary-effects` item.
- Requirements use #934's closed set: `wearing:<item name>` (the cytillesh toolkit) and `handFree`. Any other requirement → not offered.
- All-or-nothing: every sentence must be consumed.

### Vocabulary

New `npcAllyHeal` entry per eligible target:

`{ type: "npcAllyHeal", slug, targetId, cost, summary }` where `targetId` is the actor itself or an adjacent willing ally.

- Eligible targets: the actor; allies (same disposition/party) within the ability's reach (5 ft); each must have `hp < max`, not be dead, and not carry the ability's immunity marker (an active "Effect: Dero Medicine" or the ability's own immunity window flag).
- Ranking: lowest HP fraction first; ties by distance; cap of 3 entries (the best few). The model chooses via the existing #909 pipeline.
- Summary: "heal <name> for 2d8 (HP 12/40); gives slashing weakness 2 for 1 hour".

### Execution (`applyAgentDecision`, `npcAllyHeal` branch)

1. Re-check requirements and target legality.
2. Roll the healing (`2d8`), apply through the heal helper (capped at max HP, no overheal; self-target reuses #928).
3. Apply the rider effect to the target: create the linked effect (`Effect: Dero Medicine`) from the compendium if present, else a module effect built from the parsed rider (weakness 2 to slashing, 1 hour, tagged `agentSelfEffect` for #914 cleanup at combat end only if the duration is unlimited; timed effects expire naturally). The effect records the immunity window.
4. Public announcement and #925 descriptor ("The dero stitches Dero Magister: +11 HP").

### Immunity and eligibility tracking

The immunity "to Dero Medicine" for the 1-hour duration is the presence of the effect (and a flag `flags.pf2e-dungeon-crawl.abilityImmunity[<slug>]` with an expiry on the game clock, #785, for the case where the effect item is removed early). Both are checked at enumeration.

### Reporting

Result descriptor extends with `{ target, healed, rider }`.

## Error handling

- No eligible targets or a failed requirement: not offered.
- Effect creation failure: the heal still applies and the GM is told; the immunity flag is still written to prevent repeat use.
- Max-HP target: never offered (no wasted action).

## Testing

- **Recognition:** Dero Medicine parses for all seven creatures; variants with extra text are rejected; fixture hash.
- **Vocabulary:** self and ally entries, adjacency, immunity exclusion, ranking by HP fraction, cap.
- **Executor (mocked Foundry):** heal capped at max HP, effect with weakness applied, immunity flag, requirement failures.
- **Live verification:** a dero heals itself and then an adjacent ally; the second heal of the same ally is not offered for an hour.

## Explicitly out of scope

- Check-then-heal executor — #1176.
- Group heals (#1057).
- Healing spells (the AI caster pipeline).

## Open questions

None. Planning-time details: whether the compendium effect is cloned from `bestiary-effects` or rebuilt, and the reach measurement for large creatures.
