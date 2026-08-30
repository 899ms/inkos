import { BaseAgent } from "./base.js";
import type { ChapterMemo } from "../models/input-governance.js";
import { PolishedChapterToolSchema } from "./polisher-tool.js";

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

/** Explicit prose-surface worker. Structural changes remain separate actions. */
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
      ? `Polish chapter ${input.chapterNumber} and submit the complete result through the result tool.${memoBlock}\n\n## Chapter Under Polish\n${input.chapterContent}`
      : `请润色第${input.chapterNumber}章，并通过结果工具提交完整正文。${memoBlock}\n\n## 待润色章节\n${input.chapterContent}`;

    const { result, usage } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        name: "submit_polished_chapter",
        label: "Submit polished chapter",
        description: "Submit the complete polished chapter for host use.",
        parameters: PolishedChapterToolSchema,
      },
      { temperature: input.temperature ?? 0.4 },
    );

    const polishedContent = result.polishedContent;
    return {
      polishedContent,
      changed: polishedContent !== input.chapterContent,
      tokenUsage: usage,
    };
  }
}

function buildChineseSystemPrompt(): string {
  return "按已激活的长篇写作 Skill 润色文字表面，不得改变事件、人物选择、信息、视角或后果。通过结果工具提交完整正文。";
}

function buildEnglishSystemPrompt(): string {
  return "Polish the prose surface using the activated long-form writing skill. Do not change events, character choices, information, viewpoint, or consequences. Submit the complete chapter through the result tool.";
}
