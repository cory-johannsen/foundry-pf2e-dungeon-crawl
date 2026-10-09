# Advanced AI Actors: Feat Reactions for AI-Controlled Party Characters

**Issue:** #962 — reuse #931's reaction registry for character feat reactions on AI-controlled party members (Shield Block, Nimble Dodge, Retributive Strike, Reactive Strike and similar).

**Builds on:** #931 / `docs/superpowers/specs/2026-10-08-ai-npc-reactions-design.md` (the reaction registry, `resolveReactions`, shared gates, the hybrid decision, the `strike`, `acBonus` and `damageReduction` kinds, the GM-confirm vs automatic rule), #961 / `docs/superpowers/specs/2026-10-09-ai-npc-other-triggered-reactions-design.md` (the `enemyDamagesAlly` trigger and the counter-strike-plus-defensive effect shape), #914 / `docs/superpowers/specs/2026-10-08-ai-actor-self-effect-widening-design.md` (Raise a Shield as an eligible self-effect), and the existing #202 Reactive Strike code in `scripts/dungeon-combat.mjs`.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#931 builds a reaction registry for **NPC** reactions. An AI-controlled **party character** can already be a #931 reactor — the `agentControlled` gate is the same — but nothing defines the character-side reactions. This spec adds a **curated core table** of character reaction definitions to the registry: **Shield Block**, **Reactive Strike / Attack of Opportunity**, **Nimble Dodge**, **Retributive Strike** and **Flash of Grandeur**, each with character-side eligibility (a raised shield, a free hand, not encumbered, a champion's aura). Human-controlled characters still react for themselves; the module never reacts for them. Wider coverage of character reactions through #961's grammar is #1031, and the champion reactions that need an enemy's choice or free an ally are #1030.

## Investigation findings

Confirmed against the repo, the live world and the local PF2e source data.

- **Who counts as an AI-controlled party character.** `startCombat` (`dungeon-combat.mjs`) flags a combatant `agentControlled` when `isAgentEligible(actorId, partyIds, aiControlledIds)` holds, where `aiControlledIds` is `runState.aiControlledActorIds`. Party combatants not in that set are human-controlled and never get the flag. #931's shared gate ("the reactor is agent-controlled") therefore already selects exactly the AI-controlled characters; no new control concept is needed.
- **The character reactions in the live party** (read from the world): Shield Block (four of five characters), Reactive Strike (Fighter), Retributive Strike (Paladin), Nimble Dodge (Thief), Leshy Superstition, Call on Ancient Blood, Counterspell (Prepared) and Recognize Spell. The compendium holds about 577 reaction feats/actions for characters (class, archetype, ancestry, skill, general).
- **Item shapes differ from NPCs.** Character reactions are `feat` or `action` items with `actionType: "reaction"`. For example, Shield Block is a **general feat** (also granted by class features through `GrantItem`); Reactive Strike is a class feat for several classes and a **defensive action** granted by the fighter class feature; Nimble Dodge is a rogue class feat with `RollOption` and `FlatModifier` rules; Retributive Strike, Flash of Grandeur, Glimpse of Redemption, Liberating Step and Iron Command are champion **actions**. #202's `isReactiveStrikeInScope` already matches an `action` named "Reactive Strike"/"Attack of Opportunity"; the feat form needs the same match.
- **RAW for the first-slice reactions (read from the data).**
  - *Shield Block*: "While you have your shield raised, you would take physical damage (bludgeoning, piercing or slashing) from an attack. Your shield prevents you from taking an amount of damage up to the shield's Hardness. You and the shield each take any remaining damage, possibly breaking or destroying the shield."
  - *Reactive Strike*: "A creature within your reach uses a manipulate action or a move action, makes a ranged attack, or leaves a square during a move action. Make a melee Strike against the triggering creature. If your attack is a critical hit and the trigger was a manipulate action, you disrupt that action. This Strike doesn't count toward your multiple attack penalty, and your multiple attack penalty doesn't apply to it."
  - *Nimble Dodge*: "A creature targets you with an attack and you can see the attacker. Requirements: you are not encumbered. You gain a +2 circumstance bonus to AC against the triggering attack."
  - *Retributive Strike*: "An enemy damages your ally, and both are in your champion's aura. The ally gains resistance to all damage against the triggering damage equal to 2 + your level. If the enemy is within reach, make a melee Strike against it."
  - *Flash of Grandeur*: same trigger; "The ally gains resistance to all damage against the triggering damage equal to 2 + your level. Until the end of your next turn, the attacker is affected by Revealing Light."
