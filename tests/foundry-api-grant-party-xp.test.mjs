import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFoundryApi } from "../scripts/foundry-api.mjs";

// #626: grantPartyXp announces what it granted. #782: PF2e awards the full
// XP total to every character, not a split.
function member(id, type = "character", xp = 0, max = 1000) {
  const flags = {};
  return {
    id,
    type,
    system: { details: { xp: { value: xp, max } } },
    update: vi.fn(async function (changes) {
      this.system.details.xp.value = changes["system.details.xp.value"];
    }),
    getFlag: (_m, k) => flags[k],
    setFlag: vi.fn(async function (_m, k, v) {
      flags[k] = v;
    }),
  };
}

let chat;
function install(members) {
  chat = [];
  globalThis.game = {
    actors: { party: { members } },
    i18n: {
      localize: (k) => k,
      format: (k, d) => `${k}|${JSON.stringify(d)}`,
    },
  };
  globalThis.ChatMessage = { create: vi.fn(async (d) => chat.push(d)) };
}

describe("grantPartyXp announcement (#626, #782)", () => {
  beforeEach(() => install([]));

  it("grants the full total to every party character, not a split", async () => {
    const a = member("a");
    const b = member("b");
    install([a, b, member("npc", "npc")]);
    await makeFoundryApi().grantPartyXp(40, "skillChallenge");
    expect(a.system.details.xp.value).toBe(40);
    expect(b.system.details.xp.value).toBe(40);
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toBe(
      'PF2EDC.Dungeon.XpAwarded|{"source":"PF2EDC.Dungeon.XpSource.skillChallenge","total":40}',
    );
  });

  it("grants the same full total regardless of party size", async () => {
    install([member("a"), member("b"), member("c")]);
    await makeFoundryApi().grantPartyXp(10, "combat");
    expect(chat[0].content).toContain('"total":10');
  });

  it("still announces a zero grant (e.g. a victory over nothing actually defeated)", async () => {
    install([member("a"), member("b")]);
    await makeFoundryApi().grantPartyXp(0, "combat");
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toContain('"total":0');
  });

  it("does nothing, and says nothing, with no party characters", async () => {
    install([member("npc", "npc")]);
    await makeFoundryApi().grantPartyXp(40, "trap");
    expect(chat).toHaveLength(0);
  });

  it("an unknown or missing source still posts, without throwing", async () => {
    install([member("a")]);
    await expect(makeFoundryApi().grantPartyXp(5)).resolves.not.toThrow();
    expect(chat).toHaveLength(1);
  });
});

describe("#853 grantPartyXp flags a character ready to level up at the XP threshold", () => {
  beforeEach(() => install([]));

  it("flags and announces once a character's XP reaches xp.max", async () => {
    const a = member("a", "character", 960, 1000);
    install([a]);
    await makeFoundryApi().grantPartyXp(40, "combat");
    expect(a.system.details.xp.value).toBe(1000);
    expect(a.setFlag).toHaveBeenCalledWith("pf2e-dungeon-crawl", "readyToLevelUp", true);
    expect(chat).toHaveLength(2); // the existing XpAwarded message, plus the new ready-to-level one
    expect(chat[1].content).toContain("PF2EDC.Dungeon.ReadyToLevelUp");
  });

  it("does not re-announce on a later grant while still unleveled", async () => {
    const a = member("a", "character", 1000, 1000); // already over, already flagged from a prior grant
    a.getFlag = (_m, k) => (k === "readyToLevelUp" ? true : undefined);
    install([a]);
    await makeFoundryApi().grantPartyXp(50, "combat");
    expect(a.setFlag).not.toHaveBeenCalled();
    expect(chat).toHaveLength(1); // only the XpAwarded message
  });

  it("does not flag a character still under the threshold", async () => {
    const a = member("a", "character", 100, 1000);
    install([a]);
    await makeFoundryApi().grantPartyXp(40, "combat");
    expect(a.setFlag).not.toHaveBeenCalled();
    expect(chat).toHaveLength(1);
  });
});
