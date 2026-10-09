# Advanced AI Actors: Alternatives Considered and Decision Metadata

**Issue:** #952 — show alternatives considered and decision metadata (provider/model tier, latency, fallback, token usage) in the AI action display (a deferred follow-up of #925).

**Builds on:** #925 / `docs/superpowers/specs/2026-10-08-ai-actor-action-display-design.md` (the per-combat `agentLog` and the consolidated per-turn chat card), #950 / `docs/superpowers/specs/2026-10-09-ai-actor-action-log-panel-design.md` (the log window and the shared visibility helper) and #951 / `docs/superpowers/specs/2026-10-09-ai-actor-tracker-and-hover-detail-design.md` (tracker row expansion). The decision call lives in `scripts/dungeon-combat.mjs` (`runAgentDecisionLoop`, `applyAgentDecision`, `armAgentTimeout`), `scripts/agent-service-client.mjs` (`fetchCombatDecision`) and `tools/agent-service/` (`server.mjs`, `providers/*`, `tier-selection.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#925, #950 and #951 show *what* an AI actor did and, to the GM, *why* (the model's one-line rationale). They do not show **what else it could have done** or **how the decision was made**. This spec adds a **GM-only "Details" disclosure** to all three surfaces containing:

- **Alternatives considered:** the other candidate actions offered that turn (id and one-line summary), with the chosen one highlighted, capped at 12 with "+N more".
- **Decision metadata:** the provider and the model/tier that made the choice, the latency, the token usage and cost when the provider reports them, and — when the heuristic fallback chose — the **reason** it fired (timeout, call error, service unconfigured).

Today most of that metadata does not exist anywhere the module can read it, so this spec also extends the agent-service decision response with a backward-compatible `meta` object and has the module measure what only it can (round-trip latency) and record why a fallback happened.

## Investigation findings

Confirmed against the repo.

- **The decision response carries almost nothing.** `handleCombatDecision` (`tools/agent-service/server.mjs`) returns whatever the selected provider's `decide` returns: `{ candidateId, rationale }`. The litellm provider (`providers/litellm.mjs`) picks the model with `selectCombatTier(context)` — `"reasoning"` when the candidate count exceeds a threshold (default 8, env `COMBAT_REASONING_CANDIDATE_THRESHOLD`), else `"fast"` — and passes it as the model name; neither the tier nor the model is returned. The Laya provider (`providers/laya.mjs`) returns `rationale: undefined` by design; the OpenRouter provider (`providers/openrouter-decisions.mjs`) is a third option. The provider is chosen server-side by `resolveProvider()`.
- **Token usage is available at the source.** The litellm call returns an OpenAI-compatible payload with `usage` (prompt/completion/total tokens); the OpenRouter responses carry usage (and cost) in the payload; Laya reports none. A litellm proxy may also report a per-request cost in a response header; whether the deployed proxy does is confirmed at planning and the field is simply omitted when absent.
- **The module can time the call itself.** `runAgentDecisionLoop` awaits `fetchDecision({ baseUrl, apiKey, context })`; wrapping it with a monotonic clock gives the full round trip. The service can additionally time its own upstream call.
- **The candidate list is known when the decision is made.** `pending.candidates` (each `{ id, type, summary, cost, … }`) is what the service was asked to choose from, so the alternatives need no service change.
- **Why a fallback fires is not recorded.** `armAgentTimeout` (`AGENT_TIMEOUT_MS = 45000`) fires the heuristic after a quiet period; `runAgentDecisionLoop` logs a failed decision call (`console.error`) and returns, leaving the timer to fire later. Nothing distinguishes "the call failed" from "no call was made / it hung" in the record, and #925's `source: "fallback"` tag is all that is stored.
- **The record is the single carrier.** #925's per-combat `agentLog` record is what the chat card, #950's window and #951's tracker row all render, so extending that record extends all three.
- **Client-side hiding only.** As in #925/#950/#951, combat flags are readable by every client; GM-only details are hidden in the UI, not secured.

## Resolved decisions

