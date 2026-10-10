# Advanced AI Actors: Kinetic Aura/Gate State and Pending-Spellshape State

**Issue:** #1120 — kinetic aura/gate and pending-spellshape state for stateful feat actions, deferred from #999.

**Builds on:** #999 / `docs/superpowers/specs/2026-10-09-ai-actor-impulse-caster-ancestry-feat-actions-design.md` (the audit generalization, `FEAT_ALLOWLIST`, the exclusion rules this spec relaxes), #998 (reviewed allowlist), #947 (shapes, override table, requirement predicates), #1118 / `docs/superpowers/specs/2026-10-10-archetype-feat-overrides-design.md` (the `sequence` shape), #992 (closed-world state), `initAgentTurnState` and the spell candidate builders in `scripts/agent-candidates.mjs` (`buildSpellCandidates`, the area, dual-nature, target-count and attack-spell builders), #978 (last-action record), #953 (AI history).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#999 excludes two kinds of feats because the module does not track the state they depend on: **kineticist impulses** whose text refers to the kinetic aura, element, junction or gate, and **spellshape feats**, which modify the next spell cast. This spec adds both pieces of state — **kinetic state derived from the actor's own items and effects**, and a **pending-spellshape record** on the turn state — plus the **gating predicates** that read them, an **AI action to bring up the kinetic aura**, **once-per-round junction tracking**, **Gate's Threshold depth predicates**, and **history output**. An owner-approved, audit-ranked allowlist then lets the now-expressible feats be offered.

## Investigation findings

