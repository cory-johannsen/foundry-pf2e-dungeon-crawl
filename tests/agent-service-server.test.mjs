import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from '../tools/agent-service/server.mjs';
import { resolveProvider } from '../tools/agent-service/providers/index.mjs';

// Wraps the real resolveProvider so every existing test (which relies on
// the real claude.mjs decide() — see the 502 test's real-network-failure
// path below) keeps working unchanged, while individual tests can swap in
// a stub decide() via mockReturnValueOnce for a single call.
vi.mock('../tools/agent-service/providers/index.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveProvider: vi.fn(actual.resolveProvider)
  };
});

describe('agent-service server', () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    server = createServer({ apiKey: 'test-key' });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('GET /v1/health returns 200 with no auth required', async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('GET /v1/health includes Access-Control-Allow-Origin so a browser can read it', async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers a CORS preflight OPTIONS on a protected route with 204 and no auth required', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
  });

  it('includes Access-Control-Allow-Origin on error responses too (401, 404)', async () => {
    const unauthorized = await fetch(`${baseUrl}/v1/flavor-customization`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe('*');
    const notFound = await fetch(`${baseUrl}/v1/nonexistent`);
    expect(notFound.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('uses an explicit allowedOrigin instead of * when one is configured', async () => {
    const locked = createServer({ apiKey: 'test-key', allowedOrigin: 'https://foundry.example.com' });
    await new Promise((resolve) => locked.listen(0, resolve));
    try {
      const url = `http://127.0.0.1:${locked.address().port}`;
      const preflight = await fetch(`${url}/v1/flavor-customization`, { method: 'OPTIONS' });
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://foundry.example.com');
      const health = await fetch(`${url}/v1/health`);
      expect(health.headers.get('access-control-allow-origin')).toBe('https://foundry.example.com');
    } finally {
      await new Promise((resolve) => locked.close(resolve));
    }
  });

  it('rejects a protected route with 401 when the Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with 401 when the bearer token is wrong', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key' },
      body: '{}'
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/v1/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('rejects a protected route with 401 when the bearer token has the wrong length', async () => {
    // Regression coverage for the constant-time compare: the length-check
    // short-circuit is a separate branch from timingSafeEqual and must
    // also reject (not throw, not crash the handler).
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer short' },
      body: '{}'
    });
    expect(res.status).toBe(401);
  });

  it('returns a clean 400 instead of crashing when the request body stream errors on a protected route', async () => {
    // Exercises readBody's rejection path directly by invoking the
    // server's request listener with a fake req that emits 'error' after
    // auth succeeds, since reliably forcing a real socket-level stream
    // error through fetch()/undici is not straightforward in this setup.
    const [listener] = server.listeners('request');

    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/v1/combat-decision';
    req.headers = { authorization: 'Bearer test-key' };

    let statusCode;
    let responseBody = '';
    const res = {
      writeHead: (status) => {
        statusCode = status;
      },
      end: (chunk) => {
        responseBody = chunk;
      }
    };

    const handled = listener(req, res);
    req.emit('error', new Error('simulated socket error'));
    await handled;

    expect(statusCode).toBe(400);
    expect(JSON.parse(responseBody)).toEqual({ error: 'invalid JSON body' });
  });
});

describe('POST /v1/combat-decision', () => {
  let server;
  let baseUrl;
  const originalProvider = process.env.PF2EDC_AGENT_PROVIDER;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.PF2EDC_AGENT_PROVIDER = 'claude';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    server = createServer({ apiKey: 'test-key' });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (originalProvider === undefined) delete process.env.PF2EDC_AGENT_PROVIDER;
    else process.env.PF2EDC_AGENT_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('returns 400 when candidates is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ self: {}, opponents: [], roundNumber: 1 })
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 with a clear error when the upstream provider fails', async () => {
    // No real Anthropic call happens in this test: PF2EDC_AGENT_PROVIDER
    // resolves to the real claude.mjs decide(), which reads
    // ANTHROPIC_API_KEY from the environment set in beforeEach and calls
    // the real https://api.anthropic.com endpoint via the real global
    // fetch — that call fails in this sandboxed test environment (no
    // network access / invalid key), which is exactly the failure path
    // this test wants to exercise: a real upstream failure surfacing as a
    // clean 502, not an unhandled rejection or a hung request.
    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        self: { name: 'Yamaraj', hp: 40, conditions: [] },
        opponents: [],
        candidates: [{ id: 'endTurn', summary: 'End turn' }],
        roundNumber: 1
      })
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 200 with the provider decision passed through unmodified', async () => {
    const stubDecide = vi.fn().mockResolvedValue({ candidateId: 'endTurn', rationale: 'test rationale' });
    resolveProvider.mockReturnValueOnce(stubDecide);

    const res = await fetch(`${baseUrl}/v1/combat-decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        self: { name: 'Yamaraj', hp: 40, conditions: [] },
        opponents: [],
        candidates: [{ id: 'endTurn', summary: 'End turn' }],
        roundNumber: 1
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ candidateId: 'endTurn', rationale: 'test rationale' });
  });
});

describe('POST /v1/flavor-customization', () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    server = createServer({ apiKey: 'test-key' });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns 400 when kind is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/flavor-customization`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'a1' })
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown kind', async () => {
    const res = await fetch(`${baseUrl}/v1/flavor-customization`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'not-a-real-kind' })
    });
    expect(res.status).toBe(400);
  });
});
