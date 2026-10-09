// tests/dungeon-combat-maneuver-rider-expiry.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepExpiredManeuverRiders } from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function combatStub({ round = 1, turn = 0, flags = {} } = {}) {
  const store = { ...flags };
  return {
    round,
    turn,
    combatants: [],
    getFlag: (_m, key) => store[key],
    setFlag: vi.fn(async (_m, key, value) => {
      store[key] = value;
    }),
  };
}

const fleeing = (targetId, round, turn) => ({
  targetId,
  conditionSlug: 'fleeing',
  expiry: { untilRoundTurn: { round, turn } },
});
const offGuard = (targetId, round, turn) => ({
  targetId,
  conditionSlug: 'off-guard',
  expiry: { afterRoundTurn: { round, turn } },
});

beforeEach(() => {
  globalThis.game = { user: { isGM: true } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sweepExpiredManeuverRiders (#911)', () => {
  it('does nothing when no rider expiry entries are tracked', async () => {
    const combat = combatStub();
    await expect(sweepExpiredManeuverRiders(combat)).resolves.toBeUndefined();
    expect(combat.setFlag).not.toHaveBeenCalled();
  });

  it('never throws on a bare combat stub with no flag API', async () => {
    await expect(sweepExpiredManeuverRiders({ round: 3, turn: 0 })).resolves.toBeUndefined();
    await expect(sweepExpiredManeuverRiders(null)).resolves.toBeUndefined();
  });

  it('removes a "for 1 round" rider (Fleeing) once the granting round/turn comes back around a round later', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 2, turn: 1, flags: { maneuverRiderExpiry: [fleeing('c1', 2, 1)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).toHaveBeenCalledWith('fleeing', { forceRemove: true });
    expect(combat.getFlag(MODULE_ID, 'maneuverRiderExpiry')).toEqual([]);
  });

  it('keeps Fleeing through the rest of the granting round and the next round\'s earlier turns', async () => {
    for (const [round, turn] of [[1, 2], [2, 0]]) {
      const decreaseCondition = vi.fn();
      const combat = combatStub({ round, turn, flags: { maneuverRiderExpiry: [fleeing('c1', 2, 1)] } });
      combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
      await sweepExpiredManeuverRiders(combat);
      expect(decreaseCondition).not.toHaveBeenCalled();
    }
  });

  it('removes Fleeing once a later round has begun even if the exact turn was skipped', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 3, turn: 0, flags: { maneuverRiderExpiry: [fleeing('c1', 2, 1)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).toHaveBeenCalledWith('fleeing', { forceRemove: true });
  });

  it('removes a turn-expiring rider (Off-Guard) as soon as the granting round/turn pair no longer matches', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 1, turn: 1, flags: { maneuverRiderExpiry: [offGuard('c1', 1, 0)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).toHaveBeenCalledWith('off-guard', { forceRemove: true });
  });

  it('leaves a turn-expiring rider in place while still on the exact round/turn it was granted', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 1, turn: 0, flags: { maneuverRiderExpiry: [offGuard('c1', 1, 0)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
    expect(combat.setFlag).not.toHaveBeenCalled();
  });

  it('keeps a still-active entry in the flag while removing an expired one in the same sweep', async () => {
    const combat = combatStub({
      round: 2,
      turn: 0,
      flags: { maneuverRiderExpiry: [fleeing('c1', 2, 0), fleeing('c2', 5, 0)] },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition: vi.fn() } });
    combat.combatants.push({ id: 'c2', actor: { decreaseCondition: vi.fn() } });
    await sweepExpiredManeuverRiders(combat);
    expect(combat.getFlag(MODULE_ID, 'maneuverRiderExpiry')).toEqual([fleeing('c2', 5, 0)]);
  });

  it('does not throw when the tracked target no longer exists in combat.combatants', async () => {
    const combat = combatStub({ round: 2, turn: 0, flags: { maneuverRiderExpiry: [fleeing('gone', 2, 0)] } });
    await expect(sweepExpiredManeuverRiders(combat)).resolves.toBeUndefined();
    expect(combat.getFlag(MODULE_ID, 'maneuverRiderExpiry')).toEqual([]);
  });

  it('logs and drops an entry whose condition removal throws, without aborting the sweep', async () => {
    const ok = vi.fn();
    const combat = combatStub({
      round: 3,
      turn: 0,
      flags: { maneuverRiderExpiry: [fleeing('c1', 2, 0), fleeing('c2', 2, 0)] },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition: vi.fn(async () => { throw new Error('boom'); }) } });
    combat.combatants.push({ id: 'c2', actor: { decreaseCondition: ok } });
    await sweepExpiredManeuverRiders(combat);
    expect(ok).toHaveBeenCalledWith('fleeing', { forceRemove: true });
    expect(combat.getFlag(MODULE_ID, 'maneuverRiderExpiry')).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it('ignores malformed entries (no expiry) by dropping them', async () => {
    const combat = combatStub({ round: 1, turn: 0, flags: { maneuverRiderExpiry: [{ targetId: 'c1' }, null] } });
    await expect(sweepExpiredManeuverRiders(combat)).resolves.toBeUndefined();
    expect(combat.getFlag(MODULE_ID, 'maneuverRiderExpiry')).toEqual([]);
  });

  it('only the GM client sweeps (updateCombat fires on every client)', async () => {
    globalThis.game = { user: { isGM: false } };
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 3, turn: 0, flags: { maneuverRiderExpiry: [fleeing('c1', 2, 0)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
  });
});

describe('module.mjs updateCombat hook wiring (#911)', () => {
  it('sweeps expired maneuver riders before auto-playing the next turn', () => {
    const src = readFileSync(new URL('../scripts/module.mjs', import.meta.url), 'utf8');
    const hook = src.slice(src.indexOf('Hooks.on("updateCombat"'));
    const body = hook.slice(0, hook.indexOf('});'));
    const sweepAt = body.indexOf('await sweepExpiredManeuverRiders(combat)');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(body.indexOf('autoPlayCombatantTurnIfDue(combat)'));
  });
});
