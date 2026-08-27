import { BaseAgent } from "./base.js";
import {
  buildLengthSpec,
  countChapterLength,
  isOutsideHardRange,
  resolveLengthCountingMode,
} from "../utils/length-metrics.js";
import {
  type ShortFictionLanguage,
  buildShortFictionDraftReviewSystemPrompt,
  buildShortFictionDraftReviewUserPrompt,
  buildShortFictionDraftRevisionFollowup,
  buildShortFictionOutlineReviewSystemPrompt,
  buildShortFictionOutlineReviewUserPrompt,
  buildShortFictionOutlineRevisionFollowup,
  buildShortFictionOutlineSystemPrompt,
  buildShortFictionOutlineUserPrompt,
  buildShortFictionPackageSystemPrompt,
  buildShortFictionPackageUserPrompt,
  buildShortFictionWriterSystemPrompt,
  buildShortFictionWriterUserPrompt,
} from "../prompts/short-fiction.js";

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

export interface ShortFictionOutlineReviewInput {
  readonly direction: string;
  readonly outline: ShortFictionOutline;
  readonly reference?: ShortFictionReference;
  readonly language?: ShortFictionLanguage;
}

export interface ShortFictionOutlineRevisionInput extends ShortFictionOutlineReviewInput {
  readonly review: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
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

export interface ShortFictionDraftRevisionInput extends ShortFictionDraftReviewInput {
  readonly review: string;
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
    const response = await retryShortFictionCall(() =>
      this.chat([
        { role: "system", content: buildShortFictionOutlineSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionOutlineUserPrompt(input, input.language) },
      ], { temperature: 0.55, maxTokens: 16_384 }), this.name, this.log);

    return parseShortFictionOutline(response.content, input.language);
  }
}

export class ShortFictionOutlineReviewerAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-outline-reviewer";
  }

  async reviewOutline(input: ShortFictionOutlineReviewInput): Promise<string> {
    const response = await retryShortFictionCall(() =>
      this.chat([
        { role: "system", content: buildShortFictionOutlineReviewSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionOutlineReviewUserPrompt(input, input.language) },
      ], { temperature: 0.3, maxTokens: 4096 }), this.name, this.log);

    return response.content.trim();
  }
}

export class ShortFictionOutlineReviserAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-outline-reviser";
  }

  async reviseOutline(input: ShortFictionOutlineRevisionInput): Promise<ShortFictionOutline> {
    const response = await retryShortFictionCall(() =>
      this.chat([
        { role: "system", content: buildShortFictionOutlineSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionOutlineUserPrompt(input, input.language) },
        { role: "assistant", content: input.outline.rawContent.trim() },
        { role: "user", content: buildShortFictionOutlineRevisionFollowup(input, input.language) },
      ], { temperature: 0.45, maxTokens: 16_384 }), this.name, this.log);

    return parseShortFictionOutline(response.content, input.language);
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
    const outputs: string[] = [];
    const completedChapterNumbers: number[] = [];
    let currentDraft: ShortFictionBatchDraft | undefined;
    for (const chapterNumbers of batches) {
      const response = await retryShortFictionCall(() =>
        this.chat([
          { role: "system", content: buildShortFictionWriterSystemPrompt(input.language) },
          {
            role: "user",
            content: buildShortFictionWriterUserPrompt({
              ...input,
              chapterNumbers,
              ...(outputs.length > 0 ? { previousDraftMarkdown: outputs.join("\n\n") } : {}),
            }, input.language),
          },
        ], {
          temperature: 0.58,
          maxTokens: estimateShortFictionMaxTokens(
            chapterNumbers.length,
            input.charsPerChapter,
            this.ctx.client.defaults.maxTokens,
          ),
        }), this.name, this.log);
      outputs.push(response.content.trim());
      completedChapterNumbers.push(...chapterNumbers);
      currentDraft = parseShortFictionBatchDraft(outputs.join("\n\n"), {
        expectedChapters: input.chapterCount,
        language: input.language,
      });
      await input.onBatchComplete?.(currentDraft, completedChapterNumbers);
    }

    return currentDraft ?? parseShortFictionBatchDraft("", {
      expectedChapters: input.chapterCount,
      language: input.language,
    });
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
      const response = await retryShortFictionCall(() =>
        this.chat([
          { role: "system", content: buildShortFictionWriterSystemPrompt(input.language) },
          { role: "user", content: buildShortFictionWriterUserPrompt({
            ...input,
            chapterNumbers,
            previousDraftMarkdown: renderShortFictionDraftMarkdown(currentDraft, input.language),
          }, input.language) },
        ], {
          temperature: 0.68,
          maxTokens: estimateShortFictionMaxTokens(
            chapterNumbers.length,
            input.charsPerChapter,
            this.ctx.client.defaults.maxTokens,
          ),
        }), this.name, this.log);
      currentDraft = parseShortFictionBatchDraft(
        `${currentDraft.rawContent.trim()}\n\n${response.content.trim()}`,
        { expectedChapters: input.chapterCount, language: input.language },
      );
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
    const response = await retryShortFictionCall(() =>
      this.chat([
        { role: "system", content: buildShortFictionDraftReviewSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionDraftReviewUserPrompt({
          ...input,
          draftMarkdown: renderShortFictionDraftMarkdown(input.draft, input.language),
        }, input.language) },
      ], { temperature: 0.3, maxTokens: 8192 }), this.name, this.log);

    return response.content.trim();
  }
}

export class ShortFictionDraftReviserAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-draft-reviser";
  }

  async reviseDraft(input: ShortFictionDraftRevisionInput): Promise<ShortFictionBatchDraft> {
    const batches = buildShortFictionChapterBatches(
      input.chapterNumbers ?? allChapterNumbers(input.chapterCount),
      input.charsPerChapter,
      this.ctx.client.defaults.maxTokens,
    );
    const accepted = new Map(input.draft.chapters.map((chapter) => [chapter.number, chapter]));
    let storyTitle = input.draft.storyTitle;
    let openingHook = input.draft.openingHook;
    const length = buildLengthSpec(input.charsPerChapter, input.language ?? "zh");
    for (const chapterNumbers of batches) {
      const batchDraft = selectShortFictionChapters(input.draft, chapterNumbers);
      const messages = [
        {
          role: "system" as const,
          content: input.language === "en"
            ? "You are a precision short-fiction reviser. Preserve the chapter's causal events and emotional payoff, but obey the requested word range exactly. Compress semantically by merging repeated reactions, exposition, and transitions; never truncate the ending. Output only the requested tagged blocks."
            : "你是精确的短篇改稿编辑。保留本章因果事件、证据和情绪回报，但必须严格服从目标字数区间。过长时语义压缩重复反应、解释和转场，不能截断结尾；只输出规定标签块。",
        },
        { role: "user" as const, content: buildShortFictionWriterUserPrompt({ ...input, chapterNumbers }, input.language) },
        { role: "assistant" as const, content: renderShortFictionDraftMarkdown(batchDraft, input.language) },
        { role: "user" as const, content: buildShortFictionDraftRevisionFollowup({ ...input, chapterNumbers }, input.language) },
      ];
      let response = await retryShortFictionCall(() =>
        this.chat(messages, {
          temperature: 0.45,
          maxTokens: estimateShortFictionMaxTokens(
            chapterNumbers.length,
            input.charsPerChapter,
            this.ctx.client.defaults.maxTokens,
          ),
        }), this.name, this.log);
      let revised = parseShortFictionBatchDraft(response.content, {
        expectedChapters: input.chapterCount,
        language: input.language,
      });
      let candidate = revised.chapters.find((chapter) => chapter.number === chapterNumbers[0]);
      for (let correction = 0; correction < 2 && (!candidate || isOutsideHardRange(candidate.charCount, length)); correction += 1) {
        const actual = candidate?.charCount ?? 0;
        const tooLong = actual > length.hardMax;
        response = await retryShortFictionCall(() => this.chat([
          ...messages,
          { role: "assistant", content: response.content },
          {
            role: "user",
            content: input.language === "en"
              ? tooLong
                ? `This version is ${actual} words, far above the ${length.hardMin}-${length.hardMax} range. Rewrite it to about ${length.target} words. Keep every indispensable event and clue, but remove repeated reactions, duplicate explanations, and non-causal transitions. Do not add scenes and do not cut off the ending. Output only the required blocks.`
                : `This version is ${actual} words, below the ${length.hardMin}-${length.hardMax} range. Rewrite it to about ${length.target} words by completing one existing scene with action, dialogue, and evidence. Do not add a new subplot. Output only the required blocks.`
              : tooLong
                ? `这版有 ${actual} 字，明显超过 ${length.hardMin}-${length.hardMax} 字区间。重写到约 ${length.target} 字：保留不可缺的事件和证据，删除重复反应、重复解释和不推动因果的转场；不要新增场景，也不能截断结尾。只输出规定标签块。`
                : `这版只有 ${actual} 字，低于 ${length.hardMin}-${length.hardMax} 字区间。重写到约 ${length.target} 字：只把现有一个场景用动作、对话和证据写完整，不要新增支线。只输出规定标签块。`,
          },
        ], {
          temperature: correction === 0 ? 0.3 : 0.2,
          maxTokens: estimateShortFictionMaxTokens(1, input.charsPerChapter, this.ctx.client.defaults.maxTokens),
        }), this.name, this.log);
        revised = parseShortFictionBatchDraft(response.content, {
          expectedChapters: input.chapterCount,
          language: input.language,
        });
        candidate = revised.chapters.find((chapter) => chapter.number === chapterNumbers[0]);
      }
      if (candidate && !isOutsideHardRange(candidate.charCount, length)) {
        accepted.set(candidate.number, candidate);
        storyTitle = revised.storyTitle || storyTitle;
        openingHook = revised.openingHook ?? openingHook;
      }
    }

    const chapters = input.draft.chapters.map((chapter) => accepted.get(chapter.number) ?? chapter);
    const merged: ShortFictionBatchDraft = {
      storyTitle,
      ...(openingHook ? { openingHook } : {}),
      chapters,
      rawContent: "",
    };
    return {
      ...merged,
      rawContent: renderShortFictionDraftMarkdown(merged, input.language),
    };
  }
}

