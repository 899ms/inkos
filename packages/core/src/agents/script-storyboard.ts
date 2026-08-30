import { BaseAgent } from "./base.js";
import { completeLongForm } from "../llm/long-form-completion.js";
import { InteractiveFilmPackageToolSchema, StoryboardAssetsToolSchema } from "./production-document-tool.js";

export type ScriptTargetFormat =
  | "vertical_short_drama"
  | "screenplay"
  | "audio_drama"
  | "interactive_script"
  | "general_script";

export interface ScriptCreationInput {
  readonly title: string;
  readonly sourceKind?: string;
  readonly targetFormat?: ScriptTargetFormat;
  readonly sourceText?: string;
  readonly requirements?: string;
  readonly episodeCount?: number;
  readonly episodeDuration?: string;
  readonly language?: "zh" | "en";
}

export interface StoryboardCreationInput {
  readonly title: string;
  readonly sourceKind?: string;
  readonly sourceText?: string;
  readonly requirements?: string;
  readonly visualStyle?: string;
  readonly aspectRatio?: string;
  readonly granularity?: string;
  readonly maxShots?: number;
  readonly language?: "zh" | "en";
  readonly segment?: {
    readonly label: string;
    readonly index: number;
    readonly count: number;
    readonly estimatedShots: number;
  };
}

export interface InteractiveFilmCreationInput {
  readonly title: string;
  readonly sourceKind?: string;
  readonly sourceText?: string;
  readonly requirements?: string;
  readonly targetAudience?: string;
  readonly episodeCount?: number;
  readonly episodeDuration?: string;
  readonly budget?: string;
  readonly referenceMode?: string;
  readonly language?: "zh" | "en";
}

abstract class LongFormProductionAgent extends BaseAgent {
  protected async recoverProductionMarkdown(
    fragments: string,
    language: "zh" | "en",
    requiredHeadings: readonly string[],
  ): Promise<string> {
    const response = await this.chat([
      {
        role: "system",
        content: language === "en"
          ? [
              "You recover one canonical production document after a transport-confirmed output-limit continuation.",
              "The fragments may contain scratch analysis, overlapping suffixes, and complete-document restarts.",
              "Return exactly one complete Markdown deliverable. Preserve the user's requirements and the most developed usable content; remove process notes, scratch analysis, wrappers, duplicate document roots, and repeated sections.",
              "Do not summarize or shorten the actual deliverable.",
            ].join("\n")
          : [
              "你负责在模型因输出上限续写后，恢复唯一一份规范生产文档。",
              "输入片段可能包含思考草稿、重叠后缀和从头重写的完整文档。",
              "返回且只返回一份完整 Markdown 交付稿。保留用户要求和完成度最高的可用内容；删除流程说明、思考草稿、包装文本、重复文档开头和重复小节。",
              "不得概括或缩短实际交付内容。",
            ].join("\n"),
      },
      {
        role: "user",
        content: [
          language === "en" ? "## Required Headings" : "## 必需标题",
          ...requiredHeadings.map((heading) => `- ${heading}`),
          "",
          language === "en" ? "## Output Fragments" : "## 输出片段",
          fragments,
        ].join("\n"),
      },
    ], {
      temperature: 0.1,
      maxTokens: 32_000,
    });
    return response.content.trim();
  }
}

export class ScriptCreationAgent extends LongFormProductionAgent {
  get name(): string {
    return "script-creation-writer";
  }

  async writeScript(input: ScriptCreationInput): Promise<string> {
    const language = input.language ?? "zh";
    const messages = [
      { role: "system", content: buildScriptCreationSystemPrompt(language) },
      { role: "user", content: buildScriptCreationUserPrompt(input, language) },
    ] as const;
    const response = await completeLongForm({
      messages,
      language,
      generate: (continuationMessages) => this.chat(continuationMessages, {
        temperature: 0.55,
        maxTokens: this.ctx.client.defaults.maxTokens,
      }),
      onContinuation: (pass) => this.log?.warn(`[script] Output limit reached; continuing pass ${pass}.`),
      recoverAfterContinuation: (fragments) => this.recoverProductionMarkdown(
        fragments,
        language,
        language === "en" ? ["## Characters", "## Script"] : ["## 人物", "## 剧本正文"],
      ),
    });
    return response.content.trim();
  }
}

export class StoryboardCreationAgent extends LongFormProductionAgent {
  get name(): string {
    return "storyboard-creation-writer";
  }

