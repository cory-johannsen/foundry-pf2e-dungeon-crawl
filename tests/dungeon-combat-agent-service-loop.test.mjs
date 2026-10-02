import { describe, it, expect, vi, afterEach } from 'vitest';
import { runAgentDecisionLoop } from '../scripts/dungeon-combat.mjs';

// #479: a failing assertion mid-test must not leak fake timers or a
// setTimeout spy into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function installGameStub({ agentServiceUrl = 'https://agent.example', agentServiceApiKey = 'test-key' } = {}) {
  globalThis.game = {
    settings: {
      get: (_moduleId, key) => ({ agentServiceUrl, agentServiceApiKey })[key],
    },
  };
}

describe('runAgentDecisionLoop', () => {
  const combat = { id: 'combat-1' };
  const combatant = { id: 'atk' };

  it('calls fetchDecision then applyDecision with the decided candidateId, looping until the turn ends', async () => {
    installGameStub();
    const pendingTurn = {
      combatId: 'combat-1',
      combatantId: 'atk',
      context: { self: {}, opponents: [], candidates: [], roundNumber: 1 },
      candidates: [],
    };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn', rationale: 'Nothing worth doing.' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(fetchDecision).toHaveBeenCalledWith({
      baseUrl: 'https://agent.example',
      apiKey: 'test-key',
      context: { ...pendingTurn.context, actorProfile: { tier: 'standard' } },
    });
    expect(applyDecision).toHaveBeenCalledWith(combat, 'atk', 'endTurn', 'Nothing worth doing.');
  });

  it('loops again when actions remain, stopping once applyDecision returns null', async () => {
    installGameStub();
    const firstPending = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [], roundNumber: 1 }, candidates: [] };
    const secondPending = { ...firstPending, context: { candidates: [], roundNumber: 2 } };
    const getPending = vi.fn().mockResolvedValue(firstPending);
    const fetchDecision = vi
      .fn()
      .mockResolvedValueOnce({ candidateId: 'stride:approach:opp1' })
      .mockResolvedValueOnce({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValueOnce(secondPending).mockResolvedValueOnce(null);

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(fetchDecision).toHaveBeenCalledTimes(2);
    expect(applyDecision).toHaveBeenNthCalledWith(2, combat, 'atk', 'endTurn', undefined);
  });

  it('waits ACTION_PACE_DELAY_MS between applying one action and fetching the next, once per action boundary', async () => {
    installGameStub();
    const firstPending = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [], roundNumber: 1 }, candidates: [] };
    const secondPending = { ...firstPending, context: { candidates: [], roundNumber: 2 } };
    const getPending = vi.fn().mockResolvedValue(firstPending);
    const fetchDecision = vi
      .fn()
      .mockResolvedValueOnce({ candidateId: 'stride:approach:opp1' })
      .mockResolvedValueOnce({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValueOnce(secondPending).mockResolvedValueOnce(null);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const loopPromise = runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });
    await vi.runAllTimersAsync();
    await loopPromise;

    expect(fetchDecision).toHaveBeenCalledTimes(2);
    const paceDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 600);
    // Two actions -> exactly one gap between them, none after the turn ends.
    expect(paceDelayCalls.length).toBe(1);
    vi.useRealTimers();
  });

  it('does not wait at all when the very first decision already ends the turn', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 600)).toHaveLength(0);
  });

  it('does nothing (never calls getPending or fetchDecision) when agentServiceUrl is not configured', async () => {
    installGameStub({ agentServiceUrl: '' });
    const getPending = vi.fn();
    const fetchDecision = vi.fn();
    const applyDecision = vi.fn();

    await runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision });

    expect(getPending).not.toHaveBeenCalled();
    expect(fetchDecision).not.toHaveBeenCalled();
  });

  it('stops without throwing when fetchDecision rejects, leaving applyDecision uncalled', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockRejectedValue(new Error('network error'));
    const applyDecision = vi.fn();

    await expect(
      runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision }),
    ).resolves.toBeUndefined();
    expect(applyDecision).not.toHaveBeenCalled();
  });

  it('stops without throwing when applyDecision rejects', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      runAgentDecisionLoop(combat, combatant, { fetchDecision, getPending, applyDecision }),
    ).resolves.toBeUndefined();
  });
});