1. **Metadata fields:** provider and model/tier; latency; fallback reason; and token usage / cost. All GM-only.
2. **Alternatives:** all candidates, the chosen one highlighted, capped at 12 with "+N more", in a collapsed GM-only section.
3. **Surfaces:** the per-turn chat card, the action-log panel (#950) and the tracker row expansion (#951).
4. **Metadata for the reasoning candidate stage** (`/v1/combat-candidates`) is a follow-up: #1009.

## Design

### Service contract: a backward-compatible `meta`

Each provider's `decide` may return an optional `meta`; `handleCombatDecision` adds the provider name and its own timing and returns the whole object. Existing consumers that read only `candidateId` and `rationale` are unaffected.

```json
{
  "candidateId": "strike:claw:v0:tok7",
  "rationale": "Fighter is the squishiest in reach.",
  "meta": {
    "provider": "litellm",
    "model": "reasoning",
    "tier": "reasoning",
    "serverMs": 2140,
    "usage": { "promptTokens": 1830, "completionTokens": 64, "totalTokens": 1894 },
    "costUsd": 0.0112
  }
}
```

- `provider` is set by the server from the resolved provider name; `serverMs` is the server's own wall time around the provider call.
- litellm fills `model`/`tier` (the same value `selectCombatTier` produced) and `usage` from the payload's `usage` object, and `costUsd` when the proxy reports it. OpenRouter fills `usage` and `costUsd` from its payload. Laya fills only `provider`/`serverMs` (it has no model tiers or tokens).
- Every field is optional; a missing one is simply not displayed. Nothing here changes the decision logic.

### Module: capturing the decision

- **`fetchCombatDecision`** (`scripts/agent-service-client.mjs`) returns the response unchanged, including `meta`.
- **`runAgentDecisionLoop`** measures `clientMs` around the call (a monotonic clock) and passes a `decisionInfo = { source: "model", meta: { ...response.meta, clientMs } }` to `applyAgentDecision` as a new optional fifth argument.
- **Alternatives** are derived inside `applyAgentDecision` from the candidate list it already resolves: `alternatives = candidates.map(c => ({ id: c.id, summary: c.summary ?? c.type, chosen: c.id === candidateId }))`, with the chosen candidate kept in the first position when the list exceeds the cap, truncated to 12 entries plus a `moreCount`.
- **Fallback decisions** (heuristic path) record `source: "fallback"`, `meta: { provider: "heuristic" }` and a `fallbackReason`. The reason is decided at the moment the cause is known and stored on the turn state so the later timer can read it: a failed decision call sets `turnState.lastDecisionError = { kind: "error" }`; a missing agent-service URL sets `{ kind: "unconfigured" }`; when the timer fires with neither set, the reason is `"timeout"`. The heuristic path writes whichever applies into the record. (Candidate-stage failures are #1009.)

### The record additions (extends #925/#950's record)

```json
{
  "alternatives": [ { "id": "...", "summary": "...", "chosen": true }, ... ],
  "moreCount": 3,
  "meta": { "provider": "...", "model": "...", "tier": "...", "clientMs": 2310, "serverMs": 2140, "usage": {...}, "costUsd": 0.0112 },
  "fallbackReason": "timeout" | "error" | "unconfigured"
}
```

Size is bounded (12 alternatives of short strings plus a small meta object) so the combat flag stays small; the structured log is discarded with the combat as before.

### Rendering the details (shared, pure)

`buildDecisionDetails(record, { isGM })` in the shared pure module (alongside #950's `visibleRecords` and #951's digest) returns `null` for non-GM users or when the record has neither alternatives nor meta, otherwise:

```js
{
  alternatives: [{ summary, chosen }...], moreCount,
  lines: ["Provider: litellm · Model: reasoning", "Latency: 2.3 s (server 2.1 s)", "Tokens: 1,894 (≈ $0.011)", "Fallback: timed out after 45 s"]
}
```

Fields that are absent produce no line. The three surfaces render it identically inside a collapsed `<details>` labeled "Details":

- **#925's chat card:** appended inside the GM-only (`data-visibility="gm"`) block of each action's row.
- **#950's window:** under each row for GMs, in the same collapsed section.
- **#951's tracker row:** in the expanded list for GMs.

Non-GM users never receive the markup (their view builder returns `null`), consistent with the rationale handling.

### Reporting and privacy

Nothing is shown to players: alternatives reveal tactical options and metadata reveals infrastructure details. This is client-side hiding only, as for the rationale.

## Error handling

- A provider that returns no `meta`, or a malformed one, simply yields a record without metadata; the decision proceeds normally.
- A failure measuring or building details never affects the decision or the turn; errors are logged and the details are omitted.
- Candidate summaries missing a `summary` fall back to the candidate `type`; very long summaries are truncated for display.
- The server's added timing/provider fields never break the response shape, and old clients ignore `meta`.

## Testing

- **Service (`tools/agent-service/` tests):** `handleCombatDecision` adds `provider` and `serverMs` to a provider's result; litellm and OpenRouter providers populate `usage`/`tier`/`model`/`costUsd` from fixture payloads; Laya returns only provider/timing; providers returning no `meta` still work; the existing response contract tests keep passing.
- **Client/loop (mocked):** `clientMs` is measured and passed through; a failed call records `lastDecisionError`; the fallback timer reads it and chooses `"error"`, `"unconfigured"` or `"timeout"`.
- **`applyAgentDecision` (mocked Foundry):** the record carries alternatives with the chosen one marked and the cap/`moreCount` behavior (including keeping the chosen candidate when the list exceeds 12), meta from `decisionInfo`, and `fallbackReason` for heuristic decisions.
- **`buildDecisionDetails` (pure):** GM vs non-GM, absent fields produce no lines, formatting of latency/tokens/cost, fallback reason wording, truncation.
- **Rendering:** the details appear collapsed and GM-only in the chat card, the log window and the tracker row; absent for non-GM users.
- **Regression:** `fetchCombatDecision`, `runAgentDecisionLoop` and `applyAgentDecision` existing tests keep passing; old service responses without `meta` still work.
- **Live verification:** a fight against the configured provider; confirm the GM sees alternatives and metadata on the card, window and tracker, that a forced timeout/error shows the right fallback reason, and that a player never sees any of it.

## Explicitly out of scope

- Metadata for the reasoning candidate stage `/v1/combat-candidates` — #1009.
- A scoring or ranking of alternatives (the services do not return scores).
- Long-term storage or export of decision metadata (#953).
- Changing how decisions are made, the tier threshold, or the fallback behavior itself.
- Securing GM-only data from players (client-side hiding, as #925).

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: whether the deployed litellm proxy reports a response cost (header or field), where `meta` is attached for the in-process vs external-poller decision paths, and how the heuristic path reads the stored fallback reason.
