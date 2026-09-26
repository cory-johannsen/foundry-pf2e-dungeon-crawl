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
    // #93 fix round 1: fulfillKind now loops until getPending() returns
    // null, so every getter defaults to null (vi.clearAllMocks doesn't reset
    // implementations — a previous test's pending value would otherwise
    // leak) and each test's pending room is a *Once value.
    getPendingTrapCustomization.mockReturnValue(null);
    getPendingSkillChallengeCustomization.mockResolvedValue(null);
    getPendingPuzzleCustomization.mockResolvedValue(null);
    getPendingNarrativeCustomization.mockResolvedValue(null);
    getPendingTreasureCustomization.mockResolvedValue(null);
  });

  it("fetches and applies a treasure customization when one is pending", async () => {
    getPendingTreasureCustomization.mockReturnValueOnce({
      sceneId: "s1",
      roomId: "r1",
      locationTag: null,
    });
    fetchFlavorCustomization.mockResolvedValue({
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });

    await fulfillPendingCustomizations("scene1");

    expect(fetchFlavorCustomization).toHaveBeenCalledTimes(1);
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
    getPendingTrapCustomization.mockReturnValueOnce({
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
    getPendingTrapCustomization.mockReturnValueOnce({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });

    await fulfillPendingCustomizations("scene1");

    expect(fetchFlavorCustomization).not.toHaveBeenCalled();
    // #93 fix round 1: stops after the first unapplied room rather than
    // re-reading the same still-pending room up to the loop cap.
    expect(getPendingTrapCustomization).toHaveBeenCalledTimes(1);
  });

  it("drains every pending room of a kind in one call (#93 full pregeneration)", async () => {
    getPendingPuzzleCustomization
      .mockResolvedValueOnce({ sceneId: "s1", roomId: "r1" })
      .mockResolvedValueOnce({ sceneId: "s1", roomId: "r2" })
      .mockResolvedValueOnce({ sceneId: "s1", roomId: "r3" });
    fetchFlavorCustomization.mockImplementation(({ context }) =>
      Promise.resolve({ name: `Puzzle ${context.roomId}` }),
    );

    await fulfillPendingCustomizations("scene1");

    expect(applyPuzzleCustomization).toHaveBeenCalledTimes(3);
    expect(applyPuzzleCustomization).toHaveBeenNthCalledWith(1, "s1", "r1", { name: "Puzzle r1" });
    expect(applyPuzzleCustomization).toHaveBeenNthCalledWith(2, "s1", "r2", { name: "Puzzle r2" });
    expect(applyPuzzleCustomization).toHaveBeenNthCalledWith(3, "s1", "r3", { name: "Puzzle r3" });
  });

  it("caps the per-kind loop if a pending room never clears", async () => {
    getPendingNarrativeCustomization.mockResolvedValue({ sceneId: "s1", roomId: "stuck" });
    fetchFlavorCustomization.mockResolvedValue({ name: "N" });

    await fulfillPendingCustomizations("scene1");

    expect(applyNarrativeCustomization).toHaveBeenCalledTimes(50);
  });

  it("does not throw and leaves the trap unapplied when the fetch fails", async () => {
    getPendingTrapCustomization.mockReturnValueOnce({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });
    fetchFlavorCustomization.mockRejectedValue(new Error("network error"));

    await expect(
      fulfillPendingCustomizations("scene1"),
    ).resolves.toBeUndefined();
    expect(applyTrapCustomization).not.toHaveBeenCalled();
    // Stops on the error rather than retrying in a tight loop.
    expect(fetchFlavorCustomization).toHaveBeenCalledTimes(1);
  });

  it("handles multiple pending kinds independently in one call", async () => {
    getPendingTrapCustomization.mockReturnValueOnce({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });
    getPendingSkillChallengeCustomization.mockResolvedValueOnce({
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
    getPendingTrapCustomization.mockReturnValueOnce({
      actorId: "a1",
      trapLevel: 1,
      partyLevel: 1,
    });
    getPendingSkillChallengeCustomization.mockResolvedValueOnce({
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
