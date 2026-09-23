# litellm Proxy and Dynamic Model Tiering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a litellm sidecar to `tools/agent-service` and pick a "fast" vs "reasoning" model tier per request based on existing game-state signals, replacing the static `claude`/`local` provider switches with one unified litellm-backed path.

**Architecture:** `providers/litellm.mjs` (new) replaces `providers/claude.mjs` for combat decisions; `customization-generator.mjs` collapses its Claude/local split into one litellm-backed path. Both call litellm's OpenAI-compatible `/chat/completions` route (reusing the existing local-provider request-shaping code, since litellm speaks the same protocol), with `model` set to `"fast"` or `"reasoning"` by a small shared tier-selection module. Laya (`providers/laya.mjs`) is untouched. No Foundry-side (`scripts/`) changes — the `/v1/combat-decision`/`/v1/flavor-customization` wire contracts don't change.

**Tech Stack:** Node (`tools/agent-service`), litellm (Docker sidecar, OpenAI-compatible proxy), vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-litellm-model-tiering-design.md`

## Global Constraints

- Laya cannot generate free text and must remain unreachable from the litellm path under any configuration (spec: "Hard constraint").
- No `scripts/` changes — the wire contracts of `/v1/combat-decision` and `/v1/flavor-customization` are unchanged (spec: "Architecture").
- Combat-decision timeout stays `AGENT_TIMEOUT_MS = 45000` in `scripts/dungeon-combat.mjs`, unaffected by this work (spec: "Error handling").
- Flavor customization still degrades to template content on failure, never blocks (spec: "Error handling").
- Both model tiers point at `ollama/qwen2.5:3b-instruct` for now — swapping the reasoning tier later is a `litellm-config.yaml` edit only, not a code change (spec: "Non-goals").
- The litellm sidecar is not published to a host port — only reachable from the `agent-service` container over the compose network (spec: "Deployment and ownership model").
- Clean, breaking cutover — no backwards-compatibility shim for the removed `AGENT_SERVICE_CUSTOMIZATION_PROVIDER`/`LOCAL_LLM_*`/`ANTHROPIC_API_KEY` env vars (spec: "Migration").

## Review Focus

- **litellm/Ollama unreachable or times out mid-combat-decision.** Expected: `providers/litellm.mjs`'s `decide()` rejects promptly (not a hang), letting `dungeon-combat.mjs`'s existing `AGENT_TIMEOUT_MS` fallback handle it exactly as it does for any other provider failure today — Task 3's tests cover the rejection; nothing downstream of this plan needs to change for the fallback itself to keep working.
- **litellm returns a `candidateId` that was never offered, or a malformed/missing tool call.** Expected: treated as a failed decision cycle, same as today's Claude-adapter behavior — Task 3's tests mirror the equivalent existing Claude-provider tests being deleted in Task 4.
- **`candidates.length` exactly equals the reasoning threshold (the boundary).** Expected: a single, consistently-applied rule (`>`, not `>=`) so the same input never flip-flops between tiers across calls — Task 2's tests pin the exact boundary value.
- **An unrecognized `kind` reaches `selectCustomizationTier`.** `server.mjs`'s `KNOWN_KINDS` gate is the real validation boundary (unchanged, out of this plan's scope) and should reject an unknown `kind` before `generateCustomization` is ever called — but `selectCustomizationTier` itself is a pure classifier, not a validator, and must not throw for a value it doesn't recognize (a future new kind added to `SCHEMAS` without updating tier selection shouldn't crash the whole request). Expected: falls back to `"fast"` rather than throwing — Task 2's tests cover an unrecognized kind explicitly.
- **A deployed instance still has old env vars set** (`AGENT_SERVICE_CUSTOMIZATION_PROVIDER`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_TIMEOUT_MS`, `ANTHROPIC_API_KEY`) after upgrading, per the spec's migration note that these "become inert." Expected: the new code never reads them at all (confirmed by Task 5's implementation containing no references), so their presence is harmless, not a crash — Task 5 Step 1 explicitly greps for this before removal is considered complete.

---

## Task 1: Extract the shared `nodeFetch` transport

**Files:**
- Create: `tools/agent-service/node-fetch.mjs`
- Modify: `tools/agent-service/customization-generator.mjs:1-2, 95-149` (remove the local `nodeFetch` definition and its two `node:http`/`node:https` imports, import it from the new file instead)

