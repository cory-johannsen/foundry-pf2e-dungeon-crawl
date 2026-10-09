# Advanced AI Actors: Action Display (Consolidated Per-Turn Chat Cards)

**Issue:** #925 — UI display of AI-actor action rationale/history (follows #909, #910 and the other advanced-AI specs, all of which kept UI display out of scope).

**Builds on:** the existing agent-decision loop in `scripts/dungeon-combat.mjs` (`applyAgentDecision`, `postAgentDecisionChat`, `postMoveStalledChat`, `armAgentTimeout`) and the candidate types added by #909 (maneuvers), #910/#914/#922 (feat actions) and #915 (NPC abilities), each of which has its own executor.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

Today an AI-controlled combatant's decision reaches exactly one place: `postAgentDecisionChat` whispers the GM a one-line card (name, the candidate's summary, and the rationale when the provider supplied one) for every decision. Players see nothing about it beyond the PF2e roll cards the executors happen to create, and in a run with no human GM the whisper goes to the relay's GM account, so no human at the table sees it at all.

This spec replaces the stream of separate whispers with **one consolidated chat card per AI turn**. The card is public: it lists each action the AI took, in order, with its target and result, so everyone at the table can follow what the monster or allied AI did. The model's **rationale for each action is part of the same message but GM-only**, so monster tactics are not spoiled. The card is created when the AI's first action of the turn resolves and updated in place as later actions resolve. A small structured per-combat log backs the card (and is the data source later displays will reuse); it is discarded with the combat.

## Investigation findings

Confirmed against the repo and the installed PF2e system.

- **Current behavior.** `postAgentDecisionChat(combatant, candidate, rationale)` (`dungeon-combat.mjs`, ~5314) creates a whispered `ChatMessage` per decision from the i18n string `PF2EDC.Dungeon.Combat.AgentDecisionChat` ("<p><strong>{name}</strong> (agent-controlled) chose: {summary}</p>") plus an escaped rationale paragraph. `postMoveStalledChat` whispers a separate card when a stride is blocked. Both escape LLM-supplied text with `foundry.utils.escapeHTML`. Nothing is stored and nothing is public.
- **Rationale is optional and provider-dependent** (Claude supplies one; Laya never does), so the display must handle absence without a placeholder.
- **Who sees what today.** Roll cards are created by the PF2e system and are visible per normal PF2e rules; the AI's *choice* and *reason* are only in the whisper. The relay "Agent" account is a GM user, so GM-less runs show the table nothing.
- **A single message can carry GM-only parts.** PF2e's chat renderer (`UserVisibilityPF2e.process`) post-processes message HTML by `data-visibility` attributes (`gm`, `owner`, `none`), the same mechanism PF2e itself uses for GM-only roll details. A public message can therefore contain `<span data-visibility="gm">…</span>` for the rationale and be rendered without it for players. The exact handling of `gm` for non-GM clients is confirmed during planning (fallback: a second whispered message for rationale).
- **Executors return heterogeneous things** today (a strike outcome string, a list for multi-strike bundles, a stride status such as `"blocked"`/`"no-route"`, nothing for spells in some paths), and the new candidate types from #909–#922 will each add their own. There is no common "what happened" object, so one is defined here.
- **Chat messages persist; the combat document does not.** Chat history stays in the world after combat, while any flag stored on the combat document is deleted with the combat when it resolves.
- **A hidden token is a visibility concern.** An AI actor whose token is hidden from the players (`token.hidden`) should not announce its actions publicly.

## Resolved decisions

