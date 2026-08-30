export type TranslationSourceKind = "text" | "markdown" | "pdf" | "epub";
export type TranslationExportFormat = "txt" | "md" | "epub";

export interface CreateTranslationProjectInput {
  readonly filePath: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly title?: string;
  readonly segmentMaxChars?: number;
}

export interface TranslationSourceManifest {
  readonly kind: TranslationSourceKind;
  readonly path: string;
  readonly charCount: number;
  readonly totalPages?: number;
}

export interface TranslationChapterManifest {
  readonly number: number;
  readonly title: string;
  readonly sourcePath: string;
  readonly translatedPath: string;
  readonly segmentCount: number;
  readonly charCount: number;
  readonly translatedSegments: number;
  readonly reviewSummary?: string;
  readonly reviewIssues?: ReadonlyArray<string>;
}

export interface TranslationProjectManifest {
  readonly id: string;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: TranslationSourceManifest;
  readonly chapters: ReadonlyArray<TranslationChapterManifest>;
}

export interface TranslationSegment {
  readonly index: number;
  readonly source: string;
  readonly target?: string;
  readonly notes?: string;
}

export interface TranslationChapterFile {
  readonly number: number;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly segments: ReadonlyArray<TranslationSegment>;
}

export interface TranslationProjectCreateResult {
  readonly projectDir: string;
  readonly manifestPath: string;
  readonly manifest: TranslationProjectManifest;
}

export interface TranslationGlossaryTerm {
  readonly source: string;
  readonly target: string;
  readonly note?: string;
}

export const TranslationSourceManifestSchema = z.object({
  kind: z.enum(["text", "markdown", "pdf", "epub"]),
  path: z.string().min(1),
  charCount: z.number().int().nonnegative(),
  totalPages: z.number().int().positive().optional(),
}).strict();

export const TranslationChapterManifestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  sourcePath: z.string().min(1),
  translatedPath: z.string().min(1),
  segmentCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
  translatedSegments: z.number().int().nonnegative(),
  reviewSummary: z.string().optional(),
  reviewIssues: z.array(z.string()).optional(),
}).strict();

export const TranslationProjectManifestSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourceLanguage: z.string().min(1),
  targetLanguage: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  source: TranslationSourceManifestSchema,
  chapters: z.array(TranslationChapterManifestSchema),
}).strict();

export const TranslationSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  source: z.string(),
  target: z.string().optional(),
  notes: z.string().optional(),
}).strict();

export const TranslationChapterFileSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  sourceLanguage: z.string().min(1),
  targetLanguage: z.string().min(1),
  segments: z.array(TranslationSegmentSchema),
}).strict();

export const TranslationGlossaryTermSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  note: z.string().optional(),
}).strict();

export const TranslationGlossarySchema = z.object({
  terms: z.array(TranslationGlossaryTermSchema).default([]),
}).strict();

export interface TranslationModelPort {
  readonly translateSegments: (input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly chapterTitle: string;
    readonly segments: ReadonlyArray<TranslationSegment>;
    readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
  }) => Promise<{
    readonly chapterTitle?: string;
    readonly segments: ReadonlyArray<{
      readonly index: number;
      readonly target: string;
      readonly notes?: string;
    }>;
    readonly glossary?: ReadonlyArray<TranslationGlossaryTerm>;
  }>;
  readonly reviewChapter?: (input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly chapterTitle: string;
    readonly segments: ReadonlyArray<TranslationSegment>;
    readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
  }) => Promise<{
    readonly summary: string;
    readonly issues: ReadonlyArray<string>;
  }>;
}

export interface RunTranslationProjectResult {
  readonly projectId: string;
  readonly translatedSegments: number;
  readonly reviewedChapters: number;
  readonly reportPath: string;
}

export interface TranslationExportResult {
  readonly outputPath: string;
  readonly format: TranslationExportFormat;
  readonly chaptersExported: number;
}
import { z } from "zod";
