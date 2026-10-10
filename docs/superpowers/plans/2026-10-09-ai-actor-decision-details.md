# Alternatives Considered and Decision Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM-only "Details" disclosure on the chat card, the action-log window (#950) and the tracker row (#951) showing the other candidates offered that turn (chosen one highlighted, capped at 12) and decision metadata (provider/model/tier, latency, token usage/cost, fallback reason) — backed by a new, backward-compatible `meta` object in the agent-service decision response.

**Architecture:** Tasks 1–4 are real changes to the already-merged agent-service (`tools/agent-service/`) and combat loop (`scripts/dungeon-combat.mjs`) — this plan ships real value independent of #925/#950/#951 ever landing. Tasks 5–6 add the shared pure `buildDecisionDetails` helper and patch the three still-plan-only UI specs' own plan documents to render it, the same "patch an in-flight sibling plan" pattern #950/#951 already established for each other.

**Tech Stack:** Node.js (agent-service), Vanilla JS (ESM, module), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-decision-details-design.md`

## Global Constraints

- **#925, #950, #951 are all still plan-only.** Tasks 1–4 touch only real, merged files and are fully real work on their own. Task 6 patches all three sibling plan documents in one pass.
- The server's added `meta` must never change the existing response contract for a client that only reads `candidateId`/`rationale` — every existing agent-service test must keep passing unmodified.
- Nothing in this plan changes how a decision is made, the tier threshold, or the fallback trigger itself (spec's own explicit non-goal) — only what is measured and recorded about it.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`resolveProvider()`'s real signature returns a bare `decide` function, never the resolved provider's own name — and three real call sites and a whole test file already depend on that exact shape** (`validate-decision-model.mjs`, `server.mjs`, and `tests/agent-service-provider-selection.test.mjs`'s own `expect(resolveProvider()).toBe(decideLitellm)` assertions). `handleCombatDecision` needs the NAME to attach `meta.provider`, so this plan adds a new, separate `resolveProviderName()` export (duplicating only the tiny default/validation logic, not the lookup) rather than changing `resolveProvider`'s own return shape — confirmed live this is the only way to add the name without breaking real, already-passing tests.
2. **`handleCombatDecision` currently does nothing but forward whatever `decide(body)` returns, unmodified** (confirmed live, `server.mjs` lines 19–35) — the spec's own "adds the provider name and its own timing" is genuinely new work, not an existing partial mechanism.
3. **`runAgentDecisionLoop`'s unconfigured-service path (`if (!baseUrl) return;`) and its decision-call failure path (`catch (err) { console.error(...); return; }`) are both real, confirmed exact lines (951-1085) that today record nothing distinguishing them** — exactly the gap the spec's Investigation findings describe. Task 3 adds the `lastDecisionError` write at both exact real sites rather than a hypothetical one.
4. **litellm's `model` parameter and the spec's own separate `tier`/`model` meta fields are the same value in this real implementation** — confirmed live: `litellm.mjs`'s `decide()` calls `selectCombatTier(context)` directly as the `model` parameter it sends to the litellm proxy (the proxy's own model aliases are literally named `"reasoning"`/`"fast"`, confirmed by this repo's own prior commits "reasoning tier -> ... nemotron" / "fast tier -> ... nemotron"). `meta.model` and `meta.tier` are therefore always equal for the litellm provider — not a bug to reconcile, just a confirmed real fact worth stating so Task 2 doesn't invent two different values where only one exists.

## Review Focus

- A provider that throws (litellm's own `callLiteLLM` failure path) must still surface through `handleCombatDecision`'s existing 502 response unchanged — adding `meta` to the SUCCESS path must not touch the error path at all (Task 1's test).
- `lastDecisionError`'s write (Task 3) must happen before the `return`, never after — a write-then-return ordering bug here would silently lose the reason on every single occurrence, not just sometimes (Task 3's test).
- The alternatives cap-to-12 logic must keep the CHOSEN candidate in the list even when it would otherwise be pushed out by truncation (spec's own stated rule; Task 4's test).
- `buildDecisionDetails` must return `null` (not an object with empty fields) for a non-GM user, so a naive template that forgets to check for `null` fails loudly in review rather than silently rendering an empty-but-present "Details" disclosure to a player (Task 5's test).
- A missing/malformed `meta` from an old or misbehaving provider must degrade to "no metadata lines," never throw into the decision loop or the render path (spec's own stated rule; Tasks 2–5's tests).

---

### Task 1: `resolveProviderName` and `handleCombatDecision`'s own `meta`

**Files:**
- Modify: `tools/agent-service/providers/index.mjs`
- Modify: `tools/agent-service/server.mjs`
- Test: `tests/agent-service-provider-selection.test.mjs`, `tests/agent-service-server.test.mjs` (or wherever `handleCombatDecision` is already tested — find it first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveProviderName(name?)` (exported) → the validated provider name string; `handleCombatDecision`'s response now carries `meta.provider` and `meta.serverMs` merged into whatever the provider's own `decide()` returned.

