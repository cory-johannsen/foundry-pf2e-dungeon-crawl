# Advanced AI Actors: Feat Requirements That Need Tracked State

**Issue:** #992 — feat requirements the module cannot check yet (oath-sworn creature, planned course of action, previous action's damage type), deferred from #946.

**Builds on:** #946 / `docs/superpowers/specs/2026-10-08-ai-actor-marked-target-widening-design.md` (closed requirement-predicate set, `targetedSelfEffect` widening), #934 (checkable predicates), #922 (marked-target entries), #914 (agent-effect tagging, combat-end cleanup).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#946 offers a marked-target feat only when every clause of its `Requirements` text is in a closed set of checkable predicates. Three feats are excluded because their requirement is per-feature state the module never records:

- **Hungry Blade** — "Your previous action was a Strike with your spectral dagger that dealt spirit damage."
- **Enforce Oath** — "You can see a creature you've sworn an oath against."
- **Nothing Personal** — "You have an active course of action planned."

This spec adds a small **tracked-state layer** and the three predicates, and defines an audit that finds and covers any other marked-target feat whose requirement is trackable. The rule is closed-world: a state predicate is true only when the module itself recorded the state. Anything unrecorded makes the feat unavailable.

## Investigation findings

- **Turn state.** `setAgentTurnState` (`scripts/dungeon-combat.mjs`) persists `{ actionsRemaining, mapIncrement, maneuverPicks, flourishUsed, stanceUsed, counter }` on the combat flag `agentTurnState` per combatant per turn. It has no record of what the previous action was or what damage it dealt.
- **Requirement text.** Enforce Oath: "per the terms of your oath feat" — Champion causes with oath feats (`vengeful-oath`, `oath-of-the-avenger`, Spirit Warrior `sacred-wilds-oath`, `kaiju-defense-oath`, `tricksterbane-oath`) each name a creature category (undead, demons, fiends, ...). Nothing Personal (Blackjacket archetype) requires "an active course of action planned"; the same phrase appears in other Blackjacket feats and Investigator's Plot the Future, so the state is shared across several features.
- **Hungry Blade** is 1/day, with a 10-minute effect against the target of the required Strike; the requirement is purely about the immediately preceding action.
- **Existing pieces.** #946's closed predicate set (hand free, wielding/wearing, enemy within range or with condition, active-effect checks, `previousActionWasStrike` from turn state), #925's result descriptor (already carries the executed strike's damage rolls), #914's tagging/cleanup.

## Resolved decisions

1. **Track all three states** (previous-action damage type, sworn oath category, planned course of action) **and run an audit** for further trackable requirements.
2. **Closed-world rule.** A state predicate is true only if the module recorded it. No guessing, no auto-declaring state on the AI's behalf.
3. **State is derived where PF2e defines it** (oath categories come from the actor's oath feats) and **recorded where it is an in-play fact** (previous action, course of action).

## Design

### Tracked state (`scripts/agent-feature-state.mjs`, pure)

A per-combatant record, stored as `flags.pf2e-dungeon-crawl.agentFeatureState` on the combat (same lifetime as `agentTurnState`, cleared at combat end):

```js
{
  previousAction: { kind: "strike" | "other", weaponSlug?, damageTypes?: string[], round, turn, actionIndex },
  courseOfAction: { active: boolean, plannedRound?: number, source?: string },
}
```

- **previousAction** is written by the executor after every action the AI performs (strike executors record the weapon slug and the damage types actually dealt from the roll result, per #925's descriptor; any other action records `kind: "other"`). It is read as "the immediately preceding action this turn"; a new turn starts with `kind: "other"`.
- **courseOfAction** is written by the module's execution of the feature that plans one (Blackjacket's planning action, Investigator's Plot the Future) — recorded `active` when that action succeeds and cleared when the feature's own ending event occurs (combat end at the latest). If a feature that plans a course is not executable by the AI, the state is never set and the dependent feats stay hidden.

### Predicates

Added to #946's closed set:

- `previousActionWasStrike({ weaponSlug?, damageType? })` — true when `previousAction.kind === "strike"` and, if given, the weapon slug and damage types match. Hungry Blade uses `{ weaponSlug: "spectral-dagger", damageType: "spirit" }`; the weapon slug is resolved through the actor's items at evaluation.
- `swornOathAgainst(target)` — derived: the set of categories from the actor's oath feats is mapped by a **reviewed table** `OATH_CATEGORY_BY_FEAT` (feat slug → trait list/filter, e.g. `{ undead }`); a visible opposing creature is a legal Enforce Oath target when its traits intersect the actor's categories. An actor with an oath feat not in the table gets no Enforce Oath entries; the audit test enumerates oath feats so a new one fails loudly.
- `courseOfActionActive()` — reads `courseOfAction.active`.

Each is evaluated in `buildFeatVocabulary` for `targetedSelfEffect` and ordinary self-effect entries. A predicate whose backing state is absent evaluates false.

### Entries

No new entry kinds. Hungry Blade, Enforce Oath and Nothing Personal become `targetedSelfEffect` entries under #946's existing machinery, one per legal target (Enforce Oath: only oath-matching creatures; Hungry Blade: the target of the previous Strike; Nothing Personal: visible opposing creatures). `effectSummary` is deterministic and names the requirement that was met.

### Requirement audit

A one-off script `tools/audit-feat-requirements.mjs` reads the compendium population #946 classified `marked` and lists each feat whose requirement text parses into: (a) the closed set, (b) a trackable state predicate (those above or a close variant), or (c) unsupported. The planning step adds predicates only for (b) rows the owner-approved audit table lists; the audit output is checked in as a fixture so population changes fail the test.

## Error handling

- Missing or malformed state: predicate false, feat not offered.
- Stale `previousAction` after a turn change: ignored by the turn/round check.
- Unknown oath feat: no Enforce Oath entries; warning in the debug log.
- Recording failures never block the action that is executing.

## Testing

- **State layer:** previous-action recording from strike results (weapon, damage types), reset on a new turn, cleared at combat end; course-of-action set/clear.
- **Predicates:** Hungry Blade matches only a spectral-dagger spirit-damage Strike immediately before; Enforce Oath matches by trait; Nothing Personal requires recorded state.
- **Vocabulary:** each feat's entries per legal target; absent state hides the feat.
- **Audit:** fixture of classified requirement texts; table-completeness test for oath feats.
- **Live verification:** an AI champion with an oath feat uses Enforce Oath only against a matching creature; an AI Splinter of Finality uses Hungry Blade right after a spirit-damage Strike and not otherwise.

## Explicitly out of scope

- Letting the AI declare state it did not earn (rejected alternative).
- Requirements that depend on information the module cannot see (private GM knowledge).

## Open questions

None. Planning-time details: the executor hook point for writing `previousAction`, which feature actions plan a course of action in this build, and the reviewed oath table contents.
