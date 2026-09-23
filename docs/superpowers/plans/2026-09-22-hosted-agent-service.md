# Hosted Agent Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `tools/agent-loop/poll.mjs` + the `foundryvtt-rest-api` relay with a persistent, self-hosted `tools/agent-service/` HTTP service that Foundry's own client-side module code calls directly for both combat-turn decisions and flavor customization — no local process, no relay, nothing for a GM to start each session.

**Architecture:** A Node `node:http` service (`tools/agent-service/server.mjs`) exposes `GET /v1/health`, `POST /v1/combat-decision`, and `POST /v1/flavor-customization`, wrapping the existing Claude/Laya provider adapters (moved from `tools/agent-loop/providers/`) plus a new Claude-only flavor-text generator. Foundry's client (`scripts/dungeon-combat.mjs`, `scripts/ui/dungeon-app.mjs`) calls it via a new thin fetch wrapper (`scripts/agent-service-client.mjs`), replacing the old poll loop and the interactive-MCP customization flow. `module.api.getPendingAgentTurn`/`applyAgentDecision` and the four `getPending*Customization`/`apply*Customization` pairs are unchanged; only who calls the decision step changes.

**Tech Stack:** Node (`node:http`, no new HTTP framework dependency), vitest for tests, Docker/`docker-compose` for deployment, Anthropic Messages API (Claude) for both decisions and flavor-text generation, optional Laya HTTP API for combat decisions only.

**Spec:** `docs/superpowers/specs/2026-09-22-hosted-agent-service-design.md`

## Global Constraints

- Each GM self-hosts their own instance of the hosted service (and their own Laya deployment, if used) — no shared multi-tenant service, no per-request tenant isolation beyond the single bearer token (spec: "Deployment and ownership model").
- Provider secrets (`ANTHROPIC_API_KEY`, `LAYA_API_KEY`) live only in the hosted service's own environment — never in Foundry module settings or the browser client (spec: "Foundry-side integration").
- Combat-decision timeout stays exactly `AGENT_TIMEOUT_MS = 45000` (`scripts/dungeon-combat.mjs`) — unchanged from today (spec: "Error handling and fallback").
- Flavor customization never blocks room population or reveal — a failed/slow hosted-service call leaves the original template content in place, logged only (spec: "Error handling and fallback").
- This is a clean, breaking cutover — no backwards-compatibility shim for `poll.mjs`/`mcp-server.mjs` (spec: "Migration").
- `POST /v1/combat-decision`'s request body includes an optional `actorProfile` field, unused by v1's implementation, reserved for future actor-complexity tiering (spec: "Hosted service API contract").
- Laya cannot generate free text (`tools/agent-loop/providers/laya.mjs`: "Laya never generates text — no field to fill for `rationale`") — flavor-customization generation always uses the Claude adapter, regardless of which provider `PF2EDC_AGENT_PROVIDER` selects for combat decisions. This is a plan-level clarification of the spec's `/v1/flavor-customization` endpoint, not a spec contradiction.

## Review Focus