- [x] **Step 1: Write the failing tests**

```js
// tests/agent-service-provider-selection.test.mjs (append)
import { resolveProviderName } from '../tools/agent-service/providers/index.mjs';

describe('resolveProviderName (#952)', () => {
  it('defaults to litellm', () => {
    expect(resolveProviderName()).toBe('litellm');
  });
  it('returns an explicitly named provider', () => {
    expect(resolveProviderName('laya')).toBe('laya');
  });
  it('throws the same message resolveProvider does for an unknown name', () => {
    expect(() => resolveProviderName('not-a-real-provider')).toThrow(/Unknown PF2EDC_AGENT_PROVIDER/);
  });
});
```

```js
// find handleCombatDecision's existing test file first (search for
// "handleCombatDecision" across tests/) and append there, following its
// existing mocking convention for resolveProvider/decide:
describe('handleCombatDecision meta (#952)', () => {
  it('adds provider and serverMs to a successful decision, without disturbing candidateId/rationale', async () => {
    // mock resolveProviderName to return 'litellm' and resolveProvider's
    // decide to resolve { candidateId: 'x', rationale: 'y' } after a real
    // (short) delay; assert the sent JSON includes
    // { candidateId: 'x', rationale: 'y', meta: expect.objectContaining({ provider: 'litellm', serverMs: expect.any(Number) }) }.
  });

  it('merges serverMs/provider into an existing provider-supplied meta rather than overwriting it', async () => {
    // decide resolves { candidateId: 'x', rationale: 'y', meta: { model: 'reasoning', tier: 'reasoning' } };
    // assert the response's meta still has model/tier AND provider/serverMs.
  });

  it('leaves the error response (502) completely unchanged when the provider throws', async () => {
    // decide rejects; assert the existing 502 { error: ... } shape, no meta field at all.
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-service-provider-selection.test.mjs -t "resolveProviderName"`
Expected: FAIL with "resolveProviderName is not exported"

- [x] **Step 3: Implement `resolveProviderName`**

