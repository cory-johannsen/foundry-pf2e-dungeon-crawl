import { describe, it, expect, vi } from 'vitest';
import { fetchCombatDecision, fetchFlavorCustomization } from '../scripts/agent-service-client.mjs';

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
