import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolate from whatever's really in this repo's .env (a real LAYA_API_KEY is
// checked in for local dev use) — decide()'s apiKey default reads it via
// readEnvOrDotenv, so without this mock these tests would depend on, and
// leak, the real secret.
vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('ENOENT: no such file'); }
}));

const { decide } = await import('../tools/agent-loop/providers/laya.mjs');

const CONTEXT = {
  self: { name: 'Yamaraj', hp: 40, conditions: [] },
  opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: 'strike:claw:opp1', summary: 'Claw vs Fighter (variant 0)' },
    { id: 'endTurn', summary: 'End turn' }
  ],
  roundNumber: 1
};

function fakeFetch(answersJson, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ model: 'laya-rl-agent', answers: JSON.parse(answersJson), usage: {} }),
    text: async () => answersJson
  });
}

describe('laya provider decide()', () => {
  const originalApiKey = process.env.LAYA_API_KEY;

  beforeEach(() => {
    delete process.env.LAYA_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.LAYA_API_KEY;
    else process.env.LAYA_API_KEY = originalApiKey;
  });

  it('sends the context as state and the candidates as a choice question', async () => {
    const fetchImpl = fakeFetch('{"candidate": {"type": "choice", "choice": "strike:claw:opp1", "probabilities": {"strike:claw:opp1": 0.7, "endTurn": 0.3}, "confidence": 0.6}}');
    await decide(CONTEXT, { apiKey: 'test-key', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://laya.johannsen.cloud/v1/predict');
    const body = JSON.parse(options.body);
    expect(body.state).toEqual({ self: CONTEXT.self, opponents: CONTEXT.opponents, roundNumber: CONTEXT.roundNumber });
    expect(body.questions.candidate.type).toBe('choice');
    expect(body.questions.candidate.criteria).toEqual({
      'strike:claw:opp1': 'Claw vs Fighter (variant 0)',
      endTurn: 'End turn'
    });
  });

  it('sends an Authorization header when apiKey is set, omits it otherwise', async () => {
    const fetchWithKey = fakeFetch('{"candidate": {"type": "choice", "choice": "endTurn", "probabilities": {"endTurn": 1}}}');
    await decide(CONTEXT, { apiKey: 'test-key', fetchImpl: fetchWithKey });
    expect(fetchWithKey.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');

    const fetchNoKey = fakeFetch('{"candidate": {"type": "choice", "choice": "endTurn", "probabilities": {"endTurn": 1}}}');
    await decide(CONTEXT, { fetchImpl: fetchNoKey });
    expect(fetchNoKey.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('returns the chosen candidateId with no rationale (Laya has no native text generation)', async () => {
    const fetchImpl = fakeFetch('{"candidate": {"type": "choice", "choice": "strike:claw:opp1", "probabilities": {"strike:claw:opp1": 0.7, "endTurn": 0.3}, "confidence": 0.6}}');
    const result = await decide(CONTEXT, { apiKey: 'test-key', fetchImpl });
    expect(result).toEqual({ candidateId: 'strike:claw:opp1', rationale: undefined });
  });

  it('truncates the criteria to endTurn plus the first 19 others when there are more than 20 candidates', async () => {
    const manyCandidates = Array.from({ length: 25 }, (_, i) => ({ id: `strike:claw:opp${i}`, summary: `Claw vs opp${i}` }));
    const context = { ...CONTEXT, candidates: [...manyCandidates, { id: 'endTurn', summary: 'End turn' }] };
    const fetchImpl = fakeFetch('{"candidate": {"type": "choice", "choice": "endTurn", "probabilities": {"endTurn": 1}}}');
    await decide(context, { apiKey: 'test-key', fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const criteriaKeys = Object.keys(body.questions.candidate.criteria);
    expect(criteriaKeys).toHaveLength(20);
    expect(criteriaKeys).toContain('endTurn');
    expect(criteriaKeys).toEqual(['strike:claw:opp0', 'strike:claw:opp1', 'strike:claw:opp2', 'strike:claw:opp3',
      'strike:claw:opp4', 'strike:claw:opp5', 'strike:claw:opp6', 'strike:claw:opp7', 'strike:claw:opp8',
      'strike:claw:opp9', 'strike:claw:opp10', 'strike:claw:opp11', 'strike:claw:opp12', 'strike:claw:opp13',
      'strike:claw:opp14', 'strike:claw:opp15', 'strike:claw:opp16', 'strike:claw:opp17', 'strike:claw:opp18',
      'endTurn']);
  });

  it('throws if Laya returns a choice that was never offered', async () => {
    const fetchImpl = fakeFetch('{"candidate": {"type": "choice", "choice": "not-a-real-candidate", "probabilities": {}}}');
    await expect(decide(CONTEXT, { apiKey: 'test-key', fetchImpl })).rejects.toThrow(/not offered/);
  });

  it('throws with the response status and body on a non-ok response', async () => {
    const fetchImpl = fakeFetch('{}', { ok: false, status: 403 });
    await expect(decide(CONTEXT, { apiKey: 'wrong-key', fetchImpl })).rejects.toThrow(/403/);
  });

  it('throws a clear error for a non-JSON error response instead of crashing on JSON parsing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError('Unexpected token I in JSON'); },
      text: async () => 'Internal Server Error'
    });
    await expect(decide(CONTEXT, { apiKey: 'test-key', fetchImpl })).rejects.toThrow(/500.*Internal Server Error/s);
  });
});
