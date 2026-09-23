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
