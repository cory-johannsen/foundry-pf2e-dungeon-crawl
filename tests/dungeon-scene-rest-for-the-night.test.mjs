import { describe, it, expect, vi } from "vitest";
import { restPartyForTheNight } from "../scripts/dungeon-scene.mjs";

function installGameStub({ partyMembers = [] } = {}) {
  globalThis.game = {
    actors: { party: { members: partyMembers } },
    pf2e: { actions: { restForTheNight: vi.fn().mockResolvedValue([]) } },
  };
}

describe("restPartyForTheNight", () => {
  it("calls PF2e's real Rest for the Night with the party and skipDialog: true", async () => {
    const members = [{ id: "pc1", type: "character" }, { id: "pc2", type: "character" }];
    installGameStub({ partyMembers: members });

    await restPartyForTheNight();

    expect(game.pf2e.actions.restForTheNight).toHaveBeenCalledWith({
      actors: members,
      skipDialog: true,
    });
  });

  it("does not call restForTheNight at all when there is no party", async () => {
    installGameStub({ partyMembers: [] });

    await restPartyForTheNight();

    expect(game.pf2e.actions.restForTheNight).not.toHaveBeenCalled();
  });

  it("propagates (does not swallow) a rejection from restForTheNight -- the caller is responsible for catching it", async () => {
    const members = [{ id: "pc1", type: "character" }];
    installGameStub({ partyMembers: members });
    game.pf2e.actions.restForTheNight.mockRejectedValue(new Error("boom"));

    await expect(restPartyForTheNight()).rejects.toThrow("boom");
  });
});
