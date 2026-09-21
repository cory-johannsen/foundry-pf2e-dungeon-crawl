import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildServer,
  getPendingTrapCustomization,
  applyTrapCustomization,
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
  listPendingCustomizations,
} from "../tools/agent-loop/mcp-server.mjs";

function fakeFetch(result) {
  return vi.fn().mockResolvedValue({ json: async () => ({ result }) });
}

describe("mcp-server relay wrappers", () => {
  it("getPendingTrapCustomization sends the module.api call with the given sceneId", async () => {
    const fetchImpl = fakeFetch({ actorId: "trap1", name: "Scythe Blades" });
    const result = await getPendingTrapCustomization("scene-1", {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ actorId: "trap1", name: "Scythe Blades" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain('getPendingTrapCustomization("scene-1")');
  });

  it("getPendingTrapCustomization defaults sceneId to null when omitted", async () => {
    const fetchImpl = fakeFetch(null);
    await getPendingTrapCustomization(undefined, {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain("getPendingTrapCustomization(null)");
  });

  it("applyTrapCustomization sends the actorId and customization payload", async () => {
    const fetchImpl = fakeFetch({
      actorId: "trap1",
      name: "The Reaper's Toll",
    });
    const result = await applyTrapCustomization(
      "trap1",
      { name: "The Reaper's Toll", description: "Rusted blades hiss." },
      {
        baseUrl: "http://localhost:9999",
        apiKey: "k",
        clientId: "abc",
        fetchImpl,
      },
    );
    expect(result).toEqual({ actorId: "trap1", name: "The Reaper's Toll" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain('applyTrapCustomization("trap1"');
    expect(script).toContain("Rusted blades hiss.");
  });

  it("getPendingSkillChallengeCustomization sends the module.api call with the given sceneId", async () => {
    const fetchImpl = fakeFetch({ sceneId: "scene-1", roomId: "room-1" });
    const result = await getPendingSkillChallengeCustomization("scene-1", {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ sceneId: "scene-1", roomId: "room-1" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain(
      'getPendingSkillChallengeCustomization("scene-1")',
    );
  });

  it("applySkillChallengeCustomization sends sceneId, roomId, and the customization payload", async () => {
    const fetchImpl = fakeFetch({ sceneId: "scene-1", roomId: "room-1" });
    const result = await applySkillChallengeCustomization(
      "scene-1",
      "room-1",
      { name: "The Iron Concord", summary: "A tense truce.", skillFlavor: {} },
      {
        baseUrl: "http://localhost:9999",
        apiKey: "k",
        clientId: "abc",
        fetchImpl,
      },
    );
    expect(result).toEqual({ sceneId: "scene-1", roomId: "room-1" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain(
      'applySkillChallengeCustomization("scene-1", "room-1"',
    );
    expect(script).toContain("The Iron Concord");
  });

  it("getPendingPuzzleCustomization sends the module.api call with the given sceneId", async () => {
    const fetchImpl = fakeFetch({ roomId: "room-1", name: "The Perfect Hand" });
    const result = await getPendingPuzzleCustomization("scene-1", {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ roomId: "room-1", name: "The Perfect Hand" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain('getPendingPuzzleCustomization("scene-1")');
  });

  it("applyPuzzleCustomization sends sceneId, roomId, and the customization payload", async () => {
    const fetchImpl = fakeFetch({ sceneId: "scene-1", roomId: "room-1" });
    const result = await applyPuzzleCustomization(
      "scene-1",
      "room-1",
      { name: "The Whispering Vault", summary: "A vault hums.", stageFlavor: {} },
      {
        baseUrl: "http://localhost:9999",
        apiKey: "k",
        clientId: "abc",
        fetchImpl,
      },
    );
    expect(result).toEqual({ sceneId: "scene-1", roomId: "room-1" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain('applyPuzzleCustomization("scene-1", "room-1"');
    expect(script).toContain("The Whispering Vault");
  });

  it("getPendingNarrativeCustomization sends the module.api call with the given sceneId", async () => {
    const fetchImpl = fakeFetch({ roomId: "room-1", archetype: "lore" });
    const result = await getPendingNarrativeCustomization("scene-1", {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ roomId: "room-1", archetype: "lore" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain('getPendingNarrativeCustomization("scene-1")');
  });

  it("applyNarrativeCustomization sends sceneId, roomId, and the customization payload", async () => {
    const fetchImpl = fakeFetch({ sceneId: "scene-1", roomId: "room-1" });
    const result = await applyNarrativeCustomization(
      "scene-1",
      "room-1",
      { name: "The Last Warden's Oath", summary: "A collapsed guardpost.", revealText: "They knew." },
      {
        baseUrl: "http://localhost:9999",
        apiKey: "k",
        clientId: "abc",
        fetchImpl,
      },
    );
    expect(result).toEqual({ sceneId: "scene-1", roomId: "room-1" });
    const [, options] = fetchImpl.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain(
      'applyNarrativeCustomization("scene-1", "room-1"',
    );
    expect(script).toContain("The Last Warden's Oath");
  });

  it("listPendingCustomizations tags each present result with its kind and omits nulls", async () => {
    // All lookups fire in parallel (Promise.all) — a shared counter
    // incremented per fetchImpl call would be read by both .json() calls
    // only after BOTH fetches have already fired, so the response is
    // chosen by inspecting the actual script sent, not call order.
    const fetchImpl = vi.fn().mockImplementation(async (url, options) => {
      const script = JSON.parse(options.body).script;
      return {
        json: async () =>
          script.includes("getPendingTrapCustomization")
            ? { result: { actorId: "trap1", name: "Scythe Blades" } }
            : { result: null },
      };
    });
    const pending = await listPendingCustomizations("scene-1", {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    expect(pending).toEqual([
      { kind: "trap", actorId: "trap1", name: "Scythe Blades" },
    ]);
  });

  it("listPendingCustomizations returns an empty array when nothing is pending", async () => {
    const fetchImpl = fakeFetch(null);
    const pending = await listPendingCustomizations("scene-1", {
      baseUrl: "http://localhost:9999",
      apiKey: "k",
      clientId: "abc",
      fetchImpl,
    });
    expect(pending).toEqual([]);
  });
});

describe("mcp-server tool registration (full round-trip over an in-memory transport)", () => {
  const originalBaseUrl = process.env.FOUNDRY_BASE_URL;
  const originalApiKey = process.env.FOUNDRY_REST_API_KEY;
  const originalClientId = process.env.FOUNDRY_CLIENT_ID;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.FOUNDRY_BASE_URL = "http://localhost:9999";
    process.env.FOUNDRY_REST_API_KEY = "k";
    process.env.FOUNDRY_CLIENT_ID = "abc";
  });

  afterEach(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("FOUNDRY_BASE_URL", originalBaseUrl);
    restore("FOUNDRY_REST_API_KEY", originalApiKey);
    restore("FOUNDRY_CLIENT_ID", originalClientId);
    globalThis.fetch = originalFetch;
  });

  async function connectedClient() {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("lists all five tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_pending_customizations",
      "submit_narrative_customization",
      "submit_puzzle_customization",
      "submit_skill_challenge_customization",
      "submit_trap_customization",
    ]);
  });

  it("list_pending_customizations returns the live pending trap as JSON text", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url, options) => {
      const script = JSON.parse(options.body).script;
      return {
        json: async () => ({
          result: script.includes("getPendingTrapCustomization")
            ? { actorId: "trap1", name: "Scythe Blades" }
            : null,
        }),
      };
    });
    const client = await connectedClient();
    const result = await client.callTool({
      name: "list_pending_customizations",
      arguments: {},
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      { kind: "trap", actorId: "trap1", name: "Scythe Blades" },
    ]);
  });

  it("submit_trap_customization applies the customization via the relay", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { actorId: "trap1", name: "New Name" } }),
    });
    const client = await connectedClient();
    const result = await client.callTool({
      name: "submit_trap_customization",
      arguments: {
        actorId: "trap1",
        name: "New Name",
        description: "New description.",
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      actorId: "trap1",
      name: "New Name",
    });
    const [, options] = globalThis.fetch.mock.calls[0];
    expect(JSON.parse(options.body).script).toContain("New description.");
  });

  it("submit_skill_challenge_customization applies the customization via the relay", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { sceneId: "scene-1", roomId: "room-1" } }),
    });
    const client = await connectedClient();
    const result = await client.callTool({
      name: "submit_skill_challenge_customization",
      arguments: {
        sceneId: "scene-1",
        roomId: "room-1",
        name: "The Iron Concord",
        summary: "A tense truce.",
        skillFlavor: { diplomacy: "Appeal to reason." },
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      sceneId: "scene-1",
      roomId: "room-1",
    });
    const [, options] = globalThis.fetch.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain("The Iron Concord");
    expect(script).toContain("Appeal to reason.");
  });

  it("submit_puzzle_customization applies the customization via the relay", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { sceneId: "scene-1", roomId: "room-1" } }),
    });
    const client = await connectedClient();
    const result = await client.callTool({
      name: "submit_puzzle_customization",
      arguments: {
        sceneId: "scene-1",
        roomId: "room-1",
        name: "The Whispering Vault",
        summary: "A locked vault hums with old magic.",
        stageFlavor: { 0: "A far more vivid clue." },
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      sceneId: "scene-1",
      roomId: "room-1",
    });
    const [, options] = globalThis.fetch.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain("The Whispering Vault");
    expect(script).toContain("A far more vivid clue.");
  });

  it("submit_narrative_customization applies the customization via the relay", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { sceneId: "scene-1", roomId: "room-1" } }),
    });
    const client = await connectedClient();
    const result = await client.callTool({
      name: "submit_narrative_customization",
      arguments: {
        sceneId: "scene-1",
        roomId: "room-1",
        name: "The Last Warden's Oath",
        summary: "A collapsed guardpost.",
        revealText: "They knew exactly what was coming and stayed anyway.",
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      sceneId: "scene-1",
      roomId: "room-1",
    });
    const [, options] = globalThis.fetch.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain("The Last Warden's Oath");
    expect(script).toContain("They knew exactly what was coming");
  });

  it("submit_narrative_customization accepts a choice archetype's options array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { sceneId: "scene-1", roomId: "room-1" } }),
    });
    const client = await connectedClient();
    const result = await client.callTool({
      name: "submit_narrative_customization",
      arguments: {
        sceneId: "scene-1",
        roomId: "room-1",
        name: "The Chained Witness",
        summary: "A prisoner watches the party approach.",
        options: [
          { label: "Free them", consequence: "A grateful, watchful ally." },
          { label: "Leave them", consequence: "No new complication." },
        ],
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      sceneId: "scene-1",
      roomId: "room-1",
    });
    const [, options] = globalThis.fetch.mock.calls[0];
    const script = JSON.parse(options.body).script;
    expect(script).toContain("A grateful, watchful ally.");
  });
});