- **Hosted service unreachable or times out mid-combat-turn.** A GM's network hiccups or their container host is down during a session. Expected: the existing `AGENT_TIMEOUT_MS` fallback to the heuristic fires exactly as it does today for a crashed `poll.mjs` — Task 7's test covers a rejected/hanging fetch.
- **Hosted service returns a `candidateId` that was never offered**, or a malformed JSON body. Expected: the decide-apply loop treats it as a failed cycle and lets the existing timeout handle the fallback, the same way `poll.mjs`'s `playOnePendingTurnToCompletion` already does today for a provider error — Task 7's test covers this.
- **A GM has not configured `agentServiceUrl`/`agentServiceApiKey` yet** (fresh install, or upgrading from the old `poll.mjs` setup with no equivalent settings saved). Expected: combat falls straight to the heuristic without ever attempting a network call, and flavor customization silently leaves template content in place — no thrown error visible to players. Task 6 and Task 7's tests cover the missing-settings case.
- **`/v1/flavor-customization` is called for a `kind` with optional fields** (e.g. a narrative room's archetype-specific fields — `revealText` for `lore`, `options` for `choice`, etc.). Expected: the generated response only includes the fields matching that entry's own archetype, mirroring `mcp-server.mjs`'s existing tool schemas exactly — Task 4's tests cover all four kinds.
- **The bearer token is missing or wrong** on a request to the hosted service (a misconfigured Foundry setting, or a stray/malicious request against an exposed port). Expected: `401` before any provider call is made — no Claude/Laya spend on an unauthenticated request. Task 2's tests cover this.

---

## Task 1: Move provider modules and env helper to `tools/agent-service/`

**Files:**
- Create: `tools/agent-service/env.mjs` (moved from `tools/agent-loop/foundry-client.mjs`'s `readEnvOrDotenv` only)
- Create: `tools/agent-service/providers/claude.mjs` (moved from `tools/agent-loop/providers/claude.mjs`, import path updated)
- Create: `tools/agent-service/providers/laya.mjs` (moved from `tools/agent-loop/providers/laya.mjs`, import path updated)
- Create: `tools/agent-service/providers/index.mjs` (moved from `tools/agent-loop/providers/index.mjs`, import path updated)
- Create: `tests/agent-service-claude-provider.test.mjs` (moved from `tests/agent-loop-claude-provider.test.mjs`, import path updated)
- Create: `tests/agent-service-laya-provider.test.mjs` (moved from `tests/agent-loop-laya-provider.test.mjs`, import path updated)
- Create: `tests/agent-service-provider-selection.test.mjs` (moved from `tests/agent-loop-provider-selection.test.mjs`, import path updated)
- Delete: `tools/agent-loop/providers/claude.mjs`, `tools/agent-loop/providers/laya.mjs`, `tools/agent-loop/providers/index.mjs`, `tests/agent-loop-claude-provider.test.mjs`, `tests/agent-loop-laya-provider.test.mjs`, `tests/agent-loop-provider-selection.test.mjs`
- Leave in place for now (used by files not yet removed): `tools/agent-loop/foundry-client.mjs`, `tests/agent-loop-foundry-client.test.mjs`

**Interfaces:**
- Produces: `readEnvOrDotenv(name: string): string | undefined` from `tools/agent-service/env.mjs`
- Produces: `decide(context, opts?): Promise<{candidateId: string, rationale?: string}>` from `tools/agent-service/providers/claude.mjs` and `tools/agent-service/providers/laya.mjs`
- Produces: `resolveProvider(name?: string): (context, opts?) => Promise<{candidateId, rationale?}>` from `tools/agent-service/providers/index.mjs`

- [ ] **Step 1: Create `tools/agent-service/env.mjs`**

```js
import { readFileSync } from "node:fs";

/** Reads `name` from the real shell environment first, falling back to a
 * `.env` file in the current working directory. */
export function readEnvOrDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(".env", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Create `tools/agent-service/providers/claude.mjs`**

Copy `tools/agent-loop/providers/claude.mjs` verbatim, changing only the import line:

```js
import { readEnvOrDotenv } from "../env.mjs";
```

(Everything else — `CLAUDE_MODEL`, `callClaude`, `decide` — is unchanged.)

- [ ] **Step 3: Create `tools/agent-service/providers/laya.mjs`**

Copy `tools/agent-loop/providers/laya.mjs` verbatim, changing only the import line:

```js
import { readEnvOrDotenv } from "../env.mjs";
```

- [ ] **Step 4: Create `tools/agent-service/providers/index.mjs`**

Copy `tools/agent-loop/providers/index.mjs` verbatim, changing only the import lines:

```js
import { readEnvOrDotenv } from "../env.mjs";
import { decide as decideClaude } from "./claude.mjs";
import { decide as decideLaya } from "./laya.mjs";
```

- [ ] **Step 5: Move the three provider test files**

```bash
git mv tests/agent-loop-claude-provider.test.mjs tests/agent-service-claude-provider.test.mjs
git mv tests/agent-loop-laya-provider.test.mjs tests/agent-service-laya-provider.test.mjs
git mv tests/agent-loop-provider-selection.test.mjs tests/agent-service-provider-selection.test.mjs
```

In each moved file, update the import path from `'../tools/agent-loop/providers/...'` to `'../tools/agent-service/providers/...'`.

- [ ] **Step 6: Delete the old provider files**

```bash
rm tools/agent-loop/providers/claude.mjs tools/agent-loop/providers/laya.mjs tools/agent-loop/providers/index.mjs
```

- [ ] **Step 7: Run the moved tests to verify they pass**

Run: `npx vitest run tests/agent-service-claude-provider.test.mjs tests/agent-service-laya-provider.test.mjs tests/agent-service-provider-selection.test.mjs`
Expected: PASS (all three files, same assertions as before, just a new import path)

- [ ] **Step 8: Commit**

```bash
git add tools/agent-service tools/agent-loop tests/agent-service-claude-provider.test.mjs tests/agent-service-laya-provider.test.mjs tests/agent-service-provider-selection.test.mjs
git commit -m "Move agent-loop provider adapters to tools/agent-service"
```

---

## Task 2: Hosted service HTTP server scaffolding — health check and auth

**Files:**
- Create: `tools/agent-service/server.mjs`
- Create: `tools/agent-service/entrypoint.mjs`
- Test: `tests/agent-service-server.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks yet (this task only builds routing/auth scaffolding)
- Produces: `createServer({ apiKey }): http.Server` — an unstarted `node:http` server instance a caller `.listen(port)`s. Later tasks (3, 4) extend the request handler this creates. Also produces a runnable `entrypoint.mjs` so the service can actually be started locally (`node tools/agent-service/entrypoint.mjs`) for the live-verification steps Tasks 6, 8, and 9 need — Docker packaging around it comes later in Task 11, but the plan doesn't make you wait until then just to run the thing.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../tools/agent-service/server.mjs';

describe('agent-service server', () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    server = createServer({ apiKey: 'test-key' });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('GET /v1/health returns 200 with no auth required', async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('rejects a protected route with 401 when the Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with 401 when the bearer token is wrong', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key' },
      body: '{}'
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/v1/nonexistent`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-server.test.mjs`
Expected: FAIL with "Cannot find module '../tools/agent-service/server.mjs'" (or similar — the module doesn't exist yet)

- [ ] **Step 3: Write the minimal implementation**

```js
import { createServer as createHttpServer } from "node:http";

const PROTECTED_ROUTES = new Set(["/v1/combat-decision", "/v1/flavor-customization"]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req, apiKey) {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${apiKey}`;
}

/** Creates an unstarted node:http server. `apiKey` is the single shared
 * bearer-token secret this GM's Foundry client authenticates with — see
 * the design spec's "Deployment and ownership model" for why one secret
 * per self-hosted instance is sufficient (no multi-tenant isolation
 * needed). Routes are registered here in Task 2 (health, auth gate) and
 * extended by Task 3 (/v1/combat-decision) and Task 4
 * (/v1/flavor-customization). */
export function createServer({ apiKey }) {
  return createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (PROTECTED_ROUTES.has(req.url) && req.method === "POST") {
      if (!isAuthorized(req, apiKey)) return sendJson(res, 401, { error: "unauthorized" });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      // Route-specific handling added in Task 3 / Task 4.
      return sendJson(res, 501, { error: "not implemented" });
    }

    return sendJson(res, 404, { error: "not found" });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-server.test.mjs`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Write `tools/agent-service/entrypoint.mjs`**

```js
#!/usr/bin/env node
import { createServer } from "./server.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const PORT = Number(readEnvOrDotenv("PORT") ?? 8787);
const apiKey = readEnvOrDotenv("AGENT_SERVICE_API_KEY");
if (!apiKey) {
  console.error("agent-service: AGENT_SERVICE_API_KEY must be set — refusing to start unauthenticated.");
  process.exit(1);
}

const server = createServer({ apiKey });
server.listen(PORT, () => {
  console.log(`agent-service: listening on :${PORT}`);
});
```

- [ ] **Step 6: Verify it starts and serves `/v1/health` locally**

Run: `AGENT_SERVICE_API_KEY=test node tools/agent-service/entrypoint.mjs &` then `curl -s localhost:8787/v1/health`
Expected: `{"ok":true}`. Stop the background process afterward (`kill %1`).

- [ ] **Step 7: Commit**

```bash
git add tools/agent-service/server.mjs tools/agent-service/entrypoint.mjs tests/agent-service-server.test.mjs
git commit -m "Add agent-service HTTP server scaffolding with health check and bearer auth"
```

---

## Task 3: `POST /v1/combat-decision` endpoint

**Files:**
- Modify: `tools/agent-service/server.mjs`
- Test: `tests/agent-service-server.test.mjs`

**Interfaces:**
- Consumes: `resolveProvider(name?)` from `tools/agent-service/providers/index.mjs` (Task 1), `readEnvOrDotenv` from `tools/agent-service/env.mjs` (Task 1)
- Produces: `POST /v1/combat-decision` — request body `{ self, opponents, candidates, roundNumber, actorProfile? }`, response `{ candidateId, rationale? }` on success, `{ error }` with a 4xx/5xx status on failure. This is the contract `scripts/agent-service-client.mjs` (Task 5) calls.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent-service-server.test.mjs`:

```js
describe('POST /v1/combat-decision', () => {
  let server;
  let baseUrl;
  const originalProvider = process.env.PF2EDC_AGENT_PROVIDER;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.PF2EDC_AGENT_PROVIDER = 'claude';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    server = createServer({ apiKey: 'test-key' });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (originalProvider === undefined) delete process.env.PF2EDC_AGENT_PROVIDER;
    else process.env.PF2EDC_AGENT_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('returns 400 when candidates is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ self: {}, opponents: [], roundNumber: 1 })
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 with a clear error when the upstream provider fails', async () => {
    // No real Anthropic call happens in this test: PF2EDC_AGENT_PROVIDER
    // resolves to the real claude.mjs decide(), which reads
    // ANTHROPIC_API_KEY from the environment set in beforeEach and calls
    // the real https://api.anthropic.com endpoint via the real global
    // fetch — that call fails in this sandboxed test environment (no
    // network access / invalid key), which is exactly the failure path
    // this test wants to exercise: a real upstream failure surfacing as a
    // clean 502, not an unhandled rejection or a hung request.
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        self: { name: 'Yamaraj', hp: 40, conditions: [] },
        opponents: [],
        candidates: [{ id: 'endTurn', summary: 'End turn' }],
        roundNumber: 1
      })
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-server.test.mjs`
Expected: FAIL — both new tests get `501 not implemented` instead of `400`/`502`

- [ ] **Step 3: Implement the route**

Replace the `// Route-specific handling added in Task 3 / Task 4.` line in `tools/agent-service/server.mjs` with:

```js
      if (req.url === "/v1/combat-decision") {
        return handleCombatDecision(body, res);
      }
      if (req.url === "/v1/flavor-customization") {
        return sendJson(res, 501, { error: "not implemented" }); // Task 4
      }
```

Add near the top of the file (after imports):

```js
import { resolveProvider } from "./providers/index.mjs";

function isValidCombatDecisionBody(body) {
  return (
    body &&
    typeof body === "object" &&
    Array.isArray(body.candidates) &&
    body.candidates.length > 0
  );
}

async function handleCombatDecision(body, res) {
  if (!isValidCombatDecisionBody(body)) {
    return sendJson(res, 400, { error: "combat-decision: candidates is required and must be non-empty" });
  }
  let decide;
  try {
    decide = resolveProvider();
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
  try {
    const decision = await decide(body);
    return sendJson(res, 200, decision);
  } catch (err) {
    return sendJson(res, 502, { error: `combat-decision: provider call failed: ${err.message}` });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-server.test.mjs`
Expected: PASS (all tests, including the pre-existing ones from Task 2)

- [ ] **Step 5: Commit**

```bash
git add tools/agent-service/server.mjs tests/agent-service-server.test.mjs
git commit -m "Add POST /v1/combat-decision to agent-service"
```

---

## Task 4: `POST /v1/flavor-customization` endpoint and Claude-based content generator

**Files:**
- Create: `tools/agent-service/customization-generator.mjs`
- Modify: `tools/agent-service/server.mjs`
- Test: `tests/agent-service-customization-generator.test.mjs`
- Test: `tests/agent-service-server.test.mjs`

**Interfaces:**
- Consumes: `readEnvOrDotenv` from `tools/agent-service/env.mjs` (Task 1)
- Produces: `generateCustomization(kind, context, opts?): Promise<object>` from `tools/agent-service/customization-generator.mjs`, where `kind` is one of `"trap" | "skill_challenge" | "puzzle" | "narrative"` and the resolved object's shape matches the corresponding `submit_*_customization` payload in the retired `tools/agent-loop/mcp-server.mjs` (trap: `{name, description}`; skill_challenge: `{name, summary, skillFlavor}`; puzzle: `{name, summary, playerDescription, stageFlavor}`; narrative: `{name, summary, revealText?, npcName?, npcHook?, options?, suggestedObjective?}`).
- Produces: `POST /v1/flavor-customization` — request body `{ kind, ...context }`, response is the generated object above.

- [ ] **Step 1: Write the failing test for the generator**

```js
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('ENOENT: no such file'); }
}));

const { generateCustomization } = await import('../tools/agent-service/customization-generator.mjs');

function fakeClaudeFetch(toolInput) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'customize', input: toolInput }]
    })
  });
}

describe('generateCustomization', () => {
  it('generates a trap name and description', async () => {
    const fetchImpl = fakeClaudeFetch({ name: 'The Weeping Door', description: 'A door that drips illusory blood.' });
    const result = await generateCustomization(
      'trap',
      { actorId: 'actor1', trapLevel: 3, partyLevel: 2 },
      { apiKey: 'test-key', fetchImpl }
    );
    expect(result).toEqual({ name: 'The Weeping Door', description: 'A door that drips illusory blood.' });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].input_schema.required).toEqual(['name', 'description']);
  });

  it('generates skill-challenge flavor scoped to skillFlavor only', async () => {
    const fetchImpl = fakeClaudeFetch({
      name: 'The Silent Vault',
      summary: 'A vault sealed by an old ward.',
      skillFlavor: { athletics: 'Force the ward apart.', arcana: 'Unweave the ward.' }
    });
    const result = await generateCustomization(
      'skill_challenge',
      { sceneId: 's1', roomId: 'r1', specialtySkills: ['athletics', 'arcana'], locationTag: 'vault' },
      { apiKey: 'test-key', fetchImpl }
    );
    expect(result.skillFlavor).toEqual({ athletics: 'Force the ward apart.', arcana: 'Unweave the ward.' });
  });

  it('generates narrative content scoped to the entry\'s own archetype fields', async () => {
    const fetchImpl = fakeClaudeFetch({
      name: 'A Fork in the Tunnel',
      summary: 'Two passages, one choice.',
      options: [
        { label: 'Take the low path', consequence: 'Faster, riskier.' },
        { label: 'Take the high path', consequence: 'Slower, safer.' }
      ]
    });
    const result = await generateCustomization(
      'narrative',
      { sceneId: 's1', roomId: 'r1', archetype: 'choice' },
      { apiKey: 'test-key', fetchImpl }
    );
    expect(result.options).toHaveLength(2);
    expect(result.revealText).toBeUndefined();
  });

  it('throws a clear error when Claude returns no tool_use block', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [] }) });
    await expect(
      generateCustomization('trap', { actorId: 'actor1', trapLevel: 1, partyLevel: 1 }, { apiKey: 'test-key', fetchImpl })
    ).rejects.toThrow(/no customize tool call/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-customization-generator.test.mjs`
Expected: FAIL with "Cannot find module '../tools/agent-service/customization-generator.mjs'"

- [ ] **Step 3: Write the implementation**

```js
import { readEnvOrDotenv } from "./env.mjs";

const CLAUDE_MODEL = "claude-sonnet-5";

const SCHEMAS = {
  trap: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
    },
    required: ["name", "description"],
  },
  skill_challenge: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      skillFlavor: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["name", "summary", "skillFlavor"],
  },
  puzzle: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      playerDescription: { type: "string" },
      stageFlavor: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["name", "summary", "playerDescription", "stageFlavor"],
  },
  narrative: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      revealText: { type: "string" },
      npcName: { type: "string" },
      npcHook: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, consequence: { type: "string" } },
          required: ["label", "consequence"],
        },
        minItems: 2,
        maxItems: 2,
      },
      suggestedObjective: { type: "string" },
    },
    required: ["name", "summary"],
  },
};

/** Never changes gameplay values — only name/description/summary/flavor
 * text, mirroring the field-scoping rules tools/agent-loop/mcp-server.mjs's
 * submit_*_customization tools already enforced. `kind` selects which of
 * the four schemas is offered; the model can only fill fields real for
 * that kind. */
export async function generateCustomization(
  kind,
  context,
  { apiKey = readEnvOrDotenv("ANTHROPIC_API_KEY"), fetchImpl = fetch } = {},
) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`customization-generator: unknown kind "${kind}"`);

  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      tools: [
        {
          name: "customize",
          description: `Write flavor text for a Pathfinder 2e dungeon ${kind.replace("_", " ")}. Never invent mechanics — only name/description/summary/flavor text.`,
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "customize" },
      messages: [
        {
          role: "user",
          content: `Write fitting flavor text for this ${kind.replace("_", " ")}, matching its mechanical context. Only fill fields that make sense for this entry.\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`customization-generator: API request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const toolUse = payload.content?.find((c) => c.type === "tool_use" && c.name === "customize");
  if (!toolUse) throw new Error("customization-generator: no customize tool call in response");
  return toolUse.input;
}
```

- [ ] **Step 4: Run test to verify the generator passes**

Run: `npx vitest run tests/agent-service-customization-generator.test.mjs`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Write the failing test for the HTTP route**

Add to `tests/agent-service-server.test.mjs`:

```js
describe('POST /v1/flavor-customization', () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    server = createServer({ apiKey: 'test-key' });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns 400 when kind is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/flavor-customization`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'a1' })
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown kind', async () => {
    const res = await fetch(`${baseUrl}/v1/flavor-customization`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'not-a-real-kind' })
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-server.test.mjs`
Expected: FAIL — both new tests get `501 not implemented` instead of `400`

- [ ] **Step 7: Wire the route**

In `tools/agent-service/server.mjs`, add the import:

```js
import { generateCustomization } from "./customization-generator.mjs";
```

Replace the Task 4 placeholder line with:

```js
      if (req.url === "/v1/flavor-customization") {
        return handleFlavorCustomization(body, res);
      }
```

Add the handler function:

```js
const KNOWN_KINDS = new Set(["trap", "skill_challenge", "puzzle", "narrative"]);

async function handleFlavorCustomization(body, res) {
  const { kind, ...context } = body ?? {};
  if (!KNOWN_KINDS.has(kind)) {
    return sendJson(res, 400, { error: `flavor-customization: kind must be one of ${[...KNOWN_KINDS].join(", ")}` });
  }
  try {
    const result = await generateCustomization(kind, context);
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 502, { error: `flavor-customization: generation failed: ${err.message}` });
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-server.test.mjs`
Expected: PASS (all tests in the file)

- [ ] **Step 9: Commit**

```bash
git add tools/agent-service/customization-generator.mjs tools/agent-service/server.mjs tests/agent-service-customization-generator.test.mjs tests/agent-service-server.test.mjs
git commit -m "Add POST /v1/flavor-customization and Claude-based content generator"
```

---

## Task 5: Foundry-side fetch client (`scripts/agent-service-client.mjs`)

**Files:**
- Create: `scripts/agent-service-client.mjs`
- Test: `tests/agent-service-client.test.mjs`

**Interfaces:**
- Consumes: nothing from other in-repo modules (pure HTTP wrapper)
- Produces: `fetchCombatDecision({ baseUrl, apiKey, context, fetchImpl? }): Promise<{candidateId, rationale?}>` and `fetchFlavorCustomization({ baseUrl, apiKey, kind, context, fetchImpl? }): Promise<object>`, both consumed by Task 7 and Task 9.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest';
import { fetchCombatDecision, fetchFlavorCustomization } from '../scripts/agent-service-client.mjs';

function fakeFetch(status, body) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
}

describe('agent-service-client', () => {
  it('fetchCombatDecision POSTs the context to /v1/combat-decision with a bearer token', async () => {
    const fetchImpl = fakeFetch(200, { candidateId: 'endTurn', rationale: 'Nothing worth doing.' });
    const context = { self: {}, opponents: [], candidates: [{ id: 'endTurn' }], roundNumber: 1 };
    const result = await fetchCombatDecision({ baseUrl: 'https://agent.example', apiKey: 'k', context, fetchImpl });

    expect(result).toEqual({ candidateId: 'endTurn', rationale: 'Nothing worth doing.' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example/v1/combat-decision');
    expect(options.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(options.body)).toEqual(context);
  });

  it('fetchCombatDecision throws with the response status and error on a non-ok response', async () => {
    const fetchImpl = fakeFetch(502, { error: 'provider call failed: boom' });
    await expect(
      fetchCombatDecision({ baseUrl: 'https://agent.example', apiKey: 'k', context: {}, fetchImpl })
    ).rejects.toThrow(/502.*boom/s);
  });

  it('fetchFlavorCustomization POSTs kind plus context to /v1/flavor-customization', async () => {
    const fetchImpl = fakeFetch(200, { name: 'The Weeping Door', description: 'Drips illusory blood.' });
    const result = await fetchFlavorCustomization({
      baseUrl: 'https://agent.example',
      apiKey: 'k',
      kind: 'trap',
      context: { actorId: 'a1' },
      fetchImpl
    });

    expect(result).toEqual({ name: 'The Weeping Door', description: 'Drips illusory blood.' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example/v1/flavor-customization');
    expect(JSON.parse(options.body)).toEqual({ kind: 'trap', actorId: 'a1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-service-client.test.mjs`
Expected: FAIL with "Cannot find module '../scripts/agent-service-client.mjs'"

- [ ] **Step 3: Write the implementation**

```js
/**
 * Thin fetch wrapper Foundry's own client-side module code calls directly
 * against a GM's self-hosted tools/agent-service instance — replaces the
 * old foundry-rest relay round trip poll.mjs/mcp-server.mjs used to reach
 * an external process. No Foundry API access here; this file only talks
 * HTTP to the hosted service.
 */

async function postJson(baseUrl, path, body, { apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`agent-service-client: ${path} failed (${res.status}): ${payload?.error ?? "unknown error"}`);
  }
  return payload;
}

export async function fetchCombatDecision({ baseUrl, apiKey, context, fetchImpl }) {
  return postJson(baseUrl, "/v1/combat-decision", context, { apiKey, fetchImpl });
}

export async function fetchFlavorCustomization({ baseUrl, apiKey, kind, context, fetchImpl }) {
  return postJson(baseUrl, "/v1/flavor-customization", { kind, ...context }, { apiKey, fetchImpl });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-service-client.test.mjs`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-service-client.mjs tests/agent-service-client.test.mjs
git commit -m "Add Foundry-side agent-service fetch client"
```

---

## Task 6: Foundry module settings for the hosted service

**Files:**
- Modify: `scripts/module.mjs` (the `Hooks.once("init", ...)` block, currently registering `dungeonRuns` and `agentLoopHeartbeat`)
- Modify: `lang/en.json`

**Interfaces:**
- Produces: two new world-scope Foundry settings, `agentServiceUrl` (string) and `agentServiceApiKey` (string), read by Task 7 and Task 9 via `game.settings.get(MODULE_ID, "agentServiceUrl")`/`"agentServiceApiKey"`.
- Removes: the `agentLoopHeartbeat` setting (no longer meaningful once there's no external poller to heartbeat — see Task 8, which removes the code that read/wrote it).

**No vitest test for this task.** `scripts/module.mjs` runs `Hooks.once("init", ...)`/`Hooks.once("ready", ...)` at module top level against the real Foundry `game`/`Hooks` globals — confirmed by `grep -rl "scripts/module" tests/*.test.mjs` returning no matches, unlike `dungeon-combat.mjs` (which only ever touches `game`/`ChatMessage` inside function bodies, never at import time, which is exactly what makes it unit-testable). This repo's own established convention for this kind of Foundry-wiring code (see the original combat-AI design doc's Testing section) is to live-verify it via the `foundry-rest` skill rather than force an artificial unit-test harness onto code that was never structured for one. Restructuring `module.mjs` to be unit-testable is a larger, unrelated change this plan doesn't take on (writing-plans' guidance: follow established patterns, don't unilaterally restructure).

- [ ] **Step 1: Update the settings registration**

In `scripts/module.mjs`'s `Hooks.once("init", ...)` block, remove the `agentLoopHeartbeat` registration and add:

```js
  game.settings.register(MODULE_ID, "agentServiceUrl", {
    name: "PF2EDC.Settings.AgentServiceUrlLabel",
    hint: "PF2EDC.Settings.AgentServiceUrlHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "agentServiceApiKey", {
    name: "PF2EDC.Settings.AgentServiceApiKeyLabel",
    hint: "PF2EDC.Settings.AgentServiceApiKeyHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
```

Read `lang/en.json` and add `PF2EDC.Settings.AgentServiceUrlLabel`, `PF2EDC.Settings.AgentServiceUrlHint`, `PF2EDC.Settings.AgentServiceApiKeyLabel`, `PF2EDC.Settings.AgentServiceApiKeyHint` in the same place/nesting this module's other setting-label keys already live (if no `PF2EDC.Settings.*` group exists yet, add one at the same nesting depth as `PF2EDC.Dungeon`). Use concrete GM-facing copy, e.g.:
- `AgentServiceUrlLabel`: "Agent Service URL"
- `AgentServiceUrlHint`: "Base URL of your self-hosted tools/agent-service instance (e.g. https://agent.yourdomain.com)."
- `AgentServiceApiKeyLabel`: "Agent Service API Key"
- `AgentServiceApiKeyHint`: "The bearer token your agent-service deployment was started with (AGENT_SERVICE_API_KEY)."

- [ ] **Step 2: Run the existing test suite to confirm nothing else references the removed setting**

Run: `grep -rln "agentLoopHeartbeat" scripts/ tests/`
Expected: only `scripts/dungeon-combat.mjs`'s `agentLoopStatus()` (removed in Task 7) — no test file references it, confirming this task's change is safe.

- [ ] **Step 3: Live-verify via `foundry-rest`**

Using the `foundry-rest` skill against a running dev world with this change loaded: confirm `game.settings.get('pf2e-dungeon-crawl', 'agentServiceUrl')` returns `""` (the default) and that "Agent Service URL"/"Agent Service API Key" both appear in this module's entry in Foundry's Configure Settings dialog.

- [ ] **Step 4: Commit**

```bash
git add scripts/module.mjs lang/en.json
git commit -m "Add Foundry settings for the hosted agent service, remove agentLoopHeartbeat"
```

---

## Task 7: Combat decision loop — wire `dungeon-combat.mjs` to the hosted service

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`autoPlayCombatantTurnIfDue`, `armAgentTimeout`; removes `agentLoopStatus`, `HEARTBEAT_STALE_MULTIPLE`, `HEARTBEAT_STALE_FALLBACK_MS`)
- Test: `tests/dungeon-combat-agent-service-loop.test.mjs`

**Interfaces:**
- Consumes: `fetchCombatDecision` from `scripts/agent-service-client.mjs` (Task 5); `getPendingAgentTurn(combat)` and `applyAgentDecision(combat, combatantId, candidateId, rationale)` (both already exist, unchanged, exported by `scripts/dungeon-combat.mjs` itself).
- Produces: `runAgentDecisionLoop(combat, combatant, deps?): Promise<void>` — new exported function, called from `autoPlayCombatantTurnIfDue` alongside the existing `armAgentTimeout` call. `deps` (`{ fetchDecision, getPending, applyDecision }`, each defaulting to the real `fetchCombatDecision`/`getPendingAgentTurn`/`applyAgentDecision`) is injectable purely so this task's test can exercise the loop logic without constructing a full `Combat`/`Scene` fixture — the same default-parameter dependency-injection idiom this codebase already uses for `fetchImpl` throughout `tools/agent-service/providers/`. Production code never passes `deps`. Not awaited by its caller (fire-and-forget, same style as the existing `armAgentTimeout(combat, combatant)` call it sits beside), so it races the timeout exactly the way the old external poller used to.

- [ ] **Step 1: Write the failing test**

Create `tests/dungeon-combat-agent-service-loop.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runAgentDecisionLoop } from '../scripts/dungeon-combat.mjs';

function installGameStub({ agentServiceUrl = 'https://agent.example', agentServiceApiKey = 'test-key' } = {}) {
  globalThis.game = {
    settings: {
      get: (_moduleId, key) => ({ agentServiceUrl, agentServiceApiKey })[key],
    },
  };
}

describe('runAgentDecisionLoop', () => {
  const combat = { id: 'combat-1' };
  const combatant = { id: 'atk' };

  it('calls fetchDecision then applyDecision with the decided candidateId, looping until the turn ends', async () => {
    installGameStub();
    const pendingTurn = {
      combatId: 'combat-1',
      combatantId: 'atk',
      context: { self: {}, opponents: [], candidates: [], roundNumber: 1 },
      candidates: [],
    };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn', rationale: 'Nothing worth doing.' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(fetchDecision).toHaveBeenCalledWith({
      baseUrl: 'https://agent.example',
      apiKey: 'test-key',
      context: pendingTurn.context,
    });
    expect(applyDecision).toHaveBeenCalledWith(combat, 'atk', 'endTurn', 'Nothing worth doing.');
  });

  it('loops again when actions remain, stopping once applyDecision returns null', async () => {
    installGameStub();
    const firstPending = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [], roundNumber: 1 }, candidates: [] };
    const secondPending = { ...firstPending, context: { candidates: [], roundNumber: 2 } };
    const getPending = vi.fn().mockResolvedValue(firstPending);
    const fetchDecision = vi
      .fn()
      .mockResolvedValueOnce({ candidateId: 'stride:approach:opp1' })
      .mockResolvedValueOnce({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValueOnce(secondPending).mockResolvedValueOnce(null);

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(fetchDecision).toHaveBeenCalledTimes(2);
    expect(applyDecision).toHaveBeenNthCalledWith(2, combat, 'atk', 'endTurn', undefined);
  });

  it('does nothing (never calls getPending or fetchDecision) when agentServiceUrl is not configured', async () => {
    installGameStub({ agentServiceUrl: '' });
    const getPending = vi.fn();
    const fetchDecision = vi.fn();
    const applyDecision = vi.fn();

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(getPending).not.toHaveBeenCalled();
    expect(fetchDecision).not.toHaveBeenCalled();
  });

  it('stops without throwing when fetchDecision rejects, leaving applyDecision uncalled', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockRejectedValue(new Error('network error'));
    const applyDecision = vi.fn();

    await expect(
      runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision }),
    ).resolves.toBeUndefined();
    expect(applyDecision).not.toHaveBeenCalled();
  });

  it('stops without throwing when applyDecision rejects', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-combat-agent-service-loop.test.mjs`
Expected: FAIL — `runAgentDecisionLoop` is not exported yet.

- [ ] **Step 3: Implement `runAgentDecisionLoop`**

Add to `scripts/dungeon-combat.mjs`, near `armAgentTimeout` (both are part of "Task 3: external agent-controlled turn decisions"):

```js
import { fetchCombatDecision } from "./agent-service-client.mjs";

/**
 * Replaces tools/agent-loop/poll.mjs's external decide-apply loop: calls
 * the GM's configured hosted agent service directly and applies whatever
 * it decides, in-process, using the same getPendingAgentTurn/
 * applyAgentDecision this file already exposes on module.api. Runs
 * alongside armAgentTimeout (not instead of it) — armAgentTimeout is the
 * only thing that ever falls back to the heuristic, so a rejected fetch,
 * an unconfigured service, or a slow response all resolve the same way
 * they already do today: silently, letting the timeout's existing
 * warning/fallback fire. `deps` is test-only dependency injection (see
 * this task's own test) — production callers never pass it.
 */
export async function runAgentDecisionLoop(
  combat,
  combatant,
  {
    fetchDecision = fetchCombatDecision,
    getPending = getPendingAgentTurn,
    applyDecision = applyAgentDecision,
  } = {},
) {
  const baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  const apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  if (!baseUrl) return;

  let pending = await getPending(combat);
  while (pending) {
    let decision;
    try {
      decision = await fetchDecision({ baseUrl, apiKey, context: pending.context });
    } catch (err) {
      console.error("agent-service: combat-decision call failed:", err.message);
      return;
    }
    try {
      pending = await applyDecision(
        combat,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
      );
    } catch (err) {
      console.error("agent-service: applyAgentDecision failed:", err.message);
      return;
    }
  }
}
```

Wire it into `autoPlayCombatantTurnIfDue` (around line 2366-2372), alongside the existing timeout arm:

```js
  if (combatant.getFlag(MODULE_ID, "agentControlled")) {
    armAgentTimeout(combat, combatant);
    runAgentDecisionLoop(combat, combatant);
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-combat-agent-service-loop.test.mjs`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Remove the now-obsolete heartbeat/connected-status branching in `armAgentTimeout`**

There is no longer a separate process to heartbeat once `poll.mjs` is deleted (Task 10) — `agentLoopStatus()`'s "connected"/"stale"/"never seen" distinction (#113) was answering "is the external poller alive," which is meaningless once decisions are made synchronously in-module. In `scripts/dungeon-combat.mjs`:

- Delete `agentLoopStatus()`, `HEARTBEAT_STALE_MULTIPLE`, `HEARTBEAT_STALE_FALLBACK_MS`.
- In `armAgentTimeout`, replace:

```js
  const { connected } = agentLoopStatus();
  const warningKey = connected
    ? "PF2EDC.Dungeon.Combat.AgentTimeoutWarning"
    : "PF2EDC.Dungeon.Combat.AgentTimeoutWarningDisconnected";
  const chatKey = connected
    ? "PF2EDC.Dungeon.Combat.AgentTimeoutChat"
    : "PF2EDC.Dungeon.Combat.AgentTimeoutChatDisconnected";
```

  with:

```js
  const warningKey = "PF2EDC.Dungeon.Combat.AgentTimeoutWarning";
  const chatKey = "PF2EDC.Dungeon.Combat.AgentTimeoutChat";
```

- In `lang/en.json`, remove the now-unused `PF2EDC.Dungeon.Combat.AgentTimeoutWarningDisconnected` and `PF2EDC.Dungeon.Combat.AgentTimeoutChatDisconnected` keys; keep `AgentTimeoutWarning`/`AgentTimeoutChat` as the single message for both cases.
- Run: `npx vitest run tests/dungeon-combat-agent-service-loop.test.mjs` and any pre-existing test file covering `armAgentTimeout`'s warning-message keys (found via `grep -rl "AgentTimeoutWarning\|AgentLoopStatus" tests/*.test.mjs`) — update any assertion in those files that expects the disconnected-variant keys, since they no longer exist.
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs lang/en.json tests/dungeon-combat-agent-service-loop.test.mjs
git commit -m "Wire combat-turn decisions to the hosted agent service, retire poller heartbeat status"
```

---

## Task 8: `module.mjs` API cleanup — remove heartbeat API, repurpose the status button as a health check

**Files:**
- Modify: `scripts/module.mjs` (the `api` object and the `getSceneControlButtons` hook)
- Modify: `lang/en.json`

**Interfaces:**
- Removes: `api.recordAgentLoopHeartbeat`, `api.getAgentLoopStatus` (no longer meaningful — see Task 7).
- Modifies: `api.postAgentLoopStatus` now pings the configured hosted service's `GET /v1/health` (via a plain `fetch`, not `agent-service-client.mjs`, since health checks need no auth or JSON body) instead of reading the old heartbeat setting, and whispers the GM a reachable/unreachable chat message. Keeps the existing scene-control robot-icon button meaningful rather than deleting the feature (#113's original intent — "let a GM check status without watching a terminal" — still applies, just against the hosted service instead of a local poller).

**No vitest test for this task**, for the same reason as Task 6: `scripts/module.mjs`'s `api` object is built inside `Hooks.once("ready", ...)`, which — like the `Hooks.once("init", ...)` block Task 6 touches — runs against the real Foundry globals at module load time and is never imported by this repo's test suite (`grep -rl "scripts/module" tests/*.test.mjs` returns no matches). Verified live via `foundry-rest` instead, consistent with this repo's existing precedent for Foundry-wiring code.

- [ ] **Step 1: Update `scripts/module.mjs`**

Remove the `recordAgentLoopHeartbeat` and `getAgentLoopStatus` entries from the `api` object (see the excerpt at lines ~121-139 in the current file). Replace `postAgentLoopStatus` with:

```js
    postAgentLoopStatus: async () => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      const baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
      let reachable = false;
      if (baseUrl) {
        try {
          const res = await fetch(`${baseUrl}/v1/health`);
          reachable = res.ok;
        } catch {
          reachable = false;
        }
      }
      const key = !baseUrl
        ? "PF2EDC.Dungeon.Combat.AgentServiceStatusNotConfigured"
        : reachable
          ? "PF2EDC.Dungeon.Combat.AgentServiceStatusReachable"
          : "PF2EDC.Dungeon.Combat.AgentServiceStatusUnreachable";
      const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      return ChatMessage.create({ content: game.i18n.localize(key), whisper: gmIds });
    },
```

Also remove the now-unused `agentLoopStatus` import from the top of `scripts/module.mjs` (it was removed from `dungeon-combat.mjs` in Task 7).

In `lang/en.json`, remove `PF2EDC.Dungeon.Combat.AgentLoopStatusConnected`/`AgentLoopStatusStale`/`AgentLoopStatusNeverSeen`, and add:
- `PF2EDC.Dungeon.Combat.AgentServiceStatusReachable`: "Agent service: reachable."
- `PF2EDC.Dungeon.Combat.AgentServiceStatusUnreachable`: "Agent service: unreachable — check it's running and your URL/key settings."
- `PF2EDC.Dungeon.Combat.AgentServiceStatusNotConfigured`: "Agent service: not configured — set the Agent Service URL/API Key in module settings."

- [ ] **Step 2: Run the existing test suite for regressions**

Run: `grep -rln "AgentLoopStatusConnected\|AgentLoopStatusStale\|AgentLoopStatusNeverSeen\|recordAgentLoopHeartbeat\|getAgentLoopStatus" scripts/ tests/`
Expected: no matches anywhere — confirms nothing else (including any test file) still depends on the removed keys/API methods.

- [ ] **Step 3: Live-verify via `foundry-rest`**

Using the `foundry-rest` skill against a running dev world with this change loaded, and a `tools/agent-service` instance running locally (Task 11) with a matching `agentServiceUrl`/`agentServiceApiKey` configured: run `game.modules.get('pf2e-dungeon-crawl').api.postAgentLoopStatus()` and confirm a GM-whispered chat message appears with the "reachable" text. Stop the local service and repeat — confirm the "unreachable" text appears instead, with no thrown error.

- [ ] **Step 4: Commit**

```bash
git add scripts/module.mjs lang/en.json
git commit -m "Repurpose agent-loop status button as a hosted-service health check"
```

---

## Task 9: Flavor-customization integration — automatic fulfillment on room population

**Files:**
- Create: `scripts/dungeon-customization-fulfillment.mjs`
- Modify: `scripts/ui/dungeon-app.mjs` (`populateNextRoom`, currently at line 733)
- Test: `tests/dungeon-customization-fulfillment.test.mjs`

**Interfaces:**
- Consumes: `fetchFlavorCustomization` from `scripts/agent-service-client.mjs` (Task 5); the existing `getPendingTrapCustomization`/`applyTrapCustomization` (`scripts/trap-combat.mjs`) and `getPendingSkillChallengeCustomization`/`applySkillChallengeCustomization`/`getPendingPuzzleCustomization`/`applyPuzzleCustomization`/`getPendingNarrativeCustomization`/`applyNarrativeCustomization` (`scripts/dungeon-runner.mjs`) — all unchanged.
- Produces: `fulfillPendingCustomizations(sceneId): Promise<void>` — checks all four pending-customization kinds for `sceneId` and, for whichever are pending, fetches and applies generated content. Never throws (catches and logs internally) so callers can invoke it fire-and-forget.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchFlavorCustomization = vi.fn();
vi.mock('../scripts/agent-service-client.mjs', () => ({ fetchFlavorCustomization }));

const getPendingTrapCustomization = vi.fn();
const applyTrapCustomization = vi.fn();
vi.mock('../scripts/trap-combat.mjs', () => ({ getPendingTrapCustomization, applyTrapCustomization }));

const getPendingSkillChallengeCustomization = vi.fn();
const applySkillChallengeCustomization = vi.fn();
const getPendingPuzzleCustomization = vi.fn();
const applyPuzzleCustomization = vi.fn();
const getPendingNarrativeCustomization = vi.fn();
const applyNarrativeCustomization = vi.fn();
vi.mock('../scripts/dungeon-runner.mjs', () => ({
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization
}));

global.game = { settings: { get: vi.fn() } };

const { fulfillPendingCustomizations } = await import('../scripts/dungeon-customization-fulfillment.mjs');

describe('fulfillPendingCustomizations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    game.settings.get.mockImplementation((_module, key) =>
      key === 'agentServiceUrl' ? 'https://agent.example' : 'test-key'
    );
    getPendingSkillChallengeCustomization.mockResolvedValue(null);
    getPendingPuzzleCustomization.mockResolvedValue(null);
    getPendingNarrativeCustomization.mockResolvedValue(null);
  });

  it('fetches and applies a trap customization when one is pending', async () => {
    getPendingTrapCustomization.mockReturnValue({ actorId: 'a1', trapLevel: 3, partyLevel: 2 });
    fetchFlavorCustomization.mockResolvedValue({ name: 'The Weeping Door', description: 'Drips illusory blood.' });

    await fulfillPendingCustomizations('scene1');

    expect(fetchFlavorCustomization).toHaveBeenCalledWith({
      baseUrl: 'https://agent.example',
      apiKey: 'test-key',
      kind: 'trap',
      context: { actorId: 'a1', trapLevel: 3, partyLevel: 2 }
    });
    expect(applyTrapCustomization).toHaveBeenCalledWith('a1', {
      name: 'The Weeping Door',
      description: 'Drips illusory blood.'
    });
  });

  it('does nothing when agentServiceUrl is not configured', async () => {
    game.settings.get.mockReturnValue('');
    getPendingTrapCustomization.mockReturnValue({ actorId: 'a1', trapLevel: 1, partyLevel: 1 });

    await fulfillPendingCustomizations('scene1');

    expect(fetchFlavorCustomization).not.toHaveBeenCalled();
  });

  it('does not throw and leaves the trap unapplied when the fetch fails', async () => {
    getPendingTrapCustomization.mockReturnValue({ actorId: 'a1', trapLevel: 1, partyLevel: 1 });
    fetchFlavorCustomization.mockRejectedValue(new Error('network error'));

    await expect(fulfillPendingCustomizations('scene1')).resolves.toBeUndefined();
    expect(applyTrapCustomization).not.toHaveBeenCalled();
  });

  it('handles multiple pending kinds independently in one call', async () => {
    getPendingTrapCustomization.mockReturnValue({ actorId: 'a1', trapLevel: 1, partyLevel: 1 });
    getPendingSkillChallengeCustomization.mockResolvedValue({ sceneId: 's1', roomId: 'r1', specialtySkills: ['athletics'] });
    fetchFlavorCustomization.mockImplementation(({ kind }) =>
      kind === 'trap'
        ? Promise.resolve({ name: 'Trap Name', description: 'Trap desc.' })
        : Promise.resolve({ name: 'Challenge Name', summary: 'Summary.', skillFlavor: { athletics: 'Flavor.' } })
    );

    await fulfillPendingCustomizations('scene1');

    expect(applyTrapCustomization).toHaveBeenCalledWith('a1', { name: 'Trap Name', description: 'Trap desc.' });
    expect(applySkillChallengeCustomization).toHaveBeenCalledWith('s1', 'r1', {
      name: 'Challenge Name',
      summary: 'Summary.',
      skillFlavor: { athletics: 'Flavor.' }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-customization-fulfillment.test.mjs`
Expected: FAIL with "Cannot find module '../scripts/dungeon-customization-fulfillment.mjs'"

- [ ] **Step 3: Write the implementation**

```js
import { fetchFlavorCustomization } from "./agent-service-client.mjs";
import { getPendingTrapCustomization, applyTrapCustomization } from "./trap-combat.mjs";
import {
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
} from "./dungeon-runner.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

async function fulfillOne(kind, context, apply) {
  const settings = { baseUrl: undefined, apiKey: undefined };
  settings.baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  if (!settings.baseUrl) return;
  settings.apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  try {
    const result = await fetchFlavorCustomization({ ...settings, kind, context });
    await apply(result);
  } catch (err) {
    console.error(`agent-service: ${kind} customization failed, leaving template content:`, err.message);
  }
}

/**
 * Checks all four pending-customization kinds for `sceneId` and fulfills
 * whichever are pending via the hosted agent service — replaces the old
 * interactive-MCP-session flow (an agent connecting to
 * tools/agent-loop/mcp-server.mjs on its own schedule). Called
 * fire-and-forget from populateNextRoom (scripts/ui/dungeon-app.mjs) so it
 * never delays room population or reveal — a failed or slow call just
 * leaves the original template content in place, same as "nothing
 * fulfilled it in time" does today.
 */
export async function fulfillPendingCustomizations(sceneId) {
  const trap = getPendingTrapCustomization(sceneId);
  if (trap) {
    await fulfillOne("trap", trap, (result) => applyTrapCustomization(trap.actorId, result));
  }

  const skillChallenge = await getPendingSkillChallengeCustomization(sceneId);
  if (skillChallenge) {
    await fulfillOne("skill_challenge", skillChallenge, (result) =>
      applySkillChallengeCustomization(skillChallenge.sceneId, skillChallenge.roomId, result),
    );
  }

  const puzzle = await getPendingPuzzleCustomization(sceneId);
  if (puzzle) {
    await fulfillOne("puzzle", puzzle, (result) =>
      applyPuzzleCustomization(puzzle.sceneId, puzzle.roomId, result),
    );
  }

  const narrative = await getPendingNarrativeCustomization(sceneId);
  if (narrative) {
    await fulfillOne("narrative", narrative, (result) =>
      applyNarrativeCustomization(narrative.sceneId, narrative.roomId, result),
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-customization-fulfillment.test.mjs`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Wire it into `populateNextRoom`**

In `scripts/ui/dungeon-app.mjs`, add the import:

```js
import { fulfillPendingCustomizations } from "../dungeon-customization-fulfillment.mjs";
```

In `populateNextRoom` (currently lines 733-766), after the `populateSlotEncounter` call and before the `unlockDoorToSlot` check:

```js
  await populateSlotEncounter(scene, slot, {
    prefillTraits: state.traits,
    prefillExcludeTraits: state.excludeTraits,
    levelOffsetBias: depthBiasFor({
      physicalSlot: slot,
      roomCount: state.rooms.length,
      isGoal: nextRoom.isGoal,
    }),
    locationTag: nextRoom.locationTag,
    seed: state.seed,
  });
  // Fire-and-forget: never awaited, so a slow or failed hosted-service
  // call can't delay the door unlocking below. See
  // dungeon-customization-fulfillment.mjs's own docstring for why this is
  // safe to leave un-awaited.
  fulfillPendingCustomizations(sceneId);
  if (isSlotPopulated(scene, slot)) await unlockDoorToSlot(scene, slot);
```

- [ ] **Step 6: Run the full test suite for this file to check for regressions**

Run: `npx vitest run tests/dungeon-customization-fulfillment.test.mjs && grep -rl "populateNextRoom" tests/*.test.mjs | xargs npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-customization-fulfillment.mjs scripts/ui/dungeon-app.mjs tests/dungeon-customization-fulfillment.test.mjs
git commit -m "Automatically fulfill flavor customization via the hosted agent service on room population"
```

---

## Task 10: Remove the old local-process tooling

**Files:**
- Delete: `tools/agent-loop/poll.mjs`, `tools/agent-loop/mcp-server.mjs`, `tools/agent-loop/watch-pending.mjs`, `tools/agent-loop/foundry-client.mjs`, `tools/agent-loop/README.md`
- Delete: `tests/agent-loop-mcp-server.test.mjs`, `tests/agent-loop-watch-pending.test.mjs`, `tests/agent-loop-foundry-client.test.mjs`
- Delete: `.claude/skills/dungeon-customizations/` (directory)
- Modify: `.mcp.json` (remove the `foundry-agent-bridge` entry)
- Modify: `package.json` (remove `agent-loop`, `agent-loop-watch`, `agent-bridge-mcp` scripts; add `agent-service`)

**Interfaces:** none — this task only deletes now-unused files and references. All production code depending on the removed files was already replaced in Tasks 1-9.

- [ ] **Step 1: Confirm nothing still imports the files being deleted**

Run: `grep -rln "agent-loop/poll\|agent-loop/mcp-server\|agent-loop/watch-pending\|agent-loop/foundry-client" scripts/ tools/ tests/ --include="*.mjs"`
Expected: no matches (Tasks 1-9 already moved everything still needed into `tools/agent-service/`/`scripts/`)

- [ ] **Step 2: Delete the old files**

```bash
rm tools/agent-loop/poll.mjs tools/agent-loop/mcp-server.mjs tools/agent-loop/watch-pending.mjs tools/agent-loop/foundry-client.mjs tools/agent-loop/README.md
rm tests/agent-loop-mcp-server.test.mjs tests/agent-loop-watch-pending.test.mjs tests/agent-loop-foundry-client.test.mjs
rm -rf .claude/skills/dungeon-customizations
rmdir tools/agent-loop 2>/dev/null || true
```

- [ ] **Step 3: Remove the MCP server registration**

In `.mcp.json`, remove the `foundry-agent-bridge` entry. If it was the only entry, `.mcp.json` becomes `{"mcpServers": {}}`.

- [ ] **Step 4: Update `package.json` scripts**

Remove:
```json
    "agent-loop": "node tools/agent-loop/poll.mjs",
    "agent-loop-watch": "node tools/agent-loop/watch-pending.mjs",
    "agent-bridge-mcp": "node tools/agent-loop/mcp-server.mjs",
```

Add:
```json
    "agent-service": "node tools/agent-service/entrypoint.mjs",
```
(`entrypoint.mjs` is created in Task 2, alongside `server.mjs` — see that task for why the runnable entry point exists from early on rather than only after Task 11's Docker packaging.)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no leftover references to the deleted files anywhere in the suite.

- [ ] **Step 6: Commit**

```bash
git add -A tools/agent-loop tests/agent-loop-mcp-server.test.mjs tests/agent-loop-watch-pending.test.mjs tests/agent-loop-foundry-client.test.mjs .claude/skills/dungeon-customizations .mcp.json package.json
git commit -m "Remove the local-process agent-loop tooling, superseded by tools/agent-service"
```

---

## Task 11: Deployment packaging for `tools/agent-service`

**Files:**
- Create: `tools/agent-service/Dockerfile`
- Create: `tools/agent-service/docker-compose.yml`

**Interfaces:**
- Consumes: `tools/agent-service/entrypoint.mjs` (created in Task 2, already runnable via `npm run agent-service` per Task 10)
- Produces: a runnable container image and compose file a GM deploys, wrapping the entry point that already exists.

- [ ] **Step 1: Write `tools/agent-service/Dockerfile`**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY tools/agent-service ./tools/agent-service
COPY package.json ./
EXPOSE 8787
CMD ["node", "tools/agent-service/entrypoint.mjs"]
```

- [ ] **Step 2: Write `tools/agent-service/docker-compose.yml`**

```yaml
services:
  agent-service:
    build:
      context: ../..
      dockerfile: tools/agent-service/Dockerfile
    ports:
      - "8787:8787"
    environment:
      AGENT_SERVICE_API_KEY: ${AGENT_SERVICE_API_KEY}
      PF2EDC_AGENT_PROVIDER: ${PF2EDC_AGENT_PROVIDER:-claude}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      LAYA_API_KEY: ${LAYA_API_KEY}
      LAYA_BASE_URL: ${LAYA_BASE_URL}
    restart: unless-stopped
```

- [ ] **Step 3: Validate the compose file and, if Docker is available, build and run the image**

Run: `docker compose -f tools/agent-service/docker-compose.yml config` — Expected: valid, resolved YAML printed, no errors (this alone catches most authoring mistakes without needing a working Docker daemon).

If a Docker daemon is available in this environment: `AGENT_SERVICE_API_KEY=test docker compose -f tools/agent-service/docker-compose.yml up --build -d`, then `curl -s localhost:8787/v1/health` — Expected: `{"ok":true}`. Then `docker compose -f tools/agent-service/docker-compose.yml down`. If no Docker daemon is available in this environment, skip the build/run check and note that in the commit message body — the `node tools/agent-service/entrypoint.mjs` check from Task 2 already verified the underlying server works; this step only additionally verifies the Docker packaging around it.

- [ ] **Step 4: Commit**

```bash
git add tools/agent-service/Dockerfile tools/agent-service/docker-compose.yml
git commit -m "Add deployment packaging for tools/agent-service"
```

---

## Task 12: Documentation — `tools/agent-service/README.md`

**Files:**
- Create: `tools/agent-service/README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the README**

Cover, in this order (matching the retired `tools/agent-loop/README.md`'s structure of setup → env vars → run → status-checking → troubleshooting):

1. **What this replaces:** one paragraph pointing at `docs/superpowers/specs/2026-09-22-hosted-agent-service-design.md` for the full design, and noting this retires `poll.mjs`/`mcp-server.mjs`/the `foundryvtt-rest-api` relay entirely.
2. **Deploy the service:** `docker compose -f tools/agent-service/docker-compose.yml up -d` from the repo root, with a `.env` (or shell env) providing `AGENT_SERVICE_API_KEY` (a secret you generate, e.g. `openssl rand -hex 32`), `ANTHROPIC_API_KEY`, and optionally `PF2EDC_AGENT_PROVIDER=laya`/`LAYA_API_KEY`/`LAYA_BASE_URL`.
3. **Configure Foundry:** open this module's settings, set **Agent Service URL** to wherever the deployed service is reachable (e.g. `https://agent.yourdomain.com` if reverse-proxied, or `http://<host-ip>:8787` on a LAN) and **Agent Service API Key** to the same `AGENT_SERVICE_API_KEY` value.
4. **Checking it's working:** the robot icon in the token scene controls now pings `/v1/health` directly (Task 8) — click it, or run `game.modules.get('pf2e-dungeon-crawl').api.postAgentLoopStatus()` from the console.
5. **Self-hosting Laya (optional, only if using `PF2EDC_AGENT_PROVIDER=laya`):** research Laya's (ConvAI Innovations) own hosting instructions from its repository/documentation at the time this task is executed — write a short summary here (clone/build/run steps, required ports/env vars) and link to Laya's own docs as the source of truth rather than duplicating content this repo doesn't own. Note that this repo's `LAYA_BASE_URL` env var (read by `tools/agent-service/providers/laya.mjs`, unchanged from Task 1) should point at wherever that self-hosted Laya instance ends up running.
6. **Troubleshooting:** combat falls back to the heuristic with a chat notice if the service is unreachable or misconfigured (unchanged mechanism, Task 7); flavor customization silently leaves template content if its call fails (Task 9) — check `docker compose logs agent-service` for the underlying error either way.

- [ ] **Step 2: Cross-check against the actual settings/script names**

Read back `scripts/module.mjs`'s setting labels (Task 6) and `package.json`'s `agent-service` script (Task 11) to confirm the README's instructions use the exact same names — fix any drift.

- [ ] **Step 3: Commit**

```bash
git add tools/agent-service/README.md
git commit -m "Add tools/agent-service README covering deployment and Laya self-hosting"
```
