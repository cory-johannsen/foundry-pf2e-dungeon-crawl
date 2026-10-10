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
    const paceDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 1200);
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

    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 1200)).toHaveLength(0);
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

describe('runAgentDecisionLoop maneuver-candidate augmentation', () => {
  const combat = { id: 'combat-1', round: 1, turn: 0 };
  const combatant = { id: 'atk' };

  function combatWithFlagStore(initial = {}) {
    const store = { ...initial };
    return {
      ...combat,
      getFlag: (_m, key) => store[key],
      setFlag: async (_m, key, value) => {
        store[key] = value;
      },
    };
  }

  it('fetches and persists maneuver picks once, then rebuilds pending before deciding, when the vocabulary is non-empty', async () => {
    installGameStub();
    const vocabulary = [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }];
    const pendingBeforeFetch = {
      combatId: 'combat-1', combatantId: 'atk',
      context: { candidates: [], roundNumber: 1 }, candidates: [],
      maneuverVocabulary: vocabulary,
    };
    const pendingAfterFetch = {
      ...pendingBeforeFetch,
      candidates: [{ id: 'maneuver:trip:opp1', type: 'maneuver' }],
    };
    const stubCombat = combatWithFlagStore();
    const getPending = vi.fn().mockResolvedValueOnce(pendingBeforeFetch).mockResolvedValueOnce(pendingAfterFetch);
    const fetchCandidates = vi.fn().mockResolvedValue({ picks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'r' }] });
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);
    const armTimeout = vi.fn();

    await runAgentDecisionLoop(stubCombat, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision, armTimeout });

    expect(fetchCandidates).toHaveBeenCalledWith({
      baseUrl: 'https://agent.example', apiKey: 'test-key',
      context: pendingBeforeFetch.context, vocabulary,
    });
    expect(getPending).toHaveBeenCalledTimes(2);
    expect(stubCombat.getFlag('pf2e-dungeon-crawl', 'agentTurnState').maneuverPicks).toEqual([
      { type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'r' },
    ]);
    // Persisting the picks bumps the turn-state counter (invalidating the
    // already-armed fallback timer), so a fresh one must be armed.
    expect(armTimeout).toHaveBeenCalledWith(stubCombat, combatant);
    expect(fetchDecision).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining(pendingAfterFetch.context) }),
    );
  });

  it('never calls fetchCandidates when maneuverVocabulary is empty', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn();
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);
    const armTimeout = vi.fn();

    await runAgentDecisionLoop({ id: 'combat-1' }, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision, armTimeout });

    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(armTimeout).not.toHaveBeenCalled();
  });

  it('never calls fetchCandidates when maneuverVocabulary is absent entirely (existing pendingTurn shape, no regression)', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn();
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);
    const armTimeout = vi.fn();

    await runAgentDecisionLoop({ id: 'combat-1' }, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision, armTimeout });

    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(fetchDecision).toHaveBeenCalled();
  });

  it('persists an empty maneuverPicks array (not null) when fetchCandidates fails, so it is not retried on the next loop iteration this same turn', async () => {
    installGameStub();
    const vocabulary = [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }];
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary: vocabulary };
    const stubCombat = combatWithFlagStore();
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn().mockRejectedValue(new Error('network error'));
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);
    const armTimeout = vi.fn();

    await runAgentDecisionLoop(stubCombat, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision, armTimeout });

    expect(fetchCandidates).toHaveBeenCalledTimes(1);
    expect(stubCombat.getFlag('pf2e-dungeon-crawl', 'agentTurnState').maneuverPicks).toEqual([]);
    expect(fetchDecision).toHaveBeenCalled();
  });
});

describe('runAgentDecisionLoop feat-candidate augmentation (#910)', () => {
  const combatant = { id: 'atk' };
  function combatWithFlagStore() {
    const store = {};
    return {
      id: 'combat-1', round: 1, turn: 0,
      getFlag: (_m, key) => store[key],
      setFlag: async (_m, key, value) => {
        store[key] = value;
      },
    };
  }

  it('fetches once with the maneuver and feat vocabularies combined', async () => {
    installGameStub();
    const maneuverVocabulary = [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }];
    const featVocabulary = [{ type: 'feat', kind: 'selfEffect', itemId: 'rage1', slug: 'rage', targetId: null }];
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary, featVocabulary };
    const stubCombat = combatWithFlagStore();
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn().mockResolvedValue({ picks: [{ type: 'feat', slug: 'rage', targetId: null, rationale: 'r' }] });
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop(stubCombat, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision, armTimeout: vi.fn() });

    expect(fetchCandidates).toHaveBeenCalledTimes(1);
    expect(fetchCandidates.mock.calls[0][0].vocabulary).toEqual([...maneuverVocabulary, ...featVocabulary]);
    expect(stubCombat.getFlag('pf2e-dungeon-crawl', 'agentTurnState').maneuverPicks).toEqual([
      { type: 'feat', slug: 'rage', targetId: null, rationale: 'r' },
    ]);
  });

  it('fetches when only the feat vocabulary is non-empty', async () => {
    installGameStub();
    const featVocabulary = [{ type: 'feat', kind: 'selfEffect', itemId: 'rage1', slug: 'rage', targetId: null }];
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary: [], featVocabulary };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn().mockResolvedValue({ picks: [] });

    await runAgentDecisionLoop(combatWithFlagStore(), combatant, {
      fetchDecision: vi.fn().mockResolvedValue({ candidateId: 'endTurn' }),
      fetchCandidates, getPending, applyDecision: vi.fn().mockResolvedValue(null), armTimeout: vi.fn(),
    });

    expect(fetchCandidates.mock.calls[0][0].vocabulary).toEqual(featVocabulary);
  });
});

