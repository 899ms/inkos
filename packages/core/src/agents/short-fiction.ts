import { BaseAgent } from "./base.js";
import { z } from "zod";
import {
  countChapterLength,
  resolveLengthCountingMode,
} from "../utils/length-metrics.js";
import {
  type ShortFictionLanguage,
  buildShortFictionDraftReviewSystemPrompt,
  buildShortFictionDraftReviewUserPrompt,
  buildShortFictionOutlineSystemPrompt,
  buildShortFictionOutlineUserPrompt,
  buildShortFictionPackageSystemPrompt,
  buildShortFictionPackageUserPrompt,
  buildShortFictionWriterSystemPrompt,
  buildShortFictionWriterUserPrompt,
} from "../prompts/short-fiction.js";
import { ShortDraftBatchToolSchema, ShortOutlineToolSchema, ShortPackageToolSchema } from "./short-fiction-tool.js";

export const SHORT_FICTION_DEFAULT_CHAPTERS = 12;
export const SHORT_FICTION_MIN_CHAPTERS = 12;
export const SHORT_FICTION_MAX_CHAPTERS = 18;
export const SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER = 1000;
export const SHORT_FICTION_MIN_CHARS_PER_CHAPTER = 900;
export const SHORT_FICTION_MAX_CHARS_PER_CHAPTER = 1200;

// English shorts are calibrated in words, not characters. length-metrics.ts pins
// the full-length chapter defaults at zh 3000 chars ≈ en 2000 words (a 2/3 ratio),
// so the zh short range of 900/1000/1200 chars per chapter converts to
// 600/650/800 words per chapter (1000 × 2/3 ≈ 667, rounded down to 650).
export const SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER = 650;
export const SHORT_FICTION_EN_MIN_WORDS_PER_CHAPTER = 600;
export const SHORT_FICTION_EN_MAX_WORDS_PER_CHAPTER = 800;

export type { ShortFictionLanguage } from "../prompts/short-fiction.js";

export interface ShortFictionOutline {
  readonly storyTitle: string;
  readonly rawContent: string;
}

export interface ShortFictionChapter {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly charCount: number;
}

export interface ShortFictionBatchDraft {
  readonly storyTitle: string;
  readonly openingHook?: string;
  readonly chapters: ReadonlyArray<ShortFictionChapter>;
  readonly rawContent: string;
}

export const ShortFictionBatchDraftSchema = z.object({
  storyTitle: z.string().min(1),
  openingHook: z.string().optional(),
  chapters: z.array(z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    content: z.string(),
    charCount: z.number().int().nonnegative(),
  }).strict()),
  rawContent: z.string(),
}).strict();

export interface ShortFictionSalesPackage {
  readonly title: string;
  readonly intro: string;
  readonly sellingPoints: ReadonlyArray<string>;
  readonly coverPrompt: string;
  readonly rawContent: string;
}

export interface ShortFictionReference {
  readonly path?: string;
  readonly text: string;
}

export interface ShortFictionOutlineInput {
  readonly direction: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
  readonly reference?: ShortFictionReference;
  readonly language?: ShortFictionLanguage;
}

export interface ShortFictionDraftInput {
  readonly direction: string;
  readonly outlineMarkdown: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
  readonly language?: ShortFictionLanguage;
  readonly chapterNumbers?: readonly number[];
  readonly onBatchComplete?: (
    draft: ShortFictionBatchDraft,
    completedChapterNumbers: ReadonlyArray<number>,
  ) => void | Promise<void>;
}

export interface ShortFictionDraftReviewInput extends ShortFictionDraftInput {
  readonly draft: ShortFictionBatchDraft;
}

export interface ShortFictionPackageInput {
  readonly direction: string;
  readonly outlineMarkdown: string;
  readonly draft: ShortFictionBatchDraft;
  readonly language?: ShortFictionLanguage;
}

