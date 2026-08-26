import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { compileContext, ContextSourceRegistry, type ContextFragment } from "./context-compiler.js";
import type { WorkManifest, WorkProfile } from "./contracts.js";
import { workDirectory } from "./work-store.js";

const PROFILE_CONTEXT_FILES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "longform-novel": [
    "source/book.json",
    "source/story/author_intent.md",
    "source/story/current_focus.md",
  ],
  "interactive-film": ["source/story-graph.json"],
  "interactive-world": ["source/world.json"],
  translation: ["source/manifest.json", "source/glossary.json"],
};

export function createHarnessContextTransform(input: {
  readonly projectRoot: string;
  readonly work: WorkManifest | null;
  readonly profile: WorkProfile;
  readonly budgetTokens: number;
  readonly onContextCompression?: ContextCompressionCallback;
}): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  if (!input.work) return async (messages) => messages;
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
          protection: "protected",
          priority: 90,
          pointer: `works/${work.id}/${relativePath}`,
          content,
        });
      }
      return fragments;
    },
  });

  return async (messages, signal) => {
    const compiled = await compileContext({
      recipe: { id: `${input.profile.id}-agent`, sourceIds: ["work-current"] },
      sources,
      request: {
        projectRoot: input.projectRoot,
        work: input.work,
        profile: input.profile,
        actionId: "agent-turn",
        intent: latestUserText(messages),
        signal,
      },
      budgetTokens: input.budgetTokens,
    });
    if (!compiled.markdown) return messages;
    if (compiled.trace.compressionTriggered) {
      const sourceNames = compiled.trace.compiledSourceIds;
      input.onContextCompression?.({ category: "session_context", phase: "start", sources: sourceNames });
      input.onContextCompression?.({ category: "session_context", phase: "end", sources: sourceNames });
    }
    const contextMessage: UserMessage = {
      role: "user",
      content: `<current_work_context>\n${compiled.markdown}\n</current_work_context>`,
      timestamp: Date.now(),
    };
    return [contextMessage, ...messages];
  };
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
