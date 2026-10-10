import { describe, it, expect } from 'vitest';
import { preserveCombatantFlagNamespaces } from '../scripts/combatant-flag-guard.mjs';

const existing = () => ({
  'pf2e-dungeon-crawl': { agentControlled: true },
  pf2e: { roundOfLastTurnEnd: 1 },
  'pf2e-auto-action-tracker': { log: [] },
});

describe('preserveCombatantFlagNamespaces (#1212)', () => {
  it('copies unmentioned namespaces back into a non-recursive nested flags update', () => {
    const changes = { flags: { 'pf2e-auto-action-tracker': { log: [1] } } };
    const restored = preserveCombatantFlagNamespaces(existing(), changes, { diff: false, recursive: false });
    expect(restored.sort()).toEqual(['pf2e', 'pf2e-dungeon-crawl']);
    expect(changes.flags['pf2e-dungeon-crawl']).toEqual({ agentControlled: true });
    expect(changes.flags.pf2e).toEqual({ roundOfLastTurnEnd: 1 });
    expect(changes.flags['pf2e-auto-action-tracker']).toEqual({ log: [1] });
  });

  it('handles un-expanded dotted keys the same way (the tracker passes these)', () => {
    const changes = {
      'flags.pf2e-auto-action-tracker.log': [1],
      'flags.pf2e-auto-action-tracker.actionsSpent': 2,
    };
    preserveCombatantFlagNamespaces(existing(), changes, { diff: false, recursive: false });
    expect(changes['flags.pf2e-dungeon-crawl']).toEqual({ agentControlled: true });
    expect(changes['flags.pf2e']).toEqual({ roundOfLastTurnEnd: 1 });
    expect(changes['flags.pf2e-auto-action-tracker']).toBeUndefined();
  });

  it('does nothing for ordinary recursive updates', () => {
    const changes = { flags: { 'pf2e-auto-action-tracker': { log: [1] } } };
    expect(preserveCombatantFlagNamespaces(existing(), changes, {})).toEqual([]);
    expect(preserveCombatantFlagNamespaces(existing(), changes, { recursive: true })).toEqual([]);
    expect(Object.keys(changes.flags)).toEqual(['pf2e-auto-action-tracker']);
  });

  it('does nothing when the update does not touch flags', () => {
    const changes = { initiative: 12 };
    expect(preserveCombatantFlagNamespaces(existing(), changes, { recursive: false })).toEqual([]);
    expect(changes).toEqual({ initiative: 12 });
  });

  it('does not overwrite a namespace the update itself writes', () => {
    const changes = { flags: { 'pf2e-dungeon-crawl': { agentControlled: false } } };
    preserveCombatantFlagNamespaces(existing(), changes, { recursive: false });
    expect(changes.flags['pf2e-dungeon-crawl']).toEqual({ agentControlled: false });
  });

  it('does not restore a namespace the update explicitly removes', () => {
    const changes = { flags: { '-=pf2e': null } };
    const restored = preserveCombatantFlagNamespaces(existing(), changes, { recursive: false });
    expect(restored).not.toContain('pf2e');
    expect(changes.flags['-=pf2e']).toBeNull();
    expect(changes.flags['pf2e-dungeon-crawl']).toEqual({ agentControlled: true });
  });

  it('copies deeply so later edits to the restored value do not alias the source', () => {
    const src = existing();
    const changes = { flags: { x: 1 } };
    preserveCombatantFlagNamespaces(src, changes, { recursive: false });
    changes.flags['pf2e-dungeon-crawl'].agentControlled = false;
    expect(src['pf2e-dungeon-crawl'].agentControlled).toBe(true);
  });

  it('tolerates missing or malformed input without throwing', () => {
    expect(preserveCombatantFlagNamespaces(undefined, { flags: {} }, { recursive: false })).toEqual([]);
    expect(preserveCombatantFlagNamespaces(existing(), null, { recursive: false })).toEqual([]);
    expect(preserveCombatantFlagNamespaces(existing(), { flags: {} }, undefined)).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';

describe('module.mjs wiring (#1212)', () => {
  it('registers a preUpdateCombatant hook that calls the guard', () => {
    const src = readFileSync(new URL('../scripts/module.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{ preserveCombatantFlagNamespaces \} from "\.\/combatant-flag-guard\.mjs"/);
    expect(src).toMatch(/Hooks\.on\("preUpdateCombatant",[\s\S]*?preserveCombatantFlagNamespaces\(/);
  });
});
