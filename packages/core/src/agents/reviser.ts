import { BaseAgent } from "./base.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { ContextPackage } from "../models/input-governance.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { applySpotFixPatches } from "../utils/spot-fix-patches.js";
import { ChapterRewriteToolSchema, ChapterSpotFixToolSchema } from "./reviser-tool.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";

export type ReviseMode = "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "rewrite";

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    _bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    _genre?: string,
    options?: {
      readonly language: "zh" | "en";
      readonly contextPackage: ContextPackage;
      readonly lengthSpec?: LengthSpec;
    },
  ): Promise<ReviseOutput> {
    if (!options) throw new Error("Reviser requires governed context and language.");
    const isEnglish = options.language === "en";
    const issueList = issues.length > 0
      ? issues.map((issue) => [
          `- [${issue.severity}] ${issue.category}: ${issue.description}`,
          `  ${isEnglish ? "Suggestion" : "建议"}: ${issue.suggestion}`,
        ].join("\n")).join("\n")
      : (isEnglish ? "- Follow the user's explicit revision instruction in the governed context." : "- 按 governed context 中的用户明确修订要求执行。");
    const context = renderNarrativeSelectedContext(options.contextPackage.selectedContext, options.language);
    const lengthBlock = options.lengthSpec
      ? (isEnglish
          ? `\n## Length target\nUser target: ${options.lengthSpec.target} words.`
          : `\n## 字数目标\n用户目标：${options.lengthSpec.target} 字。`)
      : "";
    const systemPrompt = buildRevisionProtocol(mode, options.language);
    const userPrompt = isEnglish
      ? `Revise chapter ${chapterNumber}.\n\n## Observations or instruction\n${issueList}\n\n## Governed context\n${context}${lengthBlock}\n\n## Current chapter\n${chapterContent}`
      : `修订第${chapterNumber}章。\n\n## 观察或用户指令\n${issueList}\n\n## 权威上下文\n${context}${lengthBlock}\n\n## 当前章节\n${chapterContent}`;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const output = mode === "spot-fix"
      ? await this.submitSpotFix(messages, chapterContent)
      : await this.submitRewrite(messages);
    const wordCount = options.lengthSpec
      ? countChapterLength(output.revisedContent, options.lengthSpec.countingMode)
      : output.wordCount;
    return { ...output, wordCount };
  }

  private async submitSpotFix(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
    originalChapter: string,
  ): Promise<ReviseOutput> {
    const { result, usage } = await this.submitStructured(messages, {
      name: "submit_chapter_patches",
      label: "Submit chapter patches",
      description: "Submit local exact-text replacements for host application.",
      parameters: ChapterSpotFixToolSchema,
    }, { temperature: 0.3 });
    const revisedContent = applySpotFixPatches(originalChapter, result.patches);
    return {
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: result.fixedIssues,
      tokenUsage: usage,
    };
  }

  private async submitRewrite(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
  ): Promise<ReviseOutput> {
    const { result, usage } = await this.submitStructured(messages, {
      name: "submit_revised_chapter",
      label: "Submit revised chapter",
      description: "Submit the complete revised chapter and addressed observations.",
      parameters: ChapterRewriteToolSchema,
    }, { temperature: 0.3 });
    return {
      revisedContent: result.revisedContent,
      wordCount: result.revisedContent.length,
      fixedIssues: result.fixedIssues,
      tokenUsage: usage,
    };
  }
}

function buildRevisionProtocol(mode: ReviseMode, language: "zh" | "en"): string {
  const modes: Record<ReviseMode, { readonly en: string; readonly zh: string }> = {
    polish: { en: "Edit wording only; keep facts, events, characters, and causality.", zh: "只改文字表面，保持事实、事件、人物和因果。" },
    rewrite: { en: "Rewrite the affected passages; rewrite the whole chapter only when the instruction spans it.", zh: "重写受影响段落；只有要求跨越整章时才重写整章。" },
    rework: { en: "Scenes and conflict may be restructured within the supplied authority.", zh: "可在输入权威范围内重构场景与冲突。" },
    "anti-detect": { en: "Change wording only while preserving story facts and causality.", zh: "只调整文字表面，保持剧情事实和因果。" },
    "spot-fix": { en: "Submit only exact unique source replacements through the patch tool.", zh: "只通过补丁工具提交能唯一命中的原文替换。" },
  };
  return language === "en"
    ? `Revise with the activated professional Skill and governed context. ${modes[mode].en} Submit the result through the required tool.`
    : `按已激活的专业 Skill 和 governed context 修订。${modes[mode].zh}通过指定结果工具提交。`;
}
