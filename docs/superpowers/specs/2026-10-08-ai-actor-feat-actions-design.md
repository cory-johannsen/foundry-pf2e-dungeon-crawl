# Advanced AI Actors: Feat and Class-Action Modeling

**Issue:** #910 — AI-controlled combatants have no way to use class features/feats as actions (Rage, Stances, Flurry of Blows, Sudden Charge, Twin Feint, etc.).

**Builds on:** #909 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuvers-design.md` (the `/v1/combat-candidates` reasoning pipeline and its Foundry-side vocabulary/validation shape). This spec adds a second vocabulary entry `type` to that pipeline; it does not add a second reasoning mechanism.

**Status:** Approved. Drafted from investigation of this repo and the installed PF2e system; the four open questions were answered by the owner on 2026-10-08 and the answers are folded in below (see "Resolved questions"). Initial scope: stances + Rage as self-effect actions and four composite feats; wider self-effect coverage and NPC abilities are filed as follow-ups.

## Summary

Today the candidate list for an AI combatant (`buildCandidateList`, `scripts/agent-candidates.mjs`) is spell-, strike- and stride-shaped; #909 adds the five basic martial maneuvers. A feat or class action such as Rage, a Stance, Power Attack or Sudden Charge is never offered. PF2e feats are extremely heterogeneous, so modeling "feats" in general is not feasible. This spec defines a **narrow, deterministic eligibility filter** that picks out the feats and actions that are mechanically well-defined, and a **two-kind execution model** for them:

1. **Self-effect actions** — feats/actions that carry the PF2e system's own `system.selfEffect` link (stances, Rage, many "you gain X until..." actions). The module posts the usage message and applies the linked effect item, exactly as the system's own chat-card button does.
2. **Composite strike actions** — a small curated allowlist of one/two-action feats that are just a combination of primitives the module already executes (Stride, Strike, Strike-with-modifier): i.e. Power Attack, Sudden Charge, Lunge and Twin Feint.

Foundry enumerates the legal vocabulary each turn; the #909 reasoning endpoint selects a tactically sensible subset with rationale; Foundry validates and merges the picks into the candidate list; the existing `/v1/combat-decision` call is unchanged.

## Motivation

A martial character's identity is its feats. An AI Fighter that never raises a stance, an AI Barbarian that never Rages, or an AI Rogue that never Twin Feints plays like a generic "stride and strike" NPC and is much weaker than the PF2e rules intend (and than the human party it fights beside). Per CLAUDE.md "Game rules", the fix must use PF2e's own item data and effects, not module-invented house rules.

## Investigation findings

Confirmed against this repo and the installed PF2e system (`/srv/foundry/data/Data/systems/pf2e/pf2e.mjs`) and the live world.

- **The current candidate system has no feat concept.** `readyActions` in `getPendingAgentTurn` (`scripts/dungeon-combat.mjs`) is `actor.system.actions` — strikes only. Spell candidates read `spellcasting` entries. Nothing reads `itemTypes.feat` / `itemTypes.action` for use in combat.
- **Item shape.** Feats are `type: "feat"`, class/ancestry actions are `type: "action"`. The fields that matter: `system.actionType.value` (`action` | `reaction` | `free` | `passive`), `system.actions.value` (cost 1–3 when `actionType = action`), `system.traits.value`, `system.frequency` (`{value, max, per}`, with `value` defaulting to `max` on an actor-owned item), and `system.selfEffect` (`{uuid, name, img}`; forced to `null` when `actionType = passive`).
- **`selfEffect` is the system's own "this action applies an effect to you" marker.** The system applies it from a chat-card button (`pf2e.mjs` ~55482): it loads `fromUuid(selfEffect.uuid)`, merges the effect source with an origin context (actor/token/item UUIDs and `getOriginData().rollOptions`), and creates it on the actor. That handler is a UI event handler, not a public API, so the module has to reproduce the small amount of logic itself (see Execution).
- **Using an action message.** `createUseActionMessage` (internal, `pf2e.mjs` ~53660) decrements `system.frequency.value` when `> 0`, then posts either a plain `item.toMessage()` card or, for `selfEffect` items, the self-effect card. `item.toMessage()` is public; the frequency decrement is a plain `item.update`.
- **Prevalence (live compendium index, this world):**

  | Pack | Entries | Activatable (action/free/reaction) | With `selfEffect` | One-action | One-action with `selfEffect` | Stance | Stance with `selfEffect` |
  |---|---|---|---|---|---|---|---|
  | `pf2e.feats-srd` | 6,284 | 2,307 | 256 | 948 | 179 | 95 | 79 |
  | `pf2e.actionspf2e` | 574 | 500 | 45 | 219 | 33 | 5 | 5 |
  | `pf2e.classfeatures` | 874 | 1 | 0 | 1 | 0 | 0 | 0 |

  `Rage` is in `actionspf2e` with a `selfEffect`; 79 of 95 feat stances have one. So the self-effect filter reaches the high-value martial buffs (stances, Rage) with no per-feat code, while the other ~2,000 activatable feats are exactly the heterogeneous long tail that must stay out of scope.
