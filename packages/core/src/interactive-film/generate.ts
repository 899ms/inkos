import type { LLMClient } from "../llm/provider.js";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import { appendActivatedSkillGuidance } from "../agents/base.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import type { Static } from "@sinclair/typebox";
import { StoryGraphSchema, type StoryGraph } from "./graph-schema.js";
import { StoryGraphContentToolSchema } from "./tool-schemas.js";
import { validateStoryGraph } from "./validation.js";

const SYSTEM_PROMPT_ZH = `按已激活的互动影游 Skill 生成可玩分支图。结构要求：恰好 1 个 type=start 节点；至少有一个提供不同去向或状态后果的真实分支选择，开场节点可以直接承载这次选择；至少 1 个 ending；每条路径可达 ending；专门的后续决策场景可使用 branch，普通场景使用 normal/explore/merge。调用 submit_story_graph 提交。`;

const SYSTEM_PROMPT_EN = `Generate a playable branching graph with the activated interactive-film Skill. Structural requirements: exactly one type=start node; at least one real choice with distinct destinations or state consequences, which the start node may present directly; at least one ending; every path reaches an ending. Use branch for a dedicated later decision scene and normal/explore/merge for ordinary scenes. Submit through submit_story_graph.`;

export interface GenerateStoryGraphInput {
  readonly projectId: string;
  readonly title: string;
  readonly premise: string;
}

export async function generateStoryGraph(
  client: LLMClient,
  model: string,
  input: GenerateStoryGraphInput,
  options?: {
    readonly maxTokens?: number;
    readonly language?: "zh" | "en";
    readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
    readonly signal?: AbortSignal;
  },
): Promise<StoryGraph> {
  const language = options?.language ?? "zh";
  const systemPrompt = language === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;
  const userPrompt = language === "en"
    ? `Title: ${input.title}\nPremise: ${input.premise}`
    : `标题：${input.title}\n前提：${input.premise}`;
  const baseMessages = appendActivatedSkillGuidance([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], options?.activatedSkills);
  const tool = {
    name: "submit_story_graph",
    label: language === "en" ? "Submit Story Graph" : "提交故事图谱",
    description: language === "en"
      ? "Submit the complete playable branching graph. The host owns the project id, schema version, and title."
      : "提交完整可玩的分支图。项目 id、schema 版本和标题由宿主负责。",
    parameters: StoryGraphContentToolSchema,
    validate: (submitted: Static<typeof StoryGraphContentToolSchema>) => {
      const graph = StoryGraphSchema.parse({
        ...submitted,
        schemaVersion: 1,
        projectId: input.projectId,
        title: input.title,
      });
      const reasons = graphValidationReasons(graph);
      if (reasons.length > 0) {
        throw new Error(language === "en"
          ? `Story graph is not playable: ${reasons.join("; ")}`
          : `故事图不可玩：${reasons.join("；")}`);
      }
      return submitted;
    },
  } as const;
  const submitted = await runWorkerAgentTool(client, model, baseMessages, tool, {
    temperature: 0.5,
    maxTokens: options?.maxTokens ?? 8000,
    signal: options?.signal,
  });
  return StoryGraphSchema.parse({
    ...submitted,
    schemaVersion: 1,
    projectId: input.projectId,
    title: input.title,
  });
}

function graphValidationReasons(graph: StoryGraph): string[] {
  const startCount = graph.nodes.filter((node) => node.type === "start").length;
  const branchCount = graph.nodes.filter((node) => {
    if (node.choices.length < 2) return false;
    const outcomes = new Set(node.choices.map((choice) => JSON.stringify({
      targetNodeId: choice.targetNodeId,
      condition: choice.condition,
      effects: choice.effects,
    })));
    return outcomes.size > 1;
  }).length;
  const report = validateStoryGraph(graph);
  return [
    ...(startCount !== 1 ? [`expected exactly one start node, received ${startCount}`] : []),
    ...(branchCount < 1 ? ["expected at least one meaningful branching decision"] : []),
    ...(graph.endings.length < 1 ? ["expected at least one ending"] : []),
    ...report.issues.filter((issue) => issue.level === "error").map((issue) => issue.message),
  ];
}
