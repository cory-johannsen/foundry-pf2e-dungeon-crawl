import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readEnvOrDotenv } from "./env.mjs";

const CLAUDE_MODEL = "claude-sonnet-5";
// A locally-hosted, OpenAI-compatible chat-completions server is
// meaningfully slower than Claude on modest hardware (confirmed: minutes,
// not seconds, per-request on a modest CPU) so it gets a much longer
// default budget than the Claude path's 30s. Still finite so a genuinely
// stuck local server surfaces as a 502 instead of hanging forever.
const LOCAL_TIMEOUT_DEFAULT_MS = 300000;

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
          properties: {
            label: { type: "string" },
            consequence: { type: "string" },
          },
          required: ["label", "consequence"],
        },
        minItems: 2,
        maxItems: 2,
      },
      suggestedObjective: { type: "string" },
    },
    required: ["name", "summary"],
  },
  treasure: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
    },
    required: ["name", "summary"],
  },
};

// Per-kind tool descriptions. Defaults to a generic sentence; "narrative"
// overrides it with the archetype→field guidance that
// tools/agent-loop/mcp-server.mjs's retired submit_narrative_customization
// tool spelled out explicitly (see its description there). The narrative
// schema lists revealText/npcName/npcHook/options/suggestedObjective as
// siblings with no schema-level conditional gating — without this text the
// model has no way to know which archetype implies which optional field.
const TOOL_DESCRIPTIONS = {
  narrative:
    'Write flavor text for a Pathfinder 2e dungeon narrative room. Never invent mechanics — only name/summary/flavor text. Only supply the fields matching this entry\'s own archetype: "lore" wants revealText; "ally" wants npcName and npcHook; "choice" wants exactly 2 options (each with a label and a consequence); "goal" wants suggestedObjective. name/summary always apply.',
};

function toolDescription(kind) {
  return (
    TOOL_DESCRIPTIONS[kind] ??
    `Write flavor text for a Pathfinder 2e dungeon ${kind.replace("_", " ")}. Never invent mechanics — only name/description/summary/flavor text.`
  );
}

/** A minimal, dependency-free fetch-compatible client — the local
 * provider's default transport, used only when the caller doesn't inject
 * its own `fetchImpl` (e.g. in tests).
 *
 * This deliberately avoids Node's built-in global `fetch`: it's backed by
 * undici, which imposes its own internal `headersTimeout` (default
 * 300000ms) that is NOT governed by the `AbortSignal` passed to fetch() —
 * confirmed live against this module's own local-provider path: a
 * slow-but-legitimate Ollama response (minutes, not seconds, is normal
 * for local inference on modest hardware — the whole reason
 * LOCAL_LLM_TIMEOUT_MS defaults to five minutes) tripped undici's hidden
 * watchdog before our own configured timeout even fired, surfacing as a
 * confusing raw `TypeError: fetch failed` / `UND_ERR_HEADERS_TIMEOUT`
 * instead of a clean, documented abort. Raw node:http/node:https requests
 * have no such hidden ceiling, so `signal` (AbortSignal.timeout(...)) is
 * the only thing that can end this request early. */
function nodeFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
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
        reject(
          new Error(
            "customization-generator: local provider request timed out",
          ),
        );
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

function userMessageContent(kind, context) {
  return `Write fitting flavor text for this ${kind.replace("_", " ")}, matching its mechanical context. Only fill fields that make sense for this entry.\n\n${JSON.stringify(context, null, 2)}`;
}

async function generateWithClaude(
  kind,
  context,
  schema,
  { apiKey, fetchImpl },
) {
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
          description: toolDescription(kind),
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "customize" },
      messages: [{ role: "user", content: userMessageContent(kind, context) }],
    }),
    // Fails a stuck upstream call promptly (surfacing as a 502) rather than
    // hanging, so it can't block the other kinds queued behind it.
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `customization-generator: API request failed (${res.status}): ${errBody}`,
    );
  }

  const payload = await res.json();
  const toolUse = payload.content?.find(
    (c) => c.type === "tool_use" && c.name === "customize",
  );
  if (!toolUse)
    throw new Error(
      "customization-generator: no customize tool call in response",
    );
  return toolUse.input;
}

