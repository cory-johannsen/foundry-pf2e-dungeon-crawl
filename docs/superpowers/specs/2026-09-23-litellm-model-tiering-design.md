# litellm proxy and dynamic model tiering for the agent service — design

**Tracks:** [#133](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/133)

**Depends on:** [#132](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/132) (deploy the hosted agent service — Ollama + `tools/agent-service`) — done, live-verified.

**Related, filed as a separate follow-up (out of scope here):** [#136](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/136) — a real, game-state-driven "importance" signal for combat-decision tiering (a GM-settable complexity flag, or a computed signal once one exists), refining the `candidates.length` proxy this issue ships with.

## Problem

Model/provider selection in `tools/agent-service` is static, decided once at process start:

- Combat-turn decisions: `providers/index.mjs`'s `resolveProvider()` picks a fixed `claude` or `laya` provider from `PF2EDC_AGENT_PROVIDER` — "restart the poller to switch providers, no runtime switching."
- Flavor customization: `customization-generator.mjs` has its own separate static choice (`AGENT_SERVICE_CUSTOMIZATION_PROVIDER=claude|local`), a hardcoded `CLAUDE_MODEL` constant, and a single fixed `LOCAL_LLM_MODEL`.

Neither path picks a model per-request based on what's actually happening in the game — an ambient trap name and a major NPC's combat tactics get exactly the same model.

## Goal

Add a litellm proxy in front of the multiple model backends `tools/agent-service` already talks to (previously Claude direct + local/Ollama; going forward, whatever litellm is configured to reach), and have the agent service pick a model **tier** ("fast" vs. "reasoning") per request based on already-available game-state signals — no new Foundry-side plumbing in this iteration.

**Hard constraint:** Laya cannot generate free text (`providers/laya.mjs`: "Laya never generates text") — it is not an LLM completions API at all, but a typed choice/score/bool question-answering endpoint with calibrated probabilities. It cannot be unified behind litellm's OpenAI-compatible surface and stays a separate, untouched adapter regardless of this work.

## Non-goals / explicitly out of scope

- A real "importance"/complexity signal beyond the `candidates.length` proxy for combat, or a GM-settable flag — tracked as #136.
- Any change to Foundry-side code (`scripts/`) — the wire contract of both endpoints is unchanged, so none is needed.
- Any change to error-handling/fallback behavior — see "Error handling" below; it's inherited unchanged.
- A second, genuinely larger local model for the "reasoning" tier — both tiers point at the same model (`qwen2.5:3b-instruct`) for now, per an explicit decision to defer this until a specific model is chosen and the hardware can be confirmed to run it. Swapping it in later is a config-only change (`litellm-config.yaml`), not a code change.

## Deployment and ownership model

Unchanged from #105/#132: each GM self-hosts their own instance. The litellm sidecar is a new container in the same self-hosted `docker-compose.yml`, not published to a host port — only reachable from the `agent-service` container over the compose network, since nothing outside this deployment talks to it directly.

## Architecture

```
Foundry client (unchanged)
  runAgentDecisionLoop ──POST /v1/combat-decision──► tools/agent-service
  fulfillPendingCustomizations ──POST /v1/flavor-customization──►

tools/agent-service (this issue's changes)
  resolveProvider(): "litellm" (new, replaces claude.mjs) | "laya" (unchanged)
  generateCustomization(): always via litellm now (replaces the claude/local split)
       │
       ▼ POST /v1/chat/completions (OpenAI-compatible)
  litellm sidecar (new container, docker-compose.yml)
       │ litellm-config.yaml maps model aliases "fast"/"reasoning" → backends
       ▼
  Ollama (existing, host.docker.internal:11434) — both aliases point at
  qwen2.5:3b-instruct for now
```

The wire contracts of `POST /v1/combat-decision` and `POST /v1/flavor-customization` do not change — this issue is entirely internal to `tools/agent-service`.

## litellm sidecar and configuration

New service in `tools/agent-service/docker-compose.yml`:

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

New `tools/agent-service/litellm-config.yaml`:

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

Swapping the reasoning tier to a genuinely larger model later is a one-line edit to this file plus a container restart — no code change, no Node image rebuild.

The `agent-service` container gains `LITELLM_BASE_URL` (default `http://litellm:4000/v1`, the compose-network hostname) in its environment. It loses `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_TIMEOUT_MS`, `AGENT_SERVICE_CUSTOMIZATION_PROVIDER`, and `ANTHROPIC_API_KEY` — those Ollama-reaching and Claude-reaching concerns move to `litellm-config.yaml`/litellm itself, since litellm is now the thing that talks to model backends.

## Provider consolidation

- **New `tools/agent-service/providers/litellm.mjs`** — `decide(context, opts)` matching the existing provider interface (`{candidateId, rationale?}`), replacing `providers/claude.mjs`. Talks to litellm's `/chat/completions` using the same OpenAI-style tool-call request/response shape `customization-generator.mjs`'s existing local-provider code already implements (reused, not reinvented): `tools: [{type: "function", function: {name: "choose_action", ...}}]`, result at `choices[0].message.tool_calls[0].function.arguments`. `model` is `"fast"` or `"reasoning"` per the tier selection below, not a hardcoded string.
- **`providers/index.mjs`**: `PROVIDERS = { litellm: decideLitellm, laya: decideLaya }`. The `claude` entry is removed. `PF2EDC_AGENT_PROVIDER` defaults to `"litellm"` (was `"claude"`) — a currently-deployed instance with an explicit `PF2EDC_AGENT_PROVIDER=laya` override is unaffected.
- **`customization-generator.mjs`**: `generateWithClaude`/`generateWithLocal` and the `AGENT_SERVICE_CUSTOMIZATION_PROVIDER=claude|local` branch collapse into one `generateWithLiteLLM`, always used — no more provider switch for this path. Still never goes through `providers/index.mjs`/`resolveProvider()` — Laya remains architecturally excluded from this route under any configuration, per the hard constraint above.
- **`tools/agent-service/providers/claude.mjs` is deleted.** Nothing is lost: `litellm.mjs` and the (now-unified) customization-generation code cover the same request-shaping ground via the OpenAI-compatible tool-call shape.

## Tier selection

Two small, pure, independently-testable functions — deliberately simple, stateless, and replaceable once #136's real signal exists:

- **Combat** — `selectCombatTier(context)`: `"reasoning"` when `context.candidates.length > COMBAT_REASONING_CANDIDATE_THRESHOLD` (env-configurable via `readEnvOrDotenv`, default `8`), else `"fast"`. `candidates.length` is a proxy for tactical decision complexity (more ready strikes/spells/postures to weigh), not narrative importance — the honest limitation #136 exists to address. This is the only meaningful signal already present in `getPendingAgentTurn`'s context (`scripts/dungeon-combat.mjs:3150`) without new Foundry-side plumbing; `self` there is `{name, hp, conditions}` only — no `level` field exists despite the original #105 design doc's illustrative example suggesting one would.
- **Customization** — `selectCustomizationTier(kind)`: `"fast"` for `trap`/`treasure`, `"reasoning"` for `skill_challenge`/`puzzle`/`narrative`.

## Error handling

No change from #105's established behavior — this section exists to confirm that explicitly, not to introduce anything new:

- **Combat:** `AGENT_TIMEOUT_MS` (45s) still governs; the heuristic fallback and GM chat notice still fire exactly as today if litellm/Ollama doesn't respond in time or errors. `runAgentDecisionLoop` already treats any `fetchCombatDecision` failure uniformly (network error, non-2xx, malformed response) regardless of cause — a litellm-specific failure is indistinguishable from today's provider failures at that layer, by design.
- **Flavor customization:** unchanged "never blocks, degrades to template content" — a litellm failure surfaces as `generateCustomization` rejecting, which `fulfillOne` already catches and logs per-kind.
- **Service-side (new):** `litellm.mjs` and `generateWithLiteLLM` both apply a request timeout (`AbortSignal.timeout(...)`, reusing the existing `nodeFetch`/timeout pattern from the current local-provider code, given local Ollama-backed inference is genuinely slow — "minutes, not seconds, per request" is already documented and unchanged by this work) so a stuck litellm/Ollama call surfaces as a clean `502`, not a hang.

## Testing

- `selectCombatTier`/`selectCustomizationTier`: pure-function unit tests, no mocking needed — table-driven over the threshold boundary and each `kind`.
- `providers/litellm.mjs`'s `decide()`: mocked-fetch unit tests mirroring the existing `tests/agent-service-claude-provider.test.mjs`/`agent-service-laya-provider.test.mjs` style, now asserting the OpenAI tool-call request shape and `model: "fast"|"reasoning"` selection.
- `customization-generator.mjs`'s unified `generateWithLiteLLM`: mocked-fetch unit tests replacing the existing separate Claude/local test paths, covering all five `kind`s' schemas (trap/skill_challenge/puzzle/narrative/treasure) and both tiers.
- `providers/index.mjs`'s `resolveProvider()`: updated existing test (`tests/agent-service-provider-selection.test.mjs`) to assert `litellm`/`laya`, not `claude`/`laya`.
- No live litellm/Ollama integration test in CI — same precedent as the rest of this service (mocked-fetch unit tests only; live verification happens via the deployed instance, per #132's own closing verification).

## Migration

Breaking, clean cutover — no backwards-compatibility shim, consistent with #105's precedent:

- `ANTHROPIC_API_KEY`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_TIMEOUT_MS`, `AGENT_SERVICE_CUSTOMIZATION_PROVIDER` are removed from `tools/agent-service`'s own environment/`docker-compose.yml` — any currently-set values for these in a deployed `.env` become inert and should be removed as part of upgrading.
- `PF2EDC_AGENT_PROVIDER=claude` (if anyone has it explicitly set) must change to `PF2EDC_AGENT_PROVIDER=litellm` — the default changing from `claude` to `litellm` only helps an instance with no explicit override.
- New required deployment step: create `tools/agent-service/litellm-config.yaml` (a template ships in the repo) and ensure the `litellm` service is included when bringing up `docker-compose.yml`.
- The currently-deployed instance (per #132) uses `PF2EDC_AGENT_PROVIDER=laya` (combat, unaffected) and `AGENT_SERVICE_CUSTOMIZATION_PROVIDER=local` (flavor customization, this variable is removed — litellm's config now determines this uniformly, pointing at the same Ollama/`qwen2.5:3b-instruct` backend that variable used to select, so behavior is equivalent post-migration, not degraded).

## Alternatives considered

- **litellm as a JS/npm dependency instead of a sidecar.** litellm is a Python-native project; there is no first-party JS port. Running it as its own OpenAI-compatible HTTP sidecar (its own container) is the standard, supported integration shape for a Node caller, and matches this service's existing pattern of talking to Ollama over plain HTTP rather than embedding a Python runtime in a Node process.
- **Routing Laya through litellm too**, for full unification. Rejected outright — Laya's protocol (typed choice/score/bool questions, calibrated probabilities, no free text) is not an LLM completions API and litellm has no way to represent it; forcing this would require either a custom litellm provider plugin (real, ongoing maintenance burden for no benefit) or misrepresenting Laya's actual interface.
- **Publishing litellm's port to the host**, for direct debugging access. Rejected for the initial design — nothing outside `tools/agent-service` needs to reach it, and not publishing the port keeps the attack surface smaller for a self-hosted deployment with no other isolation. A GM can still reach it via `docker compose exec`/`docker logs` for debugging.
