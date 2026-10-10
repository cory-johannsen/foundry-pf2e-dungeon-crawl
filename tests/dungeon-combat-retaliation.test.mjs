import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleAttackForRetaliation } from "../scripts/dungeon-combat.mjs";

const M = "pf2e-dungeon-crawl";
const tok = (disposition, forceId) => ({ disposition, flags: forceId ? { [M]: { forceId } } : {} });
const forces = () => ({
  f1: { hostility: "all", hostileTo: [] },
  f2: { hostility: "players", hostileTo: [] },
});

function setup({ table = forces(), gm = true } = {}) {
  const flags = { dungeonSlot: 1 };
  if (table) flags.forces = table;
  const combat = {
    scene: { id: "s1" },
    getFlag: (m, k) => flags[k],
    setFlag: vi.fn(),
    combatants: [
      { id: "c-u", tokenId: "t-u", token: tok(-1, "f1") },
      { id: "c-g", tokenId: "t-g", token: tok(-1, "f2") },
      { id: "c-p", tokenId: "t-p", token: tok(1) },
    ],
  };
  globalThis.game = {
    user: { isGM: gm },
    users: { activeGM: { isSelf: gm } },
    combats: { contents: [combat] },
  };
  return combat;
}
const msg = (att, tgt, type = "attack-roll", outcome = "success") => ({
  speaker: { scene: "s1", token: att },
  flags: { pf2e: { context: { type, outcome, target: tgt ? { token: `Scene.s1.Token.${tgt}` } : undefined } } },
});

describe("handleAttackForRetaliation", () => {
  let combat;
  beforeEach(() => { combat = setup(); });

  it("undead hitting goblin makes goblin force hostile to f1", async () => {
    await handleAttackForRetaliation(msg("t-u", "t-g"));
    expect(combat.setFlag).toHaveBeenCalledTimes(1);
    expect(combat.setFlag.mock.calls[0][2].f2.hostileTo).toContain("f1");
  });
  it("damage-roll and misses count", async () => {
    await handleAttackForRetaliation(msg("t-u", "t-g", "damage-roll"));
    await handleAttackForRetaliation(msg("t-u", "t-g", "attack-roll", "failure"));
    expect(combat.setFlag).toHaveBeenCalledTimes(2);
  });
  it("party attacker records nothing", async () => {
    await handleAttackForRetaliation(msg("t-p", "t-g"));
    expect(combat.setFlag).not.toHaveBeenCalled();
  });
  it("no target, other message types: no-op", async () => {
    await handleAttackForRetaliation(msg("t-u", null));
    await handleAttackForRetaliation(msg("t-u", "t-g", "spell-cast"));
    expect(combat.setFlag).not.toHaveBeenCalled();
  });
  it("no forces table: no-op", async () => {
    combat = setup({ table: null });
    await handleAttackForRetaliation(msg("t-u", "t-g"));
    expect(combat.setFlag).not.toHaveBeenCalled();
  });
  it("non-GM client: no-op", async () => {
    combat = setup({ gm: false });
    await handleAttackForRetaliation(msg("t-u", "t-g"));
    expect(combat.setFlag).not.toHaveBeenCalled();
  });
});
