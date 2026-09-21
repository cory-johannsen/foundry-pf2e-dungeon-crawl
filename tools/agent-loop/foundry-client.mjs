/**
 * Thin wrapper around the foundry-rest relay's own HTTP protocol
 * (POST {base}/execute-js?clientId=... — see .claude/skills/foundry-rest/
 * foundry-exec.sh for the reference implementation this mirrors). Talks to
 * a self-hosted foundryvtt-rest-api-relay instance by default (unlimited
 * requests, no third-party dependency — see the design doc's Alternatives
 * Considered section for why).
 */

import { readFileSync } from "node:fs";

/** Reads `name` from the real shell environment first, falling back to a
 * `.env` file in the current working directory — the same lookup every var
 * in this tool's README is documented against (`ANTHROPIC_API_KEY` included,
 * see `providers/claude.mjs`), so exported for provider modules to reuse
 * rather than each reimplementing (or silently not implementing) it. */
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

// #115: during live testing, the relay's connection to the Foundry client
// dropped and recovered three separate times, but the already-running
// poller kept failing with "Invalid client ID" indefinitely even after the
// relay's own /clients endpoint showed the client back online — only
// killing and restarting the process fixed it, and a fresh process picked
// up the recovered connection immediately. That points at Node's `fetch`
// (undici) reusing a pooled keep-alive socket that went bad when the relay
// dropped, rather than opening a fresh one on retry. `Connection: close` on
// every request tells the client not to keep that socket around, so each
// call opens its own connection instead of silently reusing a dead one.
// This mitigates the reported failure mode; it hasn't been proven
// decisively, since the relay's flakiness isn't reproducible on demand here.
const NO_KEEPALIVE_HEADERS = { Connection: "close" };

export async function findOnlineClientId({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${baseUrl}/clients`, {
    headers: { "x-api-key": apiKey, ...NO_KEEPALIVE_HEADERS },
  });
  const body = await res.json();
  const clients = body.clients ?? [];
  const chosen = clients.find((c) => c.isOnline) ?? clients[0];
  if (!chosen)
    throw new Error(
      "foundry-client: no Foundry client registered with the relay",
    );
  return chosen.clientId;
}

/** Runs `script` inside the live Foundry world and returns its `result`.
 * Throws on a relay-level refusal or a script-level error, with the same
 * distinction foundry-exec.sh makes (banned pattern / no client / thrown). */
export async function runFoundryScript(
  script,
  {
    baseUrl = readEnvOrDotenv("FOUNDRY_BASE_URL"),
    apiKey = readEnvOrDotenv("FOUNDRY_REST_API_KEY"),
    clientId = readEnvOrDotenv("FOUNDRY_CLIENT_ID"),
    fetchImpl = fetch,
  } = {},
) {
  // No default to the public foundryrestapi.com relay — its 100
  // requests/month free tier is incompatible with polling every few
  // seconds (see the design doc's Alternatives Considered section and this
  // tool's README step 1). A missing/misspelled FOUNDRY_BASE_URL must fail
  // loudly here, not silently point the poller at the public relay and
  // exhaust its month's quota in minutes.
  if (!baseUrl) throw new Error("foundry-client: FOUNDRY_BASE_URL not set");
  if (!apiKey) throw new Error("foundry-client: FOUNDRY_REST_API_KEY not set");
  const client =
    clientId ?? (await findOnlineClientId({ baseUrl, apiKey, fetchImpl }));
  const res = await fetchImpl(`${baseUrl}/execute-js?clientId=${client}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...NO_KEEPALIVE_HEADERS,
    },
    body: JSON.stringify({ script }),
  });
  const body = await res.json();
  if (body.success === false)
    throw new Error(`foundry-client: script threw: ${body.error ?? "unknown"}`);
  if (body.error) throw new Error(`foundry-client: ${body.error}`);
  return body.result;
}