```js
// tools/agent-service/providers/index.mjs -- add alongside the existing
// resolveProvider, sharing its default-resolution expression:
export function resolveProviderName(name = readEnvOrDotenv('PF2EDC_AGENT_PROVIDER') ?? 'litellm') {
  if (!(name in PROVIDERS)) {
    throw new Error(`Unknown PF2EDC_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return name;
}
```

- [x] **Step 4: Wire `handleCombatDecision` to attach `meta.provider`/`meta.serverMs`**

```js
// tools/agent-service/server.mjs -- replace handleCombatDecision's body:
async function handleCombatDecision(body, res) {
  if (!isValidCombatDecisionBody(body)) {
    return sendJson(res, 400, { error: "combat-decision: candidates is required and must be non-empty" });
  }
  let providerName, decide;
  try {
    providerName = resolveProviderName();
    decide = resolveProvider(providerName);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
  const startedAt = Date.now();
  try {
    const decision = await decide(body);
    const serverMs = Date.now() - startedAt;
    return sendJson(res, 200, {
      ...decision,
      meta: { ...decision.meta, provider: providerName, serverMs },
    });
  } catch (err) {
    return sendJson(res, 502, { error: `combat-decision: provider call failed: ${err.message}` });
  }
}
```

- [x] **Step 5: Add the import**

```js
// tools/agent-service/server.mjs -- extend the existing providers/index.mjs import:
import { resolveProvider, resolveProviderName } from "./providers/index.mjs";
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-service-provider-selection.test.mjs`
Expected: PASS (plus the `handleCombatDecision` suite found/extended in Step 1)

- [x] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions — every existing agent-service test keeps passing unmodified)

- [x] **Step 8: Commit**

```bash
git add tools/agent-service/providers/index.mjs tools/agent-service/server.mjs tests/agent-service-provider-selection.test.mjs
git commit -m "feat(#952): resolveProviderName and handleCombatDecision's provider/serverMs meta"
```

---

### Task 2: Provider-reported `meta` (model/tier, usage, cost)

**Files:**
- Modify: `tools/agent-service/providers/litellm.mjs`
- Modify: `tools/agent-service/providers/openrouter-decisions.mjs`
- Test: `tests/agent-service-litellm-provider.test.mjs`, `tests/agent-service-openrouter-decisions.test.mjs` (or wherever each is already tested — find first)

**Interfaces:**
- Consumes: nothing new.
- Produces: litellm's `decide()` return gains `meta: {model, tier, usage?, costUsd?}`; OpenRouter's gains `meta: {usage?, costUsd?}` (model/tier are #952's own follow-up #1009 for that provider per the spec's own scope, since OpenRouter's own tier concept isn't confirmed the same way litellm's is — this task only adds what the spec's own Investigation findings confirmed live: usage/cost from the OpenRouter payload).

- [x] **Step 1: Write the failing tests**

```js
// tests/agent-service-litellm-provider.test.mjs (append to whichever file
// already tests tools/agent-service/providers/litellm.mjs's decide())
it('returns meta.model/tier (the same value, confirmed live) and usage from the payload (#952)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidateId: 'x', rationale: 'y' }) } }] } }],
      usage: { prompt_tokens: 1830, completion_tokens: 64, total_tokens: 1894 },
    }),
  });
  const result = await decide({ candidates: [{ id: 'x' }] }, { fetchImpl });
  expect(result.meta.model).toBe(result.meta.tier);
  expect(result.meta.usage).toEqual({ promptTokens: 1830, completionTokens: 64, totalTokens: 1894 });
});