1. **Audience: everyone sees *what* and *result*; the GM alone sees *why*.** The public card has action, target and result; rationale is GM-only. In GM-less runs the relay GM still receives the full card, and human players see the public part.
2. **Form: better chat cards** — one consolidated, formatted card per AI turn — not a panel, tracker row or token HUD (those are #950 and #951).
3. **Persistence: current combat only.** The structured log lives on the combat document and is discarded with it; widening is #953.
4. **Content: action summary + result, and rationale.** Alternatives considered and decision metadata are #952.

## Design

### The action record

Each executed candidate produces one record, appended to a per-combat log stored in `flags.pf2e-dungeon-crawl.agentLog` on the combat document:

```json
{
  "combatantId": "c1", "round": 2, "turn": 4, "index": 0,
  "candidateId": "strike:goblin-bow:v0:tok7", "type": "strike",
  "cost": 1, "summary": "Strikes Fighter with shortbow",
  "target": { "id": "tok7", "name": "Fighter" },
  "result": { "text": "hit", "tone": "success" },
  "rationale": "Fighter is the squishiest in reach.",
  "source": "model" | "fallback"
}
```

`result.tone` is one of `success`, `failure`, `neutral` (used for card styling only). `source` records whether the choice came from the reasoning/decision service or the heuristic fallback (so fallback decisions can be marked GM-only).

### Describing a result: `describeAgentAction`

A pure function `describeAgentAction(candidate, execution)` in a new `scripts/agent-action-display.mjs` returns `{ summary, targetName, result: { text, tone } }`. It has one small formatter per candidate type, driven by what each executor already returns:

- **strike / multiStrike:** the degree of success ("critical hit", "hit", "miss", "critical miss"), one clause per strike for bundles.
- **cast* spell types:** save/attack outcomes per target where the executor already computes them, else "cast".
- **stride / seek:** "moved", "blocked", "no route" (reusing the stride status already returned and the stall detection that drives `postMoveStalledChat`).
- **maneuver, feat, npcAbility (from #909–#922):** each of those executors returns a result descriptor (`{ text, tone }`) as part of its own spec's contract; this function passes it through.
- **endTurn / unknown:** "ends turn" / "done".

A formatter never throws: unreadable executor output yields a neutral "done".

### The consolidated card

- **Created** on the first action of an AI turn, as a public `ChatMessage` (no whisper) flagged `flags.pf2e-dungeon-crawl.agentTurnCard = { combatId, combatantId, round }`, using the combatant's speaker so the token/portrait shows.
- **Updated** in place (`ChatMessage#update({ content })` from the client that executed the decision — the GM client or host, as the executors already run there) after each later action in the same turn, re-rendered from the log records for that combatant and round. A second turn of the same combatant (a later round) gets a new card.
- **Content**, rendered by a Handlebars template `templates/chat/agent-turn.hbs`:
  - Header: "<name> (AI)" and the round.
  - One row per action: action-cost glyphs, summary, target, result chip (tone-styled).
  - Beneath each row, a rationale line wrapped in `data-visibility="gm"` when a rationale exists (never a placeholder when absent). All LLM text is escaped as today.
- **Fallback decisions** (`source: "fallback"`) show a GM-only "(fallback heuristic)" tag.
- **Blocked or stalled strides** add a GM-only note in the same row (replacing the separate `postMoveStalledChat` card).
- **Hidden tokens:** if the acting token is hidden from players, the whole card is created as a GM whisper instead.

### Where it plugs in

- `postAgentDecisionChat` and `postMoveStalledChat` are removed; `applyAgentDecision` instead appends the record after the executor returns and calls `renderAgentTurnCard(combat, combatantId, round)`, which creates or updates the card.
- The i18n string `PF2EDC.Dungeon.Combat.AgentDecisionChat` is replaced by the template and a few short labels (header, fallback tag, result words).
- The structured log needs no cleanup code: it is on the combat document, which `resolveCombat` deletes. The chat cards remain in the chat log by Foundry's normal behavior.

## Error handling

- A failing card create/update never blocks or delays the turn: errors are logged (`console.error`) and the turn proceeds; the record is still appended to the log.
- A card whose message was deleted by a user is recreated on the next action rather than failing.
- Missing combatant/actor data in a record renders with a generic label rather than throwing.
- Rationale or summary text is always escaped; unknown HTML is never injected.

## Testing

- **`describeAgentAction`** (pure): every candidate type with each executor-return shape (including `undefined`/unexpected values → neutral "done"), multi-strike bundles, stride statuses.
- **Card rendering** (template/pure): rows in order; rationale wrapped in `data-visibility="gm"` and absent when no rationale; fallback tag; escaping of hostile strings in summary/rationale.
- **Lifecycle (mocked Foundry):** the first action creates one public message; subsequent actions in the same round update it (one message per combatant-round); a new round makes a new card; a deleted message is recreated; a hidden token's card is a GM whisper; a failing `ChatMessage` call does not stop the turn.
- **Log:** records appended in order with the expected shape; none left behind when the combat document is deleted.
- **Live verification:** a fight with several AI monsters and one allied AI; confirm the table sees one tidy card per AI turn with results, only the GM sees rationale (check as a non-GM user), and a stalled stride adds the GM-only note.

## Explicitly out of scope

- A persistent action-log panel (#950), combat-tracker row detail and token hover (#951).
- Alternatives considered and decision metadata (provider/model, latency) (#952).
- History beyond the current combat, export to a journal (#953).
- Changing how or when AI decisions are made.
- Player-controlled actors' actions (they already use PF2e's own cards).

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact `data-visibility="gm"` behavior for non-GM clients on the installed system version (with the second-whisper fallback), the shape of the result descriptor each earlier spec's executor returns, and whether cards should also mark which actions used a reaction.