**Interfaces:**
- Produces: `nodeFetch(url, { method?, headers?, body?, signal? }): Promise<{ok, status, text(), json()}>` from `tools/agent-service/node-fetch.mjs` — identical behavior to the function being moved, just relocated so `providers/litellm.mjs` (Task 3) can also use it without duplicating ~55 lines of timeout-handling logic.

This is a pure refactor — `customization-generator.mjs`'s existing tests (`tests/agent-service-customization-generator.test.mjs`) are the safety net; no new test file for this task.

- [ ] **Step 1: Run the existing customization-generator tests to confirm a green baseline**

Run: `npx vitest run tests/agent-service-customization-generator.test.mjs`
Expected: PASS (all tests, current behavior, before any change)

- [ ] **Step 2: Create `tools/agent-service/node-fetch.mjs`**

```js
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** A minimal, dependency-free fetch-compatible client for talking to a
 * local/self-hosted OpenAI-compatible HTTP endpoint (litellm, or directly
 * to Ollama).
 *
 * This deliberately avoids Node's built-in global `fetch`: it's backed by
 * undici, which imposes its own internal `headersTimeout` (default
 * 300000ms) that is NOT governed by the `AbortSignal` passed to fetch() —
 * confirmed live against this module's local-provider path: a
 * slow-but-legitimate local-model response (minutes, not seconds, is
 * normal for local inference on modest hardware) tripped undici's hidden
 * watchdog before our own configured timeout even fired, surfacing as a
 * confusing raw `TypeError: fetch failed` / `UND_ERR_HEADERS_TIMEOUT`
 * instead of a clean, documented abort. Raw node:http/node:https requests
 * have no such hidden ceiling, so `signal` (AbortSignal.timeout(...)) is
 * the only thing that can end this request early. */
export function nodeFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(target, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", (err) => {
      if (signal?.aborted) {
        reject(new Error("nodeFetch: request timed out"));
      } else {
        reject(err);
      }
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        return;
      }
      signal.addEventListener("abort", () => req.destroy(), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}
```

(Note: the moved version's error message changes from `"customization-generator: local provider request timed out"` to the generic `"nodeFetch: request timed out"` since this file no longer belongs to `customization-generator.mjs` specifically — Task 5 Step 1 will confirm no test asserts the old, module-specific wording.)

- [ ] **Step 3: Update `customization-generator.mjs` to import the shared version**

Remove lines 1-2 (`import { request as httpRequest } from "node:http";` / `import { request as httpsRequest } from "node:https";`) and the entire `nodeFetch` function (lines ~95-149 in the current file). Add instead:

```js
import { nodeFetch } from "./node-fetch.mjs";
```

- [ ] **Step 4: Run the existing tests again to confirm nothing broke**

Run: `npx vitest run tests/agent-service-customization-generator.test.mjs`
Expected: PASS (same tests as Step 1, now exercising the relocated code) — if the "round-trips over a real HTTP connection" test's error-message assertion fails, check whether it matches the old `"customization-generator: local provider request timed out"` wording; if so, update it to match `nodeFetch.mjs`'s new generic message (it currently only asserts a successful round trip, not the timeout error message, so no change is expected here, but verify).

- [ ] **Step 5: Commit**

```bash
git add tools/agent-service/node-fetch.mjs tools/agent-service/customization-generator.mjs
git commit -m "Extract shared nodeFetch transport out of customization-generator.mjs"
```

---

## Task 2: Tier-selection pure functions

**Files:**
- Create: `tools/agent-service/tier-selection.mjs`
- Test: `tests/agent-service-tier-selection.test.mjs`

**Interfaces:**
- Produces: `selectCombatTier(context, opts?): "fast" | "reasoning"` and `selectCustomizationTier(kind): "fast" | "reasoning"`, both consumed by Task 3 (`providers/litellm.mjs`) and Task 5 (`customization-generator.mjs`).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import { selectCombatTier, selectCustomizationTier } from "../tools/agent-service/tier-selection.mjs";

describe("selectCombatTier", () => {
  it("picks fast when candidates.length is below the default threshold", () => {
    const context = { candidates: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context)).toBe("fast");
  });

  it("picks fast at exactly the threshold boundary (8)", () => {
    const context = { candidates: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context)).toBe("fast");
  });

  it("picks reasoning just above the threshold boundary (9)", () => {
    const context = { candidates: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context)).toBe("reasoning");
  });

  it("honors a custom threshold override", () => {
    const context = { candidates: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context, { threshold: 4 })).toBe("reasoning");
    expect(selectCombatTier(context, { threshold: 5 })).toBe("fast");
  });
});

