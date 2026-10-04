import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFoundryApi } from "../scripts/foundry-api.mjs";

// #626: grantPartyXp announces what it granted. The write path itself (split
// across party characters, add to system.details.xp.value) predates this.
function member(id, type = "character", xp = 0) {
  return {
    id,
    type,
    system: { details: { xp: { value: xp } } },
    update: vi.fn(async function (changes) {
      this.system.details.xp.value = changes["system.details.xp.value"];
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

describe("grantPartyXp announcement (#626)", () => {
  beforeEach(() => install([]));

  it("posts one chat line naming the source, the total and the per-character share", async () => {
    const a = member("a");
    const b = member("b");
    install([a, b, member("npc", "npc")]);
    await makeFoundryApi().grantPartyXp(40, "skillChallenge");
    expect(a.system.details.xp.value).toBe(20);
    expect(b.system.details.xp.value).toBe(20);
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toBe(
      'PF2EDC.Dungeon.XpAwarded|{"source":"PF2EDC.Dungeon.XpSource.skillChallenge","total":40,"share":20}',
    );
  });

  it("reports the actual per-character share when the total doesn't divide evenly", async () => {
    install([member("a"), member("b"), member("c")]);
    await makeFoundryApi().grantPartyXp(10, "combat");
    expect(chat[0].content).toContain('"total":10');
    expect(chat[0].content).toContain('"share":3');
  });

  it("still announces a zero grant (e.g. a victory over nothing actually defeated)", async () => {
    install([member("a"), member("b")]);
    await makeFoundryApi().grantPartyXp(0, "combat");
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toContain('"total":0');
    expect(chat[0].content).toContain('"share":0');
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
