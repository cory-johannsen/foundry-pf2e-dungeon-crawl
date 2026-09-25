import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** A minimal, dependency-free fetch-compatible client for talking to a
 * local/self-hosted OpenAI-compatible HTTP endpoint (litellm, or directly
 * to Ollama).
 *
 * This deliberately avoids Node's built-in global `fetch`: it's backed by
 * undici, which imposes its own internal `headersTimeout` (default
 * 300000ms) that is NOT governed by the `AbortSignal` passed to fetch() —
 * confirmed live against this module's local-provider path: a
 * slow-but-legitimate local-model response (minutes, not seconds, is
 * normal for local inference on modest hardware) tripped undici's hidden
 * watchdog before our own configured timeout even fired, surfacing as a
 * confusing raw `TypeError: fetch failed` / `UND_ERR_HEADERS_TIMEOUT`
 * instead of a clean, documented abort. Raw node:http/node:https requests
 * have no such hidden ceiling, so `signal` (AbortSignal.timeout(...)) is
 * the only thing that can end this request early. */
export function nodeFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
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
        reject(new Error("nodeFetch: request timed out"));
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