export class ShortFictionOutlineAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-outline";
  }

  async createOutline(input: ShortFictionOutlineInput): Promise<ShortFictionOutline> {
    const response = await this.submitStructured([
        { role: "system", content: buildShortFictionOutlineSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionOutlineUserPrompt(input, input.language) },
      ], {
        name: "submit_short_outline",
        label: "Submit short-fiction outline",
        description: "Submit the story title and complete readable plan.",
        parameters: ShortOutlineToolSchema,
      }, { temperature: 0.55, maxTokens: 16_384 });

    return { storyTitle: response.result.storyTitle.trim(), rawContent: response.result.planMarkdown.trim() };
  }
}

export class ShortFictionWriterAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-writer";
  }

  async writeDraft(input: ShortFictionDraftInput): Promise<ShortFictionBatchDraft> {
    const batches = buildShortFictionChapterBatches(
      input.chapterNumbers ?? allChapterNumbers(input.chapterCount),
      input.charsPerChapter,
      this.ctx.client.defaults.maxTokens,
    );
    const completedChapterNumbers: number[] = [];
    let currentDraft: ShortFictionBatchDraft | undefined;
    for (const chapterNumbers of batches) {
      const response = await this.submitStructured([
          { role: "system", content: buildShortFictionWriterSystemPrompt(input.language) },
          {
            role: "user",
            content: buildShortFictionWriterUserPrompt({
              ...input,
              chapterNumbers,
              ...(currentDraft ? { previousDraftMarkdown: renderShortFictionDraftMarkdown(currentDraft, input.language) } : {}),
            }, input.language),
          },
        ], {
          name: "submit_short_draft_batch",
          label: "Submit short-fiction draft batch",
          description: "Submit the requested complete chapter drafts.",
          parameters: ShortDraftBatchToolSchema,
        }, {
          temperature: 0.58,
          maxTokens: estimateShortFictionMaxTokens(
            chapterNumbers.length,
            input.charsPerChapter,
            this.ctx.client.defaults.maxTokens,
          ),
        });
      completedChapterNumbers.push(...chapterNumbers);
      currentDraft = mergeShortFictionBatch(currentDraft, response.result, input.chapterCount, input.language);
      await input.onBatchComplete?.(currentDraft, completedChapterNumbers);
    }

    if (!currentDraft) throw new Error("Short-fiction writer returned no chapter batch");
    return currentDraft;
  }

  async continueDraft(input: ShortFictionDraftInput & { readonly draft: ShortFictionBatchDraft }): Promise<ShortFictionBatchDraft> {
    const missingChapters = findIncompleteShortFictionChapters(input.draft);
    if (missingChapters.length === 0) return input.draft;

    let currentDraft = input.draft;
    const completedChapterNumbers = currentDraft.chapters
      .filter((chapter) => chapter.content.trim())
      .map((chapter) => chapter.number);
    const batches = buildShortFictionChapterBatches(
      missingChapters,
      input.charsPerChapter,
      this.ctx.client.defaults.maxTokens,
    );
    for (const chapterNumbers of batches) {
      const response = await this.submitStructured([
          { role: "system", content: buildShortFictionWriterSystemPrompt(input.language) },
          { role: "user", content: buildShortFictionWriterUserPrompt({
            ...input,
            chapterNumbers,
            previousDraftMarkdown: renderShortFictionDraftMarkdown(currentDraft, input.language),
          }, input.language) },
        ], {
          name: "submit_short_draft_batch",
          label: "Submit short-fiction draft batch",
          description: "Submit the requested complete chapter drafts.",
          parameters: ShortDraftBatchToolSchema,
        }, {
          temperature: 0.68,
          maxTokens: estimateShortFictionMaxTokens(
            chapterNumbers.length,
            input.charsPerChapter,
            this.ctx.client.defaults.maxTokens,
          ),
        });
      currentDraft = mergeShortFictionBatch(currentDraft, response.result, input.chapterCount, input.language);
      completedChapterNumbers.push(...chapterNumbers);
      await input.onBatchComplete?.(currentDraft, completedChapterNumbers);
    }
    return currentDraft;
  }
}

export class ShortFictionDraftReviewerAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-draft-reviewer";
  }

  async reviewDraft(input: ShortFictionDraftReviewInput): Promise<string> {
    const response = await this.chat([
        { role: "system", content: buildShortFictionDraftReviewSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionDraftReviewUserPrompt({
          ...input,
          draftMarkdown: renderShortFictionDraftMarkdown(input.draft, input.language),
        }, input.language) },
      ], { temperature: 0.3, maxTokens: 8192 });

    return response.content.trim();
  }
}

export class ShortFictionPackagingAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-packaging";
  }

  async generatePackage(input: ShortFictionPackageInput): Promise<ShortFictionSalesPackage> {
    const response = await this.submitStructured([
        { role: "system", content: buildShortFictionPackageSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionPackageUserPrompt({
          direction: input.direction,
          outlineMarkdown: input.outlineMarkdown,
          draftMarkdown: renderShortFictionDraftMarkdown(input.draft, input.language),
          draftTitle: input.draft.storyTitle,
        }, input.language) },
      ], {
        name: "submit_short_package",
        label: "Submit short-fiction package",
        description: "Submit title, synopsis, selling points, and cover prompt.",
        parameters: ShortPackageToolSchema,
      }, { temperature: 0.45, maxTokens: 4096 });

    const result = response.result;
    const title = result.title.trim();
    const intro = result.intro.trim();
    const sellingPoints = result.sellingPoints.map((point) => point.trim());
    if (!title || !intro || sellingPoints.some((point) => !point)) {
      throw new Error("Short-fiction packaging returned incomplete structured fields.");
    }
    return {
      title,
      intro,
      sellingPoints,
      coverPrompt: result.coverPrompt.trim(),
      rawContent: [
        `# ${title}`,
        `## Intro\n${intro}`,
        `## Selling Points\n${sellingPoints.map((point) => `- ${point}`).join("\n")}`,
        `## Cover Prompt\n${result.coverPrompt.trim()}`,
      ].join("\n\n"),
    };
  }
}

function mergeShortFictionBatch(
  current: ShortFictionBatchDraft | undefined,
  batch: {
    readonly storyTitle: string;
    readonly openingHook?: string;
    readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string; readonly content: string }>;
  },
  expectedChapters: number,
  language: ShortFictionLanguage = "zh",
): ShortFictionBatchDraft {
  const countingMode = resolveLengthCountingMode(language);
  const byNumber = new Map(current?.chapters.map((chapter) => [chapter.number, chapter]) ?? []);
  const seen = new Set<number>();
  for (const chapter of batch.chapters) {
    if (!Number.isInteger(chapter.number) || chapter.number < 1 || chapter.number > expectedChapters) {
      throw new Error(`Short-fiction batch returned invalid chapter number ${chapter.number}.`);
    }
    if (seen.has(chapter.number)) throw new Error(`Short-fiction batch returned duplicate chapter ${chapter.number}.`);
    seen.add(chapter.number);
    const content = chapter.content.trim();
    const title = chapter.title.trim();
    if (!content || !title) throw new Error(`Short-fiction batch returned empty chapter ${chapter.number}.`);
    byNumber.set(chapter.number, {
      number: chapter.number,
      title,
      content,
      charCount: countChapterLength(content, countingMode),
    });
  }
  const storyTitle = batch.storyTitle.trim();
  if (!storyTitle) throw new Error("Short-fiction batch returned an empty story title.");
  const openingHook = batch.openingHook?.trim() || current?.openingHook;
  const chapters = Array.from({ length: expectedChapters }, (_, index) => {
    const number = index + 1;
    return byNumber.get(number) ?? {
      number,
      title: "",
      content: "",
      charCount: 0,
    };
  });
  const draft: ShortFictionBatchDraft = {
    storyTitle,
    ...(openingHook ? { openingHook } : {}),
    chapters,
    rawContent: "",
  };
  return { ...draft, rawContent: renderShortFictionDraftMarkdown(draft, language) };
}
export function validateShortFictionDraftForFinal(
  draft: ShortFictionBatchDraft,
  options?: { readonly expectedChapters?: number },
): void {
  if (options?.expectedChapters !== undefined && draft.chapters.length !== options.expectedChapters) {
    throw new Error(`Short-hit draft is incomplete; expected ${options.expectedChapters} chapters, got ${draft.chapters.length}.`);
  }

  const invalidChapters = findIncompleteShortFictionChapters(draft);
  if (invalidChapters.length > 0) {
    const details = invalidChapters
      .map((number) => {
        const chapter = draft.chapters.find((item) => item.number === number);
        return `${number} (${chapter?.charCount ?? 0})`;
      })
      .join(", ");
    throw new Error(`Short-hit draft is incomplete; chapters below the minimum usable length: ${details}.`);
  }
}

