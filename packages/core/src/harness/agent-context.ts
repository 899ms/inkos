import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateTextTokens } from "../llm/provider.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import {
  compileContext,
  ContextSourceRegistry,
  ProtectedContextOverflowError,
  type ContextFragment,
  type SemanticContextCompiler,
} from "./context-compiler.js";
import type { WorkManifest, WorkProfile } from "./contracts.js";
import { loadWorkManifest, workDirectory } from "./work-store.js";

const PROFILE_CONTEXT_FILES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "longform-novel": ["source/book.json", "source/story/author_intent.md", "source/story/current_focus.md"],
  "interactive-film": ["source/story-graph.json"],
  "interactive-world": ["source/world.json"],
  translation: ["source/manifest.json", "source/glossary.json"],
};

const PROTECTED_CONTEXT_FILES = new Set([
  "source/book.json",
  "source/story/author_intent.md",
  "source/story/current_focus.md",
  "source/glossary.json",
]);

export interface ConversationCompactionRequest {
  readonly history: string;
  readonly intent: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export type ConversationCompactor = (request: ConversationCompactionRequest) => Promise<string>;

export function createHarnessContextTransform(input: {
  readonly projectRoot: string;
  readonly work: WorkManifest | null;
  readonly profile: WorkProfile;
  readonly budgetTokens: number;
  readonly semanticCompiler?: SemanticContextCompiler;
  readonly conversationCompactor?: ConversationCompactor;
  readonly onContextCompression?: ContextCompressionCallback;
}): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const sources = new ContextSourceRegistry();
  sources.register({
    id: "work-current",
    async load(request) {
      const work = request.work;
      if (!work) return [];
      const fragments: ContextFragment[] = [{
        id: "work-identity",
        source: "current Work",
        protection: "protected",
        priority: 100,
        pointer: `works/${work.id}/work.json`,
        content: JSON.stringify({
          id: work.id,
          title: work.title,
          profileId: work.profileId,
          language: work.language,
          status: work.status,
          lineage: work.lineage,
          metadata: work.metadata,
        }),
      }];
      for (const relativePath of PROFILE_CONTEXT_FILES[request.profile.id] ?? []) {
        const content = await readFile(join(workDirectory(request.projectRoot, work.id), relativePath), "utf-8")
          .catch(() => "");
        if (!content.trim()) continue;
        fragments.push({
          id: relativePath.replaceAll("/", "-"),
          source: relativePath,
          protection: PROTECTED_CONTEXT_FILES.has(relativePath) ? "protected" : "compressible",
          priority: PROTECTED_CONTEXT_FILES.has(relativePath) ? 90 : 50,
          pointer: `works/${work.id}/${relativePath}`,
          content,
        });
      }
      return fragments;
    },
  });

  return async (messages, signal) => {
    const lastUserIndex = findLastUserIndex(messages);
    const historicalMessages = lastUserIndex > 0 ? messages.slice(0, lastUserIndex) : [];
    const protectedTail = lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages;
    const tailTokens = estimateAgentMessages(protectedTail);
    const workBudget = input.budgetTokens - tailTokens;
    if (workBudget <= 0) throw new ProtectedContextOverflowError(tailTokens, input.budgetTokens);

    const currentWork = input.work ? await loadWorkManifest(input.projectRoot, input.work.id) : null;
    const compiled = await compileContext({
      recipe: { id: `${input.profile.id}-agent`, sourceIds: ["work-current"] },
      sources,
      request: {
        projectRoot: input.projectRoot,
        work: currentWork,
        profile: input.profile,
        actionId: "agent-turn",
        intent: latestUserText(messages),
        signal,
      },
      budgetTokens: workBudget,
      compiler: input.semanticCompiler,
    });
    const contextMessage: UserMessage | null = compiled.markdown
      ? {
          role: "user",
          content: `<current_work_context>\n${compiled.markdown}\n</current_work_context>`,
          timestamp: Date.now(),
        }
      : null;
    const withContext = contextMessage ? [contextMessage as AgentMessage, ...messages] : messages;
    if (estimateAgentMessages(withContext) <= input.budgetTokens) return withContext;

    if (!input.conversationCompactor || historicalMessages.length === 0) {
      throw new ProtectedContextOverflowError(
        estimateAgentMessages(contextMessage ? [contextMessage as AgentMessage, ...protectedTail] : protectedTail),
        input.budgetTokens,
      );
    }

    const workTokens = contextMessage ? estimateAgentMessages([contextMessage as AgentMessage]) : 0;
    const summaryBudget = input.budgetTokens - workTokens - tailTokens;
    if (summaryBudget <= 0) {
      throw new ProtectedContextOverflowError(workTokens + tailTokens, input.budgetTokens);
    }
    input.onContextCompression?.({ category: "session_context", phase: "start", sources: ["session transcript"] });
    const summary = (await input.conversationCompactor({
      history: renderAgentMessages(historicalMessages),
      intent: latestUserText(messages),
      maxTokens: summaryBudget,
      signal,
    })).trim();
    if (!summary) throw new Error("Conversation compactor returned empty content");
    const summaryMessage = {
      role: "system",
      content: `<conversation_summary>\n${summary}\n</conversation_summary>`,
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const finalMessages = [
      ...(contextMessage ? [contextMessage as AgentMessage] : []),
      summaryMessage,
      ...protectedTail,
    ];
    const finalTokens = estimateAgentMessages(finalMessages);
    if (finalTokens > input.budgetTokens) {
      throw new Error(`Compacted conversation still exceeds budget: ${finalTokens}/${input.budgetTokens} tokens`);
    }
    input.onContextCompression?.({ category: "session_context", phase: "end", sources: ["session transcript"] });
    return finalMessages;
  };
}

function findLastUserIndex(messages: ReadonlyArray<AgentMessage>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as { role?: string }).role === "user") return index;
  }
  return -1;
}

function estimateAgentMessages(messages: ReadonlyArray<AgentMessage>): number {
  return estimateTextTokens(renderAgentMessages(messages));
}

function renderAgentMessages(messages: ReadonlyArray<AgentMessage>): string {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

function latestUserText(messages: ReadonlyArray<AgentMessage>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((item): item is { type: "text"; text: string } => (
          Boolean(item) && typeof item === "object" && item.type === "text" && typeof item.text === "string"
        ))
        .map((item) => item.text)
        .join("\n");
    }
  }
  return "";
}