  async writeStoryboard(input: StoryboardCreationInput): Promise<string> {
    const language = input.language ?? "zh";
    const messages = [
      { role: "system", content: buildStoryboardCreationSystemPrompt(language) },
      { role: "user", content: buildStoryboardCreationUserPrompt(input, language) },
    ] as const;
    const response = await completeLongForm({
      messages,
      language,
      generate: (continuationMessages) => this.chat(continuationMessages, {
        temperature: 0.45,
        maxTokens: this.ctx.client.defaults.maxTokens,
      }),
      onContinuation: (pass) => this.log?.warn(`[storyboard] Output limit reached; continuing pass ${pass}.`),
      recoverAfterContinuation: (fragments) => this.recoverProductionMarkdown(
        fragments,
        language,
        language === "en" ? ["## Storyboard", "## Image Prompts"] : ["## 分镜表", "## 图像提示词"],
      ),
    });
    return response.content.trim();
  }
}

export class InteractiveFilmCreationAgent extends LongFormProductionAgent {
  get name(): string {
    return "interactive-film-creation-writer";
  }

  async writeInteractiveFilm(input: InteractiveFilmCreationInput): Promise<string> {
    const language = input.language ?? "zh";
    const messages = [
      { role: "system", content: buildInteractiveFilmCreationSystemPrompt(language) },
      { role: "user", content: buildInteractiveFilmCreationUserPrompt(input, language) },
    ] as const;
    const response = await completeLongForm({
      messages,
      language,
      generate: (continuationMessages) => this.chat(continuationMessages, {
        temperature: 0.5,
        maxTokens: this.ctx.client.defaults.maxTokens,
      }),
      onContinuation: (pass) => this.log?.warn(`[interactive-film] Output limit reached; continuing pass ${pass}.`),
      recoverAfterContinuation: (fragments) => this.recoverProductionMarkdown(
        fragments,
        language,
        language === "en"
          ? ["## Story Tree", "## Variables and Flags", "## Ending Paths", "## Interactive Script", "## Storyboard and Image Prompts"]
          : ["## 剧情树", "## 变量与旗标表", "## 多结局路径", "## 互动剧本", "## 分镜与图像提示词"],
      ),
    });
    return response.content.trim();
  }
}

export class ProductionDocumentCompilerAgent extends BaseAgent {
  get name(): string {
    return "production-document-compiler";
  }

  async compileStoryboardAssets(document: string, language: "zh" | "en" = "zh"): Promise<ReadonlyArray<string>> {
    const { result } = await this.submitStructured(
      [
        {
          role: "system",
          content: language === "en"
            ? "Read the complete storyboard and submit its generation-ready shot image prompts in document order. Do not invent shots or rewrite prompts."
            : "读取完整分镜稿，按文档顺序提交每个镜头可直接生图的提示词。不要发明镜头，也不要改写提示词。",
        },
        { role: "user", content: document },
      ],
      {
        name: "submit_storyboard_assets",
        label: "Submit storyboard assets",
        description: "Submit image prompts extracted semantically from the storyboard artifact.",
        parameters: StoryboardAssetsToolSchema,
      },
      { temperature: 0.1 },
    );
    return result.imagePrompts;
  }

  async compileInteractiveFilmPackage(document: string, language: "zh" | "en" = "zh") {
    const { result } = await this.submitStructured(
      [
        {
          role: "system",
          content: language === "en"
            ? "Project the complete interactive-film deliverable into the typed host package. Preserve the document content; do not invent or summarize missing sections."
            : "把完整互动影游交付稿投影到宿主结构中。保留原文内容，不发明缺失部分，也不把已有部分概括缩短。",
        },
        { role: "user", content: document },
      ],
      {
        name: "submit_interactive_film_package",
        label: "Submit interactive-film package",
        description: "Submit the host-consumed sections of the interactive-film deliverable.",
        parameters: InteractiveFilmPackageToolSchema,
      },
      { temperature: 0.1 },
    );
    return result;
  }
}

