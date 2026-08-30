import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMClient, OnStreamProgress } from "../llm/provider.js";
import { createLLMClient } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { NotifyChannel, LLMConfig, AgentLLMOverride } from "../models/project.js";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { ComposerAgent, composeGovernedChapter, contextBudgetFromClient, type ComposeChapterOutput } from "../agents/composer.js";
import { WriterAgent, type WriteChapterInput, type WriteChapterOutput } from "../agents/writer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseMode } from "../agents/reviser.js";
import { StateValidatorAgent, type ValidationResult, type ValidationWarning } from "../agents/state-validator.js";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { StateManager } from "../state/manager.js";
import { archiveChapterVersion, readChapterUserBrief } from "../state/chapter-workspace.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { RadarResult } from "../agents/radar.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { ChapterMemo, ChapterTrace, ContextPackage } from "../models/input-governance.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { buildLengthSpec, countChapterLength, formatLengthCount, isOutsideHardRange, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import {
  readCharacterContext,
  readStoryFrame,
  readVolumeMap,
} from "../utils/outline-paths.js";
import {
  createInitialRuntimeState,
  loadRuntimeStateSnapshot,
  loadRuntimeStateSnapshotAtChapter,
} from "../state/runtime-state-store.js";
import {
  renderChapterSummariesProjection,
  renderCurrentStateProjection,
  renderHooksProjection,
} from "../state/state-projections.js";
import { readFile, readdir, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildStateReconciliationIssues, reconcileChapterStateAfterReview } from "./chapter-state-recovery.js";
import { persistChapterArtifacts } from "./chapter-persistence.js";
import { createWorkManifest, saveWorkManifest, workDirectory } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { reviewChapterDraft } from "./chapter-review.js";
import { validateChapterTruthPersistence } from "./chapter-truth-validation.js";
import { loadPersistedPlan, relativeToBookDir, savePersistedPlan } from "./persisted-governed-plan.js";
import { selectBookReferenceContext } from "../references/reference-context.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import { loadAvailableAgentSkills, mergeActivatedSkillGuidance } from "../skills/index.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { compileStyleGuide } from "../agents/style-guide.js";
import { compileImportSource, renderCompleteImportSource } from "../agents/import-context.js";

function reviewObservations(issues: ReadonlyArray<AuditIssue>) {
  return issues.map((issue, index) => ({
    code: `${issue.category || "review"}-${index + 1}`,
    kind: "soft" as const,
    summary: issue.description,
    evidence: issue.suggestion ? [issue.suggestion] : [],
  }));
}

function mergeChapterRevisionInstructions(
  persistedBrief: string,
  currentInstruction?: string,
): string | undefined {
  const persisted = persistedBrief.trim();
  const current = currentInstruction?.trim() ?? "";
  if (!persisted) return current || undefined;
  if (!current || current === persisted) return persisted;
  return [
    "## Persisted chapter brief",
    persisted,
    "",
    "## Current revision instruction",
    current,
  ].join("\n");
}


export function buildSpinoffFoundationContext(
  parentCanon: string,
  direction: string | undefined,
  language: "zh" | "en",
): string {
  const dir = direction?.trim();
  if (language === "en") {
    return [
      "## This is a SIDE-STORY (番外)",
      dir ? `\n## Side-story direction\n${dir}` : "",
      `\n## Parent canon\n${parentCanon}`,
    ].filter(Boolean).join("\n");
  }
  return [
    "## 这是一部番外",
    dir ? `\n## 番外方向\n${dir}` : "",
    `\n## 正传正典\n${parentCanon}`,
  ].filter(Boolean).join("\n");
}

export function buildImportFoundationSource(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
): string {
  return renderCompleteImportSource(chapters, language);
}

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onContextCompression?: ContextCompressionCallback;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterContextTraceSummary {
  readonly tracePath: string;
  readonly selectedSources: ReadonlyArray<string>;
  readonly protectedSources: ReadonlyArray<string>;
  readonly compressibleSources: ReadonlyArray<string>;
  readonly tokenBudget: ChapterTrace["tokenBudget"];
  readonly retrieval?: ChapterTrace["retrieval"];
  readonly compression?: ChapterTrace["compression"];
}

export interface ChapterPipelineResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly review: AuditResult;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
  readonly contextTrace?: ChapterContextTraceSummary;
}

export interface WriteChaptersOptions {
  readonly wordCount?: number;
  readonly temperatureOverride?: number;
  readonly externalContext?: string;
  readonly onChapterComplete?: (
    result: ChapterPipelineResult,
    completedCount: number,
    requestedCount: number,
  ) => void;
}

export interface ReviseResult {
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly changed: boolean;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly observations: ReadonlyArray<{
    readonly severity: AuditIssue["severity"];
    readonly category: string;
    readonly description: string;
    readonly suggestion?: string;
  }>;
  readonly lengthTelemetry?: LengthTelemetry;
}

