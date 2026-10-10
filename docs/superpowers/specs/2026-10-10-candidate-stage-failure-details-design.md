# AI Action Details: Candidate-Stage Failure, Timeout and Deterministic Fallback

**Issue:** #1148 — record, in the GM-only details, whether the `/v1/combat-candidates` stage failed or timed out and the turn fell back to the deterministic candidate set, with the reason. Deferred from #1009.

**Builds on:** #1009 / `docs/superpowers/specs/2026-10-09-ai-actor-candidate-stage-details-design.md` (`stageInfo`, `turnState.candidateStage`, the `candidateStage` record block and its rendering), #952 / `docs/superpowers/specs/2026-10-09-ai-actor-decision-details-design.md` (`buildDecisionDetails`, `noteAgentFallbackReason`), #950 (AI Action Log), #951 (tracker details), #925 (result descriptor), `scripts/agent-service-client.mjs`, and the candidate-stage call in `scripts/dungeon-combat.mjs` (the `fetchCandidates` block in the agent turn loop).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

When the reasoning candidate stage fails, the turn silently continues with the deterministic candidate set and the GM cannot tell why the model never proposed any maneuvers or feats. This spec records the stage's **status** (success, success with no picks, timeout, network failure, HTTP failure, malformed response, service error), a **short reason message**, the **latency up to the failure**, and the fact that **deterministic candidates were used**, and shows it in the existing GM-only "Candidate stage" block with a small **fallback badge**. It also **links** the candidate-stage and decision-stage fallbacks when both happen in one turn.

## Investigation findings

Confirmed against the repo.

