import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";

export interface ChapterReviewUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewControlInput {
  readonly chapterIntent: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewResult {
  readonly content: string;
  readonly wordCount: number;
  readonly review: AuditResult;
  readonly totalUsage: ChapterReviewUsage;
}

export async function reviewChapterDraft(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly output: Pick<WriteChapterOutput, "content">;
  readonly controlInput?: ChapterReviewControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewUsage;
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: ChapterReviewControlInput & { readonly temperature?: number },
    ) => Promise<AuditResult>;
  };
  readonly assertNotEmpty: (content: string) => void;
  readonly addUsage: (left: ChapterReviewUsage, right?: ChapterReviewUsage) => ChapterReviewUsage;
}): Promise<ChapterReviewResult> {
  const content = params.output.content;
  params.assertNotEmpty(content);
  const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
  let modelReview: AuditResult;
  try {
    modelReview = await params.auditor.auditChapter(
      params.bookDir,
      content,
      params.chapterNumber,
      params.book.genre,
      params.controlInput ? { ...params.controlInput, temperature: 0.3 } : undefined,
    );
  } catch (error) {
    const isEnglish = params.lengthSpec.countingMode === "en_words";
    modelReview = {
      parseFailed: true,
      issues: [{
        severity: "warning",
        category: "review-unavailable",
        description: isEnglish
          ? `Review observation was unavailable: ${String(error)}`
          : `审稿观察暂不可用：${String(error)}`,
        suggestion: isEnglish
          ? "The chapter remains persisted; request review again when needed."
          : "正文照常落盘；需要时可再次发起审稿。",
      }],
      summary: isEnglish ? "Review unavailable" : "审稿暂不可用",
    };
  }
  const lengthIssues: AuditIssue[] = isOutsideHardRange(wordCount, params.lengthSpec)
    ? [{
        severity: "warning",
        category: "length-budget",
        description: `Chapter length ${wordCount} is outside ${params.lengthSpec.hardMin}-${params.lengthSpec.hardMax}.`,
        suggestion: `If this configured range remains desired, adjust length toward ${params.lengthSpec.target} while preserving the chapter's established content.`,
      }]
    : [];
  const review: AuditResult = {
    ...modelReview,
    issues: [
      ...modelReview.issues,
      ...lengthIssues,
    ],
  };
  return {
    content,
    wordCount,
    review,
    totalUsage: params.addUsage(params.initialUsage, modelReview.tokenUsage),
  };
}