export function renderScriptSpec(input: ScriptCreationInput): string {
  if ((input.language ?? "zh") === "en") {
    return [
      `# ${input.title} Script Creation Spec`,
      "",
      "## Goal",
      `- Deliverable: ${formatScriptTarget(input.targetFormat, "en")}`,
      input.episodeCount
        ? `- Episode/segment count: ${input.episodeCount}`
        : "- Episode/segment count: unspecified; judge from the source material and user requirements",
      input.episodeDuration
        ? `- Per-episode/segment duration: ${input.episodeDuration}`
        : "- Per-episode/segment duration: unspecified",
      input.sourceKind
        ? `- Source material: ${input.sourceKind}`
        : "- Source material: user input / conversation brief",
      "",
      "## User Requirements",
      input.requirements?.trim() || "Not separately specified; follow the instruction the user confirmed.",
      "",
      "## Source Material Summary",
      summarizeSourceForSpec(input.sourceText, "en"),
    ].join("\n");
  }
  return [
    `# ${input.title} 剧本创作规格`,
    "",
    "## 目标",
    `- 交付类型：${formatScriptTarget(input.targetFormat)}`,
    input.episodeCount ? `- 集数/段落数：${input.episodeCount}` : "- 集数/段落数：未指定，按素材和用户要求判断",
    input.episodeDuration ? `- 单集/单段时长：${input.episodeDuration}` : "- 单集/单段时长：未指定",
    input.sourceKind ? `- 原素材：${input.sourceKind}` : "- 原素材：用户输入/对话需求",
    "",
    "## 用户要求",
    input.requirements?.trim() || "未单独指定；以用户确认时的 instruction 为准。",
    "",
    "## 源素材摘要",
    summarizeSourceForSpec(input.sourceText),
  ].join("\n");
}

export function renderStoryboardSpec(input: StoryboardCreationInput): string {
  if ((input.language ?? "zh") === "en") {
    return [
      `# ${input.title} Storyboard Creation Spec`,
      "",
      "## Goal",
      `- Shot granularity: ${input.granularity?.trim() || "unspecified"}`,
      `- Aspect ratio: ${input.aspectRatio?.trim() || "unspecified"}`,
      `- Visual style: ${input.visualStyle?.trim() || "unspecified"}`,
      input.maxShots ? `- Shot cap: ${input.maxShots}` : "- Shot cap: unspecified",
      input.sourceKind
        ? `- Source material: ${input.sourceKind}`
        : "- Source material: user input / conversation brief",
      "",
      "## User Requirements",
      input.requirements?.trim() || "Not separately specified; follow the instruction the user confirmed.",
      "",
      "## Source Material Summary",
      summarizeSourceForSpec(input.sourceText, "en"),
    ].join("\n");
  }
  return [
    `# ${input.title} 分镜创作规格`,
    "",
    "## 目标",
    `- 分镜粒度：${input.granularity?.trim() || "未指定"}`,
    `- 画幅：${input.aspectRatio?.trim() || "未指定"}`,
    `- 视觉风格：${input.visualStyle?.trim() || "未指定"}`,
    input.maxShots ? `- 镜头上限：${input.maxShots}` : "- 镜头上限：未指定",
    input.sourceKind ? `- 原素材：${input.sourceKind}` : "- 原素材：用户输入/对话需求",
    "",
    "## 用户要求",
    input.requirements?.trim() || "未单独指定；以用户确认时的 instruction 为准。",
    "",
    "## 源素材摘要",
    summarizeSourceForSpec(input.sourceText),
  ].join("\n");
}

export function renderInteractiveFilmSpec(input: InteractiveFilmCreationInput): string {
  if ((input.language ?? "zh") === "en") {
    return [
      `# ${input.title} Interactive Film Creation Spec`,
      "",
      "## Goal",
      "- Deliverable: interactive film / interactive narrative game / film-game script",
      "- Scope: story tree, variables/flags, playable node scripts, multiple endings, storyboards, and image assets",
      input.episodeCount
        ? `- Story segments/episodes: ${input.episodeCount}`
        : "- Story segments/episodes: unspecified; judge from the source material and user requirements",
      input.episodeDuration
        ? `- Per-segment/episode duration: ${input.episodeDuration}`
        : "- Per-segment/episode duration: unspecified",
      input.budget ? `- Budget constraint: ${input.budget}` : "- Budget constraint: unspecified",
      input.targetAudience ? `- Target audience: ${input.targetAudience}` : "- Target audience: unspecified",
      input.referenceMode
        ? `- Reference mode: ${input.referenceMode}`
        : "- Reference mode: unspecified by the user; do not impose a fixed game template",
      input.sourceKind
        ? `- Source material: ${input.sourceKind}`
        : "- Source material: user input / conversation brief",
      "",
      "## User Requirements",
      input.requirements?.trim() || "Not separately specified; follow the instruction the user confirmed.",
      "",
      "## Source Material Summary",
      summarizeSourceForSpec(input.sourceText, "en"),
    ].join("\n");
  }
  return [
    `# ${input.title} 互动影游创作规格`,
    "",
    "## 目标",
    "- 交付类型：互动影游 / 互动叙事类游戏 / 影游剧本",
    "- 交付范围：剧情树、变量/旗标、可玩节点剧本、多结局、分镜与图片资产",
    input.episodeCount ? `- 剧情段落/集数：${input.episodeCount}` : "- 剧情段落/集数：未指定，按素材和用户要求判断",
    input.episodeDuration ? `- 单段/单集时长：${input.episodeDuration}` : "- 单段/单集时长：未指定",
    input.budget ? `- 预算约束：${input.budget}` : "- 预算约束：未指定",
    input.targetAudience ? `- 目标受众：${input.targetAudience}` : "- 目标受众：未指定",
    input.referenceMode ? `- 参考模式：${input.referenceMode}` : "- 参考模式：用户未指定，不擅自套固定游戏模板",
    input.sourceKind ? `- 原素材：${input.sourceKind}` : "- 原素材：用户输入/对话需求",
    "",
    "## 用户要求",
    input.requirements?.trim() || "未单独指定；以用户确认时的 instruction 为准。",
    "",
    "## 源素材摘要",
    summarizeSourceForSpec(input.sourceText),
  ].join("\n");
}


