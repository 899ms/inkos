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
  readonly output: Pick<WriteChapterOutput, "content" | "postWriteErrors">;
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
  readonly normalize: (content: string) => string;
  readonly assertNotEmpty: (content: string) => void;
  readonly addUsage: (left: ChapterReviewUsage, right?: ChapterReviewUsage) => ChapterReviewUsage;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly runPostWriteChecks: (content: string) => ReadonlyArray<AuditIssue>;
}): Promise<ChapterReviewResult> {
  const content = params.normalize(params.output.content);
  params.assertNotEmpty(content);
  const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
  const modelReview = await params.auditor.auditChapter(
    params.bookDir,
    content,
    params.chapterNumber,
    params.book.genre,
    params.controlInput ? { ...params.controlInput, temperature: 0.3 } : undefined,
  );
  const lengthIssues: AuditIssue[] = isOutsideHardRange(wordCount, params.lengthSpec)
    ? [{
        severity: "warning",
        category: "length-budget",
        description: `Chapter length ${wordCount} is outside ${params.lengthSpec.hardMin}-${params.lengthSpec.hardMax}.`,
        suggestion: `Revise the underdeveloped or redundant scenes toward ${params.lengthSpec.target}.`,
      }]
    : [];
  const review: AuditResult = {
    ...modelReview,
    issues: [
      ...modelReview.issues,
      ...params.analyzeAITells(content).issues,
      ...params.analyzeSensitiveWords(content).issues,
      ...params.runPostWriteChecks(content),
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