export interface TruthFiles {
  readonly currentState: string;
  readonly pendingHooks: string;
  readonly storyFrame: string;
  readonly volumeMap: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

export interface ImportChaptersInput {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}

export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private readonly operationContext = new AsyncLocalStorage<{
    readonly signal?: AbortSignal;
    readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
  }>();

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
  }

  async runWithAbortSignal<T>(
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.runWithAgentContext({ signal }, task);
  }

  async runWithAgentContext<T>(
    context: {
      readonly signal?: AbortSignal;
      readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
    },
    task: () => Promise<T>,
  ): Promise<T> {
    const current = this.operationContext.getStore();
    const merged = {
      signal: context.signal ?? current?.signal,
      activatedSkills: context.activatedSkills ?? current?.activatedSkills,
    };
    merged.signal?.throwIfAborted();
    return this.operationContext.run(merged, async () => {
      merged.signal?.throwIfAborted();
      return task();
    });
  }

  private currentAbortSignal(): AbortSignal | undefined {
    return this.operationContext.getStore()?.signal;
  }

  private currentActivatedSkills(): ReadonlyArray<ActivatedSkillGuidance> | undefined {
    return this.operationContext.getStore()?.activatedSkills;
  }

  private throwIfOperationAborted(): void {
    this.currentAbortSignal()?.throwIfAborted();
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    return book.language;
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    const book = await this.state.loadBookConfig(bookId);
    return this.resolveBookLanguage(book);
  }

  private languageFromLengthSpec(lengthSpec: Pick<LengthSpec, "countingMode">): LengthLanguage {
    return lengthSpec.countingMode === "en_words" ? "en" : "zh";
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(
      `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`,
    );
  }

  private logInfo(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(this.localize(language, message));
  }

  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.warn(this.localize(language, message));
  }

  private async removeFailedWork(bookId: string, originalError: unknown): Promise<never> {
    try {
      await rm(workDirectory(this.config.projectRoot, bookId), { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([originalError, cleanupError], `Work creation failed and cleanup was incomplete: ${bookId}`);
    }
    throw originalError;
  }


  private agentCtx(bookId?: string): AgentContext {
    return {
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger,
      onStreamProgress: this.config.onStreamProgress,
    };
  }

  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      return { model: this.config.model, client: this.config.client };
    }
    if (typeof override === "string") {
      return { model: override, client: this.config.client };
    }
    // Full override — needs its own client if baseUrl differs
    if (!override.baseUrl) {
      return { model: override.model, client: this.config.client };
    }
    const base = this.config.defaultLLMConfig;
    const provider = override.provider ?? base?.provider ?? "custom";
    const apiKeySource = override.apiKeyEnv
      ? `env:${override.apiKeyEnv}`
      : `base:${base?.apiKey ?? ""}`;
    const stream = override.stream ?? base?.stream ?? true;
    const apiFormat = base?.apiFormat ?? "chat";
    const cacheKey = [
      provider,
      override.baseUrl,
      apiKeySource,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      const apiKey = override.apiKeyEnv
        ? process.env[override.apiKeyEnv] ?? ""
        : base?.apiKey ?? "";
      client = createLLMClient({
        provider,
        service: base?.service ?? "custom",
        configSource: base?.configSource ?? "env",
        baseUrl: override.baseUrl,
        apiKey,
        model: override.model,
        temperature: base?.temperature ?? 0.7,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: override.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
      signal: this.currentAbortSignal(),
      activatedSkills: this.currentActivatedSkills(),
    };
  }

  public createAgentContext(agent: string, bookId?: string): AgentContext {
    return this.agentCtxFor(agent, bookId);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by OpenClaw or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    const available = await loadAvailableAgentSkills({ projectRoot: this.config.projectRoot });
    const marketSkill = [...available.skills].reverse().find((skill) => skill.id === "inkos-long-market-research");
    if (!marketSkill) throw new Error("Radar requires unavailable skill: inkos-long-market-research");
    const baseContext = this.agentCtxFor("radar");
    const radar = new RadarAgent({
      ...baseContext,
      activatedSkills: mergeActivatedSkillGuidance(
        baseContext.activatedSkills ?? [],
        [{ skill: marketSkill, resources: [] }],
      ),
    }, this.config.radarSources);
    return radar.scan();
  }

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);
    const stagingBookDir = join(
      this.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);
    const effectiveExternalContext = options.externalContext ?? this.config.externalContext;

    this.logStage(stageLanguage, { zh: "生成基础设定", en: "generating foundation" });
    const foundation = await architect.generateFoundation(book, effectiveExternalContext);
    let published = false;
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        book.language,
      );

      if (effectiveExternalContext && effectiveExternalContext.trim().length > 0) {
        const storyDir = join(stagingBookDir, "story");
        await mkdir(storyDir, { recursive: true });
        await writeFile(join(storyDir, "brief.md"), effectiveExternalContext, "utf-8");
      }

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language,
        options.authorIntent ?? effectiveExternalContext,
      );
      if (options.currentFocus?.trim()) {
        await writeFile(
          join(stagingBookDir, "story", "current_focus.md"),
          options.currentFocus.trimEnd() + "\n",
          "utf-8",
        );
      }

      await this.state.saveChapterIndexAt(stagingBookDir, []);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.state.snapshotStateAt(stagingBookDir, 0);

      if (await this.pathExists(bookDir)) {
        if (await this.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${book.id}" already exists as a Work. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      }

      await mkdir(dirname(bookDir), { recursive: true });
      await rename(stagingBookDir, bookDir);
      published = true;
      await saveWorkManifest(this.config.projectRoot, createWorkManifest({
        id: book.id,
        title: book.title,
        profileId: "longform-novel",
        language: book.language,
        now: book.createdAt,
        lineage: book.parentBookId
          ? [{ relation: "derived-from", sourceWorkId: book.parentBookId }]
          : [],
        metadata: {
          genre: book.genre,
          platform: book.platform,
          ...(book.fanficMode ? { fanficMode: book.fanficMode } : {}),
        },
      }));
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await rm(stagingBookDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (published) {
        try {
          await rm(workDirectory(this.config.projectRoot, book.id), { recursive: true, force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Work creation failed and cleanup was incomplete: ${book.id}`,
        );
      }
      throw error;
    }
  }

  /** Revise an existing Work foundation without touching runtime chapter state. */
  async reviseFoundation(bookId: string, feedback: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(storyDir, `.backup-foundation-${timestamp}`);
    await mkdir(backupDir, { recursive: true });
    await this.copyDirShallow(join(storyDir, "outline"), join(backupDir, "outline"));
    await this.copyDirRecursive(join(storyDir, "roles"), join(backupDir, "roles"));
    await writeFile(
      join(backupDir, "book_rules.md"),
      await readFile(join(storyDir, "book_rules.md"), "utf-8"),
      "utf-8",
    );

    const book = await this.state.loadBookConfig(bookId);
    const [oldStoryFrame, oldVolumeMap, oldBookRules, oldRoles] = await Promise.all([
      readStoryFrame(bookDir),
      readVolumeMap(bookDir),
      readFile(join(storyDir, "book_rules.md"), "utf-8"),
      readCharacterContext(bookDir),
    ]);

    const architect = new ArchitectAgent(this.agentCtxFor("architect", bookId));
    const foundation = await architect.generateFoundation(book, undefined, undefined, {
      reviseFrom: {
        storyFrame: oldStoryFrame,
        volumeMap: oldVolumeMap,
        bookRules: oldBookRules,
        roles: oldRoles,
        userFeedback: feedback,
      },
    });

    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      book.language,
      "revise",
    );
    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
  }

  private async copyDirShallow(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const content = await readFile(join(src, entry.name), "utf-8");
      await writeFile(join(dest, entry.name), content, "utf-8");
    }));
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        const content = await readFile(srcPath, "utf-8");
        await writeFile(destPath, content, "utf-8");
      }
    }
  }

  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(
    bookId: string,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<string> {
    const { FanficCanonImporter } = await import("../agents/fanfic-canon-importer.js");
    const importer = new FanficCanonImporter(this.agentCtxFor("fanfic-canon-importer", bookId));
    const result = await importer.importFromText(sourceText, sourceName, fanficMode);

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "fanfic_canon.md"), result.fullDocument, "utf-8");

    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
    return result.fullDocument;
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(
    book: BookConfig,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfig(book.id, book);

      this.logStage(stageLanguage, { zh: "导入同人正典", en: "importing fanfic canon" });
      const fanficCanon = await this.importFanficCanon(book.id, sourceText, sourceName, fanficMode);

      const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
      this.logStage(stageLanguage, { zh: "生成同人基础设定", en: "generating fanfic foundation" });
      const foundation = await architect.generateFanficFoundation(book, fanficCanon, fanficMode);
      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        bookDir,
        foundation,
        book.language,
      );
      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocuments(book.id, this.config.externalContext);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await mkdir(join(bookDir, "chapters"), { recursive: true });
      await this.state.saveChapterIndex(book.id, []);
      await this.state.snapshotState(book.id, 0);
    } catch (error) {
      await this.removeFailedWork(book.id, error);
    }
  }

  /**
   * Create a side-story (番外) book: a standalone companion that inherits a
   * parent book's world/characters via parent_canon.md, but tells an INDEPENDENT
   * side plot that does not advance or contradict the parent's main-line state.
   * Reuses importCanon (which already builds the parent-canon reference for
   * side-story writing) + the standard original-foundation architect path.
   */
  async initSpinoffBook(book: BookConfig, parentBookId: string, direction?: string): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfig(book.id, book);

      this.logStage(stageLanguage, { zh: "导入正传正典参照", en: "importing parent canon" });
      const parentCanon = await this.importCanon(book.id, parentBookId);

      const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
      const resolvedLanguage = book.language;
      const spinoffContext = buildSpinoffFoundationContext(parentCanon, direction, resolvedLanguage);

      this.logStage(stageLanguage, { zh: "生成番外基础设定", en: "generating side-story foundation" });
      const foundation = await architect.generateFoundation(book, spinoffContext);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(bookDir, foundation, book.language);

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocuments(book.id, direction?.trim() || this.config.externalContext);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await mkdir(join(bookDir, "chapters"), { recursive: true });
      await this.state.saveChapterIndex(book.id, []);
      await this.state.snapshotState(book.id, 0);
    } catch (error) {
      await this.removeFailedWork(book.id, error);
    }
  }

  /**
   * Create an imitation (仿写) book: an ORIGINAL story whose prose imitates the
   * voice of a reference work. The architect builds an original foundation from
   * the user's story idea; the reference text becomes the book's style_guide.md
   * so the writer mimics its style. The style guide is mandatory here (imitation
   * is the whole point), so a failure to generate it surfaces rather than being
   * silently skipped.
   */
  async initImitationBook(
    book: BookConfig,
    referenceText: string,
    storyIdea: string,
    sourceName?: string,
  ): Promise<void> {
    try {
      await this.initBook(book, { externalContext: storyIdea });
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "提取参考作品风格指纹", en: "extracting reference style fingerprint" });
      await this.generateStyleGuide(book.id, referenceText, sourceName?.trim() || "reference");
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true });
    } catch (error) {
      await this.removeFailedWork(book.id, error);
    }
  }

  /** Audit the latest (or specified) chapter. Read-only, no lock needed. */
  async reviewChapter(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }

    const content = await this.readChapterContent(bookDir, targetChapter);
    const chapterBrief = await readChapterUserBrief(bookDir, targetChapter);
    const governed = await this.createGovernedArtifacts(
      book,
      bookDir,
      targetChapter,
      chapterBrief,
      { reuseExistingIntentWhenContextMissing: true },
    );
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const language = book.language;
    this.logStage(language, {
      zh: `审计第${targetChapter}章`,
      en: `auditing chapter ${targetChapter}`,
    });
    const evaluation = await this.collectReviewObservations({
      auditor,
      book,
      bookDir,
      chapterContent: content,
      chapterNumber: targetChapter,
      language,
      auditOptions: { contextPackage: governed.composed.contextPackage },
    });
    const lengthSpec = buildLengthSpec(book.chapterWordCount, language);
    const lengthIssue = this.buildLengthReviewIssue(
      targetChapter,
      countChapterLength(content, lengthSpec.countingMode),
      lengthSpec,
    );
    const result: AuditResult = {
      ...evaluation,
      issues: [
        ...evaluation.issues,
        ...(lengthIssue ? [lengthIssue] : []),
      ],
    };

    // Update index with audit result
    const index = await this.state.loadChapterIndex(bookId);
    const updated = index.map((ch) =>
      ch.number === targetChapter
        ? {
            ...ch,
            updatedAt: new Date().toISOString(),
            observations: reviewObservations(result.issues),
          }
        : ch,
    );
    await this.state.saveChapterIndex(bookId, updated);

    await this.emitWebhook("review-complete", bookId, targetChapter, {
      summary: result.summary,
      observationCount: result.issues.length,
    });

    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
    return { ...result, chapterNumber: targetChapter };
  }

  /** Revise the latest (or specified) chapter based on audit issues. */
  async reviseDraft(bookId: string, chapterNumber?: number, mode: ReviseMode = DEFAULT_REVISE_MODE, externalContext?: string): Promise<ReviseResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }

      const stageLanguage = await this.resolveBookLanguage(book);
      // Read the current audit issues from index
      this.logStage(stageLanguage, {
        zh: `加载第${targetChapter}章修订上下文`,
        en: `loading revision context for chapter ${targetChapter}`,
      });
      const index = await this.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }
      const latestChapter = index.length > 0
        ? Math.max(...index.map((chapter) => chapter.number))
        : targetChapter;
      const isLatestChapter = targetChapter === latestChapter;

      const content = await this.readChapterContent(bookDir, targetChapter);
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const language = book.language;
      const countingMode = resolveLengthCountingMode(language);
      const persistedChapterBrief = await readChapterUserBrief(bookDir, targetChapter);
      const effectiveExternalContext = mergeChapterRevisionInstructions(
        persistedChapterBrief,
        externalContext ?? this.config.externalContext,
      );
      const reviseControlInput = await this.createGovernedArtifacts(
        book,
        bookDir,
        targetChapter,
        effectiveExternalContext,
        { reuseExistingIntentWhenContextMissing: true },
      );
      const explicitRevisionRequested = Boolean(effectiveExternalContext?.trim())
        || mode === "rewrite"
        || mode === "rework";
      const preRevision = explicitRevisionRequested
        ? { issues: [], summary: language === "en" ? "User-directed revision" : "用户定向修订" }
        : await this.collectReviewObservations({
            auditor,
            book,
            bookDir,
            chapterContent: content,
            chapterNumber: targetChapter,
            language,
            auditOptions: {
              contextPackage: reviseControlInput.composed.contextPackage,
            },
          });
      if (!explicitRevisionRequested && !preRevision.issues.some((issue) => issue.severity !== "info")) {
        return {
          chapterNumber: targetChapter,
          wordCount: countChapterLength(content, countingMode),
          changed: false,
          fixedIssues: [],
          observations: [],
        };
      }

      const chapterLengthTarget = chapterMeta.lengthTelemetry?.target ?? book.chapterWordCount;
      const lengthLanguage = chapterMeta.lengthTelemetry?.countingMode === "en_words"
        ? "en"
        : language;
      const lengthSpec = buildLengthSpec(
        chapterLengthTarget,
        lengthLanguage,
      );
      const baselineChapter = targetChapter - 1;
      const baselineSnapshot = await loadRuntimeStateSnapshotAtChapter({
        bookDir,
        chapterNumber: baselineChapter,
        language,
      }).catch((error) => {
        throw new Error(
          `Cannot revise chapter ${targetChapter} safely: baseline snapshot ${baselineChapter} is unavailable (${String(error)})`,
        );
      });
      const baselineState = renderCurrentStateProjection(baselineSnapshot.currentState, language);
      const baselineHooks = renderHooksProjection(baselineSnapshot.hooks, language);

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.logStage(stageLanguage, {
        zh: `修订第${targetChapter}章`,
        en: `revising chapter ${targetChapter}`,
      });
      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        preRevision.issues,
        mode,
        book.genre,
        {
          language,
          contextPackage: reviseControlInput.composed.contextPackage,
          lengthSpec,
        },
      );

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      const revisedContent = reviseOutput.revisedContent;
      const revisedCount = countChapterLength(revisedContent, lengthSpec.countingMode);
      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      const stateValidator = new StateValidatorAgent(this.agentCtxFor("stateValidator", bookId));
      let settledRevision = await writer.settleChapterState({
        book,
        bookDir,
        chapterNumber: targetChapter,
        baselineChapter,
        title: chapterMeta.title,
        content: revisedContent,
        chapterIntent: reviseControlInput?.plan.intentMarkdown,
        contextPackage: reviseControlInput?.composed.contextPackage,
      });
      let stateValidation = await stateValidator.validate(
        revisedContent,
        targetChapter,
        baselineState,
        settledRevision.updatedState,
        baselineHooks,
        settledRevision.updatedHooks,
        language,
      );
      if (!stateValidation.consistent || stateValidation.reconciliationRequired) {
        const recovery = await reconcileChapterStateAfterReview({
          writer,
          validator: stateValidator,
          book,
          bookDir,
          chapterNumber: targetChapter,
          baselineChapter,
          title: chapterMeta.title,
          content: revisedContent,
          reducedControlInput: {
            chapterIntent: reviseControlInput.plan.intentMarkdown,
            contextPackage: reviseControlInput.composed.contextPackage,
          },
          oldState: baselineState,
          oldHooks: baselineHooks,
          originalValidation: stateValidation,
          language,
          logger: this.config.logger,
        });
        settledRevision = recovery.output;
        stateValidation = recovery.validation;
      }
      const postRevision = await this.collectReviewObservations({
        auditor,
        book,
        bookDir,
        chapterContent: revisedContent,
        chapterNumber: targetChapter,
        language,
        auditOptions: {
          temperature: 0,
          contextPackage: reviseControlInput.composed.contextPackage,
        },
      });
      const lengthReviewIssue = this.buildLengthReviewIssue(targetChapter, revisedCount, lengthSpec);
      const postRevisionIssues = [
        ...postRevision.issues,
        ...buildStateReconciliationIssues(stateValidation.warnings, language),
        ...(lengthReviewIssue ? [lengthReviewIssue] : []),
      ];
      const revisionBaseCount = countChapterLength(content, lengthSpec.countingMode);
      const lengthWarning = isOutsideHardRange(revisedCount, lengthSpec);
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postReviseCount: revisedCount,
        finalCount: revisedCount,
        repairApplied: revisedContent !== content,
        lengthWarning,
      });

      const remainingIssues = postRevisionIssues
        .filter((issue) => issue.severity === "warning" || issue.severity === "critical")
        .map((issue) => ({
          severity: issue.severity,
          category: issue.category,
          description: issue.description,
          ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
        }));

      // Save revised chapter file
      this.logStage(stageLanguage, {
        zh: `落盘第${targetChapter}章修订结果`,
        en: `persisting revision for chapter ${targetChapter}`,
      });
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(targetChapter).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(`Chapter ${targetChapter} file not found in ${chaptersDir} (expected filename starting with ${paddedNum})`);
      }
      await archiveChapterVersion(bookDir, targetChapter, content, "revision");
      const reviseLang = book.language;
      const reviseHeading = reviseLang === "en"
        ? `# Chapter ${targetChapter}: ${chapterMeta.title}`
        : `# 第${targetChapter}章 ${chapterMeta.title}`;

      const downstreamRevisionNotice = language === "en"
        ? `Chapter ${targetChapter} changed; re-review this downstream chapter for continuity.`
        : `第${targetChapter}章已重写，请重新检查本章与前文的连续性。`;
      const updatedIndex = index.map((ch) => {
        if (ch.number === targetChapter) {
          return {
            ...ch,
            wordCount: revisedCount,
            updatedAt: new Date().toISOString(),
            observations: reviewObservations(postRevisionIssues),
            provenance: "edited" as const,
            lengthTelemetry,
          };
        }
        if (ch.number > targetChapter) {
          return {
            ...ch,
            updatedAt: new Date().toISOString(),
            observations: [
              ...ch.observations.filter((observation) => observation.code !== "upstream-revision"),
              {
                code: "upstream-revision",
                kind: "soft" as const,
                summary: downstreamRevisionNotice,
                evidence: [],
              },
            ],
          };
        }
        return ch;
      });

      // Only the latest chapter owns current truth. Reworking an older chapter
      // invalidates its descendants, but must not rewind the live story state.
      if (isLatestChapter) {
        await writer.saveChapter(bookDir, settledRevision, reviseLang, updatedIndex);
      } else {
        await commitAtomicFileSet({
          rootDir: bookDir,
          writes: [
            {
              relativePath: join("chapters", existingFile),
              content: `${reviseHeading}\n\n${revisedContent}`,
            },
            {
              relativePath: join("chapters", "index.json"),
              content: `${JSON.stringify(updatedIndex, null, 2)}\n`,
            },
          ],
        });
      }

      // Re-snapshot
      this.logStage(stageLanguage, {
        zh: `更新第${targetChapter}章索引与快照`,
        en: `updating chapter index and snapshots for chapter ${targetChapter}`,
      });

      await this.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: revisedCount,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
      return {
        chapterNumber: targetChapter,
        wordCount: revisedCount,
        changed: true,
        fixedIssues: reviseOutput.fixedIssues,
        observations: remainingIssues,
        lengthTelemetry,
      };
    } finally {
      await releaseLock();
    }
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const book = await this.state.loadBookConfig(bookId);
    const language = book.language;
    const [runtimeSnapshot, storyFrame, volumeMap, bookRules] =
      await Promise.all([
        loadRuntimeStateSnapshot(bookDir),
        readFile(join(storyDir, "outline/story_frame.md"), "utf-8"),
        readFile(join(storyDir, "outline/volume_map.md"), "utf-8"),
        readFile(join(storyDir, "book_rules.md"), "utf-8"),
      ]);

    return {
      currentState: renderCurrentStateProjection(runtimeSnapshot.currentState, language),
      pendingHooks: renderHooksProjection(runtimeSnapshot.hooks, language),
      storyFrame,
      volumeMap,
      bookRules,
    };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    const nextChapter = await this.state.getNextChapterNumber(bookId);
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter,
      chapters: [...chapters],
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextChapter(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    this.throwIfOperationAborted();
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const result = await this._writeNextChapterLocked(
        bookId,
        wordCount,
        temperatureOverride,
        externalContext ?? this.config.externalContext,
      );
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
      return result;
    } finally {
      await releaseLock();
    }
  }

  async writeChapters(
    bookId: string,
    chapterCount: number,
    options: WriteChaptersOptions = {},
  ): Promise<ReadonlyArray<ChapterPipelineResult>> {
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 20) {
      throw new Error(`chapterCount must be an integer between 1 and 20; received ${chapterCount}.`);
    }

    this.throwIfOperationAborted();
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const results: ChapterPipelineResult[] = [];
      for (let index = 0; index < chapterCount; index += 1) {
        this.throwIfOperationAborted();
        const result = await this._writeNextChapterLocked(
          bookId,
          options.wordCount,
          options.temperatureOverride,
          options.externalContext ?? this.config.externalContext,
        );
        results.push(result);
        options.onChapterComplete?.(result, results.length, chapterCount);
      }
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
      return results;
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterArtifacts(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const result = await this._resyncChapterArtifactsLocked(bookId, chapterNumber);
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true });
      return result;
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterStateAndAudit(
    bookId: string,
    chapterNumber?: number,
    options: { readonly allowNewHooks?: boolean } = {},
  ): Promise<{
    readonly chapter: ChapterPipelineResult;
    readonly audit: AuditResult & { readonly chapterNumber: number };
  }> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const chapter = await this._resyncChapterArtifactsLocked(bookId, chapterNumber, options);
      const audit = await this.reviewChapter(bookId, chapter.chapterNumber);
      return { chapter, audit };
    } finally {
      await releaseLock();
    }
  }

  private async _writeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const paddedChapter = String(chapterNumber).padStart(4, "0");
    const result = await this._executeNextChapterLocked(
      bookId,
      wordCount,
      temperatureOverride,
      externalContext,
    );
    const chapterFile = (await readdir(join(bookDir, "chapters")))
      .find((file) => file.startsWith(`${paddedChapter}_`) && file.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} completed without a persisted chapter artifact.`);
    }
    return result;
  }

  private async _executeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    this.throwIfOperationAborted();
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
    const writeInput = await this.prepareWriteInput(
      book,
      bookDir,
      chapterNumber,
      externalContext,
    );
    const reducedControlInput = {
      chapterIntent: writeInput.chapterIntent,
      chapterMemo: writeInput.chapterMemo,
      chapterIntentData: writeInput.chapterIntentData,
      contextPackage: writeInput.contextPackage,
    };
    const pipelineLang = book.language;
    const lengthSpec = buildLengthSpec(
      wordCount ?? book.chapterWordCount,
      pipelineLang,
    );
    // 1. Write chapter
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
    const output = await writer.writeChapter({
      book,
      bookDir,
      chapterNumber,
      ...writeInput,
      lengthSpec,
      ...(wordCount ? { wordCountOverride: wordCount } : {}),
      ...(temperatureOverride ? { temperatureOverride } : {}),
    });
    this.throwIfOperationAborted();
    const writerCount = countChapterLength(output.content, lengthSpec.countingMode);

    // Token usage accumulator
    let totalUsage: TokenUsageSummary = output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.logStage(stageLanguage, { zh: "生成章节审查观察", en: "collecting chapter review observations" });
    const reviewResult = await reviewChapterDraft({
      book: { genre: book.genre },
      bookDir,
      chapterNumber,
      output,
      controlInput: reducedControlInput,
      lengthSpec,
      initialUsage: totalUsage,
      auditor: new ContinuityAuditor(this.agentCtxFor("auditor", bookId)),
      assertNotEmpty: (content) => this.assertChapterContentNotEmpty(content, chapterNumber, "draft generation"),
      addUsage: PipelineRunner.addUsage,
    });
    totalUsage = reviewResult.totalUsage;
    let finalContent = reviewResult.content;
    let finalWordCount = reviewResult.wordCount;
    let auditResult = reviewResult.review;

    this.throwIfOperationAborted();
    // 4. Save the final chapter and truth files from a single persistence source
    this.logStage(stageLanguage, { zh: "落盘最终章节", en: "persisting final chapter" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const chapterIndexBeforePersist = await this.state.loadChapterIndex(bookId);
    let persistenceOutput = await this.buildPersistenceOutput(
      bookId,
      book,
      bookDir,
      chapterNumber,
      output,
      finalContent,
      lengthSpec.countingMode,
      reducedControlInput,
    );
    finalWordCount = persistenceOutput.wordCount;
    const lengthWarning = isOutsideHardRange(finalWordCount, lengthSpec);
    const lengthTelemetry = this.buildLengthTelemetry({
      lengthSpec,
      writerCount,
      postReviseCount: 0,
      finalCount: finalWordCount,
      repairApplied: false,
      lengthWarning,
    });

    // 4.1 Validate settler output before writing
    this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
    const storyDir = join(bookDir, "story");
    const [runtimeSnapshot, authorityStoryFrame, authorityBookRules] = await Promise.all([
      loadRuntimeStateSnapshot(bookDir),
      readStoryFrame(bookDir),
      readFile(join(storyDir, "book_rules.md"), "utf-8"),
    ]);
    const oldState = renderCurrentStateProjection(runtimeSnapshot.currentState, pipelineLang);
    const oldHooks = renderHooksProjection(runtimeSnapshot.hooks, pipelineLang);
    const authorityChapterSummaries = renderChapterSummariesProjection(runtimeSnapshot.chapterSummaries, pipelineLang);
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    const truthValidation = await validateChapterTruthPersistence({
      writer,
      validator,
      book,
      bookDir,
      chapterNumber,
      title: persistenceOutput.title,
      content: finalContent,
      persistenceOutput,
      previousTruth: {
        oldState,
        oldHooks,
      },
      authorityContext: {
        storyFrame: authorityStoryFrame,
        bookRules: authorityBookRules,
        chapterSummaries: authorityChapterSummaries,
      },
      reducedControlInput,
      language: pipelineLang,
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logger: this.config.logger,
    });
    persistenceOutput = truthValidation.persistenceOutput;
    if (!truthValidation.validation.consistent || truthValidation.validation.reconciliationRequired) {
      auditResult = {
        ...auditResult,
        issues: [
          ...auditResult.issues,
          ...buildStateReconciliationIssues(truthValidation.validation.warnings, pipelineLang),
        ],
      };
    }

    await persistChapterArtifacts({
      chapterNumber,
      chapterTitle: persistenceOutput.title,
      auditResult,
      finalWordCount,
      lengthTelemetry,
      tokenUsage: totalUsage,
      loadChapterIndex: () => this.state.loadChapterIndex(bookId),
      saveChapter: (index) => writer.saveChapter(bookDir, persistenceOutput, pipelineLang, index),
      markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
    });

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const chapterLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${book.title} 第${chapterNumber}章`,
        body: [
          `**${persistenceOutput.title}** | ${chapterLength}`,
          auditResult.summary,
          ...auditResult.issues
            .filter((i) => i.severity !== "info")
            .map((i) => `- [${i.severity}] ${i.description}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      observationCount: auditResult.issues.length,
    });

    return {
      chapterNumber,
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      review: auditResult,
      lengthTelemetry,
      tokenUsage: totalUsage,
      ...(writeInput.contextTrace ? { contextTrace: writeInput.contextTrace } : {}),
    };
  }

  private async _resyncChapterArtifactsLocked(
    bookId: string,
    chapterNumber?: number,
    options: { readonly allowNewHooks?: boolean } = {},
  ): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to sync.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest persisted chapter can be synced safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "根据已编辑正文同步真相文件与索引", en: "syncing truth files and indexes from edited chapter body" });
    const pipelineLang = book.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const baselineChapter = targetChapter - 1;
    const baselineSnapshot = await loadRuntimeStateSnapshotAtChapter({
      bookDir,
      chapterNumber: baselineChapter,
      language: pipelineLang,
    }).catch((error) => {
      throw new Error(
        `Cannot sync chapter ${targetChapter} safely: baseline snapshot ${baselineChapter} is unavailable (${String(error)})`,
      );
    });
    const oldState = renderCurrentStateProjection(baselineSnapshot.currentState, pipelineLang);
    const oldHooks = renderHooksProjection(baselineSnapshot.hooks, pipelineLang);

    const reducedControlInput = await this.createGovernedArtifacts(
      book,
      bookDir,
      targetChapter,
      this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let syncedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      baselineChapter,
      allowNewHooks: options.allowNewHooks,
      title: targetMeta.title,
      content,
      chapterIntent: reducedControlInput?.plan.intentMarkdown,
      contextPackage: reducedControlInput?.composed.contextPackage,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      syncedOutput.updatedState,
      oldHooks,
      syncedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.consistent) {
      const recovery = await reconcileChapterStateAfterReview({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        baselineChapter,
        allowNewHooks: options.allowNewHooks,
        title: targetMeta.title,
        content,
        reducedControlInput: {
          chapterIntent: reducedControlInput.plan.intentMarkdown,
          contextPackage: reducedControlInput.composed.contextPackage,
        },
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "reconciled") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `Chapter sync still failed for chapter ${targetChapter}.`,
        );
      }
      syncedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.consistent) {
      throw new Error(`Chapter sync still failed for chapter ${targetChapter}.`);
    }

    index[targetIndex] = {
      ...targetMeta,
      updatedAt: new Date().toISOString(),
      observations: targetMeta.observations.filter((observation) => observation.code !== "state-sync-required"),
    };
    await writer.saveChapter(bookDir, syncedOutput, pipelineLang, index);
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      review: {
        issues: [],
        summary: "chapter truth/state resynced from edited body",
      },
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    const sample = referenceText.trim();
    if (!sample) throw new Error("Reference text is required for style extraction.");

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    const book = await this.state.loadBookConfig(bookId);
    const language = book.language;
    const guide = await compileStyleGuide({
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      referenceText: sample,
      sourceName,
      language,
      activeSkills: this.currentActivatedSkills(),
      signal: this.currentAbortSignal(),
    });
    await writeFile(join(storyDir, "style_guide.md"), guide, "utf-8");
    return guide;
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Projects the parent's current truth files into parent_canon.md without
   * asking an LLM to reinterpret facts the host already owns.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    // Validate both books exist
    const bookIds = await this.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(`Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(`Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }

    const parentDir = this.state.bookDir(parentBookId);
    const targetDir = this.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readOptional = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "(无)";
        throw error;
      }
    };

    const parentBook = await this.state.loadBookConfig(parentBookId);
    const parentLanguage = parentBook.language ?? "zh";

    const [storyFrame, volumeMap, bookRules, runtimeSnapshot, characters, styleGuide] =
      await Promise.all([
        readFile(join(parentDir, "story/outline/story_frame.md"), "utf-8"),
        readFile(join(parentDir, "story/outline/volume_map.md"), "utf-8"),
        readFile(join(parentDir, "story/book_rules.md"), "utf-8"),
        loadRuntimeStateSnapshot(parentDir),
        readCharacterContext(parentDir),
        readOptional(join(parentDir, "story/style_guide.md")),
      ]);
    const currentState = renderCurrentStateProjection(runtimeSnapshot.currentState, parentLanguage);
    const hooks = renderHooksProjection(runtimeSnapshot.hooks, parentLanguage);
    const summaries = renderChapterSummariesProjection(runtimeSnapshot.chapterSummaries, parentLanguage);

    const isEn = parentBook.language === "en";
    const section = (title: string, content: string): string => [
      `## ${title}`,
      "",
      content.trim() && content !== "(无)" ? content.trim() : (isEn ? "(not present)" : "（无）"),
    ].join("\n");
    const canon = [
      isEn ? `# Parent Canon (${parentBook.title})` : `# 正传正典（《${parentBook.title}》）`,
      "",
      isEn
        ? "> Deterministic projection of current parent Work artifacts. Content is copied, not reinterpreted by a model."
        : "> 由宿主从母本 Work 的已接受产物确定性投影；内容原样复制，不经过模型重述。",
      "",
      section(isEn ? "Story Frame" : "故事框架", storyFrame),
      "",
      section(isEn ? "Volume Map" : "分卷地图", volumeMap),
      "",
      section(isEn ? "Book Rules" : "本书规则", bookRules),
      "",
      section(isEn ? "Character Canon" : "角色正典", characters),
      "",
      section(isEn ? "Current State" : "当前状态", currentState),
      "",
      section(isEn ? "Pending Hooks" : "伏笔状态", hooks),
      "",
      section(isEn ? "Chapter Summaries" : "章节摘要", summaries),
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");

    await commitAtomicFileSet({
      rootDir: targetDir,
      writes: [
        { relativePath: "story/parent_canon.md", content: canon },
        ...(styleGuide.trim() && styleGuide !== "(无)"
          ? [{ relativePath: "story/style_guide.md", content: styleGuide }]
          : []),
      ],
    });

    return canon;
  }

  // ---------------------------------------------------------------------------
  // Chapter import (for continuation writing from existing chapters)
  // ---------------------------------------------------------------------------

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_frame, volume_map, book_rules) from all chapters.
   * Step 2: Sequentially replay each chapter through ChapterAnalyzer to build truth files.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    this.throwIfOperationAborted();
    const releaseLock = await this.state.acquireBookLock(input.bookId);
    try {
      const book = await this.state.loadBookConfig(input.bookId);
      const bookDir = this.state.bookDir(input.bookId);
      const resolvedLanguage = book.language;

      const startFrom = input.resumeFrom ?? 1;

      const log = this.config.logger?.child("import");

      // Step 1: Generate foundation on first run (not on resume)
      if (startFrom === 1) {
        log?.info(this.localize(resolvedLanguage, {
          zh: `步骤 1：从 ${input.chapters.length} 章生成基础设定...`,
          en: `Step 1: Generating foundation from ${input.chapters.length} chapters...`,
        }));
        const importContext = await compileImportSource({
          client: this.config.client,
          model: this.config.model,
          projectRoot: this.config.projectRoot,
          chapters: input.chapters,
          language: resolvedLanguage,
          activeSkills: this.currentActivatedSkills(),
          signal: this.currentAbortSignal(),
        });
        const foundationSource = importContext.markdown;
        if (importContext.compiled) {
          const runtimeDir = join(bookDir, "story", "runtime");
          await mkdir(runtimeDir, { recursive: true });
          await writeFile(join(runtimeDir, "import-context-trace.json"), JSON.stringify({
            mode: "semantic-compilation",
            sourceChapters: input.chapters.length,
            chunkCount: importContext.chunkCount,
          }, null, 2), "utf-8");
        }

        const architect = new ArchitectAgent(this.agentCtxFor("architect", input.bookId));
        const isSeries = input.importMode === "series";
        const foundation = await architect.generateFoundationFromImport(
          book,
          foundationSource,
          undefined,
          undefined,
          { importMode: isSeries ? "series" : "continuation" },
        );
        this.throwIfOperationAborted();
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          resolvedLanguage,
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage);
        await this.state.saveChapterIndex(input.bookId, [], { allowEmptyWithChapterFiles: true });
        await this.state.snapshotState(input.bookId, 0);

        log?.info(this.localize(resolvedLanguage, {
          zh: "基础设定已生成。",
          en: "Foundation generated.",
        }));
      }

      // Step 2: Sequential replay
      log?.info(this.localize(resolvedLanguage, {
        zh: `步骤 2：从第 ${startFrom} 章开始顺序回放...`,
        en: `Step 2: Sequential replay from chapter ${startFrom}...`,
      }));
      const writer = new WriterAgent(this.agentCtxFor("writer", input.bookId));
      const countingMode = resolveLengthCountingMode(book.language);
      let totalWords = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.chapters.length; i++) {
        this.throwIfOperationAborted();
        const ch = input.chapters[i]!;
        const chapterNumber = i + 1;
        const governedInput = await this.prepareWriteInput(book, bookDir, chapterNumber);

        log?.info(this.localize(resolvedLanguage, {
          zh: `分析章节 ${chapterNumber}/${input.chapters.length}：${ch.title}...`,
          en: `Analyzing chapter ${chapterNumber}/${input.chapters.length}: ${ch.title}...`,
        }));

        // Analyze chapter to get truth file updates
        const output = await writer.settleChapterState({
          book,
          bookDir,
          chapterNumber,
          content: ch.content,
          title: ch.title,
          chapterIntent: governedInput.chapterIntent,
          contextPackage: governedInput.contextPackage,
        });
        this.throwIfOperationAborted();

        const chapterWordCount = countChapterLength(ch.content, countingMode);
        const persistedOutput: WriteChapterOutput = {
          ...output,
          content: ch.content,
          wordCount: chapterWordCount,
        };

        const existingIndex = await this.state.loadChapterIndex(input.bookId);
        const now = new Date().toISOString();
        const newEntry: ChapterMeta = {
          number: chapterNumber,
          title: output.title,
          wordCount: chapterWordCount,
          createdAt: now,
          updatedAt: now,
          observations: [],
          provenance: "imported",
        };
        // Replace if exists (resume case), otherwise append
        const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
        const updatedIndex = existingIdx >= 0
          ? existingIndex.map((e, idx) => idx === existingIdx ? newEntry : e)
          : [...existingIndex, newEntry];
        await writer.saveChapter(bookDir, persistedOutput, resolvedLanguage, updatedIndex);

        importedCount++;
        totalWords += chapterWordCount;
      }

      if (input.chapters.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
      }

      const nextChapter = input.chapters.length + 1;
      log?.info(this.localize(resolvedLanguage, {
        zh: `完成。已导入 ${importedCount} 章，共 ${formatLengthCount(totalWords, countingMode)}。下一章：${nextChapter}`,
        en: `Done. ${importedCount} chapters imported, ${formatLengthCount(totalWords, countingMode)}. Next chapter: ${nextChapter}`,
      }));

      return {
        bookId: input.bookId,
        importedCount,
        totalWords,
        nextChapter,
      };
    } finally {
      await releaseLock();
    }
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    output: WriteChapterOutput,
    finalContent: string,
    countingMode: Parameters<typeof countChapterLength>[1],
    reducedControlInput: {
      chapterIntent: string;
      contextPackage: ContextPackage;
    },
  ): Promise<WriteChapterOutput> {
    if (finalContent === output.content) {
      return output;
    }

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    const analyzed = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber,
      content: finalContent,
      title: output.title,
      chapterIntent: reducedControlInput.chapterIntent,
      contextPackage: reducedControlInput.contextPackage,
    });

    return {
      ...analyzed,
      content: finalContent,
      wordCount: countChapterLength(finalContent, countingMode),
      tokenUsage: output.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<Pick<WriteChapterInput, "externalContext" | "chapterIntent" | "chapterMemo" | "chapterIntentData" | "contextPackage"> & {
    readonly contextTrace?: ChapterContextTraceSummary;
  }> {
    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      externalContext,
      chapterIntent: plan.intentMarkdown,
      chapterMemo: plan.memo,
      chapterIntentData: plan.intent,
      contextPackage: composed.contextPackage,
      contextTrace: {
        tracePath: relativeToBookDir(bookDir, composed.tracePath),
        selectedSources: [...composed.trace.selectedSources],
        protectedSources: [...composed.trace.contextTiers.protectedSources],
        compressibleSources: [...composed.trace.contextTiers.compressibleSources],
        tokenBudget: { ...composed.trace.tokenBudget },
        ...(composed.trace.retrieval ? {
          retrieval: {
            ...composed.trace.retrieval,
            candidates: composed.trace.retrieval.candidates.map((candidate) => ({ ...candidate })),
            ...(composed.trace.retrieval.semanticSelectedIds
              ? { semanticSelectedIds: [...composed.trace.retrieval.semanticSelectedIds] }
              : {}),
          },
        } : {}),
        ...(composed.trace.compression ? {
          compression: {
            ...composed.trace.compression,
            protectedSources: [...composed.trace.compression.protectedSources],
            compressedSources: [...composed.trace.compression.compressedSources],
          },
        } : {}),
      },
    };
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "chapter_summaries.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
    await createInitialRuntimeState({ bookDir, language, hooks: [] });
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private assertChapterContentNotEmpty(content: string, chapterNumber: number, stage: string): void {
    if (content.trim().length > 0) return;
    throw new Error(`Chapter ${chapterNumber} has empty chapter content after ${stage}`);
  }

  private buildLengthReviewIssue(
    chapterNumber: number,
    finalCount: number,
    lengthSpec: LengthSpec,
  ): AuditIssue | undefined {
    if (!isOutsideHardRange(finalCount, lengthSpec)) return undefined;
    const language = this.languageFromLengthSpec(lengthSpec);
    return {
      severity: "warning",
      category: "length-budget",
      description: this.localize(language, {
        zh: `第${chapterNumber}章当前版本为 ${finalCount} 字，超出硬区间 ${lengthSpec.hardMin}-${lengthSpec.hardMax} 字。`,
        en: `Chapter ${chapterNumber} currently has ${finalCount} words, outside the hard range ${lengthSpec.hardMin}-${lengthSpec.hardMax}.`,
      }),
      suggestion: this.localize(language, {
        zh: `围绕 ${lengthSpec.target} 字调整当前版本。`,
        en: `Revise the current artifact toward ${lengthSpec.target} words.`,
      }),
      repairScope: "structural",
    };
  }

  private buildLengthTelemetry(params: {
    lengthSpec: LengthSpec;
    writerCount: number;
    postReviseCount: number;
    finalCount: number;
    repairApplied: boolean;
    lengthWarning: boolean;
  }): LengthTelemetry {
    return {
      target: params.lengthSpec.target,
      softMin: params.lengthSpec.softMin,
      softMax: params.lengthSpec.softMax,
      hardMin: params.lengthSpec.hardMin,
      hardMax: params.lengthSpec.hardMax,
      countingMode: params.lengthSpec.countingMode,
      writerCount: params.writerCount,
      postReviseCount: params.postReviseCount,
      finalCount: params.finalCount,
      repairApplied: params.repairApplied,
      lengthWarning: params.lengthWarning,
    };
  }

  private async collectReviewObservations(params: {
    auditor: ContinuityAuditor;
    book: BookConfig;
    bookDir: string;
    chapterContent: string;
    chapterNumber: number;
    language: LengthLanguage;
    auditOptions: {
      temperature?: number;
      contextPackage: ContextPackage;
    };
  }): Promise<AuditResult> {
    const contextPackage = await this.withPreviousChapterContext(
      params.bookDir,
      params.chapterNumber,
      params.auditOptions.contextPackage,
    );
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      params.chapterContent,
      params.chapterNumber,
      params.book.genre,
      {
        language: params.language,
        contextPackage,
        ...(params.auditOptions.temperature === undefined ? {} : { temperature: params.auditOptions.temperature }),
      },
    );
    return {
      issues: llmAudit.issues,
      summary: llmAudit.summary,
      tokenUsage: llmAudit.tokenUsage,
    };
  }

  private async withPreviousChapterContext(
    bookDir: string,
    chapterNumber: number,
    contextPackage: ContextPackage,
  ): Promise<ContextPackage> {
    if (chapterNumber <= 1) return contextPackage;
    const previousContent = await this.readChapterContent(bookDir, chapterNumber - 1);
    return {
      ...contextPackage,
      selectedContext: [
        ...contextPackage.selectedContext,
        {
          source: `runtime/previous_chapter#${chapterNumber - 1}`,
          reason: "Previous chapter text required for transition review.",
          excerpt: previousContent,
          protection: "protected",
        },
      ],
    };
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<{
    plan: PlanChapterOutput;
    composed: ComposeChapterOutput;
  }> {
    const plan = await this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, options);
    const composerCtx = this.agentCtxFor("composer", book.id);
    const composer = new ComposerAgent(composerCtx);
    const composed = await composeGovernedChapter({
      book,
      bookDir,
      chapterNumber,
      plan,
      contextBudget: contextBudgetFromClient(composerCtx.client),
      compressibleContextCompiler: (request) => composer.compileCompressibleContext(request),
      outlineSectionSelector: (request) => composer.selectOutlineSections(request),
      memorySemanticSelector: (request) => composer.selectMemoryCandidates(request),
      referenceContextProvider: (request) => selectBookReferenceContext(
        this.config.projectRoot,
        book.id,
        request,
        (selectionRequest) => composer.selectReferenceSections(selectionRequest),
      ),
      onContextCompression: this.config.onContextCompression,
    });

    return { plan, composed };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<PlanChapterOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, chapterNumber);
      if (persisted) return persisted;
    }

    const planner = new PlannerAgent(this.agentCtxFor("planner", book.id));
    const plan = await planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
    // Persist in the new memo format so subsequent compose/write phases can
    // skip the planner LLM call when no new context is supplied.
    await savePersistedPlan(bookDir, plan);
    return plan;
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    // Strip the title line
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }
}
