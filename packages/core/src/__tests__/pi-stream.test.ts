import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { guardedPiNonStreaming } from "../agent/pi-stream.js";

const fetchWithProxyMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/proxy-fetch.js", () => ({
  fetchWithProxy: fetchWithProxyMock,
}));

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

describe("guardedPiNonStreaming", () => {
  beforeEach(() => fetchWithProxyMock.mockReset());

  it("adapts a non-streaming tool call back into Pi events", async () => {
    fetchWithProxyMock.mockResolvedValue(new Response(JSON.stringify({
      id: "response-1",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "I will create the work.",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: {
              name: "workspace__propose_action",
              arguments: JSON.stringify({ action: "short_run", title: "Demo" }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const context: Context = {
      systemPrompt: "Use the tool.",
      messages: [{ role: "user", content: "Create a short.", timestamp: 1 }],
      tools: [{ name: "workspace__propose_action", description: "Propose", parameters: Type.Object({}) }],
    };

    const stream = guardedPiNonStreaming(model, context, { apiKey: "test-key", maxTokens: 1024 });
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);
    const result = await stream.result();

    expect(eventTypes).toEqual(expect.arrayContaining(["start", "text_delta", "toolcall_end", "done"]));
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "I will create the work." }),
      expect.objectContaining({
        type: "toolCall",
        name: "workspace__propose_action",
        arguments: { action: "short_run", title: "Demo" },
      }),
    ]));
    const [, init] = fetchWithProxyMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ model: "test-model", stream: false, max_tokens: 1024 });
    expect(payload.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "workspace__propose_action" }) }),
    ]));
  });
});