- **Why they were excluded.** #999's exclusion rules reject impulses "whose text refers to the kinetic gate, a junction, an aura or 'your kinetic aura'" and all `spellshape`-trait feats "until #1120". The audit marks these rows `impulse-state` and `spellshape`.
- **Kineticist state, from the rules (Rage of Elements / Player Core 2; to be re-verified against the installed compendium at planning).** A kineticist has a **kinetic gate** (one or more elements) deepened by **Gate's Threshold**; a **single-gate** kineticist gains an **impulse junction** that triggers when it uses an impulse of its element that takes two or more actions, only one junction per round, resolving before the impulse's other effects; junctions carry the Impulse trait. The **kinetic aura** is brought up by an action and several impulses depend on it. A fan reading holds that a junction needs the aura running; there is no official ruling found on the aura-ending interaction, so the module follows the compendium text of each feat rather than the reading.
- **What the actor already carries.** Class features and effects on the sheet identify the elements (the kinetic gate's element choices), the aura effect when active, and the stance/impulse effects; these are native items the module can read without new tracking.
- **Spellshapes.** A spellshape feat (traits `concentrate`, `metamagic`/`spellshape`, 1 action) modifies the next spell cast this turn (for example Shadow Spell, Contagious Spell); the modification is lost if no spell follows or the turn ends. The module's spell candidate builders know spell cost, targets and area but have no notion of a pending modification.
- **Turn state.** `initAgentTurnState` returns `{ actionsRemaining, mapIncrement, maneuverPicks, flourishUsed, stanceUsed, finisherUsed }`; there is no per-turn slot for spell modifications or junction use.

## Resolved decisions

1. **Kinetic state is derived from the actor's own items and effects;** module flags exist only where nothing native exists (a per-round junction-used marker).
2. **Pending spellshape** is a record on the turn state consumed by the next spell cast this turn; **each spellshape feat is a reviewed, allowlisted modification** with a closed descriptor.
3. **The feats offered first are an audit-ranked allowlist approved by the owner at planning time** (the #998/#999 pattern, extended with state predicates).
4. **All four extras are in scope** (no follow-up tickets): Channel Elements / aura activation as an AI action, once-per-round junction tracking, kinetic and spellshape state in the AI history, and Gate's Threshold depth predicates.

## Design

### Kinetic state (`scripts/kinetic-state.mjs`)

```js
kineticState(actor) → {
  isKineticist: boolean,
  elements: string[],          // from the kinetic gate class features
  gateDepth: number,           // how many gate choices / Gate's Threshold picks
  auraActive: boolean,         // the native aura effect/stance is on the actor
  auraElement?: string,        // when the aura carries an element
  junctionUsedThisRound: boolean // module marker, cleared at the round change
}
```

It is a pure reader over the actor's items (class features by slug, effects by slug/rule options); nothing is stored except the junction marker (`flags.pf2e-dungeon-crawl.junctionRound = <round>`; stale rounds read as unused). If the actor lacks the expected class-feature slugs (data drift), `isKineticist` is false and no kinetic feat is offered, with a debug line.

### Kinetic requirement predicates (extends #947's closed set)

`auraActive`, `elementIs(<element>)` / `usesElement(<element>)` (the impulse's element trait is among `elements` and, where the text requires it, matches the aura), `junctionAvailable` (single-gate kineticist whose junction has not fired this round and the impulse takes two or more actions), and `gateDepthAtLeast(n)`. Impulse text that does not reduce to these predicates remains not offered. Each predicate is evaluated when building the vocabulary, so an impulse that needs the aura is only listed when the aura is up.

### Channel Elements / aura activation (AI action)

A `kineticAura` vocabulary entry (cost per the compendium item, normally 1 action) is offered when the actor is a kineticist, the aura is down, and at least one allowlisted aura-dependent impulse is available. Execution applies the same effect the sheet button would (the system's own item/effect, via the actor's action mechanism or an effect-source copy) and records it in the result descriptor. The entry carries a deterministic summary ("Channel Elements: kinetic aura up (<element>)") and is only offered once per turn.

### Junction tracking

When an impulse of the actor's element that takes two or more actions resolves, a `junction` step runs **before** the impulse's other effects if `junctionAvailable`; it sets `junctionRound` to the current round so a second junction in the same round is not offered or applied. The junction's own effect (the element's junction text) is an allowlisted reviewed modification like a spellshape: each element's junction has a closed descriptor (`addRider` / `applyEffect`) or the junction is skipped with a GM note. Gate's Threshold depth predicates compare `gateDepth` to the thresholds named by an impulse.

### Pending spellshape (`scripts/spellshape-state.mjs`)

The turn state gains `pendingSpellshape: null | { slug, modification, setAtAction }`.

- **Setting.** A spellshape feat action (allowlisted, 1 action, `concentrate`) is offered like any feat action. On execution it sets `pendingSpellshape` instead of producing an effect, and costs its action.
- **Candidate modification.** Every spell candidate builder reads `pendingSpellshape`; a candidate the modification can legally apply to is rebuilt with the modification applied and a summary suffix ("Shadow Spell: …"); candidates it can't apply to (wrong spell type) are filtered out while the spellshape is pending, since the rule says the modification must apply to the next spell cast.
- **Closed modification kinds** (reviewed per slug): `addDamageType`, `changeDamageType`, `extraTargets`, `extendRange`, `addRider` (a condition on targets that fail or are hit), `extraDice`. A feat whose modification doesn't reduce to these stays out.
- **Consumption.** Casting any spell clears `pendingSpellshape` (the modification applies to that spell); ending the turn clears it unused; a second spellshape in the same turn while one is pending is not offered unless the feat text allows stacking.
- **Failure.** If the cast fails to start (no legal target), the pending record is kept and the action is not spent.

### Allowlist, audit and exclusion rules

The #999 audit adds state predicates and a `modification` classification column; rows previously reason-coded `impulse-state` or `spellshape` are re-evaluated. The planner ranks them, the owner approves slugs, and approved slugs are added to `FEAT_ALLOWLIST`'s kineticist and caster partitions with their `requires` predicates or `spellshape` modification descriptors. The exclusion rules in #999 relax only for allowlisted slugs whose text reduces to the predicates and modification kinds above.

### AI history

The #953 record gains `kinetic: { auraActive, element, junctionUsed }` and `spellshape: { slug, consumedBy? }` where relevant; the formatter appends short clauses ("aura up (fire)", "Shadow Spell applied to <spell>") and the GM journal page shows the full state.

## Error handling

- A class feature or effect the reader expects but can't find makes `isKineticist` false for that actor and the kinetic feats unavailable, with a debug line and an audit note.
- A pending spellshape with no legal spell candidate blocks nothing else: other actions remain available; the record clears at turn end.
- An allowlisted slug whose text drifts from its fixture is disabled and reported.
- A junction step failure is logged; the impulse still resolves without it.
- Hooks and builders never throw into the combat turn.

## Testing

- **`kineticState` (mocked actors):** elements and gate depth from class-feature items, aura active/inactive, missing features, stale junction markers.
- **Predicates:** each kinetic predicate true/false; an aura-dependent impulse listed only with the aura up; junction availability by action cost and round.
- **Channel Elements:** offered only when it unlocks an available impulse, applies the aura, once per turn.
- **Junction:** fires before the impulse, once per round, skipped on the second use; GM note when no descriptor.
- **Spellshape:** setting the record, candidate modification per kind, filtering of incompatible candidates, clearing on cast and on turn end, second spellshape refused, failed cast keeps the record.
- **Audit/allowlist:** re-evaluated rows classify, each allowlisted slug matches its fixture, text outside the predicates and modification kinds stays out.
- **AI history:** state fields and formatter output.
- **Regression:** non-kinetic and non-spellshape feats and spell candidates unchanged when no spellshape is pending; #999/#998/#947 tests keep passing.
- **Live verification:** an AI kineticist raising its aura, using an aura-dependent impulse and a junction once per round; an AI caster using a spellshape then casting a modified spell, and a turn that ends with the spellshape unused.

## Explicitly out of scope

- Mythic point tracking (#1117), archetype override entries (#1118).
- Spellshape feats whose modification isn't one of the closed kinds; impulses whose text doesn't reduce to the predicates.
- Kineticist class features that need no state (they are already handled by the shapes).
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the exact class-feature slugs and effect slugs for the kinetic gate and aura in the installed compendium (re-verifying the rules summarized above), the approved allowlist, and the per-element junction descriptors.