export class ShortFictionPackagingAgent extends BaseAgent {
  get name(): string {
    return "short-fiction-packaging";
  }

  async generatePackage(input: ShortFictionPackageInput): Promise<ShortFictionSalesPackage> {
    const response = await retryShortFictionCall(() =>
      this.chat([
        { role: "system", content: buildShortFictionPackageSystemPrompt(input.language) },
        { role: "user", content: buildShortFictionPackageUserPrompt({
          direction: input.direction,
          outlineMarkdown: input.outlineMarkdown,
          draftMarkdown: renderShortFictionDraftMarkdown(input.draft, input.language),
          draftTitle: input.draft.storyTitle,
        }, input.language) },
      ], { temperature: 0.45, maxTokens: 4096 }), this.name, this.log);

    return parseShortFictionSalesPackage(response.content, input.draft.storyTitle);
  }
}

export function parseShortFictionOutline(
  rawContent: string,
  language: ShortFictionLanguage = "zh",
): ShortFictionOutline {
  const fallbackTitle = untitledShortTitle(language);
  const storyTitle = normalizeTitle(
    extractTaggedBlock(rawContent, "SHORT_FICTION_PLAN_TITLE")
    || extractTaggedBlock(rawContent, "SHORT_FICTION_TITLE")
    || extractFirstHeading(rawContent)
    || fallbackTitle,
  ) || fallbackTitle;
  return { storyTitle, rawContent: rawContent.trim() };
}

export function parseShortFictionBatchDraft(
  rawContent: string,
  options?: { readonly expectedChapters?: number; readonly language?: ShortFictionLanguage },
): ShortFictionBatchDraft {
  const expectedChapters = options?.expectedChapters ?? SHORT_FICTION_DEFAULT_CHAPTERS;
  const language = options?.language ?? "zh";
  const countingMode = resolveLengthCountingMode(language);
  const fallbackTitle = untitledShortTitle(language);
  const storyTitle = normalizeTitle(
    extractTaggedBlock(rawContent, "SHORT_FICTION_TITLE")
    || extractFirstHeading(rawContent)
    || fallbackTitle,
  ) || fallbackTitle;
  const openingHook = extractTaggedBlock(rawContent, "SHORT_FICTION_OPENING_HOOK")
    || extractTaggedBlock(rawContent, "OPENING_HOOK");

  const chapters: ShortFictionChapter[] = [];
  for (let number = 1; number <= expectedChapters; number += 1) {
    const title = normalizeChapterTitle(
      extractTaggedBlock(rawContent, `CHAPTER ${number} TITLE`)
      || extractMarkdownChapterTitle(rawContent, number)
      || fallbackChapterTitle(number, language),
      number,
      language,
    );
    const content = sanitizeChapterContent(
      extractLastNonEmptyTaggedBlock(rawContent, `CHAPTER ${number} CONTENT`)
      || extractDuplicateTitleTaggedChapterContent(rawContent, number)
      || extractMarkdownChapterContent(rawContent, number)
      || "",
    );
    chapters.push({
      number,
      title,
      content,
      // charCount is in the language's native counting unit: zh characters or en words.
      charCount: countChapterLength(content, countingMode),
    });
  }

  return {
    storyTitle,
    openingHook: openingHook.trim() || undefined,
    chapters,
    rawContent,
  };
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

export function parseShortFictionSalesPackage(rawContent: string, fallbackTitle = "未命名短篇"): ShortFictionSalesPackage {
  const title = normalizeTitle(
    extractTaggedBlock(rawContent, "SHORT_FICTION_PACKAGE_TITLE")
    || extractTaggedBlock(rawContent, "SHORT_FICTION_TITLE")
    || fallbackTitle,
  ) || fallbackTitle;
  const intro = extractTaggedBlock(rawContent, "SHORT_FICTION_INTRO")
    || extractTaggedBlock(rawContent, "INTRO")
    || "";
  const sellingRaw = extractTaggedBlock(rawContent, "SHORT_FICTION_SELLING_POINTS")
    || extractTaggedBlock(rawContent, "SELLING_POINTS")
    || "";
  const coverPrompt = extractTaggedBlock(rawContent, "SHORT_FICTION_COVER_PROMPT")
    || extractTaggedBlock(rawContent, "COVER_PROMPT")
    || "";
  return {
    title,
    intro: intro.trim(),
    sellingPoints: sellingRaw
      .split(/\n+/)
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean),
    coverPrompt: coverPrompt.trim(),
    rawContent: rawContent.trim(),
  };
}

