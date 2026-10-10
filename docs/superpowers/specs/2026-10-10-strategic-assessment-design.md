# Advanced AI Actors: Strategic Assessment (Information From a Substituted Strike)

**Issue:** #1109 — Strategic Assessment informational note for substituted Devise a Stratagem Strikes, deferred from #990.

**Builds on:** #990 / `docs/superpowers/specs/2026-10-09-ai-actor-devise-stratagems-design.md` (Devise a Stratagem modes, the `devise-a-stratagem` TokenMark and RollOption effect, result descriptor), #922 (`targetedSelfEffect`), #925 (result descriptor), #953 / `scripts/ai-history-journals.mjs` (AI history journals, run-scoped state), #914 (agent-effect tagging).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

*Strategic Assessment* (Investigator feat, level 4, Player Core 2): when the investigator's Strike hits a creature it attacked using a Devise a Stratagem substitution, the GM chooses **one** piece of information about the enemy to reveal: its highest weakness, its highest resistance, its lowest saving throw, or one immunity. It has no mechanical effect, so the module's job is to **detect the qualifying hit and deliver the information** to the right audience, choosing the piece by a deterministic rule the GM can override.

## Investigation findings

- **The rule.** "When you Strike a creature using the substitution from Devise a Stratagem and hit, the GM chooses one of the following pieces of information about the enemy to tell you: which of its weaknesses is highest, which of its resistances is highest, which of its saving throws is lowest, or one immunity it has." The feat attaches to the stratagem's *attack* option: the d20 stored on `Effect: Devise a Stratagem` replaces the first Strike roll against the marked creature, and a miss gives no reveal. The reveal count per round or per target is not limited by the text.
- **How #990 wires Devise.** One effect carries a `TokenMark` (slug `devise-a-stratagem`), a toggleable `RollOption` with suboptions `attack` / `skill` / `defensive` and a Strike `SubstituteRoll` predicated on the attack choice. The system's own rule elements do the numeric work; the substitution is consumed when the Strike is rolled.
- **Data the reveal reads.** The target actor's `system.attributes.weaknesses`, `resistances`, `immunities`, and `system.saves.{fortitude,reflex,will}.mod` (derived, readable) — all available on the actor without rolling.
- **Delivery targets.** AI-controlled investigators have a per-agent decision context built from combat state; player-driven investigators own a user who can be whispered; the GM is always whispered. The AI history journals (#953) hold run-scoped state and per-encounter pages.
- **No rolling or randomness is involved**, so the feature is a pure function from the target's data and the reveal history.

## Resolved decisions

1. **The module picks by a deterministic rule; the GM can override from the whisper.** On a qualifying hit, the module selects the most useful not-yet-revealed item and whispers it to the GM with buttons to swap to any of the other available items. A GM-less table simply gets the module's pick.
2. **Delivery is GM whisper plus the investigator:** the owning player is whispered for a human-driven investigator; for an AI-controlled investigator the information is added to that agent's knowledge about the target so later decisions use it.
3. **Reveals are tracked per investigator per target**, and the picker prefers items not yet revealed to that investigator for that target, repeating the best one once all are known.
4. **All four extras are in scope** (no follow-up tickets): graceful handling of creatures missing categories, recording the reveal in the AI action history, detecting the substitution through the system's own marker, and persisting reveals across the dungeon run.

## Design

### Module: `scripts/strategic-assessment.mjs`

Pure core plus thin Foundry glue.

```js
chooseAssessment({ target, revealed }) → { kind, label, text } | null
listAssessments({ target }) → Assessment[]
recordReveal(runState, investigatorUuid, targetUuid, assessment) → runState
```

- `listAssessments` returns the available items, each `{ kind: "weakness" | "resistance" | "save" | "immunity", key, label, text }`: the **highest weakness** (type and value), the **highest resistance** (type and value), the **lowest saving throw** (save name; ties broken Fortitude, Reflex, Will), and **one immunity** (a stable choice — the first by sorted type name — so repeated picks don't flap). Categories the target lacks are omitted.
- `chooseAssessment` ranks the available items by priority (`weakness`, `resistance`, `save`, `immunity`), skips those already in `revealed` (keyed by `kind:key`), and returns the first; when all are revealed it returns the highest-priority one again. With no items at all (a creature with no weaknesses, resistances or immunities and an unreadable saves block) it returns `null`, and the glue posts a "nothing to learn" note instead.

### Detection of a qualifying hit

Hook: the system's attack-roll chat message for a Strike. A hit qualifies when all of the following hold:

1. The attacker's actor has the **Strategic Assessment** feat (slug `strategic-assessment`).
2. The attack message's degree of success is a hit (`success` or `criticalSuccess`).
3. The Strike **used the Devise a Stratagem substitution**. Detection reads the system's own record that a `SubstituteRoll` from the effect applied to this roll (the roll context's substitution record or the fortune trait the effect adds), **not** a guess from the d20 value. The `attack` suboption must be the effect's selection. Planning determines the exact context field in PF2e 8.5.0; if no reliable field exists, detection falls back to "an active `Effect: Devise a Stratagem` with `attack` selected existed on the attacker, marked this target, immediately before the roll and was consumed by it".

If detection cannot confirm the substitution, nothing is revealed and a debug line records why (a false reveal is worse than a missed one).

### Delivery

- **GM.** A whisper: "<Investigator> learns about <Target> (Strategic Assessment): <text>" with buttons for the other available items; choosing one replaces the pick (the reveal record is updated to the GM's choice).
- **Human-driven investigator.** A whisper to the owning user(s) with the same text (after the GM's override if the GM acts within the same round; otherwise the module's pick is sent immediately, and a GM override sends a correction note).
- **AI-controlled investigator.** The assessment is stored in the run state (below) and read by the agent's context builder, which adds a short "Known about <target>: ..." line to that target's entry in the decision context. The AI log line (#953) for the Strike gains "learned <text> (Strategic Assessment)".

### Persistence

Run-scoped state lives with the dungeon run's journal state (the #953 structure) as `revealed[investigatorUuid][targetUuid] = [{ kind, key, text, at }]`, written by the GM client. It survives encounters within the run (a recurring unique NPC is the same actor), is read by the picker and the agent context builder, and is dropped when the run ends. The key is the target actor's UUID.

### AI history

The #953 record of the Strike action gains an optional `assessment` field `{ kind, text }`; the formatter appends a short "learned" clause and the GM journal page shows the full text.

## Error handling

- A missing or unreadable weaknesses/resistances/immunities block is treated as empty; if every category is empty the reveal is "nothing to learn".
- A GM override that fails to apply leaves the module's pick in place and says so.
- A hook failure is logged and never blocks the attack roll, damage or the combat turn.
- A target with a hidden identity (a secret actor) still reveals to the GM only; the investigator-facing line uses the revealed token name.
- Reveals are written only by the GM client; a player client posts the request through the module's socket.

## Testing

- **Pure core:** the highest weakness/resistance across several entries, ties; lowest save with tie-break; immunity stability; categories missing; `chooseAssessment` priority, skipping revealed items, repeating when all are known, `null` when empty.
- **Detection (mocked messages):** a hit with the substitution and the feat reveals; a miss does not; a hit without the substitution (a normal Strike) does not; the feat missing does not; a non-attack roll does not; the fallback path when the context field is absent.
- **Delivery:** GM whisper with override buttons, player whisper, AI context line added, correction note after an override.
- **Persistence:** reveals recorded per investigator per target and survive a second encounter; dropped at run end.
- **AI history:** the `assessment` field appears in the log line and the GM journal page.
- **Regression:** #990 stratagem behavior and the attack-roll hook ordering unchanged; no extra reveal without the feat.
- **Live verification:** an AI investigator with the feat devises an attack stratagem, hits the marked target, the GM sees the whisper with swap buttons, a second hit reveals a different item, and the AI's next decision context shows the learned line; the same flow for a player-driven investigator.

## Explicitly out of scope

- Devise a Stratagem for human players beyond delivering the reveal (the stratagem itself is theirs to use).
- Revealing information for other Investigator or marked-target feats.
- Limits on reveals per round or per target beyond preferring new information (the text sets none).

## Open questions

None blocking. Left to planning: the PF2e 8.5.0 field that records an applied `SubstituteRoll`, how the agent context builder consumes the run state, and whether the player-side whisper should wait briefly for a GM override.
