# Advanced AI Actors: NPC Reactions (Movement-Triggered Attacks and Defensive Reactions)

**Issue:** #931 — NPC reaction abilities (Attack of Opportunity, Goblin Scuttle, Petrifying Glance, ...).

**Builds on:** the existing reaction machinery from #202 in `scripts/dungeon-combat.mjs` (`findReactiveStrikeOpportunities`, `offerReactiveStrikesAgainst`, `handleRangedAttackForReactiveStrike`, `getReactionUsed`/`markReactionUsed`), the manual-Strike damage handler from #47 (`handleManualStrikeDamage`), the agent-service decision call (`fetchCombatDecision`, #909's pipeline conventions), and #925's per-turn action card for reporting.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions"), plus the owner's rule that **in GM-less mode reactions must be fully automatic**.

## Summary

The issue says the module has no trigger/interrupt machinery for reactions. That is only partly true. #202 already built a narrow reaction system for **Reactive Strike / Attack of Opportunity**: three trigger sources (a ranged attack-roll chat message, an AI Stride, a GM manual check), a per-combatant per-round reaction-used flag, an executor that reuses the Strike primitives, and a public chat line. It is hard-coded to one ability family, and its own docs call every other reaction "too varied to parse generally".

This spec generalizes that machinery into a **reaction registry**: a data table of supported NPC reactions, each with a trigger kind, an eligibility check, a deterministic default policy and an executor. It ships two families first — **movement-triggered attacks** (Reactive Strike/Attack of Opportunity and its limb-restricted variants, Twisting Tail, Wing Rebuff) and **defensive reactions against attacks** (Shield Block, Wing Deflection, Ghost Dodge, Swat Projectile). Decisions use a **hybrid**: a deterministic policy when exactly one reaction is eligible, and the agent-service decision call with a short timeout when several are, falling back to the deterministic priority order. Reactions fire **after** the triggering roll or move resolves, using the existing chat-message and update hooks. Defensive reactions against **player-driven** attacks are automatic whenever there is no human GM, and are applied through the module's own damage-application and outcome-adjustment seams.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **What exists (#202).** `isReactiveStrikeInScope(item)` matches `^(Reactive Strike|Attack of Opportunity)\b` on a reaction-type action; `getReactionUsed(combat, id, round)` / `markReactionUsed` keep a per-combatant per-round flag on the combat (`reactionUsed`), because the PF2e system tracks no reaction economy; `findReactiveStrikeOpportunities(combat, mover, gridSize, gridDistanceFt)` finds agent-controlled opponents who observed the mover (detection matrix), are in melee reach with line of sight, and have a ready melee Strike (honoring limb restrictions via `parseReactiveStrikeWeaponRestriction`); `offerReactiveStrikesAgainst` marks the reaction used, rolls the Strike through `rollAndApplyStrikeAtVariant`, and posts `postReactiveStrikeChat`; triggers: `handleRangedAttackForReactiveStrike` (a `createChatMessage` hook on ranged attack rolls), the AI Stride path and a manual GM check macro. Reactors must be `agentControlled`.
- **Scale (bestiary data).** 734 NPC reaction actions across 625 NPCs. By trigger shape: glossary-form (mostly Reactive Strike / Attack of Opportunity / Shield Block) ~239; is-hit/damaged/targeted ~176; other ~147; movement/leaves-reach ~56; spell/save-triggered ~47; attack-triggered ~27; ranged/spell-targeted ~26; death/dropping ~16. Most common names: Reactive Strike 85, Attack of Opportunity 30 (+17 jaws-only, +7 tail-only), Shield Block 20, Twisting Tail 19, Wing Deflection 19, Ferocity 18, Buck 13.
- **Effects of the first-slice reactions (read from the data).**
  - *Twisting Tail*: trigger — a creature within reach of the tail uses a move action or leaves a square during one; effect — a tail Strike with a –2 penalty; on a hit the dragon **disrupts** the creature's action.
  - *Wing Rebuff* (Roc): trigger — a creature moves from beyond reach to within reach of the wing; effect — a wing Strike; if the roc Pushes the creature it disrupts the move.
  - *Shield Block*: glossary-form (`@Localize` reference), the standard PF2e shield-block reaction.
  - *Wing Deflection* (Desert Drake): trigger — targeted with an attack; effect — +2 circumstance bonus to AC against that attack (rule elements `RollOption` + `FlatModifier`).
  - *Ghost Dodge*: trigger — targeted by a Strike or spell; +2 circumstance AC and resistances against that attack.
  - *Swat Projectile* (Stone Giant): trigger — targeted by a physical ranged attack; +4 circumstance AC against it; may throw a stone projectile back on a miss.