function buildScriptCreationSystemPrompt(language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "You are a script-creation tool, not a novel-continuation engine.",
      "Execute the confirmed spec with the activated script-writing Skill.",
      "The deliverable must include the exact Markdown headings `## Characters` and `## Script`, followed by a complete performable script rather than a proposal or outline.",
      "Output Markdown. No process notes, no model self-narration, no \"Here is\" preamble.",
    ].join("\n");
  }
  return [
    "你是剧本创作工具，不是小说续写器。",
    "按已激活的剧本创作 Skill 执行确认规格。",
    "交付稿必须包含准确的 Markdown 标题 `## 人物` 和 `## 剧本正文`，并在其后给出完整可排演剧本，不能只交方案或大纲。",
    "输出 Markdown。不要写流程说明、模型自述或“以下是”。",
  ].join("\n");
}

function buildScriptCreationUserPrompt(input: ScriptCreationInput, language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "## Creation Spec",
      renderScriptSpec(input),
      "",
      "## Full Source Material",
      input.sourceText?.trim()
        || "The user did not provide full source material; write an extensible script draft strictly from the creation spec and user requirements.",
      "",
      "## Output Format",
      `# ${input.title}`,
      "",
      "## Characters",
      "",
      "## Script",
      "",
      "Use the target format defined by the activated Skill and confirmed spec.",
    ].join("\n");
  }
  return [
    "## 创作规格",
    renderScriptSpec(input),
    "",
    "## 完整源素材",
    input.sourceText?.trim() || "用户没有提供完整源素材；请严格根据创作规格和用户要求写一个可继续扩展的剧本稿。",
    "",
    "## 输出格式",
    `# ${input.title}`,
    "",
    "## 人物",
    "",
    "## 剧本正文",
    "",
    "按已激活 Skill 和确认规格中的目标格式输出。",
  ].join("\n");
}

function buildStoryboardCreationSystemPrompt(language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "Execute the confirmed visual spec with the activated storyboard Skill; unconfirmed choices remain adjustable.",
      "Output Markdown. No model self-narration or process explanation.",
    ].join("\n");
  }
  return [
    "按已激活的分镜 Skill 执行确认的视觉规格；未确认选择保持可调整。",
    "输出 Markdown。不要写模型自述或流程解释。",
  ].join("\n");
}

function buildStoryboardCreationUserPrompt(input: StoryboardCreationInput, language: "zh" | "en" = "zh"): string {
  const maxShotsRule = input.maxShots
    ? (language === "en" ? `Do not exceed ${input.maxShots} shots.` : `镜头总数不得超过 ${input.maxShots}。`)
    : "";
  if (language === "en") {
    return [
      "## Storyboard Spec",
      renderStoryboardSpec(input),
      "",
      "## Full Source Material",
      input.sourceText?.trim()
        || "The user did not provide full source material; write an extensible storyboard draft strictly from the storyboard spec and user requirements.",
      ...(input.segment ? [
        "",
        "## Current Production Segment",
        `Write only ${input.segment.label} (${input.segment.index + 1}/${input.segment.count}) in this call. The global shot cap is NOT the shot count for this call. Preserve all global requirements and follow the exact scene/segment shot count when the user confirmed one. Do not summarize or write any other segment.`,
      ] : []),
      "",
      "## Output Format",
      `# ${input.title} Storyboard`,
      "",
      "## Storyboard",
      "",
      maxShotsRule,
      "",
      "## Image Prompts",
      "",
      "Write one image prompt per shot as a standalone `Prompt: ...` line.",
    ].join("\n");
  }
  return [
    "## 分镜规格",
    renderStoryboardSpec(input),
    "",
    "## 完整源素材",
    input.sourceText?.trim() || "用户没有提供完整源素材；请严格根据分镜规格和用户要求写一个可继续扩展的分镜稿。",
    ...(input.segment ? [
      "",
      "## 当前生产分段",
      `本次只写${input.segment.label}（${input.segment.index + 1}/${input.segment.count}）。全局镜头上限不是本次镜头数。保留全部全局要求；用户已确认本场/本段镜头数时严格按该数量执行。不要概括或生成任何其他分段。`,
    ] : []),
    "",
    "## 输出格式",
    `# ${input.title} 分镜`,
    "",
    "## 分镜表",
    "",
    maxShotsRule,
    "",
    "## 图像提示词",
    "",
    "每个镜头对应一条独立的 `Prompt: ...` 图像提示词。",
  ].join("\n");
}

