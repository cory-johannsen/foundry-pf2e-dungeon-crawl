import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
