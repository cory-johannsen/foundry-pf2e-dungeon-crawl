import { createServer as createHttpServer } from "node:http";

const PROTECTED_ROUTES = new Set(["/v1/combat-decision", "/v1/flavor-customization"]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req, apiKey) {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${apiKey}`;
}

/** Creates an unstarted node:http server. `apiKey` is the single shared
 * bearer-token secret this GM's Foundry client authenticates with — see
 * the design spec's "Deployment and ownership model" for why one secret
 * per self-hosted instance is sufficient (no multi-tenant isolation
 * needed). Routes are registered here in Task 2 (health, auth gate) and
 * extended by Task 3 (/v1/combat-decision) and Task 4
 * (/v1/flavor-customization). */
export function createServer({ apiKey }) {
  return createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (PROTECTED_ROUTES.has(req.url) && req.method === "POST") {
      if (!isAuthorized(req, apiKey)) return sendJson(res, 401, { error: "unauthorized" });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      // Route-specific handling added in Task 3 / Task 4.
      return sendJson(res, 501, { error: "not implemented" });
    }

    return sendJson(res, 404, { error: "not found" });
  });
}
