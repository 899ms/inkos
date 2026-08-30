import { Buffer } from "node:buffer";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentContext } from "../agents/base.js";
import {
  SHORT_FICTION_DEFAULT_CHAPTERS,
  SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER,
  SHORT_FICTION_EN_MAX_WORDS_PER_CHAPTER,
  SHORT_FICTION_EN_MIN_WORDS_PER_CHAPTER,
  SHORT_FICTION_MAX_CHAPTERS,
  SHORT_FICTION_MAX_CHARS_PER_CHAPTER,
  SHORT_FICTION_MIN_CHAPTERS,
  SHORT_FICTION_MIN_CHARS_PER_CHAPTER,
  ShortFictionDraftReviewerAgent,
  ShortFictionOutlineAgent,
  ShortFictionPackagingAgent,
  ShortFictionWriterAgent,
  ShortFictionBatchDraftSchema,
  findIncompleteShortFictionChapters,
  formatShortFictionChapterHeading,
  renderShortFictionDraftMarkdown,
  validateShortFictionDraftForFinal,
  type ShortFictionBatchDraft,
  type ShortFictionLanguage,
  type ShortFictionReference,
  type ShortFictionSalesPackage,
} from "../agents/short-fiction.js";
import {
  coverSecretKey,
  normalizeCoverBaseUrl,
  resolveCoverProviderPreset,
  type CoverProviderPreset,
} from "../llm/cover-providers.js";
import { loadSecrets } from "../llm/secrets.js";
import { createRangeObservation, type Observation } from "../models/observation.js";
import { ProjectConfigSchema } from "../models/project.js";
import { buildLengthSpec, countChapterLength } from "../utils/length-metrics.js";
import { safeChildPath } from "../utils/path-safety.js";
import { toPosixPath as projectPath } from "../utils/posix-path.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";

const SHORT_FICTION_DRAFT_COMPLETION_ATTEMPTS = 3;

export interface ShortFictionRunRuntimes {
  readonly planner: AgentContext;
  readonly writer: AgentContext;
  readonly draftReview: AgentContext;
  readonly package: AgentContext;
}

export interface ShortFictionRunOptions {
  readonly projectRoot: string;
  readonly title?: string;
  readonly direction: string;
  readonly runtimes: ShortFictionRunRuntimes;
  readonly reference?: ShortFictionReference;
  readonly storyId?: string;
  readonly chapterCount?: number;
  // Per-chapter length in the language's native unit: zh characters or en words.
  readonly charsPerChapter?: number;
  readonly language?: ShortFictionLanguage;
  readonly cover?: boolean;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
}

export interface ShortFictionRunResult {
  readonly storyId: string;
  readonly observations: ReadonlyArray<Observation>;
  readonly outlinePath: string;
  readonly draftReviewPath: string;
  readonly finalMarkdownPath: string;
  readonly finalJsonPath: string;
  readonly salesPackagePath: string;
  readonly coverPromptPath: string;
  readonly coverImagePath?: string;
  readonly coverError?: string;
  readonly packageError?: string;
}

export interface ShortFictionCoverOptions {
  readonly projectRoot: string;
  readonly title: string;
  readonly intro?: string;
  readonly sellingPoints?: ReadonlyArray<string>;
  readonly coverPrompt?: string;
  readonly language?: ShortFictionLanguage;
  readonly outputDir?: string;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly signal?: AbortSignal;
}

export interface ShortFictionCoverResult {
  readonly title: string;
  readonly workId: string;
  readonly outputDir: string;
  readonly coverPromptPath: string;
  readonly coverImagePath: string;
}

export async function runShortFictionProduction(
  options: ShortFictionRunOptions,
): Promise<ShortFictionRunResult> {
  const root = options.projectRoot;
  const providedStoryId = options.storyId
    ? safeSegment(options.storyId)
    : options.title?.trim()
      ? safeSegment(slugify(options.title))
      : undefined;

  // A stable storyId lets a re-run resume from disk instead of redoing finished
  // work — a transient failure in a late stage used to throw the whole short
  // away (orphaning outline/drafts). If it already finished, return it as-is.
  if (
    providedStoryId
    && await projectFileExists(root, join(shortWorkBaseDir(providedStoryId), "final", "full.md"))
  ) {
    return buildShortRunResult(providedStoryId, shortWorkBaseDir(providedStoryId), [], {});
  }

  try {
    return await produceShort(options, root, providedStoryId);
  } catch (error) {
    if (providedStoryId) {
      try {
        await syncWorkSourceArtifacts({ projectRoot: root, workId: providedStoryId, accept: false });
      } catch (syncError) {
        throw new AggregateError([error, syncError], `Short-fiction production failed and candidate artifacts could not be recorded for ${providedStoryId}`);
      }
    }
    throw error;
  }
}