describe('runAgentDecisionLoop npcAbility vocabulary (#915)', () => {
  const combatant = { id: 'atk' };
  function combatWithFlagStore() {
    const store = {};
    return {
      id: 'combat-1', round: 1, turn: 0,
      getFlag: (_m, key) => store[key],
      setFlag: async (_m, key, value) => {
        store[key] = value;
      },
    };
  }

  it('fetches when only the NPC-ability vocabulary is non-empty, and appends it after maneuvers/feats', async () => {
    installGameStub();
    const maneuverVocabulary = [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }];
    const npcAbilityVocabulary = [{ type: 'npcAbility', itemId: 'i1', slug: 'terrifying-display', targetId: null, affectedIds: ['opp1'] }];
    for (const [vocab, expected] of [
      [{ maneuverVocabulary: [], featVocabulary: [], npcAbilityVocabulary }, npcAbilityVocabulary],
      [{ maneuverVocabulary, npcAbilityVocabulary }, [...maneuverVocabulary, ...npcAbilityVocabulary]],
    ]) {
      const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], ...vocab };
      const fetchCandidates = vi.fn().mockResolvedValue({ picks: [] });
      await runAgentDecisionLoop(combatWithFlagStore(), combatant, {
        fetchDecision: vi.fn().mockResolvedValue({ candidateId: 'endTurn' }),
        fetchCandidates, getPending: vi.fn().mockResolvedValue(pendingTurn), applyDecision: vi.fn().mockResolvedValue(null), armTimeout: vi.fn(),
      });
      expect(fetchCandidates).toHaveBeenCalledTimes(1);
      expect(fetchCandidates.mock.calls[0][0].vocabulary).toEqual(expected);
    }
  });
});

describe('runAgentDecisionLoop npcMove vocabulary (#932)', () => {
  it('fetches when only the movement-ability vocabulary is non-empty, appended last', async () => {
    installGameStub();
    const store = {};
    const combat = { id: 'combat-1', round: 1, turn: 0, getFlag: (_m, k) => store[k], setFlag: async (_m, k, v) => { store[k] = v; } };
    const npcAbilityVocabulary = [{ type: 'npcAbility', itemId: 'i1', slug: 'terrifying-display', targetId: null, affectedIds: ['opp1'] }];
    const npcMoveVocabulary = [{ type: 'npcMove', kind: 'move', itemId: 'i2', slug: 'gallop', posture: 'approach', targetId: 'opp1' }];
    for (const [vocab, expected] of [
      [{ maneuverVocabulary: [], featVocabulary: [], npcAbilityVocabulary: [], npcMoveVocabulary }, npcMoveVocabulary],
      [{ npcAbilityVocabulary, npcMoveVocabulary }, [...npcAbilityVocabulary, ...npcMoveVocabulary]],
    ]) {
      for (const k of Object.keys(store)) delete store[k];
      const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], ...vocab };
      const fetchCandidates = vi.fn().mockResolvedValue({ picks: [] });
      await runAgentDecisionLoop(combat, { id: 'atk' }, {
        fetchDecision: vi.fn().mockResolvedValue({ candidateId: 'endTurn' }),
        fetchCandidates, getPending: vi.fn().mockResolvedValue(pendingTurn), applyDecision: vi.fn().mockResolvedValue(null), armTimeout: vi.fn(),
      });
      expect(fetchCandidates).toHaveBeenCalledTimes(1);
      expect(fetchCandidates.mock.calls[0][0].vocabulary).toEqual(expected);
    }
  });
});

describe('runAgentDecisionLoop maneuver picks already fetched this turn', () => {
  it('does not re-ask the reasoning model once picks are persisted for this turn', async () => {
    installGameStub();
    const flags = {
      agentTurnState: { combatantId: 'atk', round: 1, turn: 0, actionsRemaining: 2, mapIncrement: 0, maneuverPicks: [], counter: 3 },
    };
    const stubCombat = { id: 'combat-1', round: 1, turn: 0, getFlag: (_m, k) => flags[k], setFlag: async (_m, k, v) => { flags[k] = v; } };
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }] };
    const fetchCandidates = vi.fn();
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    await runAgentDecisionLoop(stubCombat, { id: 'atk' }, {
      fetchDecision, fetchCandidates, getPending: vi.fn().mockResolvedValue(pendingTurn), applyDecision: vi.fn().mockResolvedValue(null), armTimeout: vi.fn(),
    });
    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(fetchDecision).toHaveBeenCalled();
  });
});
