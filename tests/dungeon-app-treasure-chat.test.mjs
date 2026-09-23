import { describe, it, expect, beforeAll, vi } from "vitest";
import { treasureRoomItemTableName } from "../scripts/dungeon-deck.mjs";

// #88: grantTreasureReward used to only call ui.notifications.info, a
// local/ephemeral toast on whichever client ran it -- never broadcast or
// persisted to the chat log, so a party member other than that one client
// never saw their own treasure reward. This exercises the fix directly
// (dungeon-app.mjs has no other test coverage yet -- see the module's own
// import-time foundry.applications.api.{ApplicationV2,HandlebarsApplicationMixin}
// destructure, which is why every global Foundry surface it touches is
// stubbed below before the first import).

function installFoundryStubs({ tableEntry = null, itemDoc = null } = {}) {
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => Base,
      },
    },
    utils: { escapeHTML: (s) => String(s) },
  };
  globalThis.ChatMessage = {
    create: async (data) => {
      ChatMessage.calls.push(data);
    },
    calls: [],
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.ui = {
    notifications: {
      calls: [],
      info(msg) {
        ui.notifications.calls.push(msg);
      },
      warn() {},
      error() {},
    },
  };
  globalThis.game = {
    i18n: {
      format: (key, data) => JSON.stringify({ key, data }),
      localize: (key) => key,
    },
    actors: { party: { id: "party1" } },
    packs: {
      get: () => ({
        getIndex: async () =>
          tableEntry ? [{ _id: "table1", name: tableEntry.tableName }] : [],
        getDocument: async () => ({
          draw: async () => ({
            results: tableEntry
              ? [
                  {
                    documentCollection: "pf2e.equipment-srd",
                    documentId: "item1",
                  },
                ]
              : [],
          }),
        }),
      }),
    },
  };
  // drawTreasureItem resolves the drawn result's documentCollection via a
  // second game.packs.get(...).getDocument(...) call -- reuse the same
  // stubbed pack so both lookups (table + drawn item) resolve consistently.
  if (itemDoc) {
    const originalGet = game.packs.get;
    game.packs.get = (name) => {
      if (name === "pf2e.equipment-srd") {
        return { getDocument: async () => itemDoc };
      }
      return originalGet(name);
    };
  }
  globalThis.Hooks = { on() {}, once() {}, off() {}, callAll() {} };
}

describe("grantTreasureReward (#88 chat log fix)", () => {
  let grantTreasureReward;

  beforeAll(async () => {
    // dungeon-app.mjs destructures foundry.applications.api at MODULE
    // TOP LEVEL (`const { ApplicationV2, HandlebarsApplicationMixin } =
    // foundry.applications.api`), so `foundry` must exist before the
    // first import -- install minimal stubs once, then import. Every
    // individual test below re-installs the live globals
    // (game/ui/ChatMessage) it needs right before calling
    // grantTreasureReward, since those are read at call time, not import
    // time, and the dynamic import itself is cached after this first call.
    installFoundryStubs();
    ({ grantTreasureReward } = await import("../scripts/ui/dungeon-app.mjs"));
  });

  it("posts the gp reward to the party chat log via ChatMessage.create", async () => {
    installFoundryStubs();
    const api = { addCoins: async () => {} };

    await grantTreasureReward(api, {
      partyLevel: 5,
      physicalSlot: 2,
      roomCount: 8,
      isGoal: false,
    });

    expect(ChatMessage.calls).toHaveLength(1);
    const posted = JSON.parse(ChatMessage.calls[0].content);
    expect(posted.key).toBe("PF2EDC.Dungeon.Treasure.Found");
    expect(posted.data.gp).toEqual(expect.any(Number));
    // A party-wide announcement, not a GM-only whisper.
    expect(ChatMessage.calls[0].whisper).toBeUndefined();
  });

  it("does not also fire the old GM-local toast for the gp reward", async () => {
    installFoundryStubs();
    const api = { addCoins: async () => {} };

    await grantTreasureReward(api, {
      partyLevel: 5,
      physicalSlot: 2,
      roomCount: 8,
      isGoal: false,
    });

    expect(ui.notifications.calls).toHaveLength(0);
  });

  it("also posts a chat message for a dropped item, without a redundant toast", async () => {
    // grantTreasureReward picks the drawn item's table via
    // treasureRoomItemTableName(..., { rng: Math.random }) internally, so
    // Math.random is pinned to make that pick deterministic -- the mocked
    // pack index below is then built with the SAME real function/params so
    // its one entry's name is exactly what drawTreasureItem will look up.
    const params = {
      partyLevel: 5,
      physicalSlot: 2,
      roomCount: 8,
      isGoal: false,
    };
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const expectedTableName = treasureRoomItemTableName({
      ...params,
      rng: Math.random,
    });

    const itemDoc = {
      name: "Wand of Magic Missile",
      toObject: () => ({ name: "Wand of Magic Missile", type: "weapon" }),
    };
    installFoundryStubs({
      tableEntry: { tableName: expectedTableName },
      itemDoc,
    });
    const created = [];
    globalThis.game.actors = {
      party: {
        id: "party1",
        createEmbeddedDocuments: async (type, docs) => {
          created.push(...docs);
        },
      },
    };
    const api = { addCoins: async () => {} };

    await grantTreasureReward(api, params);

    Math.random.mockRestore();
    expect(created).toHaveLength(1);
    expect(ChatMessage.calls).toHaveLength(2);
    const itemMessage = JSON.parse(ChatMessage.calls[1].content);
    expect(itemMessage.key).toBe("PF2EDC.Dungeon.Treasure.ItemFound");
    expect(itemMessage.data.item).toBe("Wand of Magic Missile");
    expect(ui.notifications.calls).toHaveLength(0);
  });
});
