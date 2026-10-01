# Validate OpenRouter (mercury-decide) as a Combat-Decision Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Actually exercise `inception/mercury-decide:free` through OpenRouter as a combat-decision model — proving the #138 OpenRouter scaffolding works end-to-end and is reliable enough for structured tool-calling, not just inert config.

**Architecture:** Add a dedicated `litellm-config.yaml` entry (its own model alias, not repointing the production `fast`/`reasoning` tiers #138 already wired up and documented). Give `providers/litellm.mjs`'s `decide()` an optional, backward-compatible `model` override so a validation run can target this new alias directly without touching tier-selection logic or the default local-Ollama setup at all. Add a small, reusable, manually-run validation script that fires repeated realistic combat-decision requests at a named model and reports a real success rate — the project's existing `tools/validate-*.mjs` convention (`validate-creature-art.mjs`, `validate-dungeon-setpieces.mjs`), applied to a decision model instead of game content.

**Tech Stack:** Node (`tools/agent-service`), vitest, a real OpenRouter API key for the live validation step (cannot be mocked away — the entire point is confirming real-world tool-calling reliability).

**Spec:** None — a bounded, narrowly-scoped validation task building directly on already-shipped infrastructure (#138's litellm/OpenRouter scaffolding, #133's tier-selection design). The one open design question #454 itself flagged — whether this repoints `fast`/`reasoning` or gets its own named tier — is resolved below: **its own named tier** (`mercury-decide`), so validating it can never destabilize the default local-Ollama setup #138/#133 already shipped and documented.

## Global Constraints

- The new model_list entry must **not** repoint or modify the existing `fast`/`reasoning` entries in `litellm-config.yaml` — those are the production defaults (#133), and #138's own `openrouter-fast`/`openrouter-reasoning` entries already demonstrate the "repoint fast/reasoning" pattern for anyone who wants to actually switch providers; this issue is validation, not a provider switch.
- `providers/litellm.mjs`'s `decide()` must stay backward compatible — no caller (`scripts/dungeon-combat.mjs` via `scripts/agent-service-client.mjs`, or any existing test) passes a `model` option today, and none should be required to start.
- The live validation step requires a real `OPENROUTER_API_KEY` and a running `litellm`/`agent-service` stack — it is not part of the automated (`npx vitest run`) suite, consistent with this project's existing convention that live, credentialed, external-network verification happens manually and gets documented, not scripted into CI (see #132's and #141's own live-verification steps).
- Document the actual outcome either way — "works reliably," "works with caveats," or "doesn't work" — per the issue's own explicit ask; a plan that only documents a success path doesn't satisfy this issue.

## Review Focus

- **`decide()`'s new `model` option defaulting correctly when omitted.** Every existing caller and every existing test calls `decide(context, {baseUrl, apiKey, ...})` with no `model` key at all — the default must still resolve to `selectCombatTier(context)`'s result, exactly as today. Task 2's tests cover both the override and the no-override (default) cases explicitly, not just the new behavior in isolation.
- **A free-tier OpenRouter model returning no tool call, or a malformed one, mid-validation run.** This is the actual risk the issue exists to characterize, not an edge case to route around — the validation script must count and report these as failures (with their raw error), not crash the whole run or silently skip them. Task 3's script design covers this explicitly.
- **Rate limiting across repeated trials against a free-tier model.** A naive tight loop risks every trial after the first few failing on rate limits rather than genuine tool-calling unreliability, muddying the actual signal this issue needs. Task 3's script adds a short delay between trials and reports rate-limit-shaped failures (429 status, or an error message containing "rate limit") separately from other failures in its summary, so Task 4's documentation reflects the real reliability signal, not an artifact of hammering a free tier too fast.
- **The `mercury-decide` litellm-config.yaml entry breaking YAML parsing or the default (Ollama-only) deployment when `OPENROUTER_API_KEY` is unset**, the same inert-by-default property #138's own `openrouter-fast`/`openrouter-reasoning` entries already have (per that file's own comment: "litellm only errors on a model_list entry's missing api_key when something actually requests that model name"). Task 1 confirms this explicitly rather than assuming it transfers automatically.
- **Documenting a negative/mixed outcome, not just a positive one.** The issue's own scope requires recording "works reliably / works with caveats / doesn't work," and it's easy for a documentation task to only get written if the answer is a clean "yes." Task 4's steps are written to apply identically regardless of which outcome the live run produces.

---

## Task 1: Add the `mercury-decide` litellm-config.yaml entry

**Files:**
- Modify: `tools/agent-service/litellm-config.yaml`

**Interfaces:** None — pure configuration, consumed at runtime by name (`"mercury-decide"`) via Task 2's `model` override.

- [ ] **Step 1: Add the new entry**

In `tools/agent-service/litellm-config.yaml`, after the existing `openrouter-reasoning` entry, add:

```yaml
  # #454: a dedicated, non-production entry for validating
  # inception/mercury-decide:free's tool-calling reliability via
  # tools/agent-service/validate-decision-model.mjs. Deliberately its own
  # named tier, not a repoint of fast/reasoning -- see that script and
  # providers/litellm.mjs's decide() `model` option. Inert by default for
  # the same reason openrouter-fast/openrouter-reasoning above are: litellm
  # only errors on a missing api_key when something actually requests this
  # model name.
  - model_name: mercury-decide
    litellm_params:
      model: openrouter/inception/mercury-decide:free
      api_key: os.environ/OPENROUTER_API_KEY
```

- [ ] **Step 2: Validate the YAML**

Run: `docker compose -f tools/agent-service/docker-compose.yml config`
Expected: valid, resolved YAML printed, no errors — same check this file's own deployment task used when it was first created (#133).

- [ ] **Step 3: Confirm the default (Ollama-only) deployment still works with no OPENROUTER_API_KEY set**

Run: `AGENT_SERVICE_API_KEY=test docker compose -f tools/agent-service/docker-compose.yml up --build -d && curl -s localhost:8787/v1/health && docker compose -f tools/agent-service/docker-compose.yml down` (skip this step and note it in the commit message if no Docker daemon is available in this environment — the YAML validation in Step 2 is the minimum bar either way).
Expected: `{"ok":true}` — the new inert entry doesn't break startup when `OPENROUTER_API_KEY` is unset.

- [ ] **Step 4: Commit**

```bash
git add tools/agent-service/litellm-config.yaml
git commit -m "Add a dedicated litellm-config.yaml entry for inception/mercury-decide:free (#454)"
```

---

## Task 2: Optional `model` override on `providers/litellm.mjs`'s `decide()`

**Files:**
- Modify: `tools/agent-service/providers/litellm.mjs`
- Test: `tests/agent-service-litellm-provider.test.mjs`

**Interfaces:**
- Produces: `decide(context, { model?, baseUrl?, apiKey?, timeoutMs?, fetchImpl? })` — `model` is new, optional, defaults to `selectCombatTier(context)` exactly as today when omitted. Consumed directly by Task 3's validation script to target `"mercury-decide"` without going through tier selection at all.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent-service-litellm-provider.test.mjs`, inside the existing `describe("litellm provider decide()", ...)` block:

```js
  it("uses an explicit model override instead of tier selection when provided", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", model: "mercury-decide", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("mercury-decide");
  });

  it("still falls back to tier selection when no model override is given", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("fast");
  });
```

- [ ] **Step 2: Run test to verify the new override test fails**

Run: `npx vitest run tests/agent-service-litellm-provider.test.mjs`
Expected: the first new test FAILs (`body.model` is `"fast"`, not `"mercury-decide"` — there is no override yet); the second new test already PASSes (it only pins today's existing default behavior).

- [ ] **Step 3: Add the override**

In `tools/agent-service/providers/litellm.mjs`, change the `decide` function's destructured parameters and the `model` assignment:

```js
export async function decide(
  context,
  {
    model = selectCombatTier(context),
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_COMBAT_TIMEOUT_MS")) || DEFAULT_COMBAT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const candidateIds = context.candidates.map((c) => c.id);
```

(Remove the old `const model = selectCombatTier(context);` line entirely — the destructured default now does this.)

- [ ] **Step 4: Run test to verify both pass**

Run: `npx vitest run tests/agent-service-litellm-provider.test.mjs`
Expected: PASS (all tests in the file, including both new ones)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS — nothing else in the codebase calls `decide()` with a `model` key, and the default-path tests (including every pre-existing test in this file) are unaffected by moving the assignment into a destructured default.

- [ ] **Step 6: Commit**

```bash
git add tools/agent-service/providers/litellm.mjs tests/agent-service-litellm-provider.test.mjs
git commit -m "Add an optional model override to litellm provider's decide() (#454)"
```

---

## Task 3: Standalone validation script

**Files:**
- Create: `tools/agent-service/validate-decision-model.mjs`
- Modify: `package.json` (new script)

**Interfaces:**
- Consumes: `decide(context, { model, baseUrl, apiKey })` from `providers/litellm.mjs` (Task 2).
- Produces: a CLI tool, no exports consumed elsewhere — `node tools/agent-service/validate-decision-model.mjs [modelName] [trialCount]`, defaulting to `mercury-decide` and `10` trials.

No vitest test for this file — it's a manually-run, live-network CLI tool (the same convention as this repo's other `tools/validate-*.mjs` files, none of which have their own test files; `decide()`'s own correctness is already covered by Task 2 and the rest of `tests/agent-service-litellm-provider.test.mjs`).

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * Fires repeated realistic combat-decision requests at a named litellm
 * model and reports a real tool-calling success rate — built for #454's
 * validation of inception/mercury-decide:free, but takes any model name
 * so a future validation (e.g. #166's gliner-2.5-decider) can reuse it.
 *
 * Requires a running tools/agent-service + litellm stack reachable at
 * LITELLM_BASE_URL (default http://localhost:4000/v1 for a locally
 * `docker compose up`'d litellm, not the agent-service's own 8787 — this
 * talks to litellm directly, bypassing the HTTP auth layer agent-service
 * adds, since it's exercising decide() as a library call, not the
 * deployed /v1/combat-decision endpoint), and whatever that model's own
 * provider needs (e.g. OPENROUTER_API_KEY for an openrouter/* entry).
 *
 * Run: node tools/agent-service/validate-decision-model.mjs [modelName] [trialCount]
 */
import { decide } from "./providers/litellm.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const MODEL_NAME = process.argv[2] ?? "mercury-decide";
const TRIAL_COUNT = Number(process.argv[3]) || 10;
// Free-tier OpenRouter models rate-limit aggressively; this delay keeps a
// genuine tool-calling-reliability signal from being swamped by 429s that
// are really about request pacing, not the model itself (see this plan's
// Review Focus).
const DELAY_BETWEEN_TRIALS_MS = 2000;

const SAMPLE_CONTEXT = {
  self: { name: "Test Combatant", hp: 24, conditions: [] },
  opponents: [
    { id: "opp1", name: "Fighter", distanceSquares: 1, hp: 30 },
    { id: "opp2", name: "Wizard", distanceSquares: 3, hp: 18 },
  ],
  candidates: [
    { id: "strike:claw:opp1", summary: "Claw vs Fighter (variant 0)" },
    { id: "stride:approach:opp2", summary: "Approach Wizard" },
    { id: "endTurn", summary: "End turn" },
  ],
  roundNumber: 2,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  return /429|rate limit/i.test(err.message);
}

async function runTrial(baseUrl, apiKey) {
  try {
    const result = await decide(SAMPLE_CONTEXT, { model: MODEL_NAME, baseUrl, apiKey });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, rateLimited: isRateLimitError(err), error: err.message };
  }
}

async function main() {
  const baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://localhost:4000/v1";
  const apiKey = readEnvOrDotenv("LITELLM_API_KEY");

  console.log(`validate-decision-model: running ${TRIAL_COUNT} trials against "${MODEL_NAME}" via ${baseUrl}`);

  const results = [];
  for (let i = 0; i < TRIAL_COUNT; i += 1) {
    const result = await runTrial(baseUrl, apiKey);
    results.push(result);
    console.log(
      `  trial ${i + 1}/${TRIAL_COUNT}: ${result.ok ? `OK (${result.result.candidateId})` : `FAIL (${result.error})`}`,
    );
    if (i < TRIAL_COUNT - 1) await sleep(DELAY_BETWEEN_TRIALS_MS);
  }

  const succeeded = results.filter((r) => r.ok).length;
  const rateLimited = results.filter((r) => !r.ok && r.rateLimited).length;
  const otherFailures = results.length - succeeded - rateLimited;

  console.log("\nSummary:");
  console.log(`  succeeded: ${succeeded}/${results.length}`);
  console.log(`  rate-limited: ${rateLimited}/${results.length}`);
  console.log(`  other failures: ${otherFailures}/${results.length}`);
}

main();
```

- [ ] **Step 2: Add a package.json script**

```json
    "validate:decision-model": "node tools/agent-service/validate-decision-model.mjs",
```

(Add alongside the existing `validate:dungeon`/`validate:creature-art` entries.)

- [ ] **Step 3: Sanity-check the script runs (without live credentials)**

Run: `node tools/agent-service/validate-decision-model.mjs mercury-decide 1`
Expected: prints the "running 1 trials..." line, then a single trial result (FAIL, since no `litellm` sidecar is reachable at the default `http://localhost:4000/v1` in a bare dev environment) and a summary — confirms the script itself runs without crashing before Task 4's real, credentialed run.

- [ ] **Step 4: Commit**

```bash
git add tools/agent-service/validate-decision-model.mjs package.json
git commit -m "Add a reusable live decision-model validation script (#454)"
```

---

## Task 4: Run the live validation and document the outcome

**Files:**
- Modify: `tools/agent-service/README.md`

**Interfaces:** None — this task executes Task 3's script against real infrastructure and writes down what happened.

- [ ] **Step 1: Bring up the stack with `OPENROUTER_API_KEY` set**

Set `OPENROUTER_API_KEY` in your `.env` (an OpenRouter API key with access to the free tier). Run:

```bash
docker compose --env-file .env -f tools/agent-service/docker-compose.yml up --build -d
```

- [ ] **Step 2: Run the validation script for real, at least 10 trials**

```bash
LITELLM_BASE_URL=http://localhost:4000/v1 npm run validate:decision-model -- mercury-decide 10
```

(Adjust `LITELLM_BASE_URL` if your `litellm` service isn't reachable at `localhost:4000` — e.g. a non-default compose port mapping.)

Record the full console output (per-trial results and the summary) — this is the actual evidence Step 4 documents, not a paraphrase.

- [ ] **Step 3: Bring the stack back down**

```bash
docker compose -f tools/agent-service/docker-compose.yml down
```

- [ ] **Step 4: Add a "Validated models" note to `tools/agent-service/README.md`**

In the "Using OpenRouter instead of local Ollama" section (after the existing `openrouter-fast`/`openrouter-reasoning` walkthrough), add a subsection documenting the real outcome — write whichever of these actually matches Step 2's recorded results, with the real success rate filled in (not a placeholder):

- If `succeeded` was 10/10 or close to it with no rate-limiting: state `inception/mercury-decide:free` works reliably for tool-calling via this path, give the observed success rate, and note it's available as the `mercury-decide` `litellm-config.yaml` entry for anyone who wants to repoint `fast`/`reasoning` at it (same pattern as the `openrouter-fast`/`openrouter-reasoning` walkthrough above).
- If some trials failed but most succeeded: state it works with caveats, give the observed success rate, and describe the actual failure mode(s) seen (malformed tool call, missing tool call, rate limiting despite the script's delay, etc.) verbatim from the recorded output.
- If most/all trials failed: state it does not currently work reliably enough to recommend, give the observed failure rate, and describe the actual failure mode(s) seen.

- [ ] **Step 5: Report the outcome on issue #454**

Comment on #454 with the real trial results (succeeded/rate-limited/other-failures counts) and a link to the README section just added. This is a judgment call for whoever runs this step, not an automated one: if the result is "works reliably," #454 can move toward being closed once this is reviewed; if "doesn't work" or "caveats," leave it open and let the comment speak for the documented outcome, per this issue's own scope ("document the outcome... whichever way it lands").

- [ ] **Step 6: Commit**

```bash
git add tools/agent-service/README.md
git commit -m "Document inception/mercury-decide:free validation outcome (#454)"
```