function extractTaggedBlock(raw: string, tag: string): string {
  return extractTaggedBlocks(raw, tag)[0] ?? "";
}

function extractLastNonEmptyTaggedBlock(raw: string, tag: string): string {
  return extractTaggedBlocks(raw, tag)
    .map((block) => block.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function extractTaggedBlocks(raw: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagPattern = new RegExp(`^\\s*===\\s*${escaped}\\s*===\\s*$`, "gim");
  const nextTagPattern = /^\s*===\s*[A-Z0-9_ ]+\s*===\s*$/gim;
  const blocks: string[] = [];
  for (const match of raw.matchAll(tagPattern)) {
    if (match.index === undefined) continue;
    const start = match.index + match[0].length;
    const rest = raw.slice(start).replace(/^\s*\n/, "");
    nextTagPattern.lastIndex = 0;
    const next = nextTagPattern.exec(rest);
    blocks.push((next ? rest.slice(0, next.index) : rest).trim());
  }
  return blocks;
}

function extractFirstHeading(raw: string): string {
  return raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function extractMarkdownChapterTitle(raw: string, number: number): string {
  const pattern = new RegExp(`^##\\s*(?:${markdownChapterPrefixPattern(number)})?(.+)$`, "m");
  return pattern.exec(raw)?.[1]?.trim() ?? "";
}

function extractMarkdownChapterContent(raw: string, number: number): string {
  const pattern = new RegExp(`^##\\s*(?:${markdownChapterPrefixPattern(number)})?.*$\\n([\\s\\S]*?)(?=^##\\s*(?:${markdownChapterPrefixPattern(number + 1)})?.*$|(?![\\s\\S]))`, "m");
  return pattern.exec(raw)?.[1]?.trim() ?? "";
}

// Matches a zh "第N章" or en "Chapter N" heading prefix inside markdown fallbacks.
function markdownChapterPrefixPattern(number: number): string {
  return `第\\s*${number}\\s*章\\s*|Chapter\\s*${number}\\s*[:：.\\-–—]?\\s*`;
}

function extractDuplicateTitleTaggedChapterContent(raw: string, number: number): string {
  const escapedTag = `CHAPTER ${number} TITLE`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titlePattern = new RegExp(`^\\s*===\\s*${escapedTag}\\s*===\\s*$`, "gim");
  const matches = Array.from(raw.matchAll(titlePattern));
  const duplicateTitle = matches[1];
  if (!duplicateTitle || duplicateTitle.index === undefined) return "";

  const start = duplicateTitle.index + duplicateTitle[0].length;
  const rest = raw.slice(start).replace(/^\s*\n/, "");
  const nextTag = rest.search(/^\s*===\s*(?:CHAPTER\s+\d+\s+(?:TITLE|CONTENT)|SHORT_FICTION_[A-Z0-9_ ]+)\s*===\s*$/im);
  return (nextTag >= 0 ? rest.slice(0, nextTag) : rest).trim();
}

function sanitizeChapterContent(raw: string): string {
  return raw
    .replace(/^```(?:md|markdown)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/^===\s*[A-Z0-9_ ]+\s*===\s*$/gim, "")
    .trim();
}

function normalizeTitle(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean)
    ?.replace(/^《(.+)》$/, "$1")
    .trim() ?? "";
}

function normalizeChapterTitle(raw: string, number: number, language: ShortFictionLanguage = "zh"): string {
  const prefixPattern = language === "en"
    ? new RegExp(`^Chapter\\s*${number}\\s*[:：.\\-–—]?\\s*`, "i")
    : new RegExp(`^第\\s*${number}\\s*章\\s*`);
  const title = normalizeTitle(raw).replace(prefixPattern, "").trim();
  return title || fallbackChapterTitle(number, language);
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

async function retryShortFictionCall<T>(
  operation: () => Promise<T>,
  label: string,
  logger?: { warn(message: string): void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await operation();
    } catch (e) {
      lastError = e;
      if (attempt >= 2 || !isTransientShortFictionError(e)) throw e;
      logger?.warn(`[${label}] transient LLM interruption, retrying once: ${String(e)}`);
    }
  }
  throw lastError;
}

function isTransientShortFictionError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("unexpected eof")
    || message.includes("econnreset")
    || message.includes("socket hang up")
    || message.includes("terminated")
    || message.includes("fetch failed");
}
