import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly passed: boolean;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
}

export class FoundationReviewParseError extends Error {
  constructor(readonly missingDimensions: ReadonlyArray<number>) {
    super(`Foundation review output is missing dimension${missingDimensions.length === 1 ? "" : "s"}: ${missingDimensions.join(", ")}`);
    this.name = "FoundationReviewParseError";
  }
}

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly targetChapters?: number;
  }): Promise<FoundationReviewResult> {
    const canonBlock = params.sourceCanon
      ? `\n## 原作正典参照\n${params.sourceCanon}\n`
      : "";
    const styleBlock = params.styleGuide
      ? `\n## 原作风格参照\n${params.styleGuide}\n`
      : "";

    const dimensions = params.mode === "original"
      ? this.originalDimensions(params.language, params.targetChapters)
      : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = params.language === "en"
      ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
      : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { temperature: 0.3 });

    return this.parseReviewResult(response.content, dimensions);
  }

  private originalDimensions(language: "zh" | "en", targetChapters?: number): ReadonlyArray<string> {
    const target = Number.isFinite(targetChapters) && targetChapters && targetChapters > 0
      ? Math.round(targetChapters)
      : 40;
    const openingWindow = Math.min(5, target);
    const repeatWindow = Math.min(10, Math.max(3, target));
    return language === "en"
      ? [
          `Core Conflict (Is there a clear, compelling central conflict that can sustain the requested ${target} chapters?)`,
          `Opening Momentum (Can the first ${openingWindow} chapters create a page-turning hook?)`,
          "World Coherence (Is the worldbuilding internally consistent and specific?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          `Pacing Feasibility (Does the outline fit the requested ${target} chapters and avoid repeating the same beat for ${repeatWindow} chapters?)`,
        ]
      : [
          `核心冲突（是否有清晰且有足够张力的核心冲突支撑用户要求的${target}章？）`,
          `开篇节奏（前${openingWindow}章能否形成翻页驱动力？）`,
          "世界一致性（世界观是否内洽且具体？）",
          "角色区分度（主要角色的声音和动机是否各不相同？）",
          `节奏可行性（大纲是否适配用户要求的${target}章，并避免连续${repeatWindow}章同一种节拍？）`,
        ];
  }

  private derivativeDimensions(language: "zh" | "en", mode: "fanfic" | "series"): ReadonlyArray<string> {
    const modeLabel = mode === "fanfic"
      ? (language === "en" ? "Fan Fiction" : "同人")
      : (language === "en" ? "Series" : "系列");

    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Is the new story's central conflict compelling and distinct from the original?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook without requiring 3 chapters of setup?)",
          `Pacing Feasibility (Does the outline avoid the trap of re-walking the original's plot beats?)`,
        ]
      : [
          `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
          `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
          "核心冲突（新故事的核心冲突是否有足够张力且区别于原作？）",
          "开篇节奏（前5章能否形成翻页驱动力，不需要3章铺垫？）",
          `节奏可行性（卷纲是否避免了重走原作剧情节拍的陷阱？）`,
        ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深小说编辑，正在审核一本新书的基础设定（世界观 + 大纲 + 规则）。

你需要逐项判断以下维度是否可以直接进入写作，并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 判断标准
- 通过：这一维度没有会妨碍实际写作的明确问题
- 修改：存在具体、可执行的缺口；必须说明要改什么，不能只说“不够好”

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
结论：{通过/修改}
意见：{具体反馈}

=== DIMENSION: 2 ===
结论：{通过/修改}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
结论：{通过/修改}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格，但不要制造抽象门槛。只有存在明确、可执行的问题时才判“修改”。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Decide whether each dimension is ready for writing and give specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Decision standard
- Accept: no concrete issue in this dimension would block actual writing
- Revise: a specific, actionable gap exists; state exactly what must change

## Output format (strict)
=== DIMENSION: 1 ===
Verdict: {accept/revise}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Verdict: {accept/revise}
Feedback: {specific feedback}

...

=== OVERALL ===
Verdict: {accept/revise}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict without inventing an abstract quality bar. Choose revise only for concrete, actionable problems.`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "en"): string {
    return language === "en"
      ? `## Story Bible\n${foundation.storyBible}\n\n## Volume Outline\n${foundation.volumeOutline}\n\n## Book Rules\n${foundation.bookRules}\n\n## Initial State\n${foundation.currentState}\n\n## Initial Hooks\n${foundation.pendingHooks}`
      : `## 世界设定\n${foundation.storyBible}\n\n## 卷纲\n${foundation.volumeOutline}\n\n## 规则\n${foundation.bookRules}\n\n## 初始状态\n${foundation.currentState}\n\n## 初始伏笔\n${foundation.pendingHooks}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
  ): FoundationReviewResult {
    const parsedDimensions: Array<{ readonly name: string; readonly passed: boolean; readonly feedback: string }> = [];
    const missingDimensions: number[] = [];

    for (let i = 0; i < dimensions.length; i++) {
      const regex = new RegExp(
        `=== DIMENSION: ${i + 1} ===\\s*[\\s\\S]*?(?:结论|Verdict)[：:]\\s*(通过|修改|accept|revise)[\\s\\S]*?(?:意见|Feedback)[：:]\\s*([\\s\\S]*?)(?==== |$)`,
        "i",
      );
      const match = content.match(regex);
      if (!match) {
        missingDimensions.push(i + 1);
        continue;
      }
      parsedDimensions.push({
        name: dimensions[i]!,
        passed: /^(?:通过|accept)$/i.test(match[1]!.trim()),
        feedback: match[2]!.trim(),
      });
    }

    if (missingDimensions.length > 0) {
      throw new FoundationReviewParseError(missingDimensions);
    }

    const passed = parsedDimensions.every((dimension) => dimension.passed);

    const overallMatch = content.match(
      /=== OVERALL ===[\s\S]*?(?:总评|Summary)[：:]\s*([\s\S]*?)$/,
    );
    const overallFeedback = overallMatch ? overallMatch[1]!.trim() : "(parse failed)";

    return { passed, dimensions: parsedDimensions, overallFeedback };
  }
}
