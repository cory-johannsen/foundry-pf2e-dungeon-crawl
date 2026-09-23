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
- `ANTHROPIC_API_KEY` — required for the default `claude` decision
  provider, and for the default `claude` flavor-customization provider
  (see "Using a local model instead of Claude" below for the
  no-Anthropic-account alternative).

Optional, only needed if you want the Laya decision provider instead of
Claude:

- `PF2EDC_AGENT_PROVIDER=laya` — switches the combat-decision provider.
  Defaults to `claude` if unset.
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
ANTHROPIC_API_KEY=sk-ant-...
```

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

## Using a local model instead of Claude (optional)

Flavor-customization generation (trap/skill-challenge/puzzle/narrative
room text, and treasure-room name+description) defaults to calling
Claude directly and needs `ANTHROPIC_API_KEY` for that. If you don't have
an Anthropic account — for example you're already running the Laya
provider for combat decisions and want to skip Anthropic entirely — you
can instead point flavor customization at any self-hosted,
OpenAI-compatible chat-completions server that supports tool/function
calling. This has been confirmed working against
[Ollama](https://ollama.com/) running `qwen2.5:3b-instruct`.

Set:

- `AGENT_SERVICE_CUSTOMIZATION_PROVIDER=local` — switches the
  flavor-customization provider. Defaults to `claude` if unset (no
  behavior change if you don't set this).
- `LOCAL_LLM_BASE_URL` — the base URL of your local server, **including
  any API-version path segment it needs**. Ollama's OpenAI-compatible
  routes live under `/v1`, so its base URL is `http://<host>:11434/v1`
  — this module always POSTs to `${LOCAL_LLM_BASE_URL}/chat/completions`.
  Required when the provider is `local`.
- `LOCAL_LLM_MODEL` — the model name as your local server knows it, e.g.
  `qwen2.5:3b-instruct`. Must support tool/function calling — this
  module always requests a forced tool call, the same way the `claude`
  path does. Required when the provider is `local`.
- `LOCAL_LLM_API_KEY` — optional bearer token. Most local
  OpenAI-compatible servers, including Ollama, don't require auth; set
  this only if yours does.
- `LOCAL_LLM_TIMEOUT_MS` — optional request timeout in milliseconds,
  default `300000` (5 minutes). Local inference on modest hardware is
  genuinely slow and variable — flavor-customization requests during
  testing against `qwen2.5:3b-instruct` on a modest 6-core CPU under real
  memory pressure ranged from about 2 minutes up to **over 6 minutes**
  for one full trap name+description generation, i.e. sometimes _past_
  the 5-minute default. This is a real, accepted tradeoff for running
  without Anthropic, not a bug: flavor customization already never
  blocks anything synchronously (see "Troubleshooting" below) — a room
  or trap keeps its template content until the (slow) call finishes or
  fails, then updates. If you see local-provider requests failing with a
  timeout, raise `LOCAL_LLM_TIMEOUT_MS` rather than assume something is
  broken. Don't expect anything close to Claude-speed responses; a
  faster/larger local model or better hardware will help, but budget for
  genuinely slow generation either way.

### The `host.docker.internal` networking requirement

**This is the single most likely thing to silently not work.** The
agent service runs inside its own Docker container (this
`docker-compose.yml`), separate from wherever you run your local model
server (e.g. Ollama, itself often in its own container). Inside a
container, `localhost` refers to the container itself, not the Docker
host — so `LOCAL_LLM_BASE_URL=http://localhost:11434/v1` will silently
fail to reach a host-run Ollama once this service is deployed via
`docker compose`, even though the exact same URL works fine testing
directly on the host (e.g. `node tools/agent-service/server.mjs` outside
Docker, or a local `curl`).

This `docker-compose.yml` already adds the fix
(`extra_hosts: ["host.docker.internal:host-gateway"]` on the
`agent-service` service) — the standard, portable (Linux/Mac/Windows)
Docker Compose mechanism for letting a container reach a service running
on its Docker host. With that in place, point `LOCAL_LLM_BASE_URL` at
`http://host.docker.internal:11434/v1` (adjust the port for your local
server) instead of `localhost`, and the agent-service container will
reach a host-run Ollama correctly.

If your local model server itself also runs in Docker (e.g. Ollama's own
official image) on the same Docker host, `host.docker.internal` still
works, because it resolves to the host's own network, not into another
container — as long as that server's port is published to the host (as
`ollama/ollama`'s default port mapping does).

Quick way to run Ollama itself via Docker, for reference:

```bash
docker run -d --name ollama -p 127.0.0.1:11434:11434 ollama/ollama
docker exec ollama ollama pull qwen2.5:3b-instruct
```

Then set (in the repo-root `.env`, or the shell environment before
`docker compose up`):

```
AGENT_SERVICE_CUSTOMIZATION_PROVIDER=local
LOCAL_LLM_BASE_URL=http://host.docker.internal:11434/v1
LOCAL_LLM_MODEL=qwen2.5:3b-instruct
```

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
  module settings and the deployed service, a missing/invalid
  `ANTHROPIC_API_KEY` (or `LAYA_API_KEY`/`LAYA_BASE_URL` if using the
  Laya provider), or the service simply not being reachable from
  Foundry's network (firewall, wrong host/port, reverse proxy
  misconfigured). If the browser console shows a CORS or mixed-content
  error, check `AGENT_SERVICE_ALLOWED_ORIGIN` and the HTTPS note above.
  If `AGENT_SERVICE_CUSTOMIZATION_PROVIDER=local`, also check: a missing
  `LOCAL_LLM_BASE_URL`/`LOCAL_LLM_MODEL` fails fast with a clear error in
  the logs; `LOCAL_LLM_BASE_URL=http://localhost:...` will _not_ reach a
  host-run server from inside the container — use
  `http://host.docker.internal:...` instead (see "Using a local model
  instead of Claude" above); and a timeout under `LOCAL_LLM_TIMEOUT_MS`
  (default 5 minutes) on slow hardware just means the model hasn't
  finished yet, not that something is broken — try a smaller model or a
  longer timeout.
