# Repoint "reasoning" Tier at qwen/qwen3.8-27b:free Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `qwen/qwen3.8-27b:free` (via OpenRouter) the production default for the `reasoning` litellm model tier, replacing the local Ollama model, since local reasoning-tier inference is too slow for practical use — and confirm its tool-calling actually works reliably before trusting it as the default, not just assuming it does.

**Architecture:** A `litellm-config.yaml` edit (repoint `reasoning`'s `litellm_params` from `ollama/qwen2.5:3b-instruct` to `openrouter/qwen/qwen3.8-27b:free`) plus a README update — no Node code changes of its own. `OPENROUTER_API_KEY` is already wired into the `litellm` service's environment by #138; this plan is the first thing that makes that variable load-bearing for the default configuration rather than optional. Live-reliability verification reuses #454's `providers/litellm.mjs` `decide()` `model` override and its `tools/agent-service/validate-decision-model.mjs` script, run against the newly-repointed `reasoning` tier itself — **this plan's Task 2 cannot start until #454 is actually implemented and merged** (not just planned), since it consumes interfaces #454 adds.

**Tech Stack:** YAML config (`litellm-config.yaml`), a real `OPENROUTER_API_KEY` and live network calls for Task 2's verification (not mockable, same as #454).

**Spec:** None — a bounded config change with no open design question of its own; the only open question #457 raised (exact model id) was resolved by checking OpenRouter's live `/api/v1/models` catalog directly (`qwen/qwen3.8-27b:free` — confirmed real, free, and `tools`/`tool_choice`/`structured_outputs` all appear in its `supported_parameters`).

## Global Constraints

- `fast` stays on local Ollama (`ollama/qwen2.5:3b-instruct`) — this plan only repoints `reasoning`. Nothing here should touch the `fast` entry.
- `openrouter-fast`/`openrouter-reasoning` (the inert template entries #138 added) are left in place, untouched — they remain a separate, independent example of the repoint pattern for a different model choice, not something this plan needs to remove or reconcile.
- This is a real behavior/deployment change, not purely additive: once `reasoning` depends on OpenRouter, a deployment with no `OPENROUTER_API_KEY` set will have every "reasoning"-tier combat decision fail (falling back to the existing heuristic timeout path — the error-handling behavior itself is unchanged, but the failure now happens by default where it previously didn't, since `reasoning` used to always work locally with zero required configuration). Document this plainly rather than silently.
- Task 2 (live reliability verification) depends on #454's `providers/litellm.mjs` `decide(context, {model, ...})` override and `tools/agent-service/validate-decision-model.mjs` already existing in the codebase — confirm both are present (`grep -n "model = selectCombatTier" tools/agent-service/providers/litellm.mjs` should show the destructured-default form, and `tools/agent-service/validate-decision-model.mjs` should exist) before starting Task 2; if neither exists yet, implement #454 first.

## Review Focus

- **`OPENROUTER_API_KEY` unset at deploy time.** Expected: `reasoning`-tier decisions fail cleanly (existing `AGENT_TIMEOUT_MS` heuristic fallback, same as any other provider failure) rather than some new, worse failure mode. Task 1's YAML-validation step confirms the config itself doesn't break startup either way; this is called out explicitly in the Global Constraints and the README update (Task 3) rather than silently assumed safe.
- **The model id string being subtly wrong** (a plausible-looking but nonexistent OpenRouter id) — the exact failure mode #457 itself flagged as a risk ("double-check... in case the id differs slightly"). Already resolved before writing this plan by querying OpenRouter's real catalog directly; Task 1 includes the same confirmation as an explicit step so the implementer isn't just trusting this plan's prose.
- **Reasoning-mode output interfering with forced tool-calling.** `qwen/qwen3.8-27b:free`'s catalog entry has `reasoning.default_enabled: true` at `xhigh` effort by default — a real, if currently unconfirmed, risk that its reasoning output could interfere with returning a clean tool call under `tool_choice: {type: "function", ...}`. Task 2's live validation is exactly the step that surfaces this if it happens; it's called out here so a reviewer doesn't dismiss it as already covered by #454's own validation (a different model).
- **Rate limiting across repeated validation trials**, same risk #454 raises for any free-tier OpenRouter model — Task 2 reuses #454's script, which already paces trials and separates rate-limit failures from genuine tool-calling failures in its summary.
- **Documenting a negative/mixed outcome, not just a positive one**, same requirement #454 holds itself to — Task 3's README update applies regardless of which outcome Task 2's live run actually produces.

---

## Task 1: Repoint the `reasoning` litellm-config.yaml entry

**Files:**
- Modify: `tools/agent-service/litellm-config.yaml`

**Interfaces:** None — pure configuration. `reasoning` is already the model name `selectCombatTier()` (`tier-selection.mjs`) requests for complex combat decisions and `generateWithLiteLLM`/`selectCustomizationTier()` requests for substantive flavor customization (both pre-existing, unchanged by this plan) — this task only changes what that name resolves to.

- [ ] **Step 1: Re-confirm the exact model id against OpenRouter's live catalog**

Run:
```bash
curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json, sys
data = json.load(sys.stdin)
ids = [m['id'] for m in data.get('data', [])]
print('qwen/qwen3.8-27b:free' in ids)
"
```
Expected: `True`. (This plan already confirmed this once; re-confirming here is cheap insurance against the catalog changing between planning and implementation, and against trusting a stale cached answer.)

- [ ] **Step 2: Edit the `reasoning` entry**

In `tools/agent-service/litellm-config.yaml`, change:

```yaml
  - model_name: reasoning
    litellm_params:
      model: ollama/qwen2.5:3b-instruct
      api_base: http://host.docker.internal:11434
```

to:

```yaml
  # #457: repointed from local Ollama (ollama/qwen2.5:3b-instruct) --
  # local reasoning-tier inference was too slow for practical use. Exact
  # id confirmed against OpenRouter's live /api/v1/models catalog before
  # committing to it (free tier, supports tools/tool_choice per its own
  # supported_parameters). Requires OPENROUTER_API_KEY to be set on the
  # litellm service (tools/agent-service/docker-compose.yml, already
  # wired by #138) -- without it, every "reasoning"-tier combat decision
  # now fails (existing AGENT_TIMEOUT_MS heuristic fallback handles it,
  # same as any other provider failure, but this is a real behavior
  # change from "always worked locally" to "requires this key").
  - model_name: reasoning
    litellm_params:
      model: openrouter/qwen/qwen3.8-27b:free
      api_key: os.environ/OPENROUTER_API_KEY
```

- [ ] **Step 3: Validate the YAML**

Run: `docker compose -f tools/agent-service/docker-compose.yml config`
Expected: valid, resolved YAML printed, no errors.

- [ ] **Step 4: Commit**

```bash
git add tools/agent-service/litellm-config.yaml
git commit -m "Repoint the reasoning litellm tier at qwen/qwen3.8-27b:free via OpenRouter (#457)"
```

---

## Task 2: Live-verify tool-calling reliability for the repointed `reasoning` tier

**Files:** None created or modified — this task only runs #454's already-implemented validation script against the config Task 1 just changed.

**Interfaces:**
- Consumes: `decide(context, {model, baseUrl, apiKey})` from `tools/agent-service/providers/litellm.mjs` and the CLI from `tools/agent-service/validate-decision-model.mjs` — both added by #454. **Do not start this task until both exist in the codebase** (see this plan's Global Constraints for how to check).

- [ ] **Step 1: Confirm #454's prerequisites are actually present**

Run:
```bash
grep -n "model = selectCombatTier" tools/agent-service/providers/litellm.mjs
ls tools/agent-service/validate-decision-model.mjs
```
Expected: both succeed (the grep prints a matching line; the file exists). If either fails, stop here and implement #454's plan (`docs/superpowers/plans/2026-10-01-validate-openrouter-mercury-decide.md`) first — this task has nothing to run against otherwise.

- [ ] **Step 2: Bring up the stack with `OPENROUTER_API_KEY` set**

Set `OPENROUTER_API_KEY` in your `.env` (an OpenRouter API key). Run:

```bash
docker compose --env-file .env -f tools/agent-service/docker-compose.yml up --build -d
```

- [ ] **Step 3: Run the validation script against the `reasoning` tier itself, at least 10 trials**

```bash
LITELLM_BASE_URL=http://localhost:4000/v1 npm run validate:decision-model -- reasoning 10
```

This passes `"reasoning"` as the model name — the same literal string `selectCombatTier()` already requests in production — so this validates the actual repointed default from Task 1, not a separate parallel entry. Record the full console output (per-trial results and the summary); this is the evidence Task 3 documents, not a paraphrase.

- [ ] **Step 4: Bring the stack back down**

```bash
docker compose -f tools/agent-service/docker-compose.yml down
```

---

## Task 3: Document the outcome and update the README's tier-configuration example

**Files:**
- Modify: `tools/agent-service/README.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update the "Configuring model tiers" opening paragraph**

Find the sentence (currently): *"Both currently point to the same local Ollama model, `qwen2.5:3b-instruct`, but you can point them to different models by editing `tools/agent-service/litellm-config.yaml`."*

Replace it with something reflecting the actual current defaults post-#457, e.g.: *"`fast` points at a local Ollama model (`qwen2.5:3b-instruct`); `reasoning` points at `qwen/qwen3.8-27b:free` via OpenRouter by default (local reasoning-tier inference was too slow for practical use — see below) — requiring `OPENROUTER_API_KEY` to be set for `reasoning`-tier decisions to work. You can point either tier at a different model by editing `tools/agent-service/litellm-config.yaml`."*

- [ ] **Step 2: Add the real validation outcome to the "Using OpenRouter instead of local Ollama" section**

After the existing walkthrough (which still correctly demonstrates the general repoint mechanism, e.g. for switching `fast` too, or picking yet another `reasoning` model later), add a subsection documenting Task 2's real, recorded results — write whichever of these actually matches, with the observed success rate filled in (not a placeholder):

- If trials succeeded reliably with no rate-limiting: state `qwen/qwen3.8-27b:free` works reliably as the `reasoning` tier's default, with the observed success rate.
- If some trials failed but most succeeded: state it works with caveats, the observed success rate, and the actual failure mode(s) seen verbatim from the recorded output (e.g. reasoning-mode output interfering with tool-call extraction, if that's what happened).
- If most/all trials failed: state it does not currently work reliably enough as a default, with the observed failure rate and mode(s) — and in this case, revert Task 1's change (repoint `reasoning` back to `ollama/qwen2.5:3b-instruct`) in the same commit as this documentation update, since shipping a documented-broken default is worse than the slow-but-working one it replaced. Comment this outcome on issue #457 either way.

- [ ] **Step 3: Commit**

```bash
git add tools/agent-service/README.md
```
(If Step 2 required reverting Task 1's config change, also: `git add tools/agent-service/litellm-config.yaml`.)
```bash
git commit -m "Document qwen/qwen3.8-27b:free reasoning-tier validation outcome (#457)"
```
