import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchFlavorCustomization = vi.fn();
vi.mock("../scripts/agent-service-client.mjs", () => ({
  fetchFlavorCustomization,
}));

const getPendingTrapCustomization = vi.fn();
const applyTrapCustomization = vi.fn();
vi.mock("../scripts/trap-combat.mjs", () => ({
  getPendingTrapCustomization,
  applyTrapCustomization,
}));

const getPendingSkillChallengeCustomization = vi.fn();
const applySkillChallengeCustomization = vi.fn();
const getPendingPuzzleCustomization = vi.fn();
const applyPuzzleCustomization = vi.fn();
const getPendingNarrativeCustomization = vi.fn();
const applyNarrativeCustomization = vi.fn();
const getPendingTreasureCustomization = vi.fn();
const applyTreasureCustomization = vi.fn();
vi.mock("../scripts/dungeon-runner.mjs", () => ({
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
  getPendingTreasureCustomization,
  applyTreasureCustomization,
}));

global.game = { settings: { get: vi.fn() } };

const { fulfillPendingCustomizations } =
  await import("../scripts/dungeon-customization-fulfillment.mjs");

describe("fulfillPendingCustomizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    game.settings.get.mockImplementation((_module, key) =>
      key === "agentServiceUrl" ? "https://agent.example" : "test-key",
    );
    getPendingSkillChallengeCustomization.mockResolvedValue(null);
    getPendingPuzzleCustomization.mockResolvedValue(null);
    getPendingNarrativeCustomization.mockResolvedValue(null);
    getPendingTreasureCustomization.mockResolvedValue(null);
  });

  it("fetches and applies a treasure customization when one is pending", async () => {
    getPendingTreasureCustomization.mockReturnValue({
      sceneId: "s1",
      roomId: "r1",
      locationTag: null,
    });
    fetchFlavorCustomization.mockResolvedValue({
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });

    await fulfillPendingCustomizations("scene1");

    expect(fetchFlavorCustomization).toHaveBeenCalledWith({
      baseUrl: "https://agent.example",
      apiKey: "test-key",
      kind: "treasure",
      context: { sceneId: "s1", roomId: "r1", locationTag: null },
    });
    expect(applyTreasureCustomization).toHaveBeenCalledWith("s1", "r1", {
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });
  });

  it("fetches and applies a trap customization when one is pending", async () => {
    getPendingTrapCustomization.mockReturnValue({
      actorId: "a1",
      trapLevel: 3,
      partyLevel: 2,
    });
    fetchFlavorCustomization.mockResolvedValue({
      name: "The Weeping Door",
      description: "Drips illusory blood.",
    });

    await fulfillPendingCustomizations("scene1");

    expect(fetchFlavorCustomization).toHaveBeenCalledWith({
      baseUrl: "https://agent.example",
      apiKey: "test-key",
      kind: "trap",
      context: { actorId: "a1", trapLevel: 3, partyLevel: 2 },
    });
    expect(applyTrapCustomization).toHaveBeenCalledWith("a1", {
      name: "The Weeping Door",
      description: "Drips illusory blood.",
    });
  });

  it("does nothing when agentServiceUrl is not configured", async () => {
    game.settings.get.mockReturnValue("");
    getPendingTrapCustomization.mockReturnValue({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });

    await fulfillPendingCustomizations("scene1");

    expect(fetchFlavorCustomization).not.toHaveBeenCalled();
  });

  it("does not throw and leaves the trap unapplied when the fetch fails", async () => {
    getPendingTrapCustomization.mockReturnValue({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });
    fetchFlavorCustomization.mockRejectedValue(new Error("network error"));

    await expect(
      fulfillPendingCustomizations("scene1"),
    ).resolves.toBeUndefined();
    expect(applyTrapCustomization).not.toHaveBeenCalled();
  });

  it("handles multiple pending kinds independently in one call", async () => {
    getPendingTrapCustomization.mockReturnValue({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });
    getPendingSkillChallengeCustomization.mockResolvedValue({
      sceneId: "s1",
      roomId: "r1",
      specialtySkills: ["athletics"],
    });
    fetchFlavorCustomization.mockImplementation(({ kind }) =>
      kind === "trap"
        ? Promise.resolve({ name: "Trap Name", description: "Trap desc." })
        : Promise.resolve({
            name: "Challenge Name",
            summary: "Summary.",
            skillFlavor: { athletics: "Flavor." },
          }),
    );

    await fulfillPendingCustomizations("scene1");

    expect(applyTrapCustomization).toHaveBeenCalledWith("a1", {
      name: "Trap Name",
      description: "Trap desc.",
    });
    expect(applySkillChallengeCustomization).toHaveBeenCalledWith("s1", "r1", {
      name: "Challenge Name",
      summary: "Summary.",
      skillFlavor: { athletics: "Flavor." },
    });
  });

  it("still fulfills a later kind when an earlier kind fails", async () => {
    getPendingTrapCustomization.mockReturnValue({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });
    getPendingSkillChallengeCustomization.mockResolvedValue({
      sceneId: "s1",
      roomId: "r1",
      specialtySkills: ["athletics"],
    });
    fetchFlavorCustomization.mockImplementation(({ kind }) =>
      kind === "trap"
        ? Promise.reject(new Error("network error"))
        : Promise.resolve({
            name: "Challenge Name",
            summary: "Summary.",
            skillFlavor: { athletics: "Flavor." },
          }),
    );

    await expect(
      fulfillPendingCustomizations("scene1"),
    ).resolves.toBeUndefined();

    expect(applyTrapCustomization).not.toHaveBeenCalled();
    expect(applySkillChallengeCustomization).toHaveBeenCalledWith("s1", "r1", {
      name: "Challenge Name",
      summary: "Summary.",
      skillFlavor: { athletics: "Flavor." },
    });
  });
});
