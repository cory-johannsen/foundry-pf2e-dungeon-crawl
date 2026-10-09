import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendAgentActionRecord, renderAgentTurnCard } from "../scripts/dungeon-combat.mjs";

// #925: the per-combat agentLog and the consolidated per-(combatant, round)
// AI turn card.

const MODULE_ID = "pf2e-dungeon-crawl";

function makeCombat({ log = [], cards = {}, tokenHidden = false } = {}) {
  const flags = { agentLog: log, agentTurnCards: cards };
  return {
    id: "combat1",
    round: 2,
    turn: 0,
    flags,
    combatants: [
      {
        id: "c1",
        name: "Goblin",
        token: { id: "tok1", hidden: tokenHidden, name: "Goblin" },
        actor: { id: "a1" },
      },
    ],
    getFlag: (_m, key) => flags[key],
    setFlag: vi.fn(async (_m, key, value) => {
      flags[key] = value;
    }),
  };
}

const rec = (over = {}) => ({
  combatantId: "c1", tokenId: "tok1", round: 2, turn: 0, type: "strike", cost: 1,
  summary: "Dagger", target: { id: "t1", name: "Fighter" },
  result: { text: "hit", tone: "success" }, gmNote: null, rationale: null,
  source: "model", visibility: "all",
  ...over,
});

let messages;
beforeEach(() => {
  messages = new Map();
  let nextId = 1;
  globalThis.ChatMessage = {
    create: vi.fn(async (data) => {
      const message = { id: `msg${nextId++}`, ...data, update: vi.fn(async (changes) => Object.assign(message, changes)) };
      messages.set(message.id, message);
      return message;
    }),
    getSpeaker: vi.fn(({ actor }) => ({ actor: actor?.id, alias: "Goblin" })),
    getWhisperRecipients: vi.fn(() => [{ id: "gm1" }]),
  };
  globalThis.game = { messages: { get: (id) => messages.get(id) } };
  globalThis.foundry = { utils: {} };
});
afterEach(() => vi.restoreAllMocks());

describe("appendAgentActionRecord (#925)", () => {
  it("appends records with a 0-based index per (combatant, round)", async () => {
    const combat = makeCombat();
    await appendAgentActionRecord(combat, rec({ summary: "a" }));
    await appendAgentActionRecord(combat, rec({ summary: "b" }));
    await appendAgentActionRecord(combat, rec({ summary: "c", round: 3 }));
    await appendAgentActionRecord(combat, rec({ summary: "d", combatantId: "c2" }));
    expect(combat.flags.agentLog.map((r) => [r.summary, r.index])).toEqual([
      ["a", 0], ["b", 1], ["c", 0], ["d", 0],
    ]);
    expect(combat.flags.agentLog[0]).toMatchObject({ tokenId: "tok1", visibility: "all" });
  });

  it("logs and returns null instead of throwing when the flag write fails", async () => {
    const combat = makeCombat();
    combat.setFlag = vi.fn(async () => { throw new Error("boom"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(appendAgentActionRecord(combat, rec())).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("renderAgentTurnCard (#925)", () => {
  it("creates one public card for the first action, flagged with combat/combatant/round, with the speaker", async () => {
    const combat = makeCombat({ log: [{ ...rec({ rationale: "Closest target." }), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 2);
    expect(ChatMessage.create).toHaveBeenCalledOnce();
    const [created] = ChatMessage.create.mock.calls[0];
    expect(created.whisper).toBeUndefined();
    expect(created.speaker).toEqual({ actor: "a1", alias: "Goblin" });
    expect(created.flags[MODULE_ID].agentTurnCard).toEqual({ combatId: "combat1", combatantId: "c1", round: 2 });
    expect(created.content).toContain("Dagger");
    expect(created.content).toContain('data-visibility="gm" class="pf2edc-agent-rationale"><em>Closest target.</em>');
    expect(combat.flags.agentTurnCards).toEqual({ "c1:2": "msg1" });
  });

  it("updates the same card in place for later actions in the same round", async () => {
    const combat = makeCombat({ log: [{ ...rec({ summary: "First" }), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 2);
    combat.flags.agentLog.push({ ...rec({ summary: "Second" }), index: 1 });
    await renderAgentTurnCard(combat, "c1", 2);
    expect(ChatMessage.create).toHaveBeenCalledOnce();
    const card = messages.get("msg1");
    expect(card.update).toHaveBeenCalledOnce();
    expect(card.content).toContain("First");
    expect(card.content).toContain("Second");
  });

  it("starts a fresh card for the same combatant's next round", async () => {
    const combat = makeCombat({ log: [{ ...rec(), index: 0 }, { ...rec({ round: 3, summary: "Later" }), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 2);
    await renderAgentTurnCard(combat, "c1", 3);
    expect(ChatMessage.create).toHaveBeenCalledTimes(2);
    expect(ChatMessage.create.mock.calls[1][0].content).toContain("Later");
    expect(ChatMessage.create.mock.calls[1][0].content).not.toContain("Dagger");
    expect(combat.flags.agentTurnCards).toEqual({ "c1:2": "msg1", "c1:3": "msg2" });
  });

  it("recreates the card when its message was deleted", async () => {
    const combat = makeCombat({ log: [{ ...rec(), index: 0 }], cards: { "c1:2": "gone" } });
    await renderAgentTurnCard(combat, "c1", 2);
    expect(ChatMessage.create).toHaveBeenCalledOnce();
    expect(combat.flags.agentTurnCards["c1:2"]).toBe("msg1");
  });

  it("whispers the whole card to the GM when the acting token was hidden", async () => {
    const combat = makeCombat({ log: [{ ...rec({ visibility: "gm" }), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 2);
    expect(ChatMessage.create.mock.calls[0][0].whisper).toEqual(["gm1"]);
  });

  it("omits the rationale element entirely when the record has none", async () => {
    const combat = makeCombat({ log: [{ ...rec(), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 2);
    expect(ChatMessage.create.mock.calls[0][0].content).not.toContain("data-visibility");
  });

  it("escapes hostile summary and rationale text", async () => {
    const combat = makeCombat({ log: [{ ...rec({ summary: "<script>x", rationale: "<script>y" }), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 2);
    expect(ChatMessage.create.mock.calls[0][0].content).not.toContain("<script>");
  });

  it("does nothing when there is no record for that combatant and round", async () => {
    const combat = makeCombat({ log: [{ ...rec(), index: 0 }] });
    await renderAgentTurnCard(combat, "c1", 5);
    expect(ChatMessage.create).not.toHaveBeenCalled();
  });

  it("logs and resolves when ChatMessage.create fails", async () => {
    ChatMessage.create = vi.fn(async () => { throw new Error("boom"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const combat = makeCombat({ log: [{ ...rec(), index: 0 }] });
    await expect(renderAgentTurnCard(combat, "c1", 2)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
