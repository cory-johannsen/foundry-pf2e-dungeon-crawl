// tests/dungeon-combat-feat-self-effect-cleanup.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { cleanupAgentSelfEffects } from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function combatantWithEffects(effects) {
  return { actor: { itemTypes: { effect: effects }, deleteEmbeddedDocuments: vi.fn() } };
}

describe('cleanupAgentSelfEffects', () => {
  it('deletes a tagged, unlimited-duration effect', async () => {
    const tagged = { id: 'e1', flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: 'unlimited' } } };
    const combatant = combatantWithEffects([tagged]);
    const combat = { combatants: [combatant] };
    await cleanupAgentSelfEffects(combat);
    expect(combatant.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['e1']);
  });

  it('leaves a tagged effect with a timed duration alone (it expires through the system\'s own duration handling)', async () => {
    const tagged = { id: 'e2', flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: 'rounds', value: 1 } } };
    const combatant = combatantWithEffects([tagged]);
    const combat = { combatants: [combatant] };
    await cleanupAgentSelfEffects(combat);
    expect(combatant.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it('leaves an untagged unlimited effect alone (not created by this module)', async () => {
    const untagged = { id: 'e3', flags: {}, system: { duration: { unit: 'unlimited' } } };
    const combatant = combatantWithEffects([untagged]);
    const combat = { combatants: [combatant] };
    await cleanupAgentSelfEffects(combat);
    expect(combatant.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it('does not throw when a combatant has no actor', async () => {
    const combat = { combatants: [{ actor: null }] };
    await expect(cleanupAgentSelfEffects(combat)).resolves.toBeUndefined();
  });

  it('logs and continues when deleteEmbeddedDocuments throws, never blocking the rest of the sweep', async () => {
    const tagged1 = { id: 'e1', flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: 'unlimited' } } };
    const tagged2 = { id: 'e2', flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: 'unlimited' } } };
    const failingCombatant = combatantWithEffects([tagged1]);
    failingCombatant.actor.deleteEmbeddedDocuments.mockRejectedValue(new Error('boom'));
    const okCombatant = combatantWithEffects([tagged2]);
    const combat = { combatants: [failingCombatant, okCombatant] };
    await expect(cleanupAgentSelfEffects(combat)).resolves.toBeUndefined();
    expect(okCombatant.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['e2']);
  });
});
