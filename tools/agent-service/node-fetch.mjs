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
    // #161: several paths can end this request (response end, response
    // error/premature close, request error, abort); only the first counts.
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const target = new URL(url);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(target, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        settle(resolve, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
      // #161: once headers have arrived, req's own "error" no longer covers
      // the body -- a stalled or reset body used to leave this promise
      // pending forever, past the caller's AbortSignal.timeout.
      res.on("error", (err) => settle(reject, err));
      res.on("close", () => {
        if (!res.complete) {
          settle(reject, new Error("nodeFetch: response ended prematurely"));
        }
      });
    });
    req.on("error", (err) => {
      if (signal?.aborted) {
        settle(reject, new Error("nodeFetch: request timed out"));
      } else {
        settle(reject, err);
      }
    });
    if (signal) {
      // Reject straight from the abort, whether or not a response has
      // started, rather than relying on the destroyed request to surface it.
      const onAbort = () => {
        settle(reject, new Error("nodeFetch: request timed out"));
        req.destroy();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}
