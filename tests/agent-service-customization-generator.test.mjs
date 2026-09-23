import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: () => {
    throw new Error("ENOENT: no such file");
  },
}));

const { generateCustomization } =
  await import("../tools/agent-service/customization-generator.mjs");

function fakeClaudeFetch(toolInput) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "tool_use", name: "customize", input: toolInput }],
    }),
  });
}

describe("generateCustomization", () => {
  it("generates a trap name and description", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Weeping Door",
      description: "A door that drips illusory blood.",
    });
    const result = await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 3, partyLevel: 2 },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result).toEqual({
      name: "The Weeping Door",
      description: "A door that drips illusory blood.",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].input_schema.required).toEqual([
      "name",
      "description",
    ]);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("generates a treasure room name and summary", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });
    const result = await generateCustomization(
      "treasure",
      { sceneId: "s1", roomId: "r1", locationTag: null },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result).toEqual({
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].input_schema.required).toEqual(["name", "summary"]);
  });

  it("generates skill-challenge flavor scoped to skillFlavor only", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Silent Vault",
      summary: "A vault sealed by an old ward.",
      skillFlavor: {
        athletics: "Force the ward apart.",
        arcana: "Unweave the ward.",
      },
    });
    const result = await generateCustomization(
      "skill_challenge",
      {
        sceneId: "s1",
        roomId: "r1",
        specialtySkills: ["athletics", "arcana"],
        locationTag: "vault",
      },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result.skillFlavor).toEqual({
      athletics: "Force the ward apart.",
      arcana: "Unweave the ward.",
    });
  });

  it("generates narrative content scoped to the entry's own archetype fields", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "A Fork in the Tunnel",
      summary: "Two passages, one choice.",
      options: [
        { label: "Take the low path", consequence: "Faster, riskier." },
        { label: "Take the high path", consequence: "Slower, safer." },
      ],
    });
    const result = await generateCustomization(
      "narrative",
      { sceneId: "s1", roomId: "r1", archetype: "choice" },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result.options).toHaveLength(2);
    expect(result.revealText).toBeUndefined();
  });

  it("tells the model the archetype-to-field mapping for narrative entries", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Weeping Statue",
      summary: "An old statue remembers the fall of the keep.",
      revealText: "The keep fell not to siege, but to betrayal from within.",
    });
    await generateCustomization(
      "narrative",
      { sceneId: "s1", roomId: "r1", archetype: "lore" },
      { apiKey: "test-key", fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const description = body.tools[0].description;
    expect(description).toMatch(/"lore"[^.]*revealText/);
  });

  it("throws a clear error when Claude returns no tool_use block", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [] }),
    });
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        { apiKey: "test-key", fetchImpl },
      ),
    ).rejects.toThrow(/no customize tool call/);
  });
});