/** Talks to a self-hosted, OpenAI-compatible chat-completions endpoint
 * (e.g. Ollama) instead of Claude. `baseUrl` is expected to already
 * include any API-version path segment the server needs (e.g.
 * `http://host.docker.internal:11434/v1` for Ollama) — this function
 * always POSTs to `${baseUrl}/chat/completions`, matching Ollama's
 * documented OpenAI-compatibility route.
 *
 * Uses the OpenAI tool-call request/response shape, which differs from
 * Claude's: tools are `{type: "function", function: {name, description,
 * parameters}}` (not Claude's flat `{name, description, input_schema}`),
 * and the result arrives as a JSON *string* at
 * `choices[0].message.tool_calls[0].function.arguments` (Claude's
 * `content[].input` is already a parsed object). */
async function generateWithLocal(
  kind,
  context,
  schema,
  { baseUrl, model, localApiKey, timeoutMs, fetchImpl },
) {
  if (!baseUrl)
    throw new Error(
      "customization-generator: LOCAL_LLM_BASE_URL is required when AGENT_SERVICE_CUSTOMIZATION_PROVIDER=local",
    );
  if (!model)
    throw new Error(
      "customization-generator: LOCAL_LLM_MODEL is required when AGENT_SERVICE_CUSTOMIZATION_PROVIDER=local",
    );

  const headers = { "Content-Type": "application/json" };
  if (localApiKey) headers.Authorization = `Bearer ${localApiKey}`;

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: userMessageContent(kind, context) }],
      tools: [
        {
          type: "function",
          function: {
            name: "customize",
            description: toolDescription(kind),
            parameters: schema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "customize" } },
    }),
    // Local inference is genuinely much slower than Claude's hosted API on
    // modest hardware (confirmed: minutes, not seconds, per request) — this
    // is an accepted tradeoff, not a bug to route around. Flavor
    // customization never blocks synchronously on this call either way.
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `customization-generator: local provider request failed (${res.status}): ${errBody}`,
    );
  }

  const payload = await res.json();
  const rawArguments =
    payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments)
    throw new Error(
      "customization-generator: no customize tool call in response",
    );
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(
      `customization-generator: local provider returned invalid tool call arguments JSON: ${err.message}`,
    );
  }
}

/** Never changes gameplay values — only name/description/summary/flavor
 * text, mirroring the field-scoping rules tools/agent-loop/mcp-server.mjs's
 * submit_*_customization tools already enforced. `kind` selects which of
 * the five schemas is offered; the model can only fill fields real for
 * that kind.
 *
 * Provider selection is internal to this function, read the same way
 * resolveProvider() in providers/index.mjs reads PF2EDC_AGENT_PROVIDER:
 * AGENT_SERVICE_CUSTOMIZATION_PROVIDER, defaulting to "claude" so existing
 * Claude-key holders see no behavior change. "local" talks to a
 * self-hosted, OpenAI-compatible chat-completions endpoint instead —
 * this module still never goes through resolveProvider()/providers/
 * index.mjs itself, because Laya cannot generate free text and must
 * remain unreachable from this route under any configuration. */
export async function generateCustomization(
  kind,
  context,
  {
    apiKey = readEnvOrDotenv("ANTHROPIC_API_KEY"),
    fetchImpl,
    provider = readEnvOrDotenv("AGENT_SERVICE_CUSTOMIZATION_PROVIDER") ??
      "claude",
    baseUrl = readEnvOrDotenv("LOCAL_LLM_BASE_URL"),
    model = readEnvOrDotenv("LOCAL_LLM_MODEL"),
    localApiKey = readEnvOrDotenv("LOCAL_LLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LOCAL_LLM_TIMEOUT_MS")) ||
      LOCAL_TIMEOUT_DEFAULT_MS,
  } = {},
) {
  const schema = SCHEMAS[kind];
  if (!schema)
    throw new Error(`customization-generator: unknown kind "${kind}"`);

  if (provider === "claude") {
    return generateWithClaude(kind, context, schema, {
      apiKey,
      fetchImpl: fetchImpl ?? fetch,
    });
  }
  if (provider === "local") {
    return generateWithLocal(kind, context, schema, {
      baseUrl,
      model,
      localApiKey,
      timeoutMs,
      // See nodeFetch()'s doc comment: global fetch's hidden headersTimeout
      // makes it unsafe as this path's default transport.
      fetchImpl: fetchImpl ?? nodeFetch,
    });
  }
  throw new Error(
    `customization-generator: unknown AGENT_SERVICE_CUSTOMIZATION_PROVIDER "${provider}" — options: claude, local`,
  );
}
