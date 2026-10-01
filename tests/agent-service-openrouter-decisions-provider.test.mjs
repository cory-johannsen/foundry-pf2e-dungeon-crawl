import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolate from whatever's really in this repo's .env — decide()'s apiKey
// default reads it via readEnvOrDotenv.
vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('ENOENT: no such file'); }
}));

const { decide } = await import('../tools/agent-service/providers/openrouter-decisions.mjs');

const CONTEXT = {
  self: { name: 'Yamaraj', hp: 40, conditions: [] },
  opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: 'strike:claw:opp1', summary: 'Claw vs Fighter (variant 0)' },
    { id: 'endTurn', summary: 'End turn' }
  ],
  roundNumber: 1
};

function fakeFetch(choice, { ok = true, status = 200, text } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({
      model: 'inception/mercury-decide:free',
      answers: { candidate: { type: 'choice', choice, probabilities: {}, confidence: 0.56 } },
      usage: {}
    }),
    text: async () => text ?? ''
  });
}

describe('openrouter-decisions provider decide()', () => {
  const saved = { a: process.env.OPEN_ROUTER_API_KEY, b: process.env.OPENROUTER_API_KEY };

  beforeEach(() => {
    delete process.env.OPEN_ROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (saved.a === undefined) delete process.env.OPEN_ROUTER_API_KEY; else process.env.OPEN_ROUTER_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved.b;
  });

  it('posts Laya\'s body plus the model to the decisions endpoint with a bearer key', async () => {
    const fetchImpl = fakeFetch('strike:claw:opp1');
    await decide(CONTEXT, { apiKey: 'test-key', fetchImpl });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({
      model: 'inception/mercury-decide:free',
      state: { self: CONTEXT.self, opponents: CONTEXT.opponents, roundNumber: 1 },
      questions: {
        candidate: {
          type: 'choice',
          instructions: 'Given the current combat state, which action should the agent take?',
          criteria: { 'strike:claw:opp1': 'Claw vs Fighter (variant 0)', endTurn: 'End turn' }
        }
      }
    });
  });

  it('honors model and baseUrl overrides', async () => {
    const fetchImpl = fakeFetch('endTurn');
    await decide(CONTEXT, { apiKey: 'k', fetchImpl, model: 'other/model', baseUrl: 'http://x/api' });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://x/api/decisions');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('other/model');
  });

  it('returns the chosen candidate with no rationale', async () => {
    const result = await decide(CONTEXT, { apiKey: 'k', fetchImpl: fakeFetch('strike:claw:opp1') });
    expect(result).toEqual({ candidateId: 'strike:claw:opp1', rationale: undefined });
  });

  it('throws with status and body text on a non-200 response', async () => {
    const fetchImpl = fakeFetch('x', { ok: false, status: 429, text: 'slow down' });
    await expect(decide(CONTEXT, { apiKey: 'k', fetchImpl }))
      .rejects.toThrow('openrouter-decisions provider: API request failed (429): slow down');
  });

  it('throws when the returned choice was not offered', async () => {
    await expect(decide(CONTEXT, { apiKey: 'k', fetchImpl: fakeFetch('toString') }))
      .rejects.toThrow('openrouter-decisions provider: candidateId "toString" was not offered');
  });

  it('truncates past 20 candidates but always keeps endTurn', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, summary: `s${i}` }));
    candidates.push({ id: 'endTurn', summary: 'End turn' });
    const fetchImpl = fakeFetch('endTurn');
    await decide({ ...CONTEXT, candidates }, { apiKey: 'k', fetchImpl });
    const criteria = JSON.parse(fetchImpl.mock.calls[0][1].body).questions.candidate.criteria;
    expect(Object.keys(criteria)).toHaveLength(20);
    expect(criteria.endTurn).toBe('End turn');
  });

  it('falls back to OPENROUTER_API_KEY when OPEN_ROUTER_API_KEY is unset', async () => {
    process.env.OPENROUTER_API_KEY = 'fallback-key';
    const fetchImpl = fakeFetch('endTurn');
    await decide(CONTEXT, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer fallback-key');
  });
});