- **The module applies damage itself for player Strikes too.** `handleManualStrikeDamage` (#47) is a `createChatMessage` hook on `damage-roll` messages from Strikes: for human-controlled attackers it reads the roll's stored target and applies damage via `actor.applyDamage(...)` itself (instead of the system's manual "Apply" button, which resolved the wrong recipient). So the module already owns damage application for AI **and** player Strikes. `Actor#applyDamage` takes `shieldBlockRequest`, so Shield Block can be applied through the same call. It does not own spell damage or saves for players.
- **The module does not own a player's attack roll.** The attack roll is made and posted by the system; the module only sees the `attack-roll` chat message afterward (`flags.pf2e.context`: type, outcome, options, dc, target, roll total). Hence "after the trigger resolves" (owner decision) and a retroactive outcome adjustment for AC-bonus reactions (below).
- **Decision call.** `fetchCombatDecision` (`scripts/agent-service-client.mjs`) already chooses one candidate from a list via `/v1/combat-decision` and is gracefully failure-tolerant; a reaction decision is a small candidate list (each eligible reaction plus "decline").
- **GM-less mode.** The module distinguishes a hosted GM-less run (`findActiveHostedRun`, `decideGmLessBroadcast`) from a table with a human GM; the relay's "Agent" account is a GM user that is always connected, so "human GM present" cannot be inferred from the user list alone.

## Resolved decisions

1. **Decision mechanism: hybrid, with a short timeout on the model.** Exactly one eligible reaction → the reaction's deterministic policy decides. Several eligible reactions for the same trigger → ask the agent service (candidates: each reaction plus "decline") with a 5-second timeout; on timeout, error or no service configured, fall back to the deterministic priority order. The one-reaction-per-round economy is enforced regardless.
2. **First-slice families:** movement-triggered attacks and defensive reactions against attacks. The rest are deferred (#959, #960, #961).
3. **Actors: NPCs first.** AI-controlled party characters' feat reactions reuse the registry later (#962).
4. **Timing: after the trigger resolves, via the existing hooks** (`createChatMessage`, the AI Stride path, `updateActor`), not pre-emptive interception.
5. **Player attacks on monsters:** automatic where the module owns resolution; a one-click GM-confirm card for what it does not — **but never in GM-less mode: with no human GM, every reaction in this spec is automatic.** Full interception before the roll is #963.

## Design

### The reaction registry

`scripts/npc-reactions.mjs` holds `REACTION_DEFS`, a data table. Each entry:

```js
{
  id: "twisting-tail",
  match: /^Twisting Tail\b/i,              // reaction-type action name
  trigger: "moveInReach" | "leaveReach" | "targetedByAttack",
  kind: "strike" | "acBonus" | "damageReduction",
  priority: 10,                             // deterministic tie-break
  eligible(ctx) -> boolean,                 // beyond the shared gates below
  policy(ctx) -> boolean,                   // deterministic default
  execute(ctx) -> ReactionResult,
}
```

Shared eligibility gates for every definition (reusing #202 code): the reactor is agent-controlled and not defeated; it has the matching reaction item; it has not used its reaction this round (`getReactionUsed`); it observed the triggering creature (detection matrix); line of sight where the reaction needs it; for `strike` kinds, a ready Strike with the named limb in reach (the existing limb-restriction parsing generalized beyond Reactive Strike/AoO).

Initial table:

| Reaction | Trigger | Kind | Default policy | Effect |
|---|---|---|---|---|
| Reactive Strike / Attack of Opportunity (+ jaws/tail-only variants) | `leaveReach` (existing triggers) | strike | always | existing behavior, moved into the registry |
| Twisting Tail | `moveInReach`/`leaveReach` (move action in reach) | strike | always | tail Strike at –2; on a hit, report the move as disrupted (AI Stride stops in place; for other movers a GM-visible note) |
| Wing Rebuff | `moveInReach` | strike | always | wing Strike; a Push result disrupts the move |
| Shield Block | `targetedByAttack` (damage step) | damageReduction | when incoming damage exceeds shield Hardness | `applyDamage({ shieldBlockRequest: true })` for the hit's damage |
| Wing Deflection / Ghost Dodge / Swat Projectile | `targetedByAttack` | acBonus | when the +bonus would change the attack's degree of success | +2 / +2 / +4 circumstance AC against the triggering attack (Swat Projectile only vs. physical ranged); resistances and the throw-back are out of scope |

The planner confirms each row's exact effect text against the compendium item before coding; unknown reactions are simply not in the table (never offered).

### Trigger sources

Three trigger paths feed one entry point `resolveReactions(combat, triggerEvent)`:

1. **Movement:** the existing AI Stride path and the manual GM check, extended to emit `moveInReach` / `leaveReach` events for any mover (AI or player-driven, observed from token position updates the module already processes); the ranged-attack hook (`handleRangedAttackForReactiveStrike`) becomes a `leaveReach` source that also reads the attacker.
2. **Attack roll resolved:** a `createChatMessage` handler for `attack-roll` messages whose context target is an NPC reactor — covers `acBonus` reactions. It runs after the roll exists, so it works as a **retroactive adjustment** (below).
3. **Damage resolved:** `handleManualStrikeDamage` and the AI executors' own damage application call `resolveReactions` with a `damageIncoming` event just before `applyDamage`, so `damageReduction` reactions can pass `shieldBlockRequest`.

### Deciding: the hybrid

`resolveReactions` collects the eligible definitions for the trigger, ordered by `priority`.

- **None eligible:** nothing happens.
- **One eligible:** apply its `policy`; if true, execute.
- **Several eligible:** build a candidate list `[{ id: "reaction:<defId>:<reactorId>", summary }, ..., { id: "decline" }]` and call `fetchCombatDecision` with a 5-second timeout. A valid pick is executed; a decline does nothing; a timeout, error or unconfigured service falls back to executing the highest-priority eligible reaction whose `policy` is true. Because a creature has one reaction per round, only one definition per reactor can run.

Across several reactors (different creatures each with a reaction), each reactor is resolved independently, in initiative order, as today.

### Executing

- **`strike` kinds:** `markReactionUsed`, then `rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0)` with the definition's modifiers (Twisting Tail's –2 applied as an explicit roll modifier), then the existing public chat announcement and, for disrupting reactions, the disruption handling above.
- **`damageReduction` (Shield Block):** at the damage seam, `markReactionUsed` and call `applyDamage({ ..., shieldBlockRequest: true })` for the reactor; the system applies Hardness and shield damage per its own rules.
- **`acBonus` (retroactive):** on the resolved attack-roll message, compute whether the reactor's bonus would turn the outcome worse for the attacker: re-evaluate the roll total against `dc.value + bonus` (both are stored in the message context). If the degree of success changes, `markReactionUsed`, write the adjusted outcome back onto the message's context (and a module flag `reactionAdjustedOutcome`) and, if a hit became a miss, make `handleManualStrikeDamage` skip applying damage for the paired damage roll. If the degree does not change, the reaction is not used (the default policy encodes this). The exact message-update mechanics (the chat message `flags.pf2e.context.outcome` and how the system's card renders an edited outcome) are verified during planning; if unreliable, the fallback is an explicit GM/table-visible note plus skipping the damage application.
- **Reporting:** the reaction is announced publicly (the existing line, via #925's card mechanism once available) with a GM-only note of why (policy or model rationale).

### Player-driven attacks, GM present vs GM-less

- **GM-less (no human GM; a hosted run is active):** everything above is **fully automatic**, including `acBonus` and `damageReduction` against player attacks.
- **A human GM is present:** movement and counter-strike reactions are still automatic (as in #202). For `acBonus`/`damageReduction` against player attacks, the module posts a **one-click GM-confirm card** ("<reactor> can use <reaction>: <effect>") instead of acting immediately; clicking applies the same executor. Spell damage and other flows the module does not own are card-only in this mode. Which mode applies is decided from the module's existing hosted-run/GM-less determination (`findActiveHostedRun`), not from the connected user list.

## Error handling

- A failing trigger hook never throws into the chat-message or update pipeline; errors are logged and the triggering flow proceeds untouched.
- The decision call's timeout/failure is the normal path to the deterministic fallback, not an error.
- If the reaction-used flag cannot be written, the reaction is skipped (never executed without being recorded).
- A reaction whose reactor or target token is missing, defeated or not on the scene is skipped.
- An `acBonus` adjustment that cannot be applied cleanly leaves the original outcome in place and posts a GM-visible note.

## Testing

- **Registry:** `match`/shared gates for each table row; ordering by priority; only one definition runs per reactor per round.
- **Policy:** each default policy (Shield Block vs. Hardness, AC bonus only when it flips the degree).
- **Hybrid decision (mocked service):** one eligible → no service call; several eligible → service called with all candidates plus decline, valid pick executed, decline respected, timeout (fake timers) and error both fall back to priority order, unconfigured service falls back immediately.
- **Executors (mocked Foundry):** strike reactions mark the economy and roll with the right modifier; Twisting Tail's disruption on a hit; Shield Block passes `shieldBlockRequest`; the retroactive AC adjustment only changes the outcome when the degree flips and skips damage application for a hit turned miss; the one-reaction-per-round rule across triggers.
- **Mode switching:** with a hosted GM-less run active the confirm card is never posted and the reaction runs automatically; with a human GM it posts the card and the click runs the executor.
- **Regression:** the existing #202 Reactive Strike/AoO tests keep passing after the move into the registry.
- **Live verification:** a monster with Twisting Tail and a creature with Shield Block in a real fight, in both a human-GM run and a GM-less run, including a player's Strike against the shield-blocker.

## Explicitly out of scope

- Death/down-triggered reactions — #959; save- and spell-triggered — #960; all other trigger shapes (approach, ally events, grabs, Tail Lash, Avenging Bite, Archon's Protection, ...) — #961.
- AI-controlled party characters' feat reactions — #962.
- Intercepting a player's attack or damage **before** the roll so reactions modify it live — #963 (this spec only reacts afterward, with the retroactive adjustment).
- Resistances granted by Ghost Dodge and the projectile throw-back on Swat Projectile.
- Player-controlled actors' own reactions (they act for themselves).

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the mechanics of writing the adjusted outcome back to the attack-roll chat message, the exact move events the module can derive for non-AI movers, and the `fetchCombatDecision` timeout parameter plumbing.
