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
docker compose -f tools/agent-service/docker-compose.yml up -d
```

This builds and runs the image defined by `tools/agent-service/Dockerfile`
and publishes it on port `8787`. Provide the following via a `.env` file
in the repo root (or the shell environment) before running it:

- `AGENT_SERVICE_API_KEY` — a secret you generate yourself, e.g.
  `openssl rand -hex 32`. The service refuses to start without this set
  (see `tools/agent-service/entrypoint.mjs`), and every request to it must
  present this key as a bearer token. Foundry needs the same value (see
  "Configure Foundry" below).
- `ANTHROPIC_API_KEY` — required for the default `claude` decision
  provider.

Optional, only needed if you want the Laya decision provider instead of
Claude:

- `PF2EDC_AGENT_PROVIDER=laya` — switches the combat-decision provider.
  Defaults to `claude` if unset.
- `LAYA_API_KEY` — bearer token for your Laya deployment, if it requires
  auth.
- `LAYA_BASE_URL` — base URL of your self-hosted Laya instance (see
  "Self-hosting Laya" below). Falls back to a default hosted instance if
  unset.

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
  `http://<host-ip>:8787` on a LAN.
- **Agent Service API Key** — the same value as `AGENT_SERVICE_API_KEY`
  you deployed the service with.

Both settings are world-scoped and GM-only (`agentServiceUrl` /
`agentServiceApiKey` in `scripts/module.mjs`).

## Checking it's working

The robot icon in the token scene controls (title "Agent Loop Status")
pings the service's `/v1/health` endpoint directly and posts a
GM-whispered chat card saying whether the agent service is reachable, not
configured, or unreachable. You can trigger the same check from the
console:

```js
game.modules.get('pf2e-dungeon-crawl').api.postAgentLoopStatus()
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
  docker compose -f tools/agent-service/docker-compose.yml logs agent-service
  ```

  Common causes: `AGENT_SERVICE_API_KEY` mismatch between Foundry's
  module settings and the deployed service, a missing/invalid
  `ANTHROPIC_API_KEY` (or `LAYA_API_KEY`/`LAYA_BASE_URL` if using the
  Laya provider), or the service simply not being reachable from
  Foundry's network (firewall, wrong host/port, reverse proxy
  misconfigured).
