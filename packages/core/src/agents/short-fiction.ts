import { BaseAgent } from "./base.js";
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
    const missingChapters = findIncompleteShortFictionChapters(input.draft, {
      minimumChapterLength: minimumShortFictionChapterLength(input.charsPerChapter),
    });
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
    return {
      title: result.title.trim() || input.draft.storyTitle,
      intro: result.intro.trim(),
      sellingPoints: result.sellingPoints.map((point) => point.trim()).filter(Boolean),
      coverPrompt: result.coverPrompt.trim(),
      rawContent: [
        `# ${result.title.trim() || input.draft.storyTitle}`,
        `## Intro\n${result.intro.trim()}`,
        `## Selling Points\n${result.sellingPoints.map((point) => `- ${point}`).join("\n")}`,
        `## Cover Prompt\n${result.coverPrompt.trim()}`,
      ].join("\n\n"),
    };
  }
}

function mergeShortFictionBatch(
  current: ShortFictionBatchDraft | undefined,
  batch: {
    readonly storyTitle?: string;
    readonly openingHook?: string;
    readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string; readonly content: string }>;
  },
  expectedChapters: number,
  language: ShortFictionLanguage = "zh",
): ShortFictionBatchDraft {
  const countingMode = resolveLengthCountingMode(language);
  const byNumber = new Map(current?.chapters.map((chapter) => [chapter.number, chapter]) ?? []);
  for (const chapter of batch.chapters) {
    if (!Number.isInteger(chapter.number) || chapter.number < 1 || chapter.number > expectedChapters) continue;
    const content = chapter.content.trim();
    byNumber.set(chapter.number, {
      number: chapter.number,
      title: chapter.title.trim() || fallbackChapterTitle(chapter.number, language),
      content,
      charCount: countChapterLength(content, countingMode),
    });
  }
  const storyTitle = batch.storyTitle?.trim() || current?.storyTitle || untitledShortTitle(language);
  const openingHook = batch.openingHook?.trim() || current?.openingHook;
  const chapters = Array.from({ length: expectedChapters }, (_, index) => {
    const number = index + 1;
    return byNumber.get(number) ?? {
      number,
      title: fallbackChapterTitle(number, language),
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
  options?: { readonly expectedChapters?: number; readonly minimumChapterLength?: number },
): void {
  if (options?.expectedChapters !== undefined && draft.chapters.length !== options.expectedChapters) {
    throw new Error(`Short-hit draft is incomplete; expected ${options.expectedChapters} chapters, got ${draft.chapters.length}.`);
  }

  const invalidChapters = findIncompleteShortFictionChapters(draft, options);
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
  options?: { readonly minimumChapterLength?: number },
): number[] {
  const minimum = Math.max(1, Math.floor(options?.minimumChapterLength ?? 1));
  return draft.chapters
    .filter((chapter) => !chapter.content.trim() || chapter.charCount < minimum)
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
  if (!trimmed) return fallbackChapterTitle(number, language);
  if (language === "en") {
    if (new RegExp(`^Chapter\\s*${number}\\b`, "i").test(trimmed)) return trimmed;
    return `Chapter ${number}: ${trimmed}`;
  }
  if (new RegExp(`^第\\s*${number}\\s*章`).test(trimmed)) return trimmed;
  return `第${number}章 ${trimmed}`;
}

function untitledShortTitle(language: ShortFictionLanguage): string {
  return language === "en" ? "Untitled Short Story" : "未命名短篇";
}

function fallbackChapterTitle(number: number, language: ShortFictionLanguage): string {
  return language === "en" ? `Chapter ${number}` : `第${number}章`;
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

export function minimumShortFictionChapterLength(targetLength: number): number {
  // This is a corruption/truncation floor, not the editorial length target.
  // Normal range observations remain stricter; this gate only prevents a title
  // or a few lines from masquerading as a completed chapter.
  return Math.max(120, Math.floor(targetLength * 0.2));
}

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