- **The machinery to reuse is specified.** #931 gives the registry, the `strike`/`acBonus`/`damageReduction` kinds, the hybrid decision, the reaction economy and the damage seam where `applyDamage({ shieldBlockRequest: true })` is applied; #961 adds the `enemyDamagesAlly` trigger (with a distance parameter) and the counter-Strike-plus-defensive shape that Archon's Protection uses — exactly the shape of Retributive Strike.
- **Shield Block needs a raised shield.** Raising a shield is the **Raise a Shield** action, a `selfEffect` action (`Effect: Raise a Shield`, slug `effect-raise-a-shield`), which #914's derived filter already makes offerable to an AI actor. The PF2e actor exposes the held shield (`actor.heldShield`, with Hardness and HP) and `applyDamage` accepts `shieldBlockRequest`.
- **Monster attacks on characters are module-owned.** AI monsters' Strikes and spells against characters are rolled and applied by the module (`rollAndApplyStrikeAtVariant`, spell executors), so attack-roll adjustments (Nimble Dodge) and damage seams (Shield Block, ally resistance) are available automatically with no GM confirmation, in both human-GM and GM-less runs.

## Resolved decisions

1. **First slice:** Shield Block, Reactive Strike / Attack of Opportunity, Nimble Dodge, and the champion reactions Retributive Strike and Flash of Grandeur. The champion reactions that need an enemy's choice or free an ally (Glimpse of Redemption, Iron Command, Liberating Step) are #1030.
2. **Recognition: a curated core table first.** Wider character reactions via #961's grammar, with character-side eligibility, are #1031.
3. **Human-controlled characters are unaffected.** Only combatants carrying the `agentControlled` flag react.

## Design

### Character reaction definitions

The `REACTION_DEFS` registry from #931 gains character entries, matched by the reaction item's name (the item may be a `feat` or an `action`; `type` is not part of the match). The shared gates from #931 apply unchanged (agent-controlled, not defeated, reaction unused this round, observed the trigger's creature, line of sight where relevant). Character-side eligibility is added per definition:

| Reaction | Trigger | Kind | Character-side eligibility | Default policy |
|---|---|---|---|---|
| Reactive Strike / Attack of Opportunity | `leaveReach` (existing triggers: ranged attack, move, manipulate) | `strike` | a ready melee Strike with the triggering creature in reach (the existing `findReactiveStrikeOpportunities` logic generalized from `action` items to `feat` items) | always |
| Shield Block | `targetedByAttack` at the damage step | `damageReduction` | `Effect: Raise a Shield` is active, `actor.heldShield` exists and is not broken, and the incoming damage is bludgeoning, piercing or slashing | use when Hardness is greater than 0 and the remaining damage would not destroy the shield unless the block prevents more than the shield would lose; never when the shield is already broken |
| Nimble Dodge | `targetedByAttack` | `acBonus` (+2 circumstance) | the character is not encumbered and can see the attacker | use when the bonus changes the attack's degree of success (the #931 retroactive re-evaluation) |
| Retributive Strike | `enemyDamagesAlly` with `aura: 15` | `counterStrike` + ally resistance | the reactor is a champion with its aura active (aura radius from the actor's `Aura` data, default 15 feet), the reactor and ally are both within it, and a melee Strike is possible when the enemy is in reach | always |
| Flash of Grandeur | `enemyDamagesAlly` with `aura` | ally resistance + a linked effect on the attacker | as above; the linked `Revealing Light` effect resolves | always |

Resistance for the ally is **`2 + the champion's level`** against the triggering damage. When several definitions are eligible for one trigger (for example a character with both Retributive Strike and Flash of Grandeur), the #931 hybrid decision applies, with the deterministic fallback ordering counter-Strikes before defensive effects.

### Mechanics per kind

- **Reactive Strike (character):** `markReactionUsed`, then `rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0)` at variant 0 — the Strike "doesn't count toward your multiple attack penalty" (which also means it does not advance `mapIncrement`). A critical hit against a manipulate trigger is announced as disrupting that action (a GM-visible note for non-AI movers, as in #202).
- **Shield Block:** at the module's damage seam (AI attackers vs a character, including AI spells, `handleManualStrikeDamage` for any module-applied damage), call `applyDamage({ ..., shieldBlockRequest: true })` for the reactor; the system applies Hardness and shield damage per its own rules. For system-applied damage with no seam, the #931 retroactive/GM-confirm rule applies (a reaction against a player-controlled attacker does not arise for an AI character, since players do not attack their own party).
- **Nimble Dodge:** at the module's attack seam for the monster's attack against the AI character: after the roll and before damage is applied, re-evaluate the roll total against `AC + 2`; if the degree of success worsens for the attacker, apply the better-for-defender outcome (a hit becoming a miss stops damage application; a critical hit becoming a hit reduces the damage to a normal hit's). The reaction is used only if the degree changes.
- **Retributive Strike / Flash of Grandeur:** at the damage seam for damage an enemy deals to the ally: the ally's damage is reduced by the resistance amount (`damage - (2 + level)` floor 0) for that triggering damage only, applied before `applyDamage`; then the Strike (Retributive Strike) or the linked `Revealing Light` effect on the attacker (Flash of Grandeur, created with the #910 effect machinery and tagged for cleanup). For damage the module does not apply, the #931 rule applies: a human GM confirms; GM-less runs have no such damage against AI characters because the module applies all monster damage.

### Making Shield Block reachable

Shield Block requires a raised shield, so the AI must have used **Raise a Shield** earlier in the turn. Raise a Shield is already offered by #914's derived self-effect filter; this spec adds one hint: when the actor has a held, unbroken shield and a Shield Block reaction available, the Raise a Shield candidate's deterministic `summary` mentions that it enables Shield Block, so the reasoning model can weigh it. No change to the candidate set is needed.

### Eligibility inputs (character-side)

A small helper `characterReactionContext(actor)` gathers, from the live actor, what the definitions need and nothing more: the reaction items it has (any item type), `heldShield` and its Hardness/HP/broken state, whether `effect-raise-a-shield` is active, free-hand count (for Reactive Strike variants and prerequisites), encumbered state, aura radius and the champion level for resistance. All reads are guarded; unreadable data excludes the reaction.

## Error handling

- A failing reaction never blocks the damage, attack or movement it responds to; errors are logged and the original flow proceeds.
- A reaction whose actor data is unreadable (no `heldShield`, missing level) is skipped.
- If the reaction-used flag cannot be written, the reaction is skipped.
- Resistance never reduces damage below 0; a Shield Block that would exceed the incoming damage prevents only what was dealt.
- A Revealing Light effect that fails to create is logged and reported; the ally resistance and the reaction still stand.

## Testing

- **Matching and gates:** each definition matches `feat` and `action` items by name; only `agentControlled` characters react; human-controlled party members never do; economy and priority; the hybrid decision with the service mocked.
- **Reactive Strike:** the feat form is recognized alongside #202's action form; the Strike is variant 0, `mapIncrement` unchanged; the disrupt note on a critical hit vs a manipulate trigger; existing #202 NPC tests keep passing.
- **Shield Block:** requires the raised-shield effect and an unbroken `heldShield`; passes `shieldBlockRequest`; the policy cases (Hardness 0, shield would break, non-physical damage).
- **Nimble Dodge:** the +2 re-evaluation at every degree boundary, used only when the degree changes, not used when encumbered or when the attacker is unseen, hit→miss stops damage application.
- **Champion reactions:** aura and distance gating, resistance equals `2 + level`, applied to the triggering damage only, the Strike when the enemy is in reach, the Flash of Grandeur effect created and tagged.
- **Hint:** the Raise a Shield summary mentions Shield Block only when the conditions hold.
- **Regression:** #202/#931 reaction tests, #914 self-effect tests and damage-application tests keep passing.
- **Live verification:** an AI-controlled Fighter (Reactive Strike), Cleric/Paladin (Shield Block after Raise a Shield; Retributive Strike) and Thief (Nimble Dodge) fighting monsters; confirm a human-controlled character does not react automatically.

## Explicitly out of scope

- Champion reactions needing an enemy's choice or freeing an ally (Glimpse of Redemption, Iron Command, Liberating Step) — #1030.
- Widening character reactions with #961's grammar (including Leshy Superstition, Call on Ancient Blood, archetype and ancestry reactions) — #1031.
- Counterspell (Prepared) and other spell-counteracting character reactions (see #1021 and #963).
- Reactions for human-controlled characters.
- Changing how the #931 registry decides or the damage/attack seams themselves.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the exact aura-radius read for champions, how `Effect: Raise a Shield` and `heldShield` are best read on the installed system version, and the definition-match rules for the feat vs action forms of Reactive Strike.