describe("selectCustomizationTier", () => {
  it("picks fast for trap and treasure", () => {
    expect(selectCustomizationTier("trap")).toBe("fast");
    expect(selectCustomizationTier("treasure")).toBe("fast");
  });

  it("picks reasoning for skill_challenge, puzzle, and narrative", () => {
    expect(selectCustomizationTier("skill_challenge")).toBe("reasoning");
    expect(selectCustomizationTier("puzzle")).toBe("reasoning");
    expect(selectCustomizationTier("narrative")).toBe("reasoning");
  });

  it("falls back to fast for an unrecognized kind rather than throwing", () => {
    expect(selectCustomizationTier("not-a-real-kind")).toBe("fast");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-tier-selection.test.mjs`
Expected: FAIL with "Cannot find module '../tools/agent-service/tier-selection.mjs'"

- [ ] **Step 3: Write the implementation**

```js
import { readEnvOrDotenv } from "./env.mjs";

const DEFAULT_COMBAT_REASONING_CANDIDATE_THRESHOLD = 8;

/** "reasoning" when the acting combatant has more candidate actions to
 * weigh than the threshold, else "fast". candidates.length is a proxy for
 * tactical decision complexity (more ready strikes/spells/postures),
 * not narrative importance — see #136 for a real importance signal this
 * is deliberately not waiting on. */
export function selectCombatTier(
  context,
  {
    threshold = Number(readEnvOrDotenv("COMBAT_REASONING_CANDIDATE_THRESHOLD")) ||
      DEFAULT_COMBAT_REASONING_CANDIDATE_THRESHOLD,
  } = {},
) {
  return context.candidates.length > threshold ? "reasoning" : "fast";
}

const REASONING_CUSTOMIZATION_KINDS = new Set(["skill_challenge", "puzzle", "narrative"]);

/** trap/treasure (short, low-stakes flavor) get "fast"; skill_challenge/
 * puzzle/narrative (more player-facing, more substantive) get "reasoning".
 * An unrecognized kind defaults to "fast" rather than throwing — kind
 * validation is server.mjs's job (KNOWN_KINDS), not this pure
 * classifier's. */
export function selectCustomizationTier(kind) {
  return REASONING_CUSTOMIZATION_KINDS.has(kind) ? "reasoning" : "fast";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-tier-selection.test.mjs`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/agent-service/tier-selection.mjs tests/agent-service-tier-selection.test.mjs
git commit -m "Add tier-selection pure functions for combat and customization"
```

---

## Task 3: `providers/litellm.mjs` — combat-decision provider via litellm

**Files:**
- Create: `tools/agent-service/providers/litellm.mjs`
- Test: `tests/agent-service-litellm-provider.test.mjs`

**Interfaces:**
- Consumes: `readEnvOrDotenv` (`../env.mjs`), `nodeFetch` (`../node-fetch.mjs`, Task 1), `selectCombatTier` (`../tier-selection.mjs`, Task 2).
- Produces: `decide(context, opts?): Promise<{candidateId, rationale?}>` — same contract every other provider (`claude.mjs`, `laya.mjs`) already implements, consumed by `providers/index.mjs` (Task 4).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from "vitest";
import { decide } from "../tools/agent-service/providers/litellm.mjs";

const CONTEXT = {
  self: { name: "Yamaraj", hp: 40, conditions: [] },
  opponents: [{ id: "opp1", name: "Fighter", distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: "strike:claw:opp1", summary: "Claw vs Fighter (variant 0)" },
    { id: "endTurn", summary: "End turn" },
  ],
  roundNumber: 1,
};

function fakeFetch(toolArgs, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "choose_action", arguments: JSON.stringify(toolArgs) } },
            ],
          },
        },
      ],
    }),
  });
}

