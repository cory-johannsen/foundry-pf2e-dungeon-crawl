import { describe, it, expect, vi } from 'vitest';
import { fetchCombatDecision, fetchFlavorCustomization, fetchCombatCandidates } from '../scripts/agent-service-client.mjs';

function fakeFetch(status, body) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
}

describe('agent-service-client', () => {
  it('fetchCombatDecision POSTs the context to /v1/combat-decision with a bearer token', async () => {
    const fetchImpl = fakeFetch(200, { candidateId: 'endTurn', rationale: 'Nothing worth doing.' });
    const context = { self: {}, opponents: [], candidates: [{ id: 'endTurn' }], roundNumber: 1 };
    const result = await fetchCombatDecision({ baseUrl: 'https://agent.example', apiKey: 'k', context, fetchImpl });

    expect(result).toEqual({ candidateId: 'endTurn', rationale: 'Nothing worth doing.' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example/v1/combat-decision');
    expect(options.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(options.body)).toEqual(context);
  });

  it('strips a trailing slash from baseUrl so the path has a single slash', async () => {
    const fetchImpl = fakeFetch(200, { candidateId: 'endTurn' });
    await fetchCombatDecision({ baseUrl: 'https://agent.example/', apiKey: 'k', context: {}, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://agent.example/v1/combat-decision');
  });

  it('passes an AbortSignal so an unresponsive service times out instead of hanging', async () => {
    const fetchImpl = fakeFetch(200, { candidateId: 'endTurn' });
    await fetchCombatDecision({ baseUrl: 'https://agent.example', apiKey: 'k', context: {}, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('fetchCombatDecision throws with the response status and error on a non-ok response', async () => {
    const fetchImpl = fakeFetch(502, { error: 'provider call failed: boom' });
    await expect(
      fetchCombatDecision({ baseUrl: 'https://agent.example', apiKey: 'k', context: {}, fetchImpl })
    ).rejects.toThrow(/502.*boom/s);
  });

  it('fetchFlavorCustomization POSTs kind plus context to /v1/flavor-customization', async () => {
    const fetchImpl = fakeFetch(200, { name: 'The Weeping Door', description: 'Drips illusory blood.' });
    const result = await fetchFlavorCustomization({
      baseUrl: 'https://agent.example',
      apiKey: 'k',
      kind: 'trap',
      context: { actorId: 'a1' },
      fetchImpl
    });

    expect(result).toEqual({ name: 'The Weeping Door', description: 'Drips illusory blood.' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example/v1/flavor-customization');
    expect(JSON.parse(options.body)).toEqual({ kind: 'trap', actorId: 'a1' });
  });
});

describe('fetchCombatCandidates', () => {
  it('posts context and vocabulary to /v1/combat-candidates with a bearer token', async () => {
    const fetchImpl = fakeFetch(200, { picks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'r' }] });
    const result = await fetchCombatCandidates({
      baseUrl: 'https://agent.example',
      apiKey: 'test-key',
      context: { self: {}, roundNumber: 1 },
      vocabulary: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }],
      fetchImpl
    });
    expect(result).toEqual({ picks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'r' }] });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example/v1/combat-candidates');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(options.body)).toEqual({ self: {}, roundNumber: 1, vocabulary: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }] });
  });

  it("throws with the service's own error message on a non-ok response", async () => {
    const fetchImpl = fakeFetch(502, { error: 'boom' });
    await expect(
      fetchCombatCandidates({ baseUrl: 'https://agent.example', apiKey: 'k', context: {}, vocabulary: [], fetchImpl })
    ).rejects.toThrow(/\/v1\/combat-candidates failed \(502\): boom/);
  });
});

describe('fetchCombatDecision timeout override (#931)', () => {
  it('calls AbortSignal.timeout with the given timeoutMs, not the 35s default', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = fakeFetch(200, { candidateId: 'x', rationale: null });
      await fetchCombatDecision({
        baseUrl: 'https://agent.example', apiKey: 'k',
        context: { candidates: [{ id: 'x', summary: 'x' }] }, fetchImpl, timeoutMs: 5000,
      });
      expect(spy).toHaveBeenCalledWith(5000);
      expect(spy).not.toHaveBeenCalledWith(35000);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the existing 35s default when timeoutMs is omitted', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = fakeFetch(200, { candidateId: 'x', rationale: null });
      await fetchCombatDecision({
        baseUrl: 'https://agent.example', apiKey: 'k',
        context: { candidates: [{ id: 'x', summary: 'x' }] }, fetchImpl,
      });
      expect(spy).toHaveBeenCalledWith(35000);
    } finally {
      spy.mockRestore();
    }
  });
});
