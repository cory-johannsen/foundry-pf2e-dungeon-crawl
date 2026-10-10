# AI Action Details: Candidate-Stage Metadata

**Issue:** #1009 — metadata for the reasoning candidate stage (`/v1/combat-candidates`), deferred from #952.

**Builds on:** #952 / `docs/superpowers/specs/2026-10-09-ai-actor-decision-details-design.md` (backward-compatible `meta`, `buildDecisionDetails`, GM-only details on the chat card, #950 log and #951 tracker), #909 (the candidate pipeline: `generateCombatCandidates`, `fetchCombatCandidates`, picks persisted as `maneuverPicks`), #925/#950 (record and log).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#952 records metadata for the `/v1/combat-decision` call only. This extends the same GM-only details to the earlier **candidate-generation stage**: a vocabulary summary, the picks returned and dropped (with reasons), and latency, model/tier and token usage/cost. Metadata returns as an optional `meta` field on the `/v1/combat-candidates` response, and the details render as an additional "Candidate stage" block inside #952's existing collapsed GM section on the chat card, the #950 log and the #951 tracker expansion. Recording stage failure/timeout and the deterministic fallback is filed as #1148.

## Investigation findings

- **Service.** `generateCombatCandidates(context, vocabulary)` (`tools/agent-service/candidate-generator.mjs`) posts to litellm with model `reasoning`, a forced `propose_candidates` tool call, and an `AbortSignal.timeout`. It parses the tool-call arguments and returns them; the payload's `usage` is discarded. `handleCombatCandidates` (`server.mjs`) returns the result as the 200 body or `{ error }` with 502.
- **Module.** `fetchCombatCandidates` (`scripts/agent-service-client.mjs`) returns the response; the caller in `scripts/dungeon-combat.mjs` (`getPendingAgentTurn` / the loop around line 1073–1117) takes `response.picks`, persists them as `turnState.maneuverPicks`, and re-validates them against the vocabulary through `buildManeuverCandidates`. Dropped picks are silently discarded there.
- **#952 contract.** `meta` is optional, every field is optional, and a missing field is simply not displayed. The same pattern fits this stage.
- **Timing.** The stage runs once per turn (before the first decision) and is cached in turn state, so its metadata belongs to the turn's record, not to each action.

## Resolved decisions

1. **Metadata recorded:** a vocabulary summary (counts per type and sent ids), picks returned and dropped with reason, and latency / model / tier / token usage and cost. (Failure/timeout and fallback is #1148.)
2. **Contract:** an optional `meta` on the 200 response, and on 502 error bodies (`{ error, meta? }`), keeping `picks` readers unaffected.
3. **Surface:** the same GM-only details as #952 — a "Candidate stage" block in the collapsed section (chat card, #950 log, #951 tracker). No separate record kind (rejected).

## Design

### Service

`generateCombatCandidates` returns `{ result, meta }` internally; `handleCombatCandidates` sends `{ ...result, meta }`:

```json
{
  "picks": [ ... ],
  "meta": {
    "provider": "litellm", "model": "reasoning", "tier": "reasoning",
    "serverMs": 3120,
    "usage": { "promptTokens": 4210, "completionTokens": 182, "totalTokens": 4392 },
    "costUsd": 0.021
  }
}
```

`serverMs` is wall time around the litellm call; `usage` is copied from the payload's `usage`; `costUsd` when the proxy reports it. On a 502, the body is `{ error, meta: { provider, serverMs } }` so the elapsed time is known even for failures. All fields optional; no behavior change.

### Module capture

- `fetchCombatCandidates` returns the response unchanged (including `meta`).
- The candidate-stage caller measures `clientMs` with a monotonic clock and builds `stageInfo = { meta: { ...response.meta, clientMs }, vocabulary: summarizeVocabulary(vocabulary), returnedPicks: picks.length }`.
- `summarizeVocabulary(vocabulary)` (pure) returns `{ total, byType: { type: count }, ids: [first 12 ids], moreCount }`.
- After `buildManeuverCandidates` validates the picks, the loop computes `dropped = returned.filter(not accepted)`, each `{ id, reason }` with a reason from a fixed set (`unknown-id`, `wrong-target`, `not-legal`, `duplicate`); capped at 12 with a `droppedMore` count. The validator already knows which rule rejected a pick; it is extended to return the reason rather than silently skipping.
- `stageInfo` is stored on the turn state (`turnState.candidateStage`, size-bounded), then copied into the first action record of the turn as `record.candidateStage`.

### Record addition (extends #925/#950/#952)

```json
"candidateStage": {
  "meta": { "provider": "...", "model": "...", "tier": "...", "clientMs": 3300, "serverMs": 3120, "usage": {...}, "costUsd": 0.021 },
  "vocabulary": { "total": 31, "byType": { "maneuver": 6, "feat": 9, "npcAbility": 2 }, "ids": ["..."], "moreCount": 19 },
  "picks": { "returned": 8, "accepted": 6, "dropped": [ { "id": "...", "reason": "wrong-target" } ], "droppedMore": 0 }
}
```

Only the first record of a turn carries it (the stage runs once per turn); later records omit it.

### Rendering (shared, pure)

`buildDecisionDetails(record, { isGM })` (#952) gains a `candidateStage` block when the record carries one: lines such as "Candidate stage: 31 options → 8 picks (6 accepted, 2 dropped)", "Model: reasoning · 3.3 s (server 3.1 s)", "Tokens: 4,392 (≈ $0.021)", and, when expanded, the vocabulary counts and the dropped picks with reasons. It returns `null`/omits the block for non-GM users exactly as the rest of the details. The chat card, #950 log and #951 tracker already render `buildDecisionDetails` output, so they need only the template for the new block.

## Error handling

- A missing `meta` or `stageInfo` field simply is not displayed.
- Malformed `meta` from an older service is ignored.
- A validator that cannot determine a reason records `not-legal`.
- The record size stays bounded (≤12 ids, ≤12 dropped).

## Testing

- **Service:** `meta` fields from a mocked litellm response (usage, cost); absent usage omitted; 502 body carries timing.
- **Module:** `summarizeVocabulary`, drop reasons for each rejection rule, `stageInfo` assembly, first-record-only placement, size caps.
- **Rendering:** GM sees the block, non-GM does not; lines for missing fields omitted.
- **Live verification:** run an AI turn with the reasoning stage; the GM details show the vocabulary summary, dropped picks and usage; a player sees none of it.

## Explicitly out of scope

- Failure/timeout and deterministic-fallback recording — #1148.
- A separate record kind for the stage (rejected).
- Token/cost aggregation across turns.

## Open questions

None. Planning-time details: where inside `buildManeuverCandidates` the rejection reasons are most cleanly surfaced.
