import { BaseAgent } from "./base.js";
import type { ChapterMemo } from "../models/input-governance.js";

export interface PolishChapterInput {
  readonly chapterContent: string;
  readonly chapterNumber: number;
  readonly chapterMemo?: ChapterMemo;
  readonly language?: "zh" | "en";
  readonly temperature?: number;
}

export interface PolishChapterOutput {
  readonly polishedContent: string;
  readonly changed: boolean;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

/**
 * File-layer polisher — runs AFTER the reviewer+reviser cycle accepts the
 * chapter's structure. Polisher ONLY touches prose surface: sentence craft,
 * paragraph shape, wording, punctuation, five-sense immersion, dialogue
 * naturalness. It is forbidden from changing plot, character, or mainline.
 *
 * If a structural/plot issue is found, the polisher marks it in a comment
 * line (`[polisher-note] ...`) for the next reviewer iteration and leaves
 * the prose untouched — it does NOT attempt to rewrite across that boundary.
 */
export class PolisherAgent extends BaseAgent {
  get name(): string {
    return "polisher";
  }

  async polishChapter(input: PolishChapterInput): Promise<PolishChapterOutput> {
    const language = input.language ?? "zh";
    const isEnglish = language === "en";

    const memoBlock = input.chapterMemo
      ? isEnglish
        ? `\n\n## Chapter Memo (do NOT let polish drift from this goal)\nGoal: ${input.chapterMemo.goal}\n\n${input.chapterMemo.body}`
        : `\n\n## 章节备忘（润色不得偏离此目标）\ngoal：${input.chapterMemo.goal}\n\n${input.chapterMemo.body}`
      : "";

    const systemPrompt = isEnglish
      ? buildEnglishSystemPrompt()
      : buildChineseSystemPrompt();

    const userPrompt = isEnglish
      ? `Polish chapter ${input.chapterNumber}. Return the polished chapter in full, nothing else — no JSON, no headers, no commentary.${memoBlock}\n\n## Chapter Under Polish\n${input.chapterContent}`
      : `请润色第${input.chapterNumber}章。只返回完整的润色后正文，不要 JSON、不要标题、不要解释。${memoBlock}\n\n## 待润色章节\n${input.chapterContent}`;

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: input.temperature ?? 0.4 },
    );

    const raw = response.content.trim();
    // Strip any leading fenced code block wrapper if the model wraps the
    // chapter body defensively.
    const stripped = stripWrappingFence(raw);
    const polishedContent = stripped.length > 0 ? stripped : input.chapterContent;
    return {
      polishedContent,
      changed: polishedContent !== input.chapterContent,
      tokenUsage: response.usage,
    };
  }
}

function stripWrappingFence(text: string): string {
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return fence?.[1]?.trim() ?? text;
}

function buildChineseSystemPrompt(): string {
  return `按已激活的长篇写作 Skill 润色文字表面，不得改变事件、人物选择、信息、视角或后果。直接返回完整正文，不要标题或解释。确需结构修复时只在末尾追加 [polisher-note] 行。总长变化不得超过原文 ±15%。`;
}

function buildEnglishSystemPrompt(): string {
  return `Polish the prose surface using the activated long-form writing skill. Do not change events, character choices, information, viewpoint, or consequences. Return the complete chapter without a heading or commentary. Append [polisher-note] lines only for structural defects that require another worker. Keep total length within ±15% of the source.`;
}