describe("litellm provider decide()", () => {
  it("sends an OpenAI tool-call request to {baseUrl}/chat/completions with the fast model for a simple turn", async () => {
    const fetchImpl = fakeFetch({ candidateId: "strike:claw:opp1", rationale: "closest target" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("fast");
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "choose_action",
        description: expect.any(String),
        parameters: expect.objectContaining({
          properties: expect.objectContaining({
            candidateId: { type: "string", enum: ["strike:claw:opp1", "endTurn"] },
          }),
        }),
      },
    });
    expect(JSON.stringify(body.messages)).toContain("Yamaraj");
  });

  it("requests the reasoning model when candidates.length is above the threshold", async () => {
    const manyCandidates = Array.from({ length: 10 }, (_, i) => ({ id: `strike:claw:opp${i}`, summary: `Claw vs opp${i}` }));
    const context = { ...CONTEXT, candidates: manyCandidates };
    const fetchImpl = fakeFetch({ candidateId: "strike:claw:opp0", rationale: "closest" });
    await decide(context, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("sends a bearer token when an API key is configured", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", apiKey: "secret", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("passes an AbortSignal so a stuck upstream call times out instead of hanging", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the chosen candidateId and rationale", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(result).toEqual({ candidateId: "endTurn", rationale: "no good options" });
  });

  it("throws if litellm picks a candidateId that was never offered", async () => {
    const fetchImpl = fakeFetch({ candidateId: "not-a-real-candidate", rationale: "oops" });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/not offered/);
  });

  it("throws a diagnosable error when the response is not ok", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 502 });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/502/);
  });

  it("throws a clear error when there is no tool call in the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/no choose_action tool call/);
  });

  it("throws a clear error when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ function: { name: "choose_action", arguments: "{not json" } }] } }],
      }),
    });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/litellm provider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-litellm-provider.test.mjs`
Expected: FAIL with "Cannot find module '../tools/agent-service/providers/litellm.mjs'"

- [ ] **Step 3: Write the implementation**

```js
import { readEnvOrDotenv } from "../env.mjs";
import { nodeFetch } from "../node-fetch.mjs";
import { selectCombatTier } from "../tier-selection.mjs";

const DEFAULT_TIMEOUT_MS = 300000;

async function callLiteLLM(body, { baseUrl, apiKey, timeoutMs, fetchImpl }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`litellm provider: API request failed (${res.status}): ${errBody}`);
  }
  return res.json();
}

