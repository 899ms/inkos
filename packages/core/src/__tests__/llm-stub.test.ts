import { describe, expect, it, afterEach } from "vitest";
import { isLlmStubEnabled, stubChatCompletion } from "../agent/llm-stub.js";

describe("llm-stub", () => {
  const prev = process.env.INKOS_AGENT_LLM_STUB;
  const prevScenario = process.env.INKOS_AGENT_LLM_STUB_SCENARIO;
  afterEach(() => {
    if (prev === undefined) delete process.env.INKOS_AGENT_LLM_STUB;
    else process.env.INKOS_AGENT_LLM_STUB = prev;
    if (prevScenario === undefined) delete process.env.INKOS_AGENT_LLM_STUB_SCENARIO;
    else process.env.INKOS_AGENT_LLM_STUB_SCENARIO = prevScenario;
  });

  it("isLlmStubEnabled reflects the env var", () => {
    process.env.INKOS_AGENT_LLM_STUB = "1";
    expect(isLlmStubEnabled()).toBe(true);
    delete process.env.INKOS_AGENT_LLM_STUB;
    expect(isLlmStubEnabled()).toBe(false);
  });

  it("returns the scripted structure fixture without interpreting prompt text", () => {
    process.env.INKOS_AGENT_LLM_STUB_SCENARIO = "interactive-film-structure";
    const res = stubChatCompletion(
      [
        { role: "system", content: "arbitrary system" },
        { role: "user", content: "arbitrary input" },
      ],
      "stub-model",
    );
    const parsed = JSON.parse(res.content) as { nodes: unknown[] };
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThanOrEqual(2);
  });
});
