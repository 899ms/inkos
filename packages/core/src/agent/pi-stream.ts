import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@mariozechner/pi-ai";
import {
  assertWithinContextWindow,
  estimatePiContextTokens,
  guardAssistantMessageStream,
} from "../llm/provider.js";
import {
  agentTrajectoryHeaders,
  beginAgentModelCall,
} from "../llm/agent-trajectory.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";

/**
 * The single Pi transport boundary used by both conversational and worker
 * agents. Pi keeps native tool calls; InkOS adds context guards, trajectory
 * headers, cancellation, and stream deadlines around the request.
 */
export function guardedPiStream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const reservedOutputTokens = Number.isFinite(options?.maxTokens)
    ? options!.maxTokens!
    : Number.isFinite(model.maxTokens)
      ? model.maxTokens
      : 4096;
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  const modelCall = beginAgentModelCall();
  const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, 1, {
    effort: String(options?.reasoning ?? (model.reasoning ? "enabled" : "disabled")),
  });
  return guardAssistantMessageStream(
    model,
    (signal) => streamSimple(model, context, {
      ...options,
      headers: { ...(options?.headers ?? {}), ...traceHeaders },
      signal,
    }),
    options?.signal,
  );
}

/**
 * Non-streaming OpenAI-compatible transport adapted back into Pi events.
 * The Agent and tool loop remain Pi-owned; this only changes the HTTP mode for
 * providers whose streaming endpoint is unavailable or unreliable.
 */
export function guardedPiNonStreaming<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  proxyUrl?: string,
): AssistantMessageEventStream {
  if (model.api !== "openai-completions") return guardedPiStream(model, context, options);
  const reservedOutputTokens = Number.isFinite(options?.maxTokens)
    ? options!.maxTokens!
    : Number.isFinite(model.maxTokens)
      ? model.maxTokens
      : 4096;
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  const eventStream = createAssistantMessageEventStream();
  const output = emptyAssistantMessage(model);
  void (async () => {
    try {
      const modelCall = beginAgentModelCall();
      const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, 1, {
        effort: String(options?.reasoning ?? (model.reasoning ? "enabled" : "disabled")),
      });
      const payload: Record<string, unknown> = {
        model: model.id,
        messages: toOpenAIChatMessages(context),
        stream: false,
      };
      if (context.tools?.length) {
        payload.tools = context.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      if (options?.maxTokens) payload.max_tokens = options.maxTokens;
      if (options?.temperature !== undefined) payload.temperature = options.temperature;
      const toolChoice = (options as SimpleStreamOptions & { toolChoice?: unknown } | undefined)?.toolChoice;
      if (toolChoice !== undefined) payload.tool_choice = toolChoice;
      const transformed = await options?.onPayload?.(payload, model);
      const response = await fetchWithProxy(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options?.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          ...(model.headers ?? {}),
          ...(options?.headers ?? {}),
          ...traceHeaders,
        },
        body: JSON.stringify(transformed ?? payload),
        signal: options?.signal,
      }, proxyUrl);
      const raw = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${readOpenAIError(raw)}`.trim());
      const json = JSON.parse(raw) as Record<string, any>;
      populateAssistantMessage(output, json);
      emitCompletedMessage(eventStream, output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({ type: "error", reason: output.stopReason, error: output });
      eventStream.end();
    }
  })();
  return eventStream;
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toOpenAIChatMessages(context: Context): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt?.trim()) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: openAIUserContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = message.content
        .filter((part): part is ToolCall => part.type === "toolCall")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.arguments) },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    messages.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content: text,
    });
  }
  return messages;
}

function openAIUserContent(content: Context["messages"][number] extends infer _T ? any : never): unknown {
  if (typeof content === "string") return content;
  return content.map((part: { type: string; text?: string; data?: string; mimeType?: string }) => (
    part.type === "image"
      ? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
      : { type: "text", text: part.text ?? "" }
  ));
}

function populateAssistantMessage(output: AssistantMessage, json: Record<string, any>): void {
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const message = choice?.message ?? {};
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  if (reasoning) output.content.push({ type: "thinking", thinking: reasoning });
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part: any) => part?.text ?? "").join("")
      : "";
  if (text) output.content.push({ type: "text", text });
  for (const item of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!item?.function?.name) continue;
    output.content.push({
      type: "toolCall",
      id: typeof item.id === "string" && item.id ? item.id : `call_${randomUUID()}`,
      name: item.function.name,
      arguments: parseToolArguments(item.function.arguments),
    });
  }
  output.responseId = typeof json.id === "string" ? json.id : undefined;
  const usage = json.usage ?? {};
  output.usage = {
    ...output.usage,
    input: Number(usage.prompt_tokens ?? 0),
    output: Number(usage.completion_tokens ?? 0),
    cacheRead: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
  };
  const finishReason = String(choice?.finish_reason ?? "stop");
  output.stopReason = output.content.some((part) => part.type === "toolCall")
    ? "toolUse"
    : finishReason === "length"
      ? "length"
      : "stop";
}

function emitCompletedMessage(stream: AssistantMessageEventStream, output: AssistantMessage): void {
  const partial = { ...output, content: [] } as AssistantMessage;
  stream.push({ type: "start", partial });
  for (const [contentIndex, part] of output.content.entries()) {
    partial.content.push(part);
    if (part.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial });
      stream.push({ type: "text_delta", contentIndex, delta: part.text, partial });
      stream.push({ type: "text_end", contentIndex, content: part.text, partial });
    } else if (part.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex, partial });
      stream.push({ type: "thinking_delta", contentIndex, delta: part.thinking, partial });
      stream.push({ type: "thinking_end", contentIndex, content: part.thinking, partial });
    } else {
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(part.arguments), partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial });
    }
  }
  stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
  stream.end();
}

function parseToolArguments(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function readOpenAIError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Fall through to the bounded raw response.
  }
  return raw;
}