- **Live party sample** (this world's five characters, non-passive feats/actions only): Shield Block, Reactive Strike, Retributive Strike, Nimble Dodge, Counterspell, Recognize Spell, Leshy Superstition, Call on Ancient Blood (all **reactions**); Battle Medicine, Dirty Trick (skill actions); Sudden Charge (2 actions, flourish), Lunge, Twin Feint (2 actions), Defensive Advance (2 actions, flourish); Widen Spell (spellshape); Drain Bonded Item (free, 1/day). None of the live feats has a `selfEffect`; the useful ones (Sudden Charge, Lunge, Twin Feint) are the composite kind. Both execution kinds are therefore needed.
- **Related existing machinery to reuse, not duplicate:** `dungeon-strike-riders.mjs` (strike riders / `resolveAthleticsRider`), the Stride/Strike executors in `applyAgentDecision`, `actionReachSquares`/`MELEE_REACH_SQUARES`, and the per-turn action accounting `turnState` already tracks.
- **The #909 pipeline is not implemented yet** (no `combat-candidates` route or `fetchCombatCandidates` in `main`; only its spec merged). This issue's implementation depends on it.

## Decisions (Proposed)

1. **Scope: a deterministic eligibility filter plus two execution kinds, not "all feats".** Initial self-effect coverage is **stances and Rage only** (an explicit allowlist: items with the `stance` trait, plus Rage); the generic "any one-action `selfEffect` feat" filter is a follow-up. Anything that fails the filter is simply never offered. There is no attempt to interpret feat prose.
2. **Reuse the #909 pipeline.** The vocabulary gains entries of `type: "feat"`; the endpoint, the schema-constrained response, and the "drop any pick not literally in the sent vocabulary" validation are unchanged apart from the schema allowing the new `type` and a free-string `slug`/`itemId` for it.
3. **Foundry decides legality; the model only chooses.** Same split as #909: eligibility, cost, frequency, prerequisites and "already active" are computed deterministically. The model never invents a feat or a target.
4. **Self-effect kind is generic; composite kind is a curated allowlist.** Self-effect works for any item passing the filter because the effect item carries the rules. Composite actions need hand-written executors, so they are an explicit, small, test-covered table keyed by feat slug — adding one is a deliberate change, never automatic.
5. **Frequency and stance rules come from the item data / RAW**, never approximated: an item with `frequency.value === 0` is excluded; entering a stance while already in one replaces it (RAW: one stance at a time); an action whose effect is already active on the actor is excluded.
6. **Reactions and free-action triggers stay out.** Shield Block, Reactive Strike and similar are handled by the module's separate reaction machinery (or not at all), not by the turn-time candidate list.

## Eligibility filter (vocabulary enumeration)

A new `buildFeatVocabulary(combatant, opponents, turnState)` in `scripts/agent-candidates.mjs`, called from `getPendingAgentTurn` next to the maneuver vocabulary builder. For each item in `actor.itemTypes.feat` and `actor.itemTypes.action`:

Include only if **all** hold (initial self-effect scope: stances and Rage only, per the owner's decision — the rest of the self-effect population is deferred to the follow-up):

- `system.actionType.value` is `action` or `free`, and cost (`actions.value`, or 0 for `free`) ≤ actions remaining this turn.
- Not on cooldown: `system.frequency` is absent, or `system.frequency.value > 0`.
- Not already in effect: no effect on the actor whose `system.context.origin.item` is this item's UUID.
- Excluded traits: `exploration`, `downtime`, `secret`, `reaction`-style triggered traits, and any item whose `system.selfEffect` is null **and** whose slug is not in the composite allowlist.
- Kind-specific gates:
  - **Self-effect (stances + Rage only for now):** the item has the `stance` trait or is Rage; `system.selfEffect.uuid` resolves to an effect item; if the item has the `stance` trait, no other effect with an origin item bearing the `stance` trait is active *or*, if one is, the entry is flagged `replacesStance` (the executor removes the old stance's effect first).
  - **Composite:** every precondition of its executor (e.g. a wielded strike with reach/range for the chosen target, a free hand for Twin Feint's second weapon, a clear stride path).
- No unresolved sub-choice: items whose rules contain a `ChoiceSet` that is unresolved are excluded (the choice is never invented).

Output entries: `{ type: "feat", kind: "selfEffect" | "composite", itemId, slug, name, cost, targetId? , replacesStance? }`. `targetId` is present only for composite actions that target an opponent.

If the vocabulary is empty (including after the #909 maneuver vocabulary is merged), the reasoning call is skipped, as in #909.

## Composite action allowlist (initial)

Each entry is an executor built only from primitives `applyAgentDecision` already has. Initial list (confirmed by the owner):

| Feat | Cost | Executor |
|---|---|---|
| Power Attack | 2 | Strike with the feat's own damage-dice change; counts as two attacks for MAP |
| Sudden Charge | 2 | Stride up to double Speed, then Strike |
| Lunge | 1 | Strike with +5 ft reach (melee weapon only) |
| Twin Feint | 2 | Two Strikes with different weapons; second target is off-guard |

Each executor delegates the actual rolls to the system's own strike statistics (`actor.system.actions` entries) and applies the feat's documented rider by reading the item description's structure where it is stable, or by a one-line hand-applied effect where it is not. This table is the main curated piece of work and the main place future issues add coverage.

## Reasoning model call

Unchanged from #909 except the vocabulary now also contains `type: "feat"` entries and the response schema's `type` enum gains `feat` with `slug`/`itemId` as free strings (referential integrity is checked on the Foundry side, not by the schema):

```json
{ "picks": [ { "type": "feat", "slug": "rage", "itemId": "abc123", "rationale": "Open the fight raged before closing." } ] }
```

The prompt guidance for the endpoint adds: prefer enabling stances/buffs on the first action of a round when a fight is imminent; do not offer a self-effect already active; respect action cost.

## Validation and candidate construction

As in #909: each pick must literally match a vocabulary entry on `(type, itemId)`; mismatches are dropped and logged. Survivors become candidates `{ id: "feat:<itemId>[:<targetId>]", type: "feat", kind, itemId, targetId?, cost, summary: rationale }` appended to the list sent to `/v1/combat-decision`.

## Execution (`applyAgentDecision`, new `case "feat"`)

- **Self-effect:** (1) post the usage message via `item.toMessage()` (public API) so the chat shows the action being used; (2) decrement `system.frequency.value` when present (mirrors the system's own handler); (3) load `fromUuid(selfEffect.uuid)`, merge its source with an origin context (actor, token, item UUIDs, `getOriginData().rollOptions`) and the target (self), and create it on the actor — the same logic as the system's chat-card button, reproduced because the handler is not callable; (4) if `replacesStance`, delete the prior stance's effect first; (5) spend the action cost through the existing `turnState` accounting.
- **Composite:** dispatch to the allowlist executor, which calls the existing Stride/Strike primitives; apply cost and MAP through the same accounting those primitives use.
- Every use is whispered to the GM like other agent actions (`whisperGm`), including which feat and why.

## Error handling

- `/v1/combat-candidates` unconfigured, failing, timing out, or malformed → no feat candidates that turn; the existing strike/stride/spell/maneuver set proceeds unchanged.
- A pick not in the vocabulary is dropped individually.
- Unreadable item data (missing `actionType`, unresolvable `selfEffect.uuid`, throwing rule data) → that item is excluded, never defaulted to "available".
- A self-effect creation that throws leaves the action unspent (cost is only deducted after the effect is created) and logs via `console.error`.

## Testing

- `buildFeatVocabulary` is pure over an actor snapshot: tests for each filter clause (cost vs remaining actions, frequency 0, already-active effect, excluded traits, stance replacement, unresolved `ChoiceSet`, unreadable `selfEffect`), using the same stub conventions as `buildStrikeCandidates` tests.
- Pick validation: matching pick kept; right type wrong `itemId` dropped; feat never in the vocabulary dropped.
- Executors: mocked-Foundry tests for the self-effect path (message posted, frequency decremented, effect created with the correct origin context, stance replaced) and for each composite entry.
- A live verification step on a world with an AI Fighter/Barbarian: a stance gets raised, Rage is used once, a composite Strike action resolves with correct MAP and cost.

## Explicitly out of scope

- Reactions and free-action *triggered* abilities (Shield Block, Reactive Strike, Nimble Dodge, Counterspell).
- Spellshape / metamagic feats (Widen Spell) and any feat that modifies a spell candidate — a separate spell-pipeline concern.
- Feat-modified maneuver variants (#911) and weapon switching (open on #909).
- Exploration and downtime activities, skill feats (Battle Medicine, Dirty Trick) — the latter could join later as another vocabulary `type`.
- Anything needing GM adjudication or a UI choice at use time.
- A GM on/off toggle (always-on for agent-controlled combatants, matching #909 and #785).

## Resolved questions

1. **Composite allowlist:** Power Attack, Sudden Charge, Lunge, Twin Feint. (Flurry of Blows is dropped from the initial list.)
2. **Self-effect scope:** stances + Rage only for now. Widening to every one-action/free `selfEffect` feat (~200) is a filed follow-up.
3. **NPCs vs PCs:** class/ancestry feats on character-style actors only. NPC/monster special-ability actions are a filed follow-up.
4. **Sequencing:** plan now against #909's spec; execution waits until #909's pipeline is implemented.

## Follow-ups

- #914: widen self-effect eligibility beyond stances + Rage to all one-action/free `selfEffect` feats and actions.
- #915: NPC/monster special-ability action modeling.
