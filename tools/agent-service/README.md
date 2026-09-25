# tools/agent-service

A persistent, self-hosted HTTP service that Foundry calls directly for
agent-controlled combat decisions and dungeon flavor-customization content.
See `docs/superpowers/specs/2026-09-22-hosted-agent-service-design.md` for
the full design.

## What this replaces

This retires the local-process `tools/agent-loop` tooling entirely —
`poll.mjs` (the polling loop that drove combat decisions),
`mcp-server.mjs` (the MCP server an interactive agent session used to
fulfill flavor customizations), and the `foundryvtt-rest-api`/
`foundryvtt-rest-api-relay` relay stack they both depended on. There is no
relay to self-host, no poller to leave running for the length of a
session, and no MCP server to keep configured in `.mcp.json`. Foundry now
talks to this service directly over plain HTTP, and the service is meant
to run continuously (e.g. via Docker) rather than be started per-session.

## Prerequisite: Ollama on the host

The default `tools/agent-service/litellm-config.yaml` routes both the
`fast` and `reasoning` model aliases to a local Ollama server running on
the Docker **host**, not inside a container. Before deploying:

1. [Install Ollama](https://ollama.com) on the machine that will host this
   stack and make sure it's running (it listens on `:11434` by default).
2. Pull the model `litellm-config.yaml` references:
   ```bash
   ollama pull qwen2.5:3b-instruct
   ```

`litellm-config.yaml`'s `api_base` for each model entry points at
`http://host.docker.internal:11434` rather than `http://localhost:11434`.
Inside the `litellm` container, `localhost` refers to the container
itself, not the Docker host — `host.docker.internal` (resolved via the
`extra_hosts: host.docker.internal:host-gateway` entry in
`docker-compose.yml`) is the portable (Linux/Mac/Windows) way to reach a
host-run server from a container. If you point `litellm-config.yaml` at a
different model provider entirely (see "Configuring model tiers" below),
this Ollama prerequisite no longer applies.

## Deploy the service

From the repo root:

```bash
docker compose --env-file .env -f tools/agent-service/docker-compose.yml up -d
```

This builds and runs the image defined by `tools/agent-service/Dockerfile`
and publishes it on port `8787`. Provide the following via a `.env` file
in the repo root (see `.env.example`), or the shell environment, before
running it. The explicit `--env-file .env` matters: Docker Compose v2
resolves its default `.env` relative to the compose file's directory
(`tools/agent-service/`), not the directory you run the command from, so
without the flag a repo-root `.env` is silently ignored.

- `AGENT_SERVICE_API_KEY` — a secret you generate yourself, e.g.
  `openssl rand -hex 32`. The service refuses to start without this set
  (see `tools/agent-service/entrypoint.mjs`), and every request to it must
  present this key as a bearer token. Foundry needs the same value (see
  "Configure Foundry" below).
- `LITELLM_BASE_URL` — the base URL of the litellm proxy sidecar.
  Defaults to `http://litellm:4000/v1` (the compose-network hostname).
  Only needs overriding for non-compose deployments.
- `LITELLM_API_KEY` — optional bearer token. Matches whatever
  `litellm-config.yaml` and litellm's own auth is set up to expect, if
  anything. Not required for the default sidecar setup since it runs
  inside the compose network and isn't published to a host port.
- `LITELLM_TIMEOUT_MS` — optional request timeout in milliseconds for
  flavor-customization calls, default `300000` (5 minutes). Matches
  local-inference speed.
- `LITELLM_COMBAT_TIMEOUT_MS` — optional request timeout in milliseconds
  for combat-decision calls, default `30000`. Kept under Foundry's 35s
  client-side combat-decision timeout so a stuck upstream call fails
  promptly instead of tying up Ollama's serial request queue.
- `COMBAT_REASONING_CANDIDATE_THRESHOLD` — optional threshold above which
  combat decisions request the `reasoning` model tier instead of `fast`,
  default `8`. If the decision has more than 8 candidates, litellm routes
  to the `reasoning` alias; 8 or fewer candidates use the `fast` alias
  (see "Configuring model tiers" below).

Optional, only needed if you want the Laya decision provider instead of
litellm:

- `PF2EDC_AGENT_PROVIDER=laya` — switches the combat-decision provider.
  Defaults to `litellm` if unset.
- `LAYA_API_KEY` — bearer token for your Laya deployment, if it requires
  auth.
- `LAYA_BASE_URL` — base URL of your self-hosted Laya instance (see
  "Self-hosting Laya" below). Falls back to a default hosted instance if
  unset.

Optional, for locking down CORS:

- `AGENT_SERVICE_ALLOWED_ORIGIN` — the `Access-Control-Allow-Origin` value
  the service sends (Foundry calls it via browser `fetch()` from a
  different origin). Defaults to `*`, which is safe because auth is a
  bearer token rather than a cookie, but you can lock it to your GM's
  actual Foundry origin, e.g. `https://foundry.yourdomain.com`.

Example `.env`:

```
AGENT_SERVICE_API_KEY=<output of `openssl rand -hex 32`>
```

The `litellm` sidecar (deployed by the same compose file) handles model
access. No Anthropic API key or local-model config needed — the sidecar
is containerized and configured separately.

Leave the service running continuously — it's meant to be always-on
infrastructure, not something you start and stop per session. Wherever
you deploy it, make sure it's reachable from the machine(s) running
Foundry (a LAN address, or a public/reverse-proxied hostname if Foundry
and the service aren't on the same network).

**If Foundry is served over HTTPS** (a reverse proxy with TLS, or Forge
VTT hosting), the agent-service URL must also be HTTPS — e.g. behind a
reverse proxy with a real certificate, or a self-signed certificate the
GM's browser is configured to trust. Browsers block a plain-HTTP `fetch()`
from an HTTPS page as mixed content, and every call silently fails. A
plain LAN URL like `http://<host-ip>:8787` only works when Foundry itself
is also served over plain HTTP.

For local development without Docker, the same entrypoint is available
as an npm script (reads the same env vars from the shell or a `.env` in
the repo root):

```bash
npm run agent-service
```

## Configure Foundry

In this module's settings, set:

- **Agent Service URL** — the base URL where the deployed service is
  reachable, e.g. `https://agent.yourdomain.com` if reverse-proxied, or
  `http://<host-ip>:8787` on a LAN (only if Foundry is also plain HTTP —
  see the HTTPS note above).
- **Agent Service API Key** — the same value as `AGENT_SERVICE_API_KEY`
  you deployed the service with.

Both settings are **client-scoped** (`agentServiceUrl` /
`agentServiceApiKey` in `scripts/module.mjs`): they're stored in each
browser, not in the world, so the API key never syncs to players'
clients. That means they are per-GM-browser, not per-world — every GM
who might run a session needs to set them in their own browser (and again
after clearing browser storage or switching browsers/machines).

## Checking it's working

The robot icon in the token scene controls (title "Agent Loop Status")
pings the service's `/v1/health` endpoint directly and posts a
GM-whispered chat card saying whether the agent service is reachable, not
configured, or unreachable. You can trigger the same check from the
console:

```js
game.modules.get("pf2e-dungeon-crawl").api.postAgentLoopStatus();
```

## Configuring model tiers

The `litellm` sidecar exposes two model aliases: `fast` (for simple
decisions and customizations) and `reasoning` (for higher-stakes or
complex decisions). Both currently point to the same local Ollama model,
`qwen2.5:3b-instruct`, but you can point them to different models by
editing `tools/agent-service/litellm-config.yaml`.

For example, to use a faster model for `fast` and a larger model for
`reasoning`:

```yaml
model_list:
  - model_name: fast
    litellm_params:
      model: ollama/dolphin-mixtral
      api_base: http://host.docker.internal:11434
  - model_name: reasoning
    litellm_params:
      model: ollama/qwen2.5:32b-instruct-q5_k_m
      api_base: http://host.docker.internal:11434
```

After editing `litellm-config.yaml`, restart the litellm service to pick
up the change (no code rebuild required, since it is a volume-mounted
config file):

```bash
docker compose --env-file .env -f tools/agent-service/docker-compose.yml restart litellm
```

Or, if the service isn't yet running, bring up the full stack (including
litellm):

```bash
docker compose --env-file .env -f tools/agent-service/docker-compose.yml up -d
```

The `COMBAT_REASONING_CANDIDATE_THRESHOLD` env var (default `8`) controls
when the `reasoning` tier is requested: if a combat decision has more than
8 candidates, litellm routes to `reasoning`; 8 or fewer candidates use
`fast`.

## Migrating from older deployments

If you deployed the agent-service before this change, your `.env` file
likely contains environment variables that are no longer used:

- `AGENT_SERVICE_CUSTOMIZATION_PROVIDER` — remove this from your `.env`.
  Customizations now always go through litellm, using the same `fast`/
  `reasoning` model aliases combat decisions use (see "Configuring model
  tiers" above).
- `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`,
  `LOCAL_LLM_TIMEOUT_MS` — remove these. The local Ollama model is now
  configured in `tools/agent-service/litellm-config.yaml` instead, and
  `LITELLM_TIMEOUT_MS` replaces the old local timeout setting.
- `ANTHROPIC_API_KEY` — remove this. The sidecar handles model access
  (currently to a local model; point it at Claude or anything else by
  editing `litellm-config.yaml`).

If you had `PF2EDC_AGENT_PROVIDER=claude` explicitly set, change it to
`PF2EDC_AGENT_PROVIDER=litellm` (the new default).

The `litellm` service is now a required dependency. Bring up the full
stack including it:

```bash
docker compose --env-file .env -f tools/agent-service/docker-compose.yml up -d
```

Both `agent-service` and `litellm` must be running for the module to work.

## Self-hosting Laya (optional)

Only relevant if you set `PF2EDC_AGENT_PROVIDER=laya`. Laya (ConvAI
Innovations' open-weight, non-autoregressive "System 1" decision model)
is a separate thing you host yourself — it is not part of this repo or
this Docker Compose file.

As of this writing, ConvAI Innovations ships Laya as a Python package and
Hugging Face model (`pip install laya`, weights at
`convaiinnovations/laya` on Hugging Face), not as an official
Docker image or turnkey HTTP server — see
[github.com/NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) and
[laya.convaiinnovations.com](https://laya.convaiinnovations.com/) for the
canonical source. A few community projects wrap it in a Dockerized REST
API instead of the raw Python SDK (e.g. `suarify/laya-selfhost`,
`mroxso/laya-docker`, `TheNerdMan/docker-laya-api` on GitHub) — treat
these, and Laya's own docs, as the source of truth for exact clone/build/
run steps, ports, and hardware requirements (CPU works; a GPU is faster),
since they may change independently of this repo.

**Whatever hosting route you use, the important constraint is the wire
contract**: `tools/agent-service/providers/laya.mjs` (unchanged since
introduction) POSTs to `{LAYA_BASE_URL}/v1/predict` with a JSON body of
`{ state, questions: { candidate: { type: 'choice', instructions, criteria } } }`
and an optional `Authorization: Bearer <LAYA_API_KEY>` header, and expects
back `{ answers: { candidate: { choice: <criterionId> } } }` — the
protocol confirmed in #102. Point `LAYA_BASE_URL` at wherever your
self-hosted Laya instance ends up exposing that shape (directly, or
behind a small adapter if the hosting option you chose exposes a
different surface than `/v1/predict`).

## Troubleshooting

- **Combat decisions:** if the agent service is unreachable or
  misconfigured, agent-controlled combat falls back to the built-in
  heuristic and posts a chat notice saying so (unchanged mechanism —
  Foundry waits up to `AGENT_TIMEOUT_MS` before falling back). This is
  the same failure mode `postAgentLoopStatus()` above is meant to help
  you diagnose ahead of time.
- **Flavor customization:** if a trap/skill-challenge/puzzle/narrative
  customization call to the service fails, the room or trap silently
  keeps its original template content — it never blocks reveal or
  discovery, but you also won't get an error in Foundry itself.
- **Either way**, check the service's own logs for the underlying error:

  ```bash
  docker compose --env-file .env -f tools/agent-service/docker-compose.yml logs agent-service
  ```

  Common causes: `AGENT_SERVICE_API_KEY` mismatch between Foundry's
  module settings and the deployed service, `LITELLM_BASE_URL` pointing to
  an unreachable litellm instance (check the sidecar is running: `docker
  compose --env-file .env -f tools/agent-service/docker-compose.yml ps`), missing or
  misconfigured models in `tools/agent-service/litellm-config.yaml`, a
  missing/invalid `LAYA_API_KEY`/`LAYA_BASE_URL` if using the Laya
  provider, or the service simply not being reachable from Foundry's
  network (firewall, wrong host/port, reverse proxy misconfigured). If the
  browser console shows a CORS or mixed-content error, check
  `AGENT_SERVICE_ALLOWED_ORIGIN` and the HTTPS note above. If combat
  decisions are timing out, check `LITELLM_COMBAT_TIMEOUT_MS` (default
  30000ms); if flavor-customization calls are timing out, check
  `LITELLM_TIMEOUT_MS` (default 5 minutes) — on slow hardware or a slow
  model, the inference may just need more time. Check the litellm logs as
  well: `docker compose --env-file .env -f tools/agent-service/docker-compose.yml logs litellm`.