export function findEmptyShortFictionChapters(draft: ShortFictionBatchDraft): number[] {
  return findIncompleteShortFictionChapters(draft);
}

export function findIncompleteShortFictionChapters(
  draft: ShortFictionBatchDraft,
): number[] {
  return draft.chapters
    .filter((chapter) => !chapter.content.trim())
    .map((chapter) => chapter.number);
}

export function renderShortFictionDraftMarkdown(
  draft: ShortFictionBatchDraft,
  language: ShortFictionLanguage = "zh",
): string {
  const hookHeading = language === "en" ? "## Opening Hook" : "## 开篇钩子";
  return [
    `# ${draft.storyTitle}`,
    draft.openingHook ? `${hookHeading}\n\n${draft.openingHook}` : "",
    ...draft.chapters.map((chapter) => [
      `## ${formatShortFictionChapterHeading(chapter.number, chapter.title, language)}`,
      "",
      chapter.content,
    ].join("\n")),
  ].filter(Boolean).join("\n\n");
}

export function formatShortFictionChapterHeading(
  number: number,
  title: string,
  language: ShortFictionLanguage = "zh",
): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error(`Short-fiction chapter ${number} has no title.`);
  return language === "en" ? `Chapter ${number}: ${trimmed}` : `第${number}章 ${trimmed}`;
}

// charsPerChapter is the language's native unit (zh chars / en words). The 2.2
// multiplier is calibrated for zh chars (~1-1.5 tokens each); for en words
// (~1.3-1.5 tokens each) it simply leaves extra headroom, which is safe for a cap.
function estimateShortFictionMaxTokens(
  chapterCount: number,
  charsPerChapter: number,
  modelMaxOutput = 24_576,
): number {
  const requested = Math.max(4096, Math.ceil(chapterCount * charsPerChapter * 2.2) + 2048);
  return Math.min(requested, safeShortFictionOutputBudget(modelMaxOutput));
}

const MAX_SHORT_FICTION_CHAPTERS_PER_CALL = 1;

export function buildShortFictionChapterBatches(
  chapterNumbers: readonly number[],
  charsPerChapter: number,
  modelMaxOutput: number,
): number[][] {
  const budget = safeShortFictionOutputBudget(modelMaxOutput);
  const perChapter = Math.max(1, Math.ceil(charsPerChapter * 2.2));
  const batchSize = Math.max(1, Math.min(
    MAX_SHORT_FICTION_CHAPTERS_PER_CALL,
    Math.floor((budget - 2048) / perChapter),
  ));
  const normalized = [...new Set(chapterNumbers)]
    .filter((chapter) => Number.isInteger(chapter) && chapter > 0)
    .sort((a, b) => a - b);
  const batches: number[][] = [];
  for (let index = 0; index < normalized.length; index += batchSize) {
    batches.push(normalized.slice(index, index + batchSize));
  }
  return batches;
}

function safeShortFictionOutputBudget(modelMaxOutput: number): number {
  const usableModelLimit = Number.isFinite(modelMaxOutput) && modelMaxOutput > 0
    ? Math.floor(modelMaxOutput)
    : 12_288;
  return Math.max(4096, Math.min(usableModelLimit, 24_576));
}

function allChapterNumbers(chapterCount: number): number[] {
  return Array.from({ length: chapterCount }, (_, index) => index + 1);
}

function selectShortFictionChapters(
  draft: ShortFictionBatchDraft,
  chapterNumbers: readonly number[],
): ShortFictionBatchDraft {
  const selected = new Set(chapterNumbers);
  return {
    ...draft,
    chapters: draft.chapters.filter((chapter) => selected.has(chapter.number)),
  };
}
