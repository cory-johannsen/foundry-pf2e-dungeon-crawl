import { describe, it, expect, vi } from "vitest";
import { decide } from "../tools/agent-loop/providers/claude.mjs";

const CONTEXT = {
  self: { name: "Yamaraj", hp: 40, conditions: [] },
  opponents: [{ id: "opp1", name: "Fighter", distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: "strike:claw:opp1", summary: "Claw vs Fighter (variant 0)" },
    { id: "endTurn", summary: "End turn" },
  ],
  roundNumber: 1,
};

function fakeFetch(toolInputJson) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [
        {
          type: "tool_use",
          name: "choose_action",
          input: JSON.parse(toolInputJson),
        },
      ],
    }),
  });
}

describe("claude provider decide()", () => {
  it("sends the context as prompt content and a candidate-id enum tool", async () => {
    const fetchImpl = fakeFetch(
      '{"candidateId": "strike:claw:opp1", "rationale": "closest target"}',
    );
    await decide(CONTEXT, { apiKey: "test-key", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(options.body);
    expect(body.tools[0].name).toBe("choose_action");
    expect(body.tools[0].input_schema.properties.candidateId.enum).toEqual([
      "strike:claw:opp1",
      "endTurn",
    ]);
    expect(JSON.stringify(body.messages)).toContain("Yamaraj");
  });

  it("returns the chosen candidateId and rationale", async () => {
    const fetchImpl = fakeFetch(
      '{"candidateId": "endTurn", "rationale": "no good options"}',
    );
    const result = await decide(CONTEXT, { apiKey: "test-key", fetchImpl });
    expect(result).toEqual({
      candidateId: "endTurn",
      rationale: "no good options",
    });
  });

  it("throws if Claude picks a candidateId that was never offered", async () => {
    const fetchImpl = fakeFetch(
      '{"candidateId": "not-a-real-candidate", "rationale": "oops"}',
    );
    await expect(
      decide(CONTEXT, { apiKey: "test-key", fetchImpl }),
    ).rejects.toThrow(/not offered/);
  });

  it('throws a diagnosable error when the API response is not ok, instead of the generic "no tool call" message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    });
    await expect(
      decide(CONTEXT, { apiKey: "bad-key", fetchImpl }),
    ).rejects.toThrow(/401.*invalid x-api-key/);
  });

  it("falls back to a generic message when a non-ok response has no error payload", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(
      decide(CONTEXT, { apiKey: "test-key", fetchImpl }),
    ).rejects.toThrow(/500.*unknown error/);
  });
});