export async function decide(
  context,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const candidateIds = context.candidates.map((c) => c.id);
  const model = selectCombatTier(context);

  const payload = await callLiteLLM(
    {
      model,
      messages: [
        {
          role: "user",
          content: `You are controlling an NPC's turn in a Pathfinder 2e combat. Pick the best candidate action.\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "choose_action",
            description: "Choose exactly one candidate action for this combatant's turn.",
            parameters: {
              type: "object",
              properties: {
                candidateId: { type: "string", enum: candidateIds },
                rationale: { type: "string", description: "One short sentence explaining the choice." },
              },
              required: ["candidateId", "rationale"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "choose_action" } },
    },
    { baseUrl, apiKey, timeoutMs, fetchImpl },
  );

  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("litellm provider: no choose_action tool call in response");

  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`litellm provider: tool call arguments were not valid JSON: ${err.message}`);
  }

  const { candidateId, rationale } = parsed;
  if (!candidateIds.includes(candidateId)) {
    throw new Error(`litellm provider: candidateId "${candidateId}" was not offered`);
  }
  return { candidateId, rationale };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-litellm-provider.test.mjs`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/agent-service/providers/litellm.mjs tests/agent-service-litellm-provider.test.mjs
git commit -m "Add litellm-backed combat-decision provider with tier selection"
```

---

## Task 4: Swap `claude` for `litellm` in `providers/index.mjs`

**Files:**
- Modify: `tools/agent-service/providers/index.mjs`
- Modify: `tests/agent-service-provider-selection.test.mjs`
- Delete: `tools/agent-service/providers/claude.mjs`
- Delete: `tests/agent-service-claude-provider.test.mjs`

**Interfaces:**
- Consumes: `decide` from `providers/litellm.mjs` (Task 3).
- Produces: `resolveProvider(name?)` now resolves `"litellm"` (default) or `"laya"` — `"claude"` is no longer a valid value.

- [ ] **Step 1: Update the failing/changed assertions in `tests/agent-service-provider-selection.test.mjs`**

Replace the `'defaults to claude when nothing is configured'` test:

```js
  it('defaults to litellm when nothing is configured', async () => {
    const { decide: decideLitellm } = await import('../tools/agent-service/providers/litellm.mjs');
    expect(resolveProvider()).toBe(decideLitellm);
  });
```

Replace the `.env`-fallback test's `PF2EDC_AGENT_PROVIDER=claude` reference in the "still works and is not shadowed by .env" test:

```js
  it('a real shell environment variable still works and is not shadowed by .env', async () => {
    process.env.PF2EDC_AGENT_PROVIDER = 'laya';
    mockedEnvFileContent = 'PF2EDC_AGENT_PROVIDER=litellm\n';
    const { decide: decideLaya } = await import('../tools/agent-service/providers/laya.mjs');
    expect(resolveProvider()).toBe(decideLaya);
  });
```

The other three tests (`'picks the provider named by an explicit argument'`, `'reads PF2EDC_AGENT_PROVIDER from .env'`, `'throws a helpful error for an unknown provider name'`) are unchanged — they don't reference `claude` at all.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-provider-selection.test.mjs`
Expected: FAIL — `resolveProvider()` still defaults to the (still-present) `claude` provider.

- [ ] **Step 3: Update `providers/index.mjs`**

```js
import { readEnvOrDotenv } from '../env.mjs';
import { decide as decideLitellm } from './litellm.mjs';
import { decide as decideLaya } from './laya.mjs';

const PROVIDERS = { litellm: decideLitellm, laya: decideLaya };

/** Picks the decide() function named by PF2EDC_AGENT_PROVIDER — a real shell
 * env var if set, otherwise a `.env` entry, defaulting to "litellm". */
export function resolveProvider(name = readEnvOrDotenv('PF2EDC_AGENT_PROVIDER') ?? 'litellm') {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown PF2EDC_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
```

- [ ] **Step 4: Delete the old Claude provider and its test**

```bash
rm tools/agent-service/providers/claude.mjs tests/agent-service-claude-provider.test.mjs
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-provider-selection.test.mjs`
Expected: PASS (all 5 tests)

- [ ] **Step 6: Confirm nothing else still references the deleted file**

Run: `grep -rln "providers/claude" scripts/ tools/ tests/ --include="*.mjs"`
Expected: no matches

- [ ] **Step 7: Commit**

```bash
git add tools/agent-service/providers/index.mjs tools/agent-service/providers/claude.mjs tests/agent-service-provider-selection.test.mjs tests/agent-service-claude-provider.test.mjs
git commit -m "Swap the claude provider for litellm in resolveProvider()"
```

---

## Task 5: Consolidate `customization-generator.mjs` onto litellm

**Files:**
- Modify: `tools/agent-service/customization-generator.mjs` (replace `generateWithClaude`/`generateWithLocal` and the `provider` switch with one `generateWithLiteLLM`)
- Modify: `tests/agent-service-customization-generator.test.mjs` (replace the two `describe` blocks with one unified set of tests)

**Interfaces:**
- Consumes: `nodeFetch` (`./node-fetch.mjs`, already imported per Task 1), `selectCustomizationTier` (`./tier-selection.mjs`, Task 2).
- Produces: `generateCustomization(kind, context, opts?): Promise<object>` — same exported name and per-kind return shape as before; the `provider`/`apiKey`/`baseUrl`/`model`/`localApiKey`/`timeoutMs` options collapse to just `baseUrl`/`apiKey`/`timeoutMs`/`fetchImpl` (litellm-only, no more provider switch). This is the function `server.mjs`'s `handleFlavorCustomization` already calls unchanged.

- [ ] **Step 1: Confirm no other code references the options being removed**

Run: `grep -rln "generateWithClaude\|generateWithLocal\|AGENT_SERVICE_CUSTOMIZATION_PROVIDER\|LOCAL_LLM_BASE_URL\|LOCAL_LLM_MODEL\|LOCAL_LLM_API_KEY\|LOCAL_LLM_TIMEOUT_MS" scripts/ tools/ --include="*.mjs"`
Expected: only `tools/agent-service/customization-generator.mjs` itself (about to be edited) and `tools/agent-service/docker-compose.yml` (a non-`.mjs` file this grep won't match — updated separately in Task 6).

- [ ] **Step 2: Replace the test file's two provider-specific `describe` blocks with one unified set**

Replace the entire contents of `tests/agent-service-customization-generator.test.mjs` with:

```js
import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: () => {
    throw new Error("ENOENT: no such file");
  },
}));

const { generateCustomization } = await import("../tools/agent-service/customization-generator.mjs");

function fakeFetch(toolArgs, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      choices: [
        { message: { tool_calls: [{ function: { name: "customize", arguments: JSON.stringify(toolArgs) } }] } },
      ],
    }),
  });
}

const OPTS = { baseUrl: "http://litellm:4000/v1", fetchImpl: null };

describe("generateCustomization", () => {
  it("generates a trap name and description at the fast tier", async () => {
    const fetchImpl = fakeFetch({ name: "The Weeping Door", description: "A door that drips illusory blood." });
    const result = await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 3, partyLevel: 2 },
      { ...OPTS, fetchImpl },
    );
    expect(result).toEqual({ name: "The Weeping Door", description: "A door that drips illusory blood." });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("fast");
    expect(body.tools[0].function.parameters.required).toEqual(["name", "description"]);
  });

  it("generates a treasure room name and summary at the fast tier", async () => {
    const fetchImpl = fakeFetch({ name: "The Cairn of the Unnamed", summary: "A quiet burial mound." });
    const result = await generateCustomization(
      "treasure",
      { sceneId: "s1", roomId: "r1", locationTag: null },
      { ...OPTS, fetchImpl },
    );
    expect(result).toEqual({ name: "The Cairn of the Unnamed", summary: "A quiet burial mound." });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("fast");
  });

  it("generates skill-challenge flavor at the reasoning tier, scoped to skillFlavor only", async () => {
    const fetchImpl = fakeFetch({
      name: "The Silent Vault",
      summary: "A vault sealed by an old ward.",
      skillFlavor: { athletics: "Force the ward apart.", arcana: "Unweave the ward." },
    });
    const result = await generateCustomization(
      "skill_challenge",
      { sceneId: "s1", roomId: "r1", specialtySkills: ["athletics", "arcana"], locationTag: "vault" },
      { ...OPTS, fetchImpl },
    );
    expect(result.skillFlavor).toEqual({ athletics: "Force the ward apart.", arcana: "Unweave the ward." });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("generates narrative content at the reasoning tier, scoped to the entry's own archetype fields", async () => {
    const fetchImpl = fakeFetch({
      name: "A Fork in the Tunnel",
      summary: "Two passages, one choice.",
      options: [
        { label: "Take the low path", consequence: "Faster, riskier." },
        { label: "Take the high path", consequence: "Slower, safer." },
      ],
    });
    const result = await generateCustomization(
      "narrative",
      { sceneId: "s1", roomId: "r1", archetype: "choice" },
      { ...OPTS, fetchImpl },
    );
    expect(result.options).toHaveLength(2);
    expect(result.revealText).toBeUndefined();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("tells the model the archetype-to-field mapping for narrative entries", async () => {
    const fetchImpl = fakeFetch({
      name: "The Weeping Statue",
      summary: "An old statue remembers the fall of the keep.",
      revealText: "The keep fell not to siege, but to betrayal from within.",
    });
    await generateCustomization("narrative", { sceneId: "s1", roomId: "r1", archetype: "lore" }, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].function.description).toMatch(/"lore"[^.]*revealText/);
  });

  it("sends an OpenAI-shaped tool-call request", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "customize",
        description: expect.any(String),
        parameters: expect.objectContaining({ required: ["name", "description"] }),
      },
    });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "customize" } });
  });

  it("sends a bearer token when an API key is configured", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
      { ...OPTS, apiKey: "secret-token", fetchImpl },
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer secret-token");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("passes an AbortSignal derived from the configured timeout", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a clear error for an unknown kind", async () => {
    await expect(
      generateCustomization("not-a-real-kind", {}, { ...OPTS, fetchImpl: vi.fn() }),
    ).rejects.toThrow(/unknown kind/);
  });

  it("throws a clear error when the response is not ok", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 502 });
    await expect(
      generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl }),
    ).rejects.toThrow(/502/);
  });

  it("throws a clear error when there is no tool call in the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(
      generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl }),
    ).rejects.toThrow(/no customize tool call/);
  });

  it("throws a clear error when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "customize", arguments: "{not json" } }] } }] }),
    });
    await expect(
      generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl }),
    ).rejects.toThrow(/customization-generator/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-customization-generator.test.mjs`
Expected: FAIL — the current implementation still expects `{provider, apiKey, baseUrl, model, localApiKey, timeoutMs}` and defaults to Claude.

- [ ] **Step 4: Replace `generateWithClaude`/`generateWithLocal` with `generateWithLiteLLM`**

In `tools/agent-service/customization-generator.mjs`, remove `generateWithClaude` and `generateWithLocal` entirely, and remove the `CLAUDE_MODEL` and `LOCAL_TIMEOUT_DEFAULT_MS` constants (replaced below). Add:

```js
import { selectCustomizationTier } from "./tier-selection.mjs";

const DEFAULT_TIMEOUT_MS = 300000;

async function generateWithLiteLLM(kind, context, schema, { baseUrl, apiKey, timeoutMs, fetchImpl }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: selectCustomizationTier(kind),
      messages: [{ role: "user", content: userMessageContent(kind, context) }],
      tools: [
        {
          type: "function",
          function: { name: "customize", description: toolDescription(kind), parameters: schema },
        },
      ],
      tool_choice: { type: "function", function: { name: "customize" } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`customization-generator: request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("customization-generator: no customize tool call in response");
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`customization-generator: tool call arguments were not valid JSON: ${err.message}`);
  }
}
```

Replace the exported `generateCustomization` function's body with:

```js
export async function generateCustomization(
  kind,
  context,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`customization-generator: unknown kind "${kind}"`);
  return generateWithLiteLLM(kind, context, schema, { baseUrl, apiKey, timeoutMs, fetchImpl });
}
```

Leave `SCHEMAS`, `TOOL_DESCRIPTIONS`, `toolDescription`, and `userMessageContent` unchanged — none of them are provider-specific.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-customization-generator.test.mjs`
Expected: PASS (all 14 tests)

- [ ] **Step 6: Commit**

```bash
git add tools/agent-service/customization-generator.mjs tests/agent-service-customization-generator.test.mjs
git commit -m "Consolidate customization-generator.mjs onto litellm with tier selection"
```

---

## Task 6: litellm sidecar deployment configuration

**Files:**
- Create: `tools/agent-service/litellm-config.yaml`
- Modify: `tools/agent-service/docker-compose.yml`

**Interfaces:** none — configuration only, consumed at deploy time by the containers Task 3/5's code already talks to via `LITELLM_BASE_URL`.

- [ ] **Step 1: Create `tools/agent-service/litellm-config.yaml`**

```yaml
model_list:
  - model_name: fast
    litellm_params:
      model: ollama/qwen2.5:3b-instruct
      api_base: http://host.docker.internal:11434
  - model_name: reasoning
    litellm_params:
      model: ollama/qwen2.5:3b-instruct
      api_base: http://host.docker.internal:11434
```

- [ ] **Step 2: Update `tools/agent-service/docker-compose.yml`**

Replace the `agent-service` service's `environment` block (currently including `AGENT_SERVICE_CUSTOMIZATION_PROVIDER`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_TIMEOUT_MS`, and `ANTHROPIC_API_KEY`) with:

```yaml
    environment:
      AGENT_SERVICE_API_KEY: ${AGENT_SERVICE_API_KEY}
      PF2EDC_AGENT_PROVIDER: ${PF2EDC_AGENT_PROVIDER:-litellm}
      LAYA_API_KEY: ${LAYA_API_KEY}
      LAYA_BASE_URL: ${LAYA_BASE_URL}
      AGENT_SERVICE_ALLOWED_ORIGIN: ${AGENT_SERVICE_ALLOWED_ORIGIN}
      LITELLM_BASE_URL: ${LITELLM_BASE_URL:-http://litellm:4000/v1}
      LITELLM_API_KEY: ${LITELLM_API_KEY}
      LITELLM_TIMEOUT_MS: ${LITELLM_TIMEOUT_MS}
      COMBAT_REASONING_CANDIDATE_THRESHOLD: ${COMBAT_REASONING_CANDIDATE_THRESHOLD}
```

Add the new sidecar service and make `agent-service` wait for it:

```yaml
  litellm:
    image: ghcr.io/berriai/litellm:main-stable
    volumes:
      - ./litellm-config.yaml:/app/config.yaml
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
```

Add `depends_on: [litellm]` to the existing `agent-service` service block (alongside its existing `build`/`ports`/`environment`/`extra_hosts`/`restart` keys — `extra_hosts` on `agent-service` itself is now only needed if something else on that container still reaches `host.docker.internal` directly; leave it in place since removing it is out of scope for this task and it's harmless if unused).

- [ ] **Step 3: Validate the compose file**

Run: `docker compose -f tools/agent-service/docker-compose.yml config`
Expected: valid, resolved YAML printed, no errors. If a Docker daemon is available in this environment, additionally run `AGENT_SERVICE_API_KEY=test docker compose -f tools/agent-service/docker-compose.yml up --build -d`, then `curl -s localhost:8787/v1/health` (expected `{"ok":true}`), then `docker compose -f tools/agent-service/docker-compose.yml down`. If no Docker daemon is available, skip the build/run check and note that in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add tools/agent-service/litellm-config.yaml tools/agent-service/docker-compose.yml
git commit -m "Add litellm sidecar to the agent-service deployment"
```

---

## Task 7: Documentation — migration and new configuration

**Files:**
- Modify: `tools/agent-service/README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Read the current README to find the exact sections to update**

Run: `grep -n "^#\|LOCAL_LLM\|AGENT_SERVICE_CUSTOMIZATION_PROVIDER\|ANTHROPIC_API_KEY\|PF2EDC_AGENT_PROVIDER" tools/agent-service/README.md`

Use the line numbers this prints to locate the deployment/env-var and provider-selection sections before editing, rather than guessing their position.

- [ ] **Step 2: Update the environment-variable documentation**

Remove documentation for `AGENT_SERVICE_CUSTOMIZATION_PROVIDER`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_TIMEOUT_MS`, and `ANTHROPIC_API_KEY`. Add documentation for `LITELLM_BASE_URL` (default `http://litellm:4000/v1`, the compose-network hostname — only needs overriding for a non-compose deployment), `LITELLM_API_KEY` (optional, matches whatever `litellm-config.yaml`/litellm's own auth is set up to expect, if anything — not required for the default sidecar setup since it isn't published to a host port), `LITELLM_TIMEOUT_MS` (default 300000ms, matching local-inference speed), and `COMBAT_REASONING_CANDIDATE_THRESHOLD` (default 8 — the candidate-count above which a combat decision requests the "reasoning" tier instead of "fast").

Update `PF2EDC_AGENT_PROVIDER`'s documented options from `claude|laya` to `litellm|laya`, default `litellm`.

- [ ] **Step 3: Add a "Configuring model tiers" section**

Document that `tools/agent-service/litellm-config.yaml` defines two model aliases, `fast` and `reasoning`, both currently pointing at the same local Ollama model (`qwen2.5:3b-instruct`) — and that pointing `reasoning` at a genuinely larger/different model later is a one-line edit to that file plus `docker compose restart litellm` (or a full `up -d` to pick up the volume-mounted change), no code change or image rebuild required.

- [ ] **Step 4: Add a migration note for existing deployments**

State plainly: this is a breaking change for any instance deployed before this work. `AGENT_SERVICE_CUSTOMIZATION_PROVIDER`, `LOCAL_LLM_*`, and `ANTHROPIC_API_KEY` should be removed from your `.env` (they're no longer read). If you had `PF2EDC_AGENT_PROVIDER=claude` explicitly set, change it to `PF2EDC_AGENT_PROVIDER=litellm`. Bring up the new `litellm` service alongside `agent-service` (`docker compose -f tools/agent-service/docker-compose.yml up -d`) — it's now a required dependency, not optional.

- [ ] **Step 5: Commit**

```bash
git add tools/agent-service/README.md
git commit -m "Document the litellm sidecar, model tiers, and migration from the old provider env vars"
```