it('omits usage when the payload carries none, without throwing', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidateId: 'x', rationale: 'y' }) } }] } }] }),
  });
  const result = await decide({ candidates: [{ id: 'x' }] }, { fetchImpl });
  expect(result.meta.usage).toBeUndefined();
});
```

```js
// tests/agent-service-openrouter-decisions.test.mjs (append)
it('returns meta.usage/costUsd from the OpenRouter payload when present (#952)', async () => {
  // Find this provider's own existing test fixture shape first (its
  // mocked fetchImpl/payload) and add a `usage`/cost field to it matching
  // whatever OpenRouter's own real response shape is -- confirmed against
  // that file's own existing fixtures, not invented here.
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-service-litellm-provider.test.mjs -t "#952"`
Expected: FAIL (no `meta` on the return value yet)

- [x] **Step 3: Implement in `litellm.mjs`**

```js
// tools/agent-service/providers/litellm.mjs -- decide()'s own final return,
// replacing `return { candidateId, rationale };`:
  const usage = payload.usage
    ? { promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens, totalTokens: payload.usage.total_tokens }
    : undefined;
  // #952: the deployed litellm proxy's own response-cost reporting shape
  // (a header vs a payload field) is confirmed against the real running
  // proxy at implementation time -- costUsd is simply omitted until then,
  // per the spec's own stated error-handling rule ("omitted when absent"),
  // not guessed here.
  return { candidateId, rationale, meta: { model, tier: model, ...(usage ? { usage } : {}) } };
```

- [x] **Step 4: Implement in `openrouter-decisions.mjs`**

Read that file's own current `decide()` return and response-payload handling first (its exact field names for usage/cost, which the spec's Investigation findings confirm exist in the payload but this plan doesn't re-derive blind). Add a `meta: { ...(usage ? {usage} : {}), ...(costUsd != null ? {costUsd} : {}) }` field to its return, following the same "omit when absent" rule as Step 3.

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-service-litellm-provider.test.mjs tests/agent-service-openrouter-decisions.test.mjs`
Expected: PASS

- [x] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [x] **Step 7: Commit**

```bash
git add tools/agent-service/providers/litellm.mjs tools/agent-service/providers/openrouter-decisions.mjs tests/agent-service-litellm-provider.test.mjs tests/agent-service-openrouter-decisions.test.mjs
git commit -m "feat(#952): litellm/OpenRouter providers report model/tier/usage/cost in meta"
```

---

### Task 3: Client-side latency measurement and fallback-reason recording

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`runAgentDecisionLoop`, `armAgentTimeout`)
- Test: `tests/dungeon-combat-decision-loop.test.mjs` (extend the existing `runAgentDecisionLoop` test file — find its real name first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `runAgentDecisionLoop` measures `clientMs` and passes a `decisionInfo` fifth argument to `applyAgentDecision`; a failed call or an unconfigured service records `turnState.lastDecisionError`; `armAgentTimeout` reads it to pick the fallback reason.

- [ ] **Step 1: Write the failing tests**

```js
// append to runAgentDecisionLoop's existing test file
it('measures clientMs and passes decisionInfo through to applyDecision (#952)', async () => {
  // fetchDecision resolves { candidateId: 'x', rationale: 'y', meta: { provider: 'litellm', serverMs: 100 } }
  // after a real short delay; assert applyDecision's own mock was called
  // with a 5th argument matching
  // { source: 'model', meta: expect.objectContaining({ provider: 'litellm', serverMs: 100, clientMs: expect.any(Number) }) }.
});

it('records lastDecisionError: {kind: "error"} when the decision call throws, before returning (#952)', async () => {
  // fetchDecision rejects; assert setAgentTurnState (or whichever real
  // turn-state writer this file already uses) was called with
  // lastDecisionError: { kind: 'error' } BEFORE the function returns --
  // confirm call ordering via mock.invocationCallOrder if another write
  // happens in the same test, matching this plan's own Review Focus bullet.
});

it('returns without recording anything when the service is simply unconfigured (no baseUrl) -- existing behavior unchanged except for the one new write', async () => {
  // game.settings.get(..., 'agentServiceUrl') returns '' -- assert
  // lastDecisionError: { kind: 'unconfigured' } is written and the
  // function returns with no fetch attempted.
});
```

```js
// tests for armAgentTimeout's new fallbackReason read (same test file,
// or armAgentTimeout's own existing one)
it('reads a stored lastDecisionError kind as the fallback reason instead of defaulting to "timeout" (#952)', async () => {
  // turnState has lastDecisionError: { kind: 'error' }; assert
  // playHeuristicTurn (or whatever this file's real heuristic entry point
  // is) receives/records fallbackReason: 'error', not 'timeout'.
});

it('defaults to "timeout" when no lastDecisionError was ever recorded', async () => {
  // turnState has no lastDecisionError; assert fallbackReason: 'timeout'.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-decision-loop.test.mjs -t "#952"`
Expected: FAIL (no `decisionInfo` passed; no `lastDecisionError` written)

- [ ] **Step 3: Implement in `runAgentDecisionLoop`**

```js
// scripts/dungeon-combat.mjs -- runAgentDecisionLoop's real body (lines
// ~1013-1096): the unconfigured-service early return:
  const baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  const apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  if (!baseUrl) {
    await setAgentTurnState(combat, combatant.id, {
      ...getAgentTurnState(combat, combatant.id),
      lastDecisionError: { kind: "unconfigured" },
    });
    return;
  }
```

```js
// scripts/dungeon-combat.mjs -- the decision-call try/catch (real lines
// ~1073-1096):
    let decision;
    const startedAt = Date.now();
    try {
      decision = await fetchDecision({
        baseUrl, apiKey,
        context: { ...pending.context, actorProfile: { tier: "standard" } },
      });
    } catch (err) {
      console.error("agent-service: combat-decision call failed:", err.message);
      await setAgentTurnState(combat, pending.combatantId, {
        ...getAgentTurnState(combat, pending.combatantId),
        lastDecisionError: { kind: "error" },
      });
      return;
    }
    const clientMs = Date.now() - startedAt;
    try {
      pending = await applyDecision(
        combat,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
        { source: "model", meta: { ...decision.meta, clientMs } },
      );
    } catch (err) {
      console.error("agent-service: applyAgentDecision failed:", err.message);
      return;
    }
```

- [ ] **Step 4: Implement in `armAgentTimeout`**

```js
// scripts/dungeon-combat.mjs -- armAgentTimeout, immediately before the
// existing `await playHeuristicTurn(combat, combatant);` call:
  const lastError = currentStoredAgentTurnState(combat, combatant.id)?.lastDecisionError;
  const fallbackReason = lastError?.kind ?? "timeout";
  await playHeuristicTurn(combat, combatant, { fallbackReason });
```

(`playHeuristicTurn`'s own signature gains an optional second parameter; Task 4 is where that reason actually reaches the `agentLog` record, via whichever executor path the heuristic turn ultimately calls into `applyAgentDecision` through — confirm `playHeuristicTurn`'s real current signature and call chain before writing this exact threading, since this plan has not independently re-derived that function's full body.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-decision-loop.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-decision-loop.test.mjs
git commit -m "feat(#952): measure clientMs and record why a fallback fired (error/unconfigured/timeout)"
```

---

### Task 4: Amend #925's plan — the record's alternatives/meta/fallbackReason fields

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-action-display.md`

- [ ] **Step 1: Add the fifth `decisionInfo` parameter to `applyAgentDecision`'s own signature in that plan, and the alternatives-building step**

In that plan's Task 3 (`applyAgentDecision`'s dispatch capture), add immediately after the point it already resolves `pending.candidates` and the chosen `candidateId`:

```js
// docs/superpowers/plans/2026-10-09-ai-actor-action-display.md's own
// applyAgentDecision signature gains a fifth, optional parameter:
export async function applyAgentDecision(combat, combatantId, candidateId, rationale = null, decisionInfo = null) {
  // ...unchanged...

  // #952: alternatives considered this turn, chosen one marked, capped at
  // 12 keeping the chosen one even if it would otherwise be truncated out.
  const chosenIndex = pending.candidates.findIndex((c) => c.id === candidateId);
  let alternativesSource = pending.candidates;
  let moreCount = 0;
  if (alternativesSource.length > 12) {
    const chosen = alternativesSource[chosenIndex];
    const rest = alternativesSource.filter((_, i) => i !== chosenIndex).slice(0, 11);
    alternativesSource = chosenIndex >= 0 ? [chosen, ...rest] : rest.slice(0, 12);
    moreCount = pending.candidates.length - alternativesSource.length;
  }
  const alternatives = alternativesSource.map((c) => ({ id: c.id, summary: c.summary ?? c.type, chosen: c.id === candidateId }));
```

- [ ] **Step 2: Add the three new fields to the record `appendAgentActionRecord` writes**

```js
// that plan's own record-building object (wherever it spreads describeAgentAction's
// result into the record passed to appendAgentActionRecord), add:
    alternatives,
    moreCount,
    meta: decisionInfo?.meta ?? null,
    fallbackReason: decisionInfo?.source === "fallback" ? decisionInfo?.fallbackReason ?? null : null,
```

Update that plan's own `source` determination: when `decisionInfo` is passed with `source: "model"` (Task 3 above), the record's `source` field is `"model"`; the heuristic path (unchanged call site, no `decisionInfo` passed, or explicitly `{source: "fallback", fallbackReason}`) keeps `source: "fallback"` as it already does. Thread `fallbackReason` from Task 3's `playHeuristicTurn({fallbackReason})` call through to whichever `applyAgentDecision` call the heuristic path ultimately makes — confirm that exact call site in #925's own plan before finalizing this step.

- [ ] **Step 3: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-action-display.md
git commit -m "docs(#952): amend #925's plan -- alternatives/meta/fallbackReason record fields"
```

---

### Task 5: `buildDecisionDetails` (pure)

**Files:**
- Create: `scripts/ui/ai-decision-details.mjs`
- Test: `tests/ai-decision-details.test.mjs`

**Interfaces:**
- Consumes: nothing (takes a plain record).
- Produces: `buildDecisionDetails(record, {isGM})` → `null | {alternatives, moreCount, lines}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/ai-decision-details.test.mjs
import { describe, it, expect } from 'vitest';
import { buildDecisionDetails } from '../scripts/ui/ai-decision-details.mjs';

const record = {
  alternatives: [{ id: 'a', summary: 'Strike Goblin', chosen: true }, { id: 'b', summary: 'Strike Fighter', chosen: false }],
  moreCount: 3,
  meta: { provider: 'litellm', model: 'reasoning', tier: 'reasoning', clientMs: 2310, serverMs: 2140, usage: { totalTokens: 1894 }, costUsd: 0.0112 },
  fallbackReason: null,
};

describe('buildDecisionDetails (#952)', () => {
  it('returns null for a non-GM user', () => {
    expect(buildDecisionDetails(record, { isGM: false })).toBeNull();
  });

  it('returns null when the record has neither alternatives nor meta', () => {
    expect(buildDecisionDetails({}, { isGM: true })).toBeNull();
  });

  it('builds alternatives, moreCount and formatted lines for a GM', () => {
    const details = buildDecisionDetails(record, { isGM: true });
    expect(details.alternatives).toEqual([{ summary: 'Strike Goblin', chosen: true }, { summary: 'Strike Fighter', chosen: false }]);
    expect(details.moreCount).toBe(3);
    expect(details.lines).toContain('Provider: litellm · Model: reasoning');
    expect(details.lines.some((l) => l.includes('2.3 s'))).toBe(true);
    expect(details.lines.some((l) => l.includes('1,894'))).toBe(true);
    expect(details.lines.some((l) => l.includes('0.011'))).toBe(true);
  });

  it('omits a line for any absent field rather than printing "undefined"', () => {
    const details = buildDecisionDetails({ meta: { provider: 'laya', serverMs: 50 } }, { isGM: true });
    expect(details.lines.join(' ')).not.toContain('undefined');
    expect(details.lines).toEqual(['Provider: laya', 'Latency: 0.1 s (server 0.1 s)']);
  });

  it('formats a fallback reason', () => {
    const details = buildDecisionDetails({ fallbackReason: 'timeout' }, { isGM: true });
    expect(details.lines).toContain('Fallback: timed out');
  });

  it('truncates a very long alternative summary for display', () => {
    const long = 'x'.repeat(200);
    const details = buildDecisionDetails({ alternatives: [{ id: 'a', summary: long, chosen: true }] }, { isGM: true });
    expect(details.alternatives[0].summary.length).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-decision-details.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/ui/ai-decision-details.mjs
/** #952: pure GM-only rendering of alternatives/decision metadata -- no
 * Foundry API surface, alongside #950's visibleRecords and #951's
 * buildCombatantDigest. */

const FALLBACK_LABELS = { timeout: 'timed out', error: 'call failed', unconfigured: 'service unconfigured' };

function truncate(text, max = 100) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildDecisionDetails(record, { isGM }) {
  if (!isGM) return null;
  const hasAlternatives = Array.isArray(record?.alternatives) && record.alternatives.length > 0;
  const hasMeta = record?.meta && Object.keys(record.meta).length > 0;
  const hasFallbackReason = !!record?.fallbackReason;
  if (!hasAlternatives && !hasMeta && !hasFallbackReason) return null;

  const alternatives = hasAlternatives
    ? record.alternatives.map((a) => ({ summary: truncate(a.summary ?? ''), chosen: a.chosen === true }))
    : [];

  const lines = [];
  const meta = record?.meta ?? {};
  if (meta.provider) {
    lines.push(meta.model ? `Provider: ${meta.provider} · Model: ${meta.model}` : `Provider: ${meta.provider}`);
  }
  if (typeof meta.clientMs === 'number' || typeof meta.serverMs === 'number') {
    const total = typeof meta.clientMs === 'number' ? (meta.clientMs / 1000).toFixed(1) : null;
    const server = typeof meta.serverMs === 'number' ? (meta.serverMs / 1000).toFixed(1) : null;
    if (total && server) lines.push(`Latency: ${total} s (server ${server} s)`);
    else if (server) lines.push(`Latency: ${server} s (server ${server} s)`);
  }
  if (typeof meta.usage?.totalTokens === 'number') {
    const tokens = meta.usage.totalTokens.toLocaleString();
    lines.push(typeof meta.costUsd === 'number' ? `Tokens: ${tokens} (≈ $${meta.costUsd.toFixed(3)})` : `Tokens: ${tokens}`);
  }
  if (record?.fallbackReason) {
    lines.push(`Fallback: ${FALLBACK_LABELS[record.fallbackReason] ?? record.fallbackReason}`);
  }

  return { alternatives, moreCount: record?.moreCount ?? 0, lines };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-decision-details.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/ai-decision-details.mjs tests/ai-decision-details.test.mjs
git commit -m "feat(#952): buildDecisionDetails, pure GM-only alternatives/metadata rendering"
```

---

### Task 6: Amend #925/#950/#951's plans — render the Details disclosure

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-action-display.md`
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-action-log-panel.md`
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-tracker-and-hover-detail.md`

- [ ] **Step 1: #925's chat-card template** — inside its existing GM-only (`data-visibility="gm"`) block for each action row, add a collapsed disclosure calling `buildDecisionDetails(record, {isGM: true})` (the template itself only runs inside the already-GM-gated span, but the helper is called the same way everywhere for consistency) and rendering its `lines`/`alternatives`/`moreCount` inside a `<details><summary>Details</summary>...</details>` element.
- [ ] **Step 2: #950's `AiActionLogApp` template** — the same `<details>` block under each GM-visible row, reusing `buildDecisionDetails` from `ai-decision-details.mjs` imported alongside `buildAiLogView`.
- [ ] **Step 3: #951's tracker-row expanded list** — the same block inside each expanded row's own GM-only section (`renderTrackerDigestInto`'s `rowHtml` helper).
- [ ] **Step 4: Commit the amendments**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-action-display.md docs/superpowers/plans/2026-10-09-ai-actor-action-log-panel.md docs/superpowers/plans/2026-10-09-ai-actor-tracker-and-hover-detail.md
git commit -m "docs(#952): amend #925/#950/#951's plans -- render the Details disclosure"
```

---

### Task 7: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (new file `ai-decision-details.mjs`; `resolveProviderName` new export)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#952): bump version for decision details/alternatives"
```

---

## Self-Review

**1. Spec coverage:** The service contract (Task 1–2), client-side latency/fallback recording (Task 3), the record shape (Task 4), the pure rendering helper (Task 5), and all three surfaces (Task 6) are each covered. The reasoning-candidate-stage metadata the spec defers (#1009) is correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". Two spots are explicitly flagged as needing a real file read before finalizing rather than guessed: Task 2 Step 4 (OpenRouter's own real usage/cost field names) and Task 3 Step 4 (`playHeuristicTurn`'s real current signature/call chain) — both named plainly rather than silently assumed.

**3. Type consistency:** `decisionInfo`'s shape (`{source, meta, fallbackReason?}`) is produced in Task 3 and consumed identically by Task 4's amendment to `applyAgentDecision`. The record's `{alternatives, moreCount, meta, fallbackReason}` fields are produced in Task 4 and consumed identically by Task 5's `buildDecisionDetails`.

**4. Review Focus:** All five bullets (error-path isolation, write-before-return ordering, the cap-keeps-chosen rule, strict `null` for non-GM, missing-meta safety) are each pinned to a named test in Tasks 1, 3, 4, and 5.

**Corrections found while writing this plan:** the first draft of Task 4's alternatives-capping logic truncated to 12 and THEN checked whether the chosen candidate survived, which would silently drop it exactly when the model's own choice happened to sort past position 12 in `pending.candidates`' own order — rewritten to pull the chosen candidate out FIRST and prepend it, truncating the REST to 11, so the chosen one is structurally guaranteed to survive rather than surviving only when lucky.
