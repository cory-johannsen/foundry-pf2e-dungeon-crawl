import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { nodeFetch } from "../tools/agent-service/node-fetch.mjs";

// Real-HTTP tests (#161): nodeFetch exists to avoid undici's hidden
// headersTimeout, so a mocked transport would prove nothing.
let server;
const open = [];

function listen(handler) {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      open.push(res);
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}/`),
    );
  });
}

afterEach(async () => {
  for (const res of open.splice(0)) res.destroy();
  if (server) await new Promise((r) => server.close(r));
  server = null;
});

// Rejects the test (not the process) if `promise` hasn't settled in `ms`.
const settledWithin = (promise, ms) =>
  Promise.race([
    promise.then(
      (v) => ({ status: "resolved", value: v }),
      (e) => ({ status: "rejected", error: e }),
    ),
    new Promise((r) => setTimeout(() => r({ status: "pending" }), ms)),
  ]);

describe("nodeFetch (#161)", () => {
  it("round-trips a JSON POST", async () => {
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: JSON.parse(body), method: req.method }));
      });
    });
    const res = await nodeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: { a: 1 }, method: "POST" });
  });

  it("waits for a slow body with no hidden timeout when no signal is given", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      setTimeout(() => res.end("slow but fine"), 1200);
    });
    const res = await nodeFetch(url);
    expect(await res.text()).toBe("slow but fine");
  });

  it("resolves ok:false for an error status instead of rejecting", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const res = await nodeFetch(url);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("boom");
  });

  it("rejects when the signal aborts after headers arrive and the body stalls", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      res.write("partial"); // headers + some body, then never end
    });
    const outcome = await settledWithin(
      nodeFetch(url, { signal: AbortSignal.timeout(300) }),
      2000,
    );
    expect(outcome.status).toBe("rejected");
    expect(outcome.error.message).toMatch(/timed out/);
  });

  it("rejects when the signal aborts before any response", async () => {
    const url = await listen(() => {
      /* never respond */
    });
    const outcome = await settledWithin(
      nodeFetch(url, { signal: AbortSignal.timeout(300) }),
      2000,
    );
    expect(outcome.status).toBe("rejected");
    expect(outcome.error.message).toMatch(/timed out/);
  });

  it("rejects when the connection resets mid-body with no signal involved", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 100);
    });
    const outcome = await settledWithin(nodeFetch(url), 2000);
    expect(outcome.status).toBe("rejected");
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const url = await listen((_req, res) => res.end("never reached"));
    const outcome = await settledWithin(
      nodeFetch(url, { signal: AbortSignal.abort() }),
      2000,
    );
    expect(outcome.status).toBe("rejected");
    expect(outcome.error.message).toMatch(/timed out/);
  });
});