function buildInteractiveFilmCreationSystemPrompt(language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "Execute the confirmed spec with the activated interactive-film Skill; unconfirmed choices remain adjustable.",
      "Output must be Markdown with the specified sections. No model self-narration, process notes, or \"Here is\" preamble.",
      "Every storyboard image prompt must be its own standalone `Prompt: ...` line so downstream asset management can pick it up; include only the visual constraints the user has confirmed.",
    ].join("\n");
  }
  return [
    "按已激活的互动影游 Skill 执行确认规格；未确认选择保持可调整。",
    "输出必须是 Markdown，包含指定小节。不要写模型自述、流程说明或“以下是”。",
    "分镜图提示词必须写成单独的 `Prompt: ...` 行，便于后续资产管理；只写用户确认过的视觉限制。",
  ].join("\n");
}

function buildInteractiveFilmCreationUserPrompt(input: InteractiveFilmCreationInput, language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    return [
      "## Interactive Film Spec",
      renderInteractiveFilmSpec(input),
      "",
      "## Full Source Material",
      input.sourceText?.trim()
        || "The user did not provide full source material; write an extensible interactive-film deliverable strictly from the creation spec and user requirements.",
      "",
      "## Output Format",
      `# ${input.title} Interactive Film Package`,
      "",
      "## Story Tree",
      "Provide the complete story tree using the activated Skill.",
      "",
      "## Variables and Flags",
      "Provide the complete variables and flags surface using the activated Skill.",
      "",
      "## Ending Paths",
      "Provide every ending path and its conditions.",
      "",
      "## Interactive Script",
      "Provide the complete playable node scripts.",
      "",
      "## Storyboard and Image Prompts",
      "Provide the storyboard; each shot has one standalone `Prompt: ...` line.",
    ].join("\n");
  }
  return [
    "## 互动影游规格",
    renderInteractiveFilmSpec(input),
    "",
    "## 完整源素材",
    input.sourceText?.trim() || "用户没有提供完整源素材；请严格根据创作规格和用户要求写一个可继续扩展的互动影游交付稿。",
    "",
    "## 输出格式",
    `# ${input.title} 互动影游方案`,
    "",
    "## 剧情树",
    "按已激活 Skill 提交完整剧情树。",
    "",
    "## 变量与旗标表",
    "按已激活 Skill 提交完整变量与旗标面。",
    "",
    "## 多结局路径",
    "提交全部结局路径及其条件。",
    "",
    "## 互动剧本",
    "提交完整可玩的节点剧本。",
    "",
    "## 分镜与图像提示词",
    "提交分镜；每个镜头对应一条独立的 `Prompt: ...`。",
  ].join("\n");
}

function formatScriptTarget(value: ScriptTargetFormat | undefined, language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    switch (value) {
      case "vertical_short_drama":
        return "vertical short drama";
      case "screenplay":
        return "standard screenplay";
      case "audio_drama":
        return "audio drama";
      case "interactive_script":
        return "interactive script";
      case "general_script":
      default:
        return "general script";
    }
  }
  switch (value) {
    case "vertical_short_drama":
      return "竖屏短剧";
    case "screenplay":
      return "标准剧本";
    case "audio_drama":
      return "广播剧/有声剧";
    case "interactive_script":
      return "互动剧本";
    case "general_script":
    default:
      return "通用剧本";
  }
}

function summarizeSourceForSpec(sourceText: string | undefined, language: "zh" | "en" = "zh"): string {
  const text = sourceText?.replace(/\s+/g, " ").trim();
  if (language === "en") {
    if (!text) return "No full source material provided.";
    return `Full source material provided, about ${text.length} characters; the full content will be read during generation.`;
  }
  if (!text) return "未提供完整源素材。";
  return `已提供完整源素材，约 ${text.length} 字符；生成时会读取完整内容。`;
}