- **What happens today.** In the agent turn loop, the candidate stage runs once per turn when any vocabulary is non-empty and `turnState.maneuverPicks === null`. It calls `fetchCandidates`, takes `response.picks` if it is an array, and on any thrown error only logs `agent-service: combat-candidates call failed: …` to the console and keeps `picks = []`. It then persists `maneuverPicks: picks` (so the stage is **never retried this turn**) and re-arms the fallback timer. Nothing about the failure reaches the record.
- **How the client errors look.** `postJson` throws a plain `Error`: `agent-service-client: /v1/combat-candidates failed (<status>): <payload.error | "unknown error">` for a non-OK response; a `fetch` rejection is a `TypeError` (network) and `AbortSignal.timeout` rejects with a `TimeoutError` `DOMException` after the 35 s client timeout. A non-JSON body makes `res.json()` throw a `SyntaxError`. A 200 whose `picks` is not an array is silently coerced to `[]`.
- **Valid empty picks are indistinguishable from failure.** A 200 with `picks: []` (the model proposed nothing) and a failed call both end with `picks = []`.
- **Existing fallback-reason plumbing (#952).** For the decision stage, `noteAgentFallbackReason(combat, combatantId, reason)` stores a reason (`"error"`, `"unconfigured"`, default `"timeout"`) for the fallback timer to report; `clearAgentFallbackReason` clears it after a successful decision.
- **Where #1009 puts stage data.** `stageInfo` is stored on `turnState.candidateStage` and copied into the **first record of the turn** as `record.candidateStage`; `buildDecisionDetails(record, { isGM })` renders it for GMs only.

## Resolved decisions

1. **Reason detail:** a fixed status category plus a short bounded message, GM-only.
2. **Prominence:** a small fallback badge on the record (log row and tracker row) plus the detail line in the Candidate stage block.
3. **Empty picks:** a 200 with zero picks is recorded as `ok-empty`, not a fallback.
4. **Extras in scope:** failure latency (`clientMs` measured on failure too) and linking the candidate-stage and decision-stage fallbacks. **Filed:** a per-combat failure counter in the log header (#1233) and a GM whisper after repeated failures (#1234).

## Design

### Typed client errors (`scripts/agent-service-client.mjs`)

`postJson` throws `AgentServiceError extends Error` with `{ kind, status?, serviceMessage? }`:

- `kind: "http"` with `status` and `serviceMessage` (`payload.error`) for a non-OK response (the message text is unchanged, so existing log lines and tests keep matching);
- `kind: "timeout"` when the abort signal fires (`error.name === "TimeoutError"`);
- `kind: "network"` for a `fetch` rejection that is not a timeout;
- `kind: "malformed"` when the body is not JSON.

Callers that only read `err.message` are unaffected.

### Status classification (pure, `classifyCandidateStage`)

```js
classifyCandidateStage({ error, response }) → { status, message?, httpStatus? }
```

| Condition | `status` | `message` |
|---|---|---|
| thrown `AgentServiceError` `timeout` | `timeout` | "no response after 35 s" |
| thrown `network` | `network` | the error text, bounded |
| thrown `http` | `http` | `serviceMessage` or "unknown error", bounded; `httpStatus` set |
| thrown `malformed` | `malformed` | "response was not JSON" |
| any other thrown error | `network` | the error text, bounded |
| 200, `picks` not an array | `malformed` | "response had no picks array" |
| 200, `picks` array of length 0 | `ok-empty` | — |
| 200, `picks` length > 0 | `ok` | — |

Messages are plain text, collapsed to one line and capped at 160 characters. `status ∈ { timeout, network, http, malformed }` marks a **fallback**; `ok` and `ok-empty` do not.

### Capture (candidate-stage call site in `dungeon-combat.mjs`)

The call is wrapped to measure `clientMs` with the same monotonic clock as #1009 **whether it succeeds or fails**. After the call, `stageInfo` is built as in #1009 plus:

```js
stageInfo.status = status;            // classification above
stageInfo.reason = message ?? null;
stageInfo.httpStatus = httpStatus ?? null;
stageInfo.fallback = isFallback;      // true when status is timeout/network/http/malformed
stageInfo.meta = { ...(response?.meta ?? {}), clientMs };   // meta present even when failing, with clientMs only
```

On a failure, `vocabulary` is still summarized (the options the stage was asked about), `returnedPicks` is 0, and `picks.dropped` is empty. The deterministic-candidates behavior is unchanged (the stage still persists `[]` and is not retried this turn); the record just says so: `stageInfo.deterministicUsed = true` when `fallback`.

### Linking with the decision stage

The decision-stage fallback reason from #952 (`noteAgentFallbackReason`) is recorded on the same record. When both stages fell back in one turn, `buildDecisionDetails` renders them together as one block: "Candidate stage fell back (timeout, 35.0 s) → deterministic candidates; decision stage fell back (error)". The record keeps both fields: `candidateStage.status` / `candidateStage.fallback` and #952's existing decision-fallback field; the renderer joins them, and no extra storage is needed.

### Record and rendering

The `candidateStage` record block (#1009) gains `status`, `reason`, `httpStatus`, `fallback`, `deterministicUsed`. `buildDecisionDetails`:

- shows a **badge** `fallback` (and `ok-empty` as a quiet note, not a badge) for GMs;
- in the Candidate stage block: "Candidate stage: failed (timeout) after 35.0 s — used deterministic candidates" with the reason line, "Candidate stage: no picks proposed" for `ok-empty`, and the normal #1009 lines for `ok`;
- is hidden entirely from non-GM users, as the rest of the details.

The #950 log row and #951 tracker row render the badge from the same `buildDecisionDetails` output (a new `badges: ["fallback"]` field).

## Error handling

- A missing or unknown `status` on an older record is treated as `ok` and renders nothing new.
- A classification error (an unexpected thrown value) defaults to `network` with the string form of the value, bounded.
- The capture never changes turn behavior: the stage still persists `[]`, re-arms the fallback timer, and continues, exactly as today.
- Size limits from #1009 hold; the message is capped at 160 characters.
- Non-GM clients never receive the reason text (the existing GM-only gating applies to the whole block).

## Testing

- **Client:** each failure produces the right `AgentServiceError.kind` (mocked fetch: non-OK, abort/timeout, rejected fetch, non-JSON body); existing message strings unchanged.
- **Classification (pure):** every row of the table, including a 200 with a non-array `picks`, empty and non-empty `picks`, bounded and collapsed messages.
- **Capture (mocked loop):** failure persists `[]` and records `status`, `reason`, `clientMs` and `deterministicUsed`; success unchanged; `ok-empty` records no fallback; the stage is not retried.
- **Linking:** both-stage fallback renders as a joined line; candidate-only and decision-only render individually.
- **Rendering:** GM sees the badge and reason lines, non-GM sees nothing; older records without `status` render as before.
- **Regression:** #1009 and #952 tests keep passing; behavior with no vocabulary (no stage call) unchanged.
- **Live verification:** point the module at an unreachable agent-service (network), a hung one (timeout) and one returning 502, and confirm each shows the right status, reason and badge in the chat card, log and tracker for the GM only.

## Explicitly out of scope

- A per-combat failure counter (#1233) and a repeated-failure whisper (#1234).
- Retrying the candidate stage within a turn.
- Changing the deterministic fallback behavior itself.

## Open questions

None blocking. Left to planning: the exact wording of the lines and badge, and how `AgentServiceError` is exported without breaking existing imports.
