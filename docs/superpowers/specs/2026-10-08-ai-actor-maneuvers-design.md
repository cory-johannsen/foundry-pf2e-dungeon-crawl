# Advanced AI Actors: Martial Maneuvers via a Reasoning-Model Candidate Pipeline

**Issue:** #909 — AI-controlled actors should use the full breadth of available PF2e actions (healing, buffs, debuffs, crowd control, feats, class actions, weapon selection/switching), not just the current subset.

**Status:** Approved via conversational design (this session). Scope narrowed from #909's full breadth to one subsystem, confirmed with the owner: martial maneuvers (Trip/Shove/Grapple/Disarm/Demoralize), implemented via a new general-purpose agent-service "reasoning model" candidate-generation pipeline. Feat/class-action modeling and weapon-switching (the other two #909 gaps) are deferred to reuse this same pipeline later; feat-modified maneuver variants (Improved Grab, Titan Wrestler, etc.) are deferred to a separate follow-up. See #910 and #911.

## Summary

Today, AI-controlled combatants only ever get `stride`/`strike`/spell candidates (`scripts/agent-candidates.mjs`'s `buildCandidateList`) — there is no martial-maneuver candidate type at all, so a non-caster agent only ever strikes. This spec adds the five PF2e basic combat maneuvers (Trip, Shove, Grapple, Disarm, Demoralize) as a new candidate type, generated through a new agent-service pipeline stage: Foundry deterministically enumerates the actor's real, legally-available maneuver vocabulary for the turn; a new agent-service "reasoning model" endpoint picks a tactically-sensible subset of that vocabulary (with per-pick rationale); Foundry validates each pick against the vocabulary it sent and merges the survivors into the existing candidate list; the existing `/v1/combat-decision` call and `applyAgentDecision` dispatch are otherwise unchanged.

## Motivation

AI-controlled martial actors (fighters, barbarians, most NPCs) have no mechanical options beyond "attack" — they never trip, shove, grapple, disarm, or demoralize an opponent, even when it would be the obviously correct tactical choice (e.g. tripping a foe about to flee, demoralizing a low-Will spellcaster). This is a real combat-AI capability gap, not a cosmetic one.

## Investigation findings (this session, all confirmed live against this repo and the installed PF2e system)

- `scripts/agent-candidates.mjs`'s `buildCandidateList` already has a rich **spell**-based repertoire (`stride`/`strike`/`seek`/`endTurn` plus a dozen spell-candidate builders covering area, heal, buff, debuff, chain, breath weapon, multi-strike, dual-nature, target-count, auto-hit-area, and attack spells) — healing/buffing/debuffing/crowd-control are already modeled **for spellcasters only**. The confirmed gap is purely non-spell: no martial maneuvers, no feat/class-action modeling, no weapon-switching.
- `scripts/dungeon-combat.mjs`'s `runAgentDecisionLoop` is the existing agent-service integration: it calls the agent's configured `/v1/combat-decision` endpoint with `{ ...pending.context, actorProfile }`, gets back `{ candidateId, rationale }`, and applies it via `applyAgentDecision` — a failed/unconfigured call is already handled gracefully (silently falls through to `armAgentTimeout`'s existing heuristic fallback).
- `tools/agent-service/server.mjs` already has two route shapes: `/v1/combat-decision` (provider-selectable — Laya or litellm — picks **one** candidate from a fixed list) and `/v1/flavor-customization` (always litellm, schema-constrained structured **generation** from `tools/agent-service/customization-generator.mjs`'s per-kind JSON Schema table, never provider-selectable because Laya can only answer typed choice/score/bool questions, not generate structured content). The new pipeline stage this spec adds is shaped like the second kind, not the first.
- `scripts/dungeon-strike-riders.mjs`'s `resolveAthleticsRider` (used for Grab/Knockdown strike riders) is the exact precedent for maneuver execution: roll the attacker's real `actor.skills.athletics` statistic against the target's real save DC via `athletics.roll({ dc: { value: dc }, createMessage: true })`, read the outcome off the just-created chat message's `flags.pf2e.context.outcome`, then apply the maneuver's own RAW consequence by hand (PF2e's own check-rolling is reused; nothing about the roll itself is reimplemented).
- The installed PF2e system (`pf2e.mjs`) confirms `game.pf2e.actions.trip/shove/grapple/disarm/demoralize(...)` exist as real, callable macros on the same `game.pf2e.actions` surface this module already uses for `restForTheNight` (`scripts/dungeon-scene.mjs:1522`). Each macro's `simpleRollActionCheck` helper accepts an explicit `target` callback (not only a UI-selected `game.user.targets`), so headless/agent-driven invocation without a human selecting a target first is supported. None of the five macros auto-apply their own outcome's condition (no Prone/Grabbed/Frightened/item-drop) — they only roll the check and report the outcome via `callback`, confirmed by reading each macro's body; applying the RAW consequence is always the caller's job, exactly as `resolveAthleticsRider` already does by hand for Grab/Knockdown.
- The PF2e system's own action text (`lang/action-en.json`, read directly rather than guessed) gives the exact prerequisites and outcome table for all five maneuvers — see "Maneuver reference table" below. None of the five macros track Demoralize's documented 10-minute re-attempt immunity; the system provides no effect item for it either (confirmed: no "Demoralize"-named effect exists in the installed system, and the macro body applies no such state) — this module must track it itself.
- #785 (the game clock, merged just before this session) gives this module a real, persistent `game.time`/`worldTime` — the Demoralize immunity window ("temporarily immune... for 10 minutes") can be timestamped against real elapsed game time (`worldTime + 600`) rather than an approximate round-count, which is more RAW-faithful than any round-based approximation would have been and ties directly into existing, already-shipped infrastructure.

## Decisions

1. **Scope: the five basic maneuvers only, via a new general-purpose reasoning pipeline.** Not a one-off `buildManeuverCandidates` deterministic builder (the original framing) — the owner explicitly wants the agent service to supply a reasoning model that *generates* the candidate list, reusable later for feats/weapon-switching (#910) without redesigning the pipeline.
2. **Foundry enumerates the legal vocabulary; the reasoning model only selects and parameterizes from it, never invents.** The reasoning model is given a vocabulary of `(maneuver, targetId)` pairs Foundry has already determined are legally available this turn (skill exists, range, line of sight, PF2e RAW prerequisites — see Decision 3) and returns a subset with rationale. This matches CLAUDE.md's "prefer the PF2e system's own implementation / don't invent house rules" directly: legality is always decided by deterministic code reading real PF2e data, never by the LLM.
3. **Full RAW prerequisites are enforced in vocabulary enumeration, not just skill/range/LOS.** Trip/Shove/Grapple/Disarm all require ≥1 free hand (or a weapon with the matching trait) and a target no more than one size category larger than the attacker; Demoralize requires the target within 30 ft, aware of the attacker, and not within its 10-minute re-attempt immunity window. All five prerequisites are taken verbatim from the installed system's own `lang/action-en.json` action text (see "Maneuver reference table"), not approximated.
4. **The new agent-service endpoint is pinned to litellm only, never provider-selectable.** Named generically, `/v1/combat-candidates`, so a later addition (feats, weapon-switching) is a new `vocabulary` entry `type`, not a new endpoint. Reasoning-model picks are validated against the vocabulary Foundry sent (referential-integrity check only — never a second PF2e-rules legality filter, since everything in the vocabulary is already legal by construction).
5. **The reasoning-model call is skipped when the vocabulary is empty.** No extra latency/cost on a turn where the actor has no eligible maneuver (e.g. no trained Athletics/Intimidation, or no valid target) — falls straight through to today's deterministic `stride`/`strike`/`cast*` candidates.
6. **Execution reuses PF2e's own `game.pf2e.actions.<slug>()` macros with an explicit `target`**, applying each maneuver's documented RAW outcome by hand afterward (condition, forced movement, item-drop effect, or Demoralize's immunity timestamp) — the same "call the system's own check, then hand-apply the documented consequence" shape `resolveAthleticsRider` already established.
7. **Demoralize's 10-minute re-attempt immunity is tracked as a real game-time timestamp** (`worldTime` at the moment of the attempt, regardless of outcome, + 600 seconds), reusing #785's game clock rather than inventing a round-count approximation or an encounter-scoped flag.
8. **Feat/class-action modeling, weapon-switching, and feat-modified maneuver variants are explicitly out of scope here** — filed as #910 and #911 respectively, both designed to build on this spec's pipeline/vocabulary builder rather than invent a second one.

## Maneuver reference table

Taken verbatim from the installed PF2e system's own `lang/action-en.json` (not summarized from memory):

| Maneuver | Statistic | Target DC | Prerequisites (beyond range/LOS) | Critical Success | Success | Critical Failure |
|---|---|---|---|---|---|---|
| Trip | Athletics | Reflex | ≥1 free hand (or trip-trait weapon); target ≤1 size larger | Prone + 1d6 bludgeoning | Prone | Attacker falls Prone |
| Shove | Athletics | Fortitude | ≥1 free hand (or shove-trait weapon); target ≤1 size larger | Target pushed 10 ft | Target pushed 5 ft | Attacker falls Prone |
| Grapple | Athletics | Fortitude | ≥1 free hand (or grapple-trait weapon) **or** target already Grabbed/Restrained by attacker; target ≤1 size larger | Target Restrained until end of attacker's next turn (unless attacker moves or target Escapes) | Target Grabbed (same duration) | If target was already Grabbed/Restrained by attacker, it breaks free and may Grapple or Trip the attacker |
| Disarm | Athletics | Reflex | ≥1 free hand (or disarm-trait weapon); target ≤1 size larger | Item knocked to target's square | Apply `Compendium.pf2e.other-effects.Item.PuDS0DEq0CnaSIFV` ("Disarm (Success)": +2 circumstance to further Disarm attempts on that item, target takes −2 circumstance on checks/attacks requiring a firm grip on it, until the target Interacts to reset its grip) | Attacker becomes Off-Guard until the start of its next turn |
| Demoralize | Intimidation | Will | Target within 30 ft, aware of attacker, not within 10-minute re-attempt immunity | Frightened 2 | Frightened 1 | — (no stated critical-failure effect; regardless of outcome, target becomes immune to further Demoralize from this attacker for 10 minutes) |

Melee reach for Trip/Shove/Grapple/Disarm reuses the same `actionReachSquares`/`MELEE_REACH_SQUARES` logic `buildStrikeCandidates` already uses. Demoralize's 30 ft is a fixed range (6 squares at this module's 5 ft/square grid), not reach-based.

## Architecture

### 1. Vocabulary enumeration (Foundry-side, deterministic, no LLM)

A new `buildManeuverVocabulary(combatant, opponents)` in `scripts/agent-candidates.mjs`, called from `getPendingAgentTurn` (`scripts/dungeon-combat.mjs`) alongside the existing `readyActions`/`readySpells` builders. For each of the five maneuvers, for each opponent:

- Skip the maneuver entirely if the attacker lacks the relevant statistic (`actor.skills.athletics` or `actor.skills.intimidation`, same existence guard `resolveAthleticsRider` already uses).
- Check range (melee reach for the four Athletics maneuvers; 6 squares for Demoralize) and line of sight (reusing the existing `hasLineOfSight` check already computed for `opponents` in `getPendingAgentTurn`).
- Check the free-hand-or-matching-weapon-trait and size-category prerequisites (Trip/Shove/Grapple/Disarm) by reading the attacker's held items/traits and both creatures' `system.traits.size` — the exact accessor for "free hand" is confirmed during planning (the installed system's internal `getBestEquippedItemForAction` helper, referenced from `disarmCheckContext`, is the existing precedent to mirror or call, not reinvent).
- For Demoralize, check the target isn't within its immunity window: `state.rooms[currentRoomId]` (or combat-scoped state — exact location confirmed during planning) tracks a `demoralizeImmunityUntil[attackerId][targetId]` worldTime timestamp; eligible only if `game.time.worldTime >= (demoralizeImmunityUntil[attackerId]?.[targetId] ?? 0)`.

Output: `[{ type: 'maneuver', slug, targetId }, ...]` — the same shape sent to the agent service and validated against afterward.

### 2. The reasoning-model call (agent-service)

If the vocabulary is non-empty, `scripts/dungeon-combat.mjs` calls a new agent-service client function (`scripts/agent-service-client.mjs`, alongside the existing `fetchCombatDecision`), `fetchCombatCandidates({ baseUrl, apiKey, context, vocabulary })`, hitting a new route:

```
POST /v1/combat-candidates
{
  "context": { "self": {...}, "opponents": [...], "allies": [...], "roundNumber": 3 },
  "vocabulary": [
    { "type": "maneuver", "slug": "trip", "targetId": "tok1" },
    { "type": "maneuver", "slug": "demoralize", "targetId": "tok2" }
  ]
}
```

`context.self`/`opponents`/`allies`/`roundNumber` reuse the exact shape `getPendingAgentTurn` already builds for `/v1/combat-decision` — no new context shape. The route (`tools/agent-service/server.mjs`) is always litellm (new `tools/agent-service/candidate-generator.mjs`, modeled directly on `customization-generator.mjs`'s `generateCustomization`/`SCHEMAS` pattern), using a fixed JSON Schema for the response:

```json
{ "picks": [ { "type": "maneuver", "slug": "trip", "targetId": "tok1", "rationale": "..." } ] }
```

The schema constrains `type`/`slug` to known enums and `targetId` to a string; it cannot by itself guarantee the pick was actually offered (that's Foundry's job, next).

### 3. Validation and candidate construction (Foundry-side)

Back in `scripts/dungeon-combat.mjs`, each returned pick is checked against the exact vocabulary array just sent — a pick whose `(type, slug, targetId)` triple isn't a literal member of that array is dropped (logged via `console.error`, not thrown). Surviving picks become new candidates, `{ id: `maneuver:${slug}:${targetId}`, type: 'maneuver', slug, targetId, cost: 1, summary: rationale }`, appended to `buildCandidateList`'s output before it's sent to the existing `/v1/combat-decision` call — which proceeds completely unchanged, now just seeing a few more options in the same list it already handles generically.

### 4. Execution (`applyAgentDecision`, `scripts/dungeon-combat.mjs`)

A new `case 'maneuver':` branch (alongside the existing `strike`/`cast*` branches) looks up the target combatant, then calls `game.pf2e.actions[slug]({ actors: [combatant.actor], target: () => ({ actor: target.actor, token: target.token }), event: null, callback: async ({ outcome }) => { /* apply RAW consequence per the reference table */ } })`. The callback:

- Trip/Shove/Grapple/Disarm: applies the matched condition via `target.actor.increaseCondition` (Prone/Grabbed/Restrained — same helper `applyConditionOnSuccess` in `dungeon-strike-riders.mjs` already wraps), or for Shove's forced movement, reuses the existing push-resolution movement machinery `dungeon-combat.mjs`'s own Improved Push rider handling already has (`posturePath`/`walkPath`); Disarm applies `Compendium.pf2e.other-effects.Item.PuDS0DEq0CnaSIFV` on success or drops the held item to the target's square on a critical success; Trip's critical success additionally rolls `1d6` bludgeoning damage.
- Demoralize: applies Frightened 1/2 via `increaseCondition`, and regardless of outcome writes `demoralizeImmunityUntil[attackerId][targetId] = game.time.worldTime + 600`.
- Every outcome (including failure/critical failure) is whispered to the GM via `whisperGm`, matching `resolveAthleticsRider`'s existing chat-reporting convention.

## Error handling

- `agentServiceUrl` unconfigured, the `/v1/combat-candidates` call fails, times out, or returns a malformed/non-schema-conforming body → no maneuver candidates are added for that turn; the existing deterministic `stride`/`strike`/`cast*` set proceeds exactly as it does today. This never blocks or delays the turn beyond the one extra call's own timeout.
- A vocabulary-mismatched pick is dropped individually; the turn proceeds with whatever valid picks (possibly zero) remain.
- A maneuver's prerequisite-check data is unreadable (e.g. an actor/target with no `system.traits.size`, or an item without a readable trait list) → that maneuver is excluded from the vocabulary for that pairing, never defaulted to "available."

## Testing considerations

- `buildManeuverVocabulary` is pure given an actor/opponent snapshot and is fully unit-testable without a live Foundry world (same convention as `buildStrikeCandidates`/`buildSpellCandidates`), including every prerequisite: free hand, size cap, Demoralize range/awareness/immunity-timestamp check.
- The new `tools/agent-service/candidate-generator.mjs` is testable the same way `customization-generator.mjs` already is — schema validation, and a fake litellm response fixture.
- The pick-validation step (vocabulary-membership check) needs tests for: a pick matching the vocabulary (kept), a pick with a right type/slug but wrong targetId (dropped), and a pick for a maneuver never in the vocabulary at all (dropped).
- `applyAgentDecision`'s new `maneuver` branch needs a mocked-`game`/`game.pf2e.actions` test per maneuver, asserting the correct condition/effect/immunity-write happens on each outcome (`criticalSuccess`/`success`/`failure`/`criticalFailure`), matching `tests/`'s existing Foundry-stub conventions (e.g. `tests/dungeon-app-treasure-chat.test.mjs`'s `installFoundryStubs` pattern).

## Explicitly out of scope

- Feat/class-action modeling (Rage, Stances, Hunt Prey, Devise a Stratagem, etc.) — #910, reusing this spec's pipeline.
- Weapon selection/switching — not yet filed as its own issue; remains documented as open scope on #909 itself.
- Feat-modified maneuver variants (Improved Grab, Titan Wrestler, Agile Maneuvers, etc.) — #911, depends on this spec shipping first.
- A GM-facing on/off toggle for whether maneuver candidates are offered at all — this is always-on for any agent-controlled combatant with an eligible maneuver, matching #785's own "automatic, not a toggle" precedent for mechanical correctness features.
- Multi-encounter Demoralize-immunity edge cases beyond the worldTime-timestamp approach (handled correctly by construction, since it's real elapsed game time, not an encounter-scoped flag).

## Open questions

None remaining — every decision point raised during this session's design was resolved above.
