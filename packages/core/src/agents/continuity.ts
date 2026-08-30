import { BaseAgent } from "./base.js";
import type { ContextPackage } from "../models/input-governance.js";
import { ChapterReviewToolSchema } from "./review-tool.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";

export interface AuditResult {
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly summary: string;
  readonly parseFailed?: boolean;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface AuditIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
  readonly repairScope?: "local" | "structural" | "unknown";
}

export class ContinuityAuditor extends BaseAgent {
  get name(): string {
    return "continuity-auditor";
  }

  async auditChapter(
    _bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    _genre: string | undefined,
    options: {
      readonly language: "zh" | "en";
      readonly contextPackage: ContextPackage;
      readonly temperature?: number;
    },
  ): Promise<AuditResult> {
    const isEnglish = options.language === "en";
    const systemPrompt = isEnglish
      ? "Audit this chapter against the activated review Skill and supplied governed context. Use only concrete evidence. Do not estimate length; the host computes it. Submit observations and a concise summary through the review tool. An empty issues array is valid."
      : "按已激活的审稿 Skill 和输入的 governed context 审查本章。只报告有证据的问题，不估算字数，字数由宿主计算。通过结果工具提交观察和简短结论，issues 为空是合法结果。";
    const governedContext = renderNarrativeSelectedContext(
      options.contextPackage.selectedContext,
      options.language,
    );
    const userPrompt = isEnglish
      ? `Review chapter ${chapterNumber}.\n\n## Governed Context\n${governedContext}\n\n## Chapter Content\n${chapterContent}`
      : `审查第${chapterNumber}章。\n\n## 权威上下文\n${governedContext}\n\n## 章节正文\n${chapterContent}`;

    const { result, usage } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        name: "submit_chapter_review",
        label: isEnglish ? "Submit chapter review" : "提交章节审稿",
        description: isEnglish
          ? "Submit evidence-backed observations only."
          : "只提交有证据的审稿观察。",
        parameters: ChapterReviewToolSchema,
      },
      { temperature: options.temperature ?? 0.3 },
    );
    return {
      issues: result.issues.map((issue) => ({
        severity: issue.severity,
        category: issue.category,
        description: issue.description,
        suggestion: issue.suggestion,
        repairScope: issue.repairScope,
      })),
      summary: result.summary,
      tokenUsage: usage,
    };
  }
}
