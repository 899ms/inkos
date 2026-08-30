import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Api,
} from "@mariozechner/pi-ai";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";

export function isLlmStubEnabled(): boolean {
  return Boolean(process.env.INKOS_AGENT_LLM_STUB);
}

// Mirrors EMPTY_USAGE in agent-session.ts exactly.
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function alreadyProposed(
  context: { messages?: Array<{ role: string; content: unknown; toolName?: string }> },
): boolean {
  return (context.messages ?? []).some((m) => {
    const isProposalTool = (name: unknown) => (
      typeof name === "string" && (name === "workspace__propose_action" || name.endsWith("__propose_action"))
    );
    // Agent format (non-openai-completions): role="toolResult" with toolName
    if (m.role === "toolResult" && isProposalTool((m as { toolName?: string }).toolName)) {
      return true;
    }
    // LLM format (openai-completions): assistant message with toolCall content
    if (m.role === "assistant" && Array.isArray(m.content)) {
      if (
        (m.content as Array<{ type: string; name?: string }>).some(
          (c) => c.type === "toolCall" && isProposalTool(c.name),
        )
      ) {
        return true;
      }
    }
    // LLM format (openai-completions folded): tool result folded into user message string
    if (m.role === "user" && typeof m.content === "string") {
      if (/- (?:workspace__)?propose_action \(/.test(m.content as string)) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Returns a deterministic AssistantMessageEventStream selected by the explicit
 * test scenario. The stub never interprets user text to choose a workflow.
 *
 * Mirrors localAssistantStopStream in agent-session.ts exactly — same
 * createAssistantMessageEventStream() + queueMicrotask pattern.
 */
export function stubAgentStream(model: Model<Api>, context: unknown): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const proposed = alreadyProposed(
    context as { messages?: Array<{ role: string; content: unknown; toolName?: string }> },
  );
  const wantStructure = !proposed
    && process.env.INKOS_AGENT_LLM_STUB_SCENARIO === "interactive-film-structure";

  const content = wantStructure
    ? [
        {
          type: "toolCall" as const,
          id: "stub-draft",
          name: "workspace__propose_action",
          arguments: {
            action: "draft_structure",
            title: "搭建结构",
            summary: "确认后生成三幕骨架",
            instruction: "搭建一个三幕分支结构",
            draftStructure: { instruction: "三幕分支结构" },
          },
        },
      ]
    : [{ type: "text" as const, text: "好的。" }];

  const stopReason = wantStructure ? ("toolUse" as const) : ("stop" as const);

  const message: AssistantMessage = {
    role: "assistant",
    content: content as AssistantMessage["content"],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE as AssistantMessage["usage"],
    stopReason,
    timestamp: Date.now(),
  };

  queueMicrotask(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });

  return stream;
}

const STRUCTURE_JSON = JSON.stringify({
  nodes: [
    {
      id: "s",
      type: "start",
      title: "开场",
      sceneDesc: "宫门前",
      dialogue: [],
      choices: [{ id: "c1", text: "查账", targetNodeId: "b", effects: [] }],
      act: "第一幕",
    },
    {
      id: "b",
      type: "branch",
      title: "抉择",
      sceneDesc: "账房",
      dialogue: [],
      choices: [
        { id: "c2", text: "公开", targetNodeId: "e1", effects: [] },
        { id: "c3", text: "隐瞒", targetNodeId: "e2", effects: [] },
      ],
      act: "第二幕",
    },
    { id: "e1", type: "ending", title: "真相", sceneDesc: "公开真相", dialogue: [], choices: [], act: "第三幕" },
    { id: "e2", type: "ending", title: "沉沦", sceneDesc: "隐瞒真相", dialogue: [], choices: [], act: "第三幕" },
  ],
});

const NODE_JSON = JSON.stringify({
  type: "branch",
  title: "新场景",
  sceneDesc: "夜色",
  dialogue: [{ speaker: "阿梅", text: "账不能错", emotion: "坚定" }],
  choices: [],
  act: "第一幕",
});

/**
 * Deterministic replacement for the chatCompletion network call.
 */
export function stubChatCompletion(
  _messages: ReadonlyArray<LLMMessage>,
  _model: string,
): LLMResponse {
  const content = process.env.INKOS_AGENT_LLM_STUB_SCENARIO === "interactive-film-structure"
    ? STRUCTURE_JSON
    : NODE_JSON;
  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}
