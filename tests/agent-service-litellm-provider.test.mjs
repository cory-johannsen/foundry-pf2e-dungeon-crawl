import { describe, it, expect, vi } from "vitest";
import { decide } from "../tools/agent-service/providers/litellm.mjs";

const CONTEXT = {
  self: { name: "Yamaraj", hp: 40, conditions: [] },
  opponents: [{ id: "opp1", name: "Fighter", distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: "strike:claw:opp1", summary: "Claw vs Fighter (variant 0)" },
    { id: "endTurn", summary: "End turn" },
  ],
  roundNumber: 1,
};

function fakeFetch(toolArgs, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "choose_action", arguments: JSON.stringify(toolArgs) } },
            ],
          },
        },
      ],
    }),
  });
}

describe("litellm provider decide()", () => {
  it("sends an OpenAI tool-call request to {baseUrl}/chat/completions with the fast model for a simple turn", async () => {
    const fetchImpl = fakeFetch({ candidateId: "strike:claw:opp1", rationale: "closest target" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("fast");
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "choose_action",
        description: expect.any(String),
        parameters: expect.objectContaining({
          properties: expect.objectContaining({
            candidateId: { type: "string", enum: ["strike:claw:opp1", "endTurn"] },
          }),
        }),
      },
    });
    expect(JSON.stringify(body.messages)).toContain("Yamaraj");
  });

  it("requests the reasoning model when candidates.length is above the threshold", async () => {
    const manyCandidates = Array.from({ length: 10 }, (_, i) => ({ id: `strike:claw:opp${i}`, summary: `Claw vs opp${i}` }));
    const context = { ...CONTEXT, candidates: manyCandidates };
    const fetchImpl = fakeFetch({ candidateId: "strike:claw:opp0", rationale: "closest" });
    await decide(context, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("sends a bearer token when an API key is configured", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", apiKey: "secret", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("passes an AbortSignal so a stuck upstream call times out instead of hanging", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the chosen candidateId and rationale", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(result).toEqual({ candidateId: "endTurn", rationale: "no good options" });
  });

  it("throws if litellm picks a candidateId that was never offered", async () => {
    const fetchImpl = fakeFetch({ candidateId: "not-a-real-candidate", rationale: "oops" });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/not offered/);
  });

  it("throws a diagnosable error when the response is not ok", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 502 });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/502/);
  });

  it("throws a clear error when there is no tool call in the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/no choose_action tool call/);
  });

  it("throws a clear error when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ function: { name: "choose_action", arguments: "{not json" } }] } }],
      }),
    });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/litellm provider/);
  });
});
