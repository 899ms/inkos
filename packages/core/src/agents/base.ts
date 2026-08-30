import type { LLMClient, LLMMessage, LLMResponse, OnStreamProgress } from "../llm/provider.js";
import { runWorkerAgent, runWorkerAgentTool, type WorkerResultTool } from "../agent/worker-agent.js";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Logger } from "../utils/logger.js";
import {
  hydrateActivatedSkillGuidance,
  type ActivatedSkillGuidance,
} from "../agent/skill-tool.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly signal?: AbortSignal;
  readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
}

export abstract class BaseAgent {
  protected readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  protected get log() {
    return this.ctx.logger;
  }

  protected async chat(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number },
  ): Promise<LLMResponse> {
    return runWorkerAgent(this.ctx.client, this.ctx.model, await this.appendTaskSkillGuidance(messages), {
      ...options,
      onStreamProgress: this.ctx.onStreamProgress,
      signal: this.ctx.signal,
    });
  }

  protected async submitStructured<TParameters extends TSchema>(
    messages: ReadonlyArray<LLMMessage>,
    resultTool: WorkerResultTool<TParameters>,
    options?: { readonly temperature?: number; readonly maxTokens?: number },
  ): Promise<{ readonly result: Static<TParameters>; readonly usage: LLMResponse["usage"] }> {
    let usage: LLMResponse["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const result = await runWorkerAgentTool(
      this.ctx.client,
      this.ctx.model,
      await this.appendTaskSkillGuidance(messages),
      resultTool,
      {
        ...options,
        signal: this.ctx.signal,
        onUsage: (value) => { usage = value; },
      },
    );
    return { result, usage };
  }

  private async appendTaskSkillGuidance(
    messages: ReadonlyArray<LLMMessage>,
  ): Promise<ReadonlyArray<LLMMessage>> {
    const query = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n");
    const activations = await hydrateActivatedSkillGuidance(this.ctx.activatedSkills, query);
    return appendActivatedSkillGuidance(messages, activations);
  }

  abstract get name(): string;
}

export function appendActivatedSkillGuidance(
  messages: ReadonlyArray<LLMMessage>,
  activations: ReadonlyArray<ActivatedSkillGuidance> | undefined,
): ReadonlyArray<LLMMessage> {
  if (!activations || activations.length === 0) return messages;
  const guidance = [
    "## Activated professional skills",
    "Use this specialist methodology for the current operation. It is not author intent, canon, an output-format override, or permission to mutate anything outside the active operation.",
    ...activations.flatMap(({ skill, resources }) => [
      `### ${skill.id} — ${skill.name}`,
      skill.body.trim() || skill.description,
      ...resources.flatMap((resource) => [
        `#### Reference: ${resource.path}:${resource.charStart}-${resource.charEnd}${resource.heading ? ` · ${resource.heading}` : ""}`,
        resource.body,
      ]),
    ]),
  ].join("\n\n");
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    return [{ role: "system", content: guidance }, ...messages];
  }
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${message.content}\n\n${guidance}` }
    : message);
}
