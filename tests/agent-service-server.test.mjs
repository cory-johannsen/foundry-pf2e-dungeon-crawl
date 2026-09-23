import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from '../tools/agent-service/server.mjs';

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