async function produceShort(
  options: ShortFictionRunOptions,
  root: string,
  providedStoryId: string | undefined,
): Promise<ShortFictionRunResult> {
  const language = options.language ?? "zh";
  const chapterCount = boundedInteger(
    options.chapterCount,
    SHORT_FICTION_DEFAULT_CHAPTERS,
    "chapterCount",
    SHORT_FICTION_MIN_CHAPTERS,
    SHORT_FICTION_MAX_CHAPTERS,
  );
  // charsPerChapter is the language's native unit: zh chars (900-1200) or en words (600-800).
  const charsPerChapter = language === "en"
    ? boundedInteger(
        options.charsPerChapter,
        SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER,
        "charsPerChapter",
        SHORT_FICTION_EN_MIN_WORDS_PER_CHAPTER,
        SHORT_FICTION_EN_MAX_WORDS_PER_CHAPTER,
      )
    : boundedInteger(
        options.charsPerChapter,
        SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
        "charsPerChapter",
        SHORT_FICTION_MIN_CHARS_PER_CHAPTER,
        SHORT_FICTION_MAX_CHARS_PER_CHAPTER,
      );

  // Resume the current outline from disk when this Work already exists.
  const resumedOutline = providedStoryId
    ? await tryReadProjectText(root, join(shortWorkBaseDir(providedStoryId), "outline", "v001.md"))
    : undefined;

  let outlineMarkdown: string;
  let storyId: string;
  let baseDir: string;
  let workTitle: string;
  if (providedStoryId && resumedOutline?.trim()) {
    storyId = providedStoryId;
    baseDir = shortWorkBaseDir(storyId);
    workTitle = options.title?.trim() || storyId;
    outlineMarkdown = resumedOutline;
    await ensureShortWork(root, storyId, workTitle, language);
    options.onProgress?.("Resuming from existing outline (skipping outline stages)...");
  } else {
    options.onProgress?.("Creating short fiction outline...");
    const outlineAgent = new ShortFictionOutlineAgent(options.runtimes.planner);
    const outlineV1 = await outlineAgent.createOutline({
      direction: options.direction,
      chapterCount,
      charsPerChapter,
      reference: options.reference,
      language,
    });

    storyId = providedStoryId ?? safeSegment(slugify(outlineV1.storyTitle || options.direction));
    baseDir = shortWorkBaseDir(storyId);
    workTitle = outlineV1.storyTitle || options.title?.trim() || storyId;
    await ensureShortWork(root, storyId, workTitle, language);
    await writeText(root, join(baseDir, "outline", "v001.md"), outlineV1.rawContent);
    outlineMarkdown = outlineV1.rawContent;
  }

  let finalDraft: ShortFictionBatchDraft;
  let draftReviewWarning: string | undefined;
  let packageWarning: string | undefined;
  let salesPackage: ShortFictionSalesPackage;
  try {
    options.onProgress?.("Writing full short fiction draft...");
    const writer = new ShortFictionWriterAgent(options.runtimes.writer);
    const persistDraftBatch = async (
      draft: ShortFictionBatchDraft,
      completedChapterNumbers: ReadonlyArray<number>,
    ) => {
      await writeDraftArtifacts(root, baseDir, "v001-partial", draft, language);
      options.onProgress?.(`Completed short fiction draft chapters: ${completedChapterNumbers.join(", ")}...`);
    };
    const currentDraft = providedStoryId
      ? await tryReadShortFictionDraft(root, join(baseDir, "drafts", "v001", "draft.json"))
      : undefined;
    const resumedDraft = currentDraft ?? await tryReadShortFictionDraft(
      root,
      join(baseDir, "drafts", "v001-partial", "draft.json"),
    );
    let draftV1 = resumedDraft
      ? await writer.continueDraft({
          direction: options.direction,
          outlineMarkdown,
          chapterCount,
          charsPerChapter,
          language,
          draft: resumedDraft,
          onBatchComplete: persistDraftBatch,
        })
      : await writer.writeDraft({
      direction: options.direction,
      outlineMarkdown,
      chapterCount,
      charsPerChapter,
      language,
          onBatchComplete: persistDraftBatch,
        });
    let missingFromDraft = findIncompleteShortFictionChapters(draftV1);
    if (missingFromDraft.length > 0) {
      await writeDraftArtifacts(root, baseDir, "v001-partial", draftV1, language);
      for (let attempt = 1; missingFromDraft.length > 0 && attempt <= SHORT_FICTION_DRAFT_COMPLETION_ATTEMPTS; attempt += 1) {
        options.onProgress?.(`Completing missing short fiction chapters: ${missingFromDraft.join(", ")}...`);
        draftV1 = await writer.continueDraft({
          direction: options.direction,
          outlineMarkdown,
          chapterCount,
          charsPerChapter,
          language,
          draft: draftV1,
        });
        missingFromDraft = findIncompleteShortFictionChapters(draftV1);
        if (missingFromDraft.length > 0) {
          await writeDraftArtifacts(root, baseDir, "v001-partial", draftV1, language);
        }
      }
    }
    validateShortFictionDraftForFinal(draftV1, { expectedChapters: chapterCount });
    await writeDraftArtifacts(root, baseDir, "v001", draftV1, language);

    finalDraft = draftV1;
    options.onProgress?.("Reviewing completed short fiction...");
    const draftReviewer = new ShortFictionDraftReviewerAgent(options.runtimes.draftReview);
    try {
      const draftReview = await draftReviewer.reviewDraft({
        direction: options.direction,
        outlineMarkdown,
        draft: draftV1,
        chapterCount,
        charsPerChapter,
        language,
      });
      await writeText(root, join(baseDir, "reviews", "draft-v001.md"), draftReview);
    } catch (error) {
      options.signal?.throwIfAborted();
      draftReviewWarning = error instanceof Error ? error.message : String(error);
      await writeText(root, join(baseDir, "reviews", "draft-v001.md"), language === "en"
        ? `# Review unavailable\n\nThe complete draft remains available.\n\n## Reason\n\n${draftReviewWarning}`
        : `# 审稿暂不可用\n\n完整正文已经保留。\n\n## 原因\n\n${draftReviewWarning}`);
    }

    await writeFinalArtifacts(root, baseDir, finalDraft, language);

    options.onProgress?.("Generating synopsis and cover prompt...");
    const packager = new ShortFictionPackagingAgent(options.runtimes.package);
    try {
      salesPackage = await packager.generatePackage({
        direction: options.direction,
        outlineMarkdown,
        draft: finalDraft,
        language,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      packageWarning = error instanceof Error ? error.message : String(error);
      salesPackage = {
        title: finalDraft.storyTitle,
        intro: "",
        sellingPoints: [],
        coverPrompt: "",
        rawContent: "",
      };
      await writeText(root, join(baseDir, "reviews", "package-warning.md"), language === "en"
        ? `# Packaging requires retry\n\nThe complete story remains available. Synopsis and cover packaging failed without invalidating the prose.\n\n## Reason\n\n${packageWarning}`
        : `# 包装阶段需要重试\n\n完整正文已经保留。简介与封面包装失败不会再把正文标成失败。\n\n## 原因\n\n${packageWarning}`);
    }
    await writePackageArtifacts(root, baseDir, salesPackage, language);
  } catch (error) {
    throw error;
  }

  const coverArtifacts: { readonly coverImagePath?: string; readonly coverError?: string } = options.cover === false
    ? { coverError: "disabled" }
    : await generateCoverArtifact({
        root,
        baseDir,
        salesPackage,
        language,
        coverBaseUrl: options.coverBaseUrl,
        coverEndpoint: options.coverEndpoint,
        coverModel: options.coverModel,
        coverSize: options.coverSize,
        coverApiKeyEnv: options.coverApiKeyEnv,
        signal: options.signal,
      }).catch((error: unknown) => {
        options.signal?.throwIfAborted();
        return { coverError: String(error) };
      });

  const completionWarnings = [
    draftReviewWarning ? `draft review unavailable: ${draftReviewWarning}` : "",
    packageWarning ? `packaging requires retry: ${packageWarning}` : "",
  ].filter(Boolean);
  const observations = [
    ...buildShortLengthObservations(finalDraft, charsPerChapter, language),
    ...completionWarnings.map((warning): Observation => ({
      code: warning.startsWith("packaging") ? "package-generation" : "draft-review",
      kind: "soft",
      summary: warning,
      evidence: [warning],
    })),
    ...(coverArtifacts.coverError && coverArtifacts.coverError !== "disabled"
      ? [{
          code: "cover-generation",
          kind: "soft" as const,
          summary: coverArtifacts.coverError,
          evidence: [coverArtifacts.coverError],
        }]
      : []),
  ];
  await syncWorkSourceArtifacts({ projectRoot: root, workId: storyId, accept: true });

  return buildShortRunResult(storyId, baseDir, observations, { ...coverArtifacts, packageError: packageWarning });
}

function buildShortRunResult(
  storyId: string,
  baseDir: string,
  observations: ReadonlyArray<Observation>,
  coverArtifacts: {
    readonly coverImagePath?: string;
    readonly coverError?: string;
    readonly packageError?: string;
  },
): ShortFictionRunResult {
  return {
    storyId,
    observations,
    outlinePath: projectPath(join(baseDir, "outline", "v001.md")),
    draftReviewPath: projectPath(join(baseDir, "reviews", "draft-v001.md")),
    finalMarkdownPath: projectPath(join(baseDir, "final", "full.md")),
    finalJsonPath: projectPath(join(baseDir, "final", "short-story.json")),
    salesPackagePath: projectPath(join(baseDir, "final", "sales-package.md")),
    coverPromptPath: projectPath(join(baseDir, "final", "cover-prompt.md")),
    coverImagePath: coverArtifacts.coverImagePath,
    coverError: coverArtifacts.coverError,
    packageError: coverArtifacts.packageError,
  };
}

async function projectFileExists(root: string, path: string): Promise<boolean> {
  try {
    await access(safeChildPath(root, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function tryReadProjectText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(safeChildPath(root, path), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryReadShortFictionDraft(
  root: string,
  path: string,
): Promise<ShortFictionBatchDraft | undefined> {
  const raw = await tryReadProjectText(root, path);
  if (!raw) return undefined;
  return ShortFictionBatchDraftSchema.parse(JSON.parse(raw));
}

export async function generateShortFictionCover(
  options: ShortFictionCoverOptions,
): Promise<ShortFictionCoverResult> {
  options.signal?.throwIfAborted();
  const title = options.title.trim();
  if (!title) {
    throw new Error("title is required for cover generation.");
  }

  const workId = options.outputDir
    ? safeSegment(basename(projectPath(options.outputDir).replace(/\/+$/u, "")))
    : `cover-${safeSegment(slugify(title))}`;
  const outputDir = join("works", workId, "source");
  await ensureVisualWork(options.projectRoot, workId, title, options.language ?? "zh");
  const salesPackage: ShortFictionSalesPackage = {
    title,
    intro: options.intro?.trim() ?? "",
    sellingPoints: normalizeSellingPoints(options.sellingPoints),
    coverPrompt: options.coverPrompt?.trim() ?? "",
    rawContent: "",
  };
  const promptPath = join(outputDir, "cover-prompt.md");
  const imagePrompt = buildCoverImagePrompt(salesPackage, options.language);
  await writeText(options.projectRoot, promptPath, imagePrompt);

  const artifact = await generateCoverImageArtifact({
    root: options.projectRoot,
    outputDir,
    salesPackage,
    language: options.language,
    coverBaseUrl: options.coverBaseUrl,
    coverEndpoint: options.coverEndpoint,
    coverModel: options.coverModel,
    coverSize: options.coverSize,
    coverApiKeyEnv: options.coverApiKeyEnv,
    signal: options.signal,
  });
  await syncWorkSourceArtifacts({ projectRoot: options.projectRoot, workId, accept: true });

  return {
    title,
    workId,
    outputDir: projectPath(outputDir),
    coverPromptPath: projectPath(promptPath),
    coverImagePath: artifact.coverImagePath,
  };
}

async function writeDraftArtifacts(
  root: string,
  baseDir: string,
  version: string,
  draft: ShortFictionBatchDraft,
  language: ShortFictionLanguage = "zh",
): Promise<void> {
  const draftDir = join(baseDir, "drafts", version);
  await commitAtomicFileSet({
    rootDir: root,
    writes: [
      textWrite(join(draftDir, "full.md"), renderShortFictionDraftMarkdown(draft, language)),
      textWrite(join(draftDir, "draft.json"), JSON.stringify(draft, null, 2)),
      ...draft.chapters.map((chapter) => textWrite(
        join(draftDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`),
        [
      `# ${formatShortFictionChapterHeading(chapter.number, chapter.title, language)}`,
      "",
      chapter.content,
        ].join("\n"),
      )),
    ],
  });
}

async function writeFinalArtifacts(
  root: string,
  baseDir: string,
  draft: ShortFictionBatchDraft,
  language: ShortFictionLanguage = "zh",
): Promise<void> {
  const finalDir = join(baseDir, "final");
  const markdown = renderShortFictionDraftMarkdown(draft, language);
  await commitAtomicFileSet({
    rootDir: root,
    writes: [
      textWrite(join(finalDir, "full.md"), markdown),
      textWrite(join(finalDir, `${safeFileName(draft.storyTitle)}.md`), markdown),
      textWrite(join(finalDir, "short-story.json"), JSON.stringify(draft, null, 2)),
      ...draft.chapters.map((chapter) => textWrite(
        join(finalDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`),
        [
          `# ${formatShortFictionChapterHeading(chapter.number, chapter.title, language)}`,
          "",
          chapter.content,
        ].join("\n"),
      )),
    ],
  });
}

async function writePackageArtifacts(
  root: string,
  baseDir: string,
  salesPackage: ShortFictionSalesPackage,
  language: ShortFictionLanguage = "zh",
): Promise<void> {
  const finalDir = join(baseDir, "final");
  const headings = language === "en"
    ? { intro: "## Synopsis", sellingPoints: "## Selling Points", coverPrompt: "## Cover Prompt" }
    : { intro: "## 简介", sellingPoints: "## 卖点", coverPrompt: "## 封面提示词" };
  const packageMarkdown = [
    `# ${salesPackage.title}`,
    "",
    headings.intro,
    "",
    salesPackage.intro,
    "",
    headings.sellingPoints,
    "",
    ...salesPackage.sellingPoints.map((point) => `- ${point}`),
    "",
    headings.coverPrompt,
    "",
    salesPackage.coverPrompt,
  ].join("\n");
  await commitAtomicFileSet({
    rootDir: root,
    writes: [
      textWrite(join(finalDir, "sales-package.json"), JSON.stringify(salesPackage, null, 2)),
      textWrite(join(finalDir, "sales-package.md"), packageMarkdown),
      textWrite(join(finalDir, "cover-prompt.md"), salesPackage.coverPrompt),
    ],
  });
}

function buildShortLengthObservations(
  draft: ShortFictionBatchDraft,
  target: number,
  language: ShortFictionLanguage,
): Observation[] {
  const spec = buildLengthSpec(target, language);
  return draft.chapters.flatMap((chapter) => {
    const observation = createRangeObservation({
    code: `chapter-${chapter.number}-length`,
    actual: countChapterLength(chapter.content, spec.countingMode),
    target: spec.target,
    min: spec.hardMin,
    max: spec.hardMax,
    unit: spec.countingMode,
    evidence: `chapter ${chapter.number}: ${chapter.title}`,
    });
    return observation ? [observation] : [];
  });
}

async function generateCoverArtifact(input: {
  readonly root: string;
  readonly baseDir: string;
  readonly salesPackage: ShortFictionSalesPackage;
  readonly language?: ShortFictionLanguage;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly coverImagePath: string }> {
  return generateCoverImageArtifact({
    ...input,
    outputDir: join(input.baseDir, "final"),
  });
}

async function generateCoverImageArtifact(input: {
  readonly root: string;
  readonly outputDir: string;
  readonly salesPackage: ShortFictionSalesPackage;
  readonly language?: ShortFictionLanguage;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly coverImagePath: string }> {
  const request = await resolveCoverGenerationRequest({
    root: input.root,
    coverBaseUrl: input.coverBaseUrl,
    coverEndpoint: input.coverEndpoint,
    coverModel: input.coverModel,
    coverApiKeyEnv: input.coverApiKeyEnv,
  });
  const size = input.coverSize || process.env.INKOS_COVER_SIZE || "1024x1360";
  const { buffer, extension } = await generateImageFromPrompt(
    request,
    buildCoverImagePrompt(input.salesPackage, input.language),
    size,
    input.signal,
  );
  const coverPath = join(input.outputDir, extension === "jpg" ? "cover.jpg" : "cover.png");
  await writeBinary(input.root, coverPath, buffer);
  return { coverImagePath: projectPath(coverPath) };
}

/**
 * Generate one image from a free-text prompt via whichever image API the cover
 * config resolves to (gemini / images / responses). Shared by cover generation
 * and the interactive-world (Play) illustration feature so both go through the
 * same provider plumbing.
 */
export async function generateImageFromPrompt(
  request: ShortFictionCoverRequest,
  prompt: string,
  size: string,
  signal?: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly extension: "png" | "jpg" }> {
  if (request.api === "gemini") {
    const payload = await generateGeminiCover(request, prompt, signal);
    return { buffer: Buffer.from(payload.base64, "base64"), extension: payload.extension };
  }
  if (request.api === "images") {
    return generateImagesCover(request, prompt, size, signal);
  }

  const endpoint = request.endpoint ?? `${request.baseUrl.replace(/\/+$/u, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      input: prompt,
      tools: [{ type: "image_generation", size }],
    }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`image generation failed: HTTP ${response.status} ${text}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`image generation returned non-JSON response: ${String(error)}`);
  }

  const imageBase64 = extractResponsesImageBase64(payload);
  if (!imageBase64) {
    throw new Error("image generation response did not include image_generation_call result.");
  }
  return { buffer: Buffer.from(imageBase64, "base64"), extension: "png" };
}

export interface ShortFictionCoverRequest {
  readonly api: CoverProviderPreset["api"];
  readonly baseUrl: string;
  readonly endpoint?: string;
  readonly model: string;
  readonly apiKey: string;
}

export async function resolveCoverGenerationRequest(input: {
  readonly root: string;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverApiKeyEnv?: string;
}): Promise<ShortFictionCoverRequest> {
  if (input.coverEndpoint || input.coverBaseUrl || process.env.INKOS_COVER_ENDPOINT || process.env.INKOS_COVER_BASE_URL) {
    const endpoint = resolveCoverEndpoint(input.coverEndpoint, input.coverBaseUrl);
    const baseUrl = input.coverBaseUrl || process.env.INKOS_COVER_BASE_URL || endpoint
      .replace(/\/responses\/?$/u, "")
      .replace(/\/images\/generations\/?$/u, "");
    return {
      api: endpoint.includes("/responses") ? "responses" : "images",
      baseUrl,
      endpoint,
      model: input.coverModel || process.env.INKOS_COVER_MODEL || "gpt-image-2",
      apiKey: resolveCoverApiKey(input.coverApiKeyEnv || "INKOS_COVER_API_KEY"),
    };
  }

  const projectCover = await readProjectCoverConfig(input.root);
  if (!projectCover) {
    throw new Error("cover endpoint is required. Configure cover generation in Studio or set INKOS_COVER_BASE_URL.");
  }

  const preset = resolveCoverProviderPreset(projectCover.service);
  if (!preset) {
    throw new Error(`Unsupported cover service: ${projectCover.service}`);
  }
  const apiKey = await resolveProjectCoverApiKey(input.root, projectCover.service);
  if (!apiKey) {
    throw new Error(`Cover API key is required. Configure a cover key for ${preset.label}.`);
  }

  return {
    api: preset.api,
    baseUrl: projectCover.baseUrl || preset.baseUrl,
    model: input.coverModel || projectCover.model || preset.defaultModel,
    apiKey,
  };
}

async function readProjectCoverConfig(root: string): Promise<{
  readonly service: string;
  readonly model?: string;
  readonly baseUrl?: string;
} | undefined> {
  const parsed = ProjectConfigSchema.parse(JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")));
  const cover = parsed.llm.cover;
  if (!cover) return undefined;
  const baseUrl = normalizeCoverBaseUrl(cover.baseUrl);
  return {
    service: cover.service,
    model: cover.model,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

async function resolveProjectCoverApiKey(root: string, service: string): Promise<string> {
  const secrets = await loadSecrets(root);
  return secrets.services[coverSecretKey(service)]?.apiKey
    || secrets.services[service]?.apiKey
    || process.env[`${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`]
    || "";
}

async function generateImagesCover(
  request: ShortFictionCoverRequest,
  prompt: string,
  size: string,
  signal?: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly extension: "png" | "jpg" }> {
  const endpoint = request.endpoint ?? `${request.baseUrl.replace(/\/+$/u, "")}/images/generations`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      prompt,
      n: 1,
      size,
    }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`cover generation failed: HTTP ${response.status} ${text}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`cover generation returned non-JSON response: ${String(error)}`);
  }

  const image = extractImagesGenerationImage(payload);
  if (image?.base64) {
    return {
      buffer: Buffer.from(image.base64, "base64"),
      extension: image.extension,
    };
  }
  if (image?.url) {
    return downloadGeneratedCoverImage(image.url, request.apiKey, signal);
  }
  throw new Error("cover generation response did not include image URL or base64 data.");
}

export function extractImagesGenerationImage(payload: unknown): (
  | { readonly base64: string; readonly extension: "png" | "jpg"; readonly url?: undefined }
  | { readonly url: string; readonly base64?: undefined; readonly extension?: undefined }
) | undefined {
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;

  for (const item of data) {
    const record = item as { b64_json?: unknown; url?: unknown };
    if (typeof record.b64_json === "string" && record.b64_json.trim()) {
      return { base64: record.b64_json.trim(), extension: "png" };
    }
    if (typeof record.url === "string" && record.url.trim()) {
      return { url: record.url.trim() };
    }
  }

  return undefined;
}

async function downloadGeneratedCoverImage(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly extension: "png" | "jpg" }> {
  const response = await fetch(url, { signal });
  const fallbackResponse = response.status === 401 || response.status === 403
    ? await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
    : response;
  if (!fallbackResponse.ok) {
    const text = await fallbackResponse.text();
    throw new Error(`cover image download failed: HTTP ${fallbackResponse.status} ${text}`);
  }
  const contentType = fallbackResponse.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await fallbackResponse.arrayBuffer());
  return {
    buffer,
    extension: coverImageExtension(contentType, url),
  };
}

function coverImageExtension(contentType: string, url: string): "png" | "jpg" {
  const normalized = `${contentType} ${url}`.toLowerCase();
  return normalized.includes("jpeg") || normalized.includes(".jpg") || normalized.includes(".jpeg") ? "jpg" : "png";
}

async function generateGeminiCover(
  request: ShortFictionCoverRequest,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ readonly base64: string; readonly extension: "png" | "jpg" }> {
  const endpoint = `${request.baseUrl.replace(/\/+$/u, "")}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`cover generation failed: HTTP ${response.status} ${text}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`cover generation returned non-JSON response: ${String(error)}`);
  }

  const image = extractGeminiImageBase64(payload);
  if (!image) {
    throw new Error("cover generation response did not include Gemini inline image data.");
  }
  return image;
}

export function extractResponsesImageBase64(payload: unknown): string | undefined {
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    const record = item as { type?: unknown; result?: unknown; content?: unknown };
    if (record.type === "image_generation_call" && typeof record.result === "string" && record.result.trim()) {
      return record.result.trim();
    }
    if (Array.isArray(record.content)) {
      for (const contentItem of record.content) {
        const contentRecord = contentItem as { result?: unknown; image_base64?: unknown };
        if (typeof contentRecord.result === "string" && contentRecord.result.trim()) return contentRecord.result.trim();
        if (typeof contentRecord.image_base64 === "string" && contentRecord.image_base64.trim()) return contentRecord.image_base64.trim();
      }
    }
  }

  return undefined;
}

export function extractGeminiImageBase64(payload: unknown): { readonly base64: string; readonly extension: "png" | "jpg" } | undefined {
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return undefined;

  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inlineData = (part as { inlineData?: unknown; inline_data?: unknown }).inlineData
        ?? (part as { inlineData?: unknown; inline_data?: unknown }).inline_data;
      const record = inlineData as { data?: unknown; mimeType?: unknown; mime_type?: unknown } | undefined;
      if (typeof record?.data !== "string" || !record.data.trim()) continue;
      const mimeType = String(record.mimeType ?? record.mime_type ?? "image/png").toLowerCase();
      return {
        base64: record.data.trim(),
        extension: mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png",
      };
    }
  }

  return undefined;
}

export function resolveCoverApiKey(apiKeyEnv: string): string {
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Cover API key is required. Set ${apiKeyEnv} or pass coverApiKeyEnv.`);
  }
  return apiKey;
}

function resolveCoverEndpoint(coverEndpoint?: string, coverBaseUrl?: string): string {
  const endpoint = coverEndpoint || process.env.INKOS_COVER_ENDPOINT;
  if (endpoint) return endpoint;
  const baseUrl = coverBaseUrl || process.env.INKOS_COVER_BASE_URL;
  if (!baseUrl) {
    throw new Error("cover endpoint is required. Set INKOS_COVER_BASE_URL or disable cover generation.");
  }
  return `${baseUrl.replace(/\/+$/u, "")}/images/generations`;
}

function buildCoverImagePrompt(
  salesPackage: ShortFictionSalesPackage,
  language: ShortFictionLanguage = "zh",
): string {
  if (language === "en") {
    const base = [
      `Title: ${salesPackage.title}`,
      salesPackage.intro ? `Synopsis: ${salesPackage.intro}` : "",
      salesPackage.sellingPoints.length > 0 ? `Selling points: ${salesPackage.sellingPoints.join("; ")}` : "",
      salesPackage.coverPrompt ? `User visual notes: ${salesPackage.coverPrompt}` : "",
    ].filter(Boolean);

    return [
      "Generate a cover image from the supplied work facts and visual direction.",
      ...base,
    ].join("\n");
  }

  const base = [
    `标题：${salesPackage.title}`,
    salesPackage.intro ? `简介：${salesPackage.intro}` : "",
    salesPackage.sellingPoints.length > 0 ? `卖点：${salesPackage.sellingPoints.join("；")}` : "",
    salesPackage.coverPrompt ? `用户视觉要求：${salesPackage.coverPrompt}` : "",
  ].filter(Boolean);

  return [
    "根据以下作品事实和视觉要求生成封面图。",
    ...base,
  ].join("\n");
}

function normalizeSellingPoints(value: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return (value ?? []).map((point) => point.trim()).filter(Boolean);
}

async function writeBinary(root: string, path: string, value: Buffer): Promise<void> {
  const resolved = safeChildPath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, value);
}

function textWrite(relativePath: string, value: string): AtomicFileWrite {
  return {
    relativePath,
    content: `${value.trimEnd()}\n`,
  };
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const resolved = safeChildPath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${value.trimEnd()}\n`, "utf-8");
}

function shortWorkBaseDir(storyId: string): string {
  return join("works", safeSegment(storyId), "source");
}

async function ensureShortWork(
  root: string,
  storyId: string,
  title: string,
  language: ShortFictionLanguage,
): Promise<void> {
  try {
    await loadWorkManifest(root, storyId);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await saveWorkManifest(root, createWorkManifest({
    id: storyId,
    title,
    profileId: "short-fiction",
    language,
  }));
}

async function ensureVisualWork(
  root: string,
  workId: string,
  title: string,
  language: ShortFictionLanguage,
): Promise<void> {
  try {
    const existing = await loadWorkManifest(root, workId);
    if (existing.profileId !== "visual-asset") {
      throw new Error(`Work "${workId}" already uses profile "${existing.profileId}".`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await saveWorkManifest(root, createWorkManifest({
    id: workId,
    title,
    profileId: "visual-asset",
    language,
  }));
}

function boundedInteger(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `short-${Date.now()}`;
}

function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/:\0*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return `short-${Date.now()}`;
  return cleaned;
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:\0*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "short-fiction";
}
