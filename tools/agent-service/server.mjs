import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolveProvider } from "./providers/index.mjs";
import { generateCustomization } from "./customization-generator.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const PROTECTED_ROUTES = new Set(["/v1/combat-decision", "/v1/flavor-customization"]);

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

const KNOWN_KINDS = new Set(["trap", "skill_challenge", "puzzle", "narrative"]);

/** Always calls generateCustomization(), which talks to litellm directly —
 * never resolveProvider() — because Laya cannot generate free text. This
 * route must not become provider-selectable. */
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** Every response carries Access-Control-Allow-Origin so a browser (Foundry
 * calls this service via fetch() from a different origin) is allowed to
 * read it. The request handler stashes the resolved origin on `res`, so
 * every sendJson call site gets the header without threading it through. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": res.allowedOrigin ?? "*"
  });
  res.end(JSON.stringify(body));
}

/** Constant-time bearer-token check. Uses `timingSafeEqual` so a wrong
 * guess doesn't leak how many leading characters matched via response
 * timing. `timingSafeEqual` throws on mismatched buffer lengths, so we
 * length-check first — that's safe here because the token's *length*
 * isn't the secret, only its value is. */
function isAuthorized(req, apiKey) {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${apiKey}`;
  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (headerBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(headerBuf, expectedBuf);
}

/** Creates an unstarted node:http server. `apiKey` is the single shared
 * bearer-token secret this GM's Foundry client authenticates with — see
 * the design spec's "Deployment and ownership model" for why one secret
 * per self-hosted instance is sufficient (no multi-tenant isolation
 * needed). Routes are registered here in Task 2 (health, auth gate) and
 * extended by Task 3 (/v1/combat-decision) and Task 4
 * (/v1/flavor-customization).
 *
 * `allowedOrigin` is the CORS Access-Control-Allow-Origin value sent on
 * every response: AGENT_SERVICE_ALLOWED_ORIGIN if set, else `*`. `*` is
 * safe here because auth is a bearer token in a header, not a cookie. */
export function createServer({
  apiKey,
  allowedOrigin = readEnvOrDotenv("AGENT_SERVICE_ALLOWED_ORIGIN") || "*"
}) {
  return createHttpServer(async (req, res) => {
    res.allowedOrigin = allowedOrigin;

    // CORS preflight — answered before the auth gate, since a browser's
    // preflight OPTIONS never carries the Authorization header.
    if (req.method === "OPTIONS" && req.url?.startsWith("/v1/")) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type"
      });
      return res.end();
    }

    if (req.method === "GET" && req.url === "/v1/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (PROTECTED_ROUTES.has(req.url) && req.method === "POST") {
      if (!isAuthorized(req, apiKey)) return sendJson(res, 401, { error: "unauthorized" });
      let body;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw || "{}");
      } catch {
        // Covers both a malformed JSON body and a request-stream error
        // (e.g. the client aborts mid-upload) — readBody's rejection
        // lands here too, so neither can escape as an unhandled
        // rejection inside the request handler.
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      if (req.url === "/v1/combat-decision") {
        return handleCombatDecision(body, res);
      }
      if (req.url === "/v1/flavor-customization") {
        return handleFlavorCustomization(body, res);
      }
    }

    return sendJson(res, 404, { error: "not found" });
  });
}
