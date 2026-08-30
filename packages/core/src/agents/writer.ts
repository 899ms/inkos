import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { BookRules } from "../models/book-rules.js";
import { buildWriterSystemPrompt } from "./writer-prompts.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "./settler-prompts.js";
import { SettlementToolSchema } from "./settler-tool.js";
import { ChapterDraftToolSchema } from "./writer-tool.js";
import { readBookRules } from "./rules-reader.js";
import type { ChapterIntent, ChapterMemo, ContextPackage } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { ChapterMeta } from "../models/chapter.js";
import { RuntimeStateDeltaSchema, type RuntimeStateDelta } from "../models/runtime-state.js";
import { buildLengthSpec, countChapterLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import {
  buildRuntimeStateArtifacts,
  buildRuntimeStateArtifactsFromSnapshot,
  loadRuntimeStateSnapshot,
  loadRuntimeStateSnapshotAtChapter,
  type RuntimeStateArtifacts,
} from "../state/runtime-state-store.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { renderMemoAsNarrativeBlock, renderNarrativeSelectedContext } from "../utils/narrative-control.js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import {
  renderChapterSummariesProjection,
  renderCurrentStateProjection,
  renderHooksProjection,
} from "../state/state-projections.js";


export interface WriteChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  readonly chapterIntent: string;
  readonly chapterMemo: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly lengthSpec?: LengthSpec;
  readonly wordCountOverride?: number;
  readonly temperatureOverride?: number;
}

export interface SettleChapterStateInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly allowReapply?: boolean;
  readonly allowNewHooks?: boolean;
  readonly baselineChapter?: number;
  readonly chapterIntent: string;
  readonly contextPackage: ContextPackage;
  readonly validationFeedback?: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface WriteChapterOutput {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
  readonly runtimeStateSnapshot: RuntimeStateSnapshot;
  readonly updatedState: string;
  readonly updatedHooks: string;
  readonly updatedChapterSummaries: string;
  readonly runtimeStateApplied: boolean;
  readonly tokenUsage?: TokenUsage;
}

export class WriterAgent extends BaseAgent {
  get name(): string {
    return "writer";
  }

  private localize(language: "zh" | "en", messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private logInfo(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.info(this.localize(language, messages));
  }

  private logWarn(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.warn(this.localize(language, messages));
  }

  async writeChapter(input: WriteChapterInput): Promise<WriteChapterOutput> {
    const { book, bookDir, chapterNumber } = input;

    const [styleGuide, runtimeSnapshot] = await Promise.all([
      this.readFileOrDefault(join(bookDir, "story/style_guide.md")),
      loadRuntimeStateSnapshot(bookDir),
    ]);

    const parsedBookRules = await readBookRules(bookDir);
    const bookRules = parsedBookRules.rules;
    const bookRulesBody = parsedBookRules.body;

    const resolvedLanguage = book.language;
    const targetWords = input.lengthSpec?.target ?? input.wordCountOverride ?? book.chapterWordCount;
    const resolvedLengthSpec = input.lengthSpec ?? buildLengthSpec(targetWords, resolvedLanguage);
    if (!input.chapterIntent || !input.chapterMemo || !input.contextPackage) {
      throw new Error("Writer requires governed chapter intent, memo, and context package.");
    }
    const governedMemoryBlocks = buildGovernedMemoryEvidenceBlocks(input.contextPackage, resolvedLanguage);
    // ── Phase 1: Creative writing (temperature 0.7) ──
    const creativeSystemPrompt = buildWriterSystemPrompt(
      book, bookRules, bookRulesBody, styleGuide,
      resolvedLanguage,
      resolvedLengthSpec,
    );

    const creativeUserPrompt = this.buildGovernedUserPrompt({
      chapterNumber,
      chapterMemo: input.chapterMemo,
      chapterIntentData: input.chapterIntentData,
      contextPackage: input.contextPackage,
      externalContext: input.externalContext,
      lengthSpec: resolvedLengthSpec,
      language: book.language,
      selectedEvidenceBlock: this.joinGovernedEvidenceBlocks(governedMemoryBlocks),
    });

    const creativeTemperature = input.temperatureOverride ?? 0.7;

    this.logInfo(resolvedLanguage, {
      zh: `阶段 1：创作正文（第${chapterNumber}章）`,
      en: `Phase 1: creative writing for chapter ${chapterNumber}`,
    });

    const { result: creativeSubmission, usage: creativeUsage } = await this.submitStructured(
      [
        { role: "system", content: creativeSystemPrompt },
        { role: "user", content: creativeUserPrompt },
      ],
      {
        name: "submit_chapter_draft",
        label: resolvedLanguage === "en" ? "Submit chapter draft" : "提交章节初稿",
        description: resolvedLanguage === "en"
          ? "Submit the complete chapter title and prose."
          : "提交完整的章节标题和正文。",
        parameters: ChapterDraftToolSchema,
      },
      { temperature: creativeTemperature },
    );
    const creative = {
      title: creativeSubmission.title.trim(),
      content: creativeSubmission.content.trim(),
      wordCount: countChapterLength(creativeSubmission.content, resolvedLengthSpec.countingMode),
    };

    // ── Phase 2: State settlement (temperature 0.3) ──
    this.logInfo(resolvedLanguage, {
      zh: `阶段 2：状态结算（第${chapterNumber}章，${creative.wordCount}字）`,
      en: `Phase 2: state settlement for chapter ${chapterNumber} (${creative.wordCount} words)`,
    });
    const settleResult = await this.settle({
      book,
      bookRules,
      language: resolvedLanguage,
      chapterNumber,
      title: creative.title,
      content: creative.content,
      selectedEvidenceBlock: this.joinGovernedEvidenceBlocks(governedMemoryBlocks),
      chapterIntent: input.chapterIntent,
      contextPackage: input.contextPackage,
      validationFeedback: undefined,
    });
    const settlement = settleResult.settlement;
    const settleUsage = settleResult.usage;
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      bookDir,
      settlement.runtimeStateDelta,
      resolvedLanguage,
      chapterNumber,
    );
    const resolvedRuntimeStateDelta = runtimeStateArtifacts?.resolvedDelta ?? settlement.runtimeStateDelta;

    // ── Merge into WriteChapterOutput ──
    const tokenUsage: TokenUsage = {
      promptTokens: creativeUsage.promptTokens + settleUsage.promptTokens,
      completionTokens: creativeUsage.completionTokens + settleUsage.completionTokens,
      totalTokens: creativeUsage.totalTokens + settleUsage.totalTokens,
    };

    return {
      chapterNumber,
      title: creative.title,
      content: creative.content,
      wordCount: creative.wordCount,
      postSettlement: settlement.postSettlement,
      runtimeStateDelta: resolvedRuntimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts.snapshot,
      updatedState: runtimeStateArtifacts.currentStateMarkdown,
      updatedHooks: runtimeStateArtifacts.hooksMarkdown,
      updatedChapterSummaries: runtimeStateArtifacts.chapterSummariesMarkdown,
      runtimeStateApplied: true,
      tokenUsage,
    };
  }

  async settleChapterState(input: SettleChapterStateInput): Promise<WriteChapterOutput> {
    const runtimeSnapshot = await (input.baselineChapter === undefined
        ? loadRuntimeStateSnapshot(input.bookDir)
        : loadRuntimeStateSnapshotAtChapter({
            bookDir: input.bookDir,
            chapterNumber: input.baselineChapter,
            language: input.book.language,
          }));

    const parsedBookRules = await readBookRules(input.bookDir);
    const bookRules = parsedBookRules.rules;
    const resolvedLanguage = input.book.language;
    const governedMemoryBlocks = buildGovernedMemoryEvidenceBlocks(input.contextPackage, resolvedLanguage);

    const settleResult = await this.settle({
      book: input.book,
      bookRules,
      language: resolvedLanguage,
      chapterNumber: input.chapterNumber,
      title: input.title,
      content: input.content,
      selectedEvidenceBlock: this.joinGovernedEvidenceBlocks(governedMemoryBlocks),
      chapterIntent: input.chapterIntent,
      contextPackage: input.contextPackage,
      validationFeedback: input.validationFeedback,
    });
    const settlement = settleResult.settlement;
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      input.bookDir,
      settlement.runtimeStateDelta,
      resolvedLanguage,
      input.chapterNumber,
      input.allowReapply,
      input.baselineChapter,
      input.allowNewHooks,
    );

    return {
      chapterNumber: input.chapterNumber,
      title: input.title,
      content: input.content,
      wordCount: countChapterLength(
        input.content,
        resolvedLanguage === "en" ? "en_words" : "zh_chars",
      ),
      postSettlement: settlement.postSettlement,
      runtimeStateDelta: runtimeStateArtifacts?.resolvedDelta ?? settlement.runtimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts.snapshot,
      updatedState: runtimeStateArtifacts.currentStateMarkdown,
      updatedHooks: runtimeStateArtifacts.hooksMarkdown,
      updatedChapterSummaries: runtimeStateArtifacts.chapterSummariesMarkdown,
      runtimeStateApplied: true,
      tokenUsage: settleResult.usage,
    };
  }

  private async settle(params: {
    readonly book: BookConfig;
    readonly bookRules: BookRules | null;
    readonly language: "zh" | "en";
    readonly chapterNumber: number;
    readonly title: string;
    readonly content: string;
    readonly selectedEvidenceBlock?: string;
    readonly chapterIntent: string;
    readonly contextPackage: ContextPackage;
    readonly validationFeedback?: string;
  }): Promise<{
    settlement: {
      readonly postSettlement: string;
      readonly runtimeStateDelta: RuntimeStateDelta;
      readonly updatedState: string;
      readonly updatedHooks: string;
    };
    usage: TokenUsage;
  }> {
    const resolvedLang = params.language;
    this.logInfo(resolvedLang, {
      zh: `阶段 2：把第${params.chapterNumber}章事实投影到运行时状态`,
      en: `Phase 2: projecting chapter ${params.chapterNumber} facts into runtime state`,
    });
    const systemPrompt = buildSettlerSystemPrompt(params.book, params.bookRules, resolvedLang);
    const governedControlBlock = this.buildSettlerGovernedControlBlock(
      params.chapterIntent,
      params.contextPackage,
      resolvedLang,
    );
    const userPrompt = buildSettlerUserPrompt({
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      selectedEvidenceBlock: params.selectedEvidenceBlock,
      governedControlBlock,
      validationFeedback: params.validationFeedback,
      language: resolvedLang,
    });
    const { result, usage } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        name: "submit_runtime_state_delta",
        label: resolvedLang === "en" ? "Submit runtime state delta" : "提交运行时状态变更",
        description: resolvedLang === "en"
          ? "Submit only chapter-grounded incremental state changes. The host owns the chapter number."
          : "只提交正文有证据的增量状态变更；章节号由宿主持有。",
        parameters: SettlementToolSchema,
      },
      { temperature: 0.3 },
    );
    const runtimeStateDelta = RuntimeStateDeltaSchema.parse({
      chapter: params.chapterNumber,
      factOps: {
        upsert: result.factOps.upsert,
        expire: result.factOps.expire,
      },
      hookOps: {
        upsert: result.hookOps.upsert,
        mention: result.hookOps.mention,
        resolve: result.hookOps.resolve,
        defer: result.hookOps.defer,
      },
      newHookCandidates: result.newHookCandidates,
      chapterSummary: {
        chapter: params.chapterNumber,
        title: result.chapterSummary.title,
        characters: result.chapterSummary.characters,
        events: result.chapterSummary.events,
        stateChanges: result.chapterSummary.stateChanges,
        hookActivity: result.chapterSummary.hookActivity,
        mood: result.chapterSummary.mood,
        chapterType: result.chapterSummary.chapterType,
      },
    });

    return {
      settlement: {
        postSettlement: result.postSettlement,
        runtimeStateDelta,
        updatedState: "",
        updatedHooks: "",
      },
      usage,
    };
  }
  async saveChapter(
    bookDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en" = "zh",
    chapterIndex?: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });

    const paddedNum = String(output.chapterNumber).padStart(4, "0");
    const filename = `${paddedNum}_${this.sanitizeFilename(output.title)}.md`;
    let existingChapterFiles: string[] = [];
    try {
      existingChapterFiles = await readdir(chaptersDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const supersededChapterFiles = existingChapterFiles
      .filter((file) => file.startsWith(`${paddedNum}_`) && file.endsWith(".md") && file !== filename);

    const heading = language === "en"
      ? `# Chapter ${output.chapterNumber}: ${output.title}`
      : `# 第${output.chapterNumber}章 ${output.title}`;
    const chapterContent = [
      heading,
      "",
      output.content,
    ].join("\n");
    const runtimeStateArtifacts = await this.resolveRuntimeStateArtifactsForOutput(
      bookDir,
      output,
      language,
    );
    const chapterSummariesMarkdown = runtimeStateArtifacts.chapterSummariesMarkdown;

    const writes: AtomicFileWrite[] = [
      { relativePath: join("chapters", filename), content: chapterContent },
      {
        relativePath: join("story", "current_state.md"),
        content: runtimeStateArtifacts.currentStateMarkdown,
      },
      {
        relativePath: join("story", "pending_hooks.md"),
        content: runtimeStateArtifacts.hooksMarkdown,
      },
    ];

    writes.push({
      relativePath: join("story", "chapter_summaries.md"),
      content: chapterSummariesMarkdown,
    });

    const runtimeStateSnapshot = runtimeStateArtifacts.snapshot;
    writes.push(
        {
          relativePath: join("story", "state", "manifest.json"),
          content: JSON.stringify(runtimeStateSnapshot.manifest, null, 2),
        },
        {
          relativePath: join("story", "state", "current_state.json"),
          content: JSON.stringify(runtimeStateSnapshot.currentState, null, 2),
        },
        {
          relativePath: join("story", "state", "hooks.json"),
          content: JSON.stringify(runtimeStateSnapshot.hooks, null, 2),
        },
        {
          relativePath: join("story", "state", "chapter_summaries.json"),
          content: JSON.stringify(runtimeStateSnapshot.chapterSummaries, null, 2),
        },
    );

    const snapshotRoot = join("story", "snapshots", String(output.chapterNumber));
    writes.push(
      { relativePath: join(snapshotRoot, "current_state.md"), content: runtimeStateArtifacts.currentStateMarkdown },
      { relativePath: join(snapshotRoot, "pending_hooks.md"), content: runtimeStateArtifacts.hooksMarkdown },
      { relativePath: join(snapshotRoot, "chapter_summaries.md"), content: chapterSummariesMarkdown },
      { relativePath: join(snapshotRoot, "state", "manifest.json"), content: JSON.stringify(runtimeStateSnapshot.manifest, null, 2) },
      { relativePath: join(snapshotRoot, "state", "current_state.json"), content: JSON.stringify(runtimeStateSnapshot.currentState, null, 2) },
      { relativePath: join(snapshotRoot, "state", "hooks.json"), content: JSON.stringify(runtimeStateSnapshot.hooks, null, 2) },
      { relativePath: join(snapshotRoot, "state", "chapter_summaries.json"), content: JSON.stringify(runtimeStateSnapshot.chapterSummaries, null, 2) },
    );
    if (chapterIndex) {
      writes.push({
        relativePath: join("chapters", "index.json"),
        content: `${JSON.stringify(chapterIndex, null, 2)}\n`,
      });
    }

    await commitAtomicFileSet({
      rootDir: bookDir,
      writes,
      deletes: supersededChapterFiles.map((file) => join("chapters", file)),
    });
  }

  private buildGovernedUserPrompt(params: {
    readonly chapterNumber: number;
    readonly chapterMemo: ChapterMemo;
    readonly chapterIntentData?: ChapterIntent;
    readonly contextPackage: ContextPackage;
    readonly externalContext?: string;
    readonly lengthSpec: LengthSpec;
    readonly language?: "zh" | "en";
    readonly selectedEvidenceBlock?: string;
  }): string {
    const language = params.language ?? "zh";
    // The user's steering docs (author_intent = long-term direction, current_focus =
    // short-term focus) must land as a prominent, binding block near the top — not
    // buried among generic "evidence" entries where the model treats them as optional.
    const DIRECTION_SOURCES = new Set(["story/author_intent.md", "story/current_focus.md"]);
    const directionEntries = params.contextPackage.selectedContext.filter((entry) =>
      DIRECTION_SOURCES.has(entry.source),
    );
    const otherEntries = params.contextPackage.selectedContext.filter((entry) =>
      !DIRECTION_SOURCES.has(entry.source),
    );
    const contextSections = renderNarrativeSelectedContext(otherEntries, language);
    const userDirectionBlock = directionEntries.length > 0
      ? (language === "en"
          ? `## User direction (overrides model defaults — must follow)\n${renderNarrativeSelectedContext(directionEntries, language)}\n`
          : `## 用户方向（优先于模型默认，必须遵循）\n${renderNarrativeSelectedContext(directionEntries, language)}\n`)
      : "";

    const lengthRequirementBlock = this.buildLengthRequirementBlock(params.lengthSpec, params.language ?? "zh");
    const selectedEvidenceBlock = params.selectedEvidenceBlock
      ? `\n${params.selectedEvidenceBlock}\n`
      : "";
    const chapterContextBlock = this.buildChapterContextBlock(params.externalContext, language);
    const briefNarrative = renderMemoAsNarrativeBlock(params.chapterMemo, params.chapterIntentData, language);

    if (params.language === "en") {
      return `Write chapter ${params.chapterNumber}.

${chapterContextBlock}

${userDirectionBlock}
${briefNarrative}

## Selected Context
${contextSections || "(none)"}
${selectedEvidenceBlock}

${lengthRequirementBlock}
- Submit the complete title and prose through the chapter-draft result tool.`;
    }

    return `请续写第${params.chapterNumber}章。

${chapterContextBlock}

${userDirectionBlock}
${briefNarrative}

## 已选上下文
${contextSections || "(无)"}
${selectedEvidenceBlock}

${lengthRequirementBlock}
- 通过章节初稿结果工具提交完整标题和正文。`;
  }

  private buildChapterContextBlock(externalContext: string | undefined, language: "zh" | "en"): string {
    const trimmed = externalContext?.trim();
    if (!trimmed) return "";
    if (language === "en") {
      return `## Per-chapter user instruction (highest priority)
${trimmed}

Obey this direct instruction for the current chapter. If it specifies a chapter title, submit that title exactly. Keep continuity, but do not replace this instruction with the outline fallback.`;
    }
    return `## 本章用户指令（最高优先级）
${trimmed}

这是用户对当前章节的直接指令。若其中指定章节标题，结果工具中的标题必须原样使用。保持连续性，但不要用卷纲兜底替换这条指令。`;
  }

  private joinGovernedEvidenceBlocks(blocks: ReturnType<typeof buildGovernedMemoryEvidenceBlocks> | undefined): string | undefined {
    if (!blocks) {
      return undefined;
    }

    const joined = [
      blocks.titleHistoryBlock,
      blocks.moodTrailBlock,
      blocks.canonBlock,
      blocks.referencedHooksBlock,
      blocks.hooksBlock,
      blocks.summariesBlock,
      blocks.volumeSummariesBlock,
    ]
      .filter((block): block is string => Boolean(block))
      .join("\n");

    return joined || undefined;
  }

  private buildSettlerGovernedControlBlock(
    chapterIntent: string,
    contextPackage: ContextPackage,
    language: "zh" | "en",
  ): string {
    const selectedContext = renderNarrativeSelectedContext(contextPackage.selectedContext, language)
      .replace(/^### /gm, "- ");

    if (language === "en") {
      return `\n## Chapter Control Inputs
${chapterIntent}

### Selected Context
${selectedContext || "- none"}\n`;
    }

    return `\n## 本章控制输入
${chapterIntent}

### 已选上下文
${selectedContext || "- none"}\n`;
  }

  private buildLengthRequirementBlock(lengthSpec: LengthSpec, language: "zh" | "en"): string {
    if (language === "en") {
      return `Requirements:
- User target length: ${lengthSpec.target} words
- Keep the scene complete; do not pad or cut mechanically`;
    }

    return `要求：
- 用户目标字数：${lengthSpec.target}字
- 保持场景完整，不要机械注水或裁切`;
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private normalizeRuntimeStateDeltaChapter(
    delta: RuntimeStateDelta,
    authoritativeChapterNumber: number,
  ): RuntimeStateDelta {
    const hookOps = delta.hookOps ?? {
      upsert: [],
      mention: [],
      resolve: [],
      defer: [],
    };
    let changed = delta.chapter !== authoritativeChapterNumber;
    const normalizedUpserts = hookOps.upsert.map((hook) => {
      const startChapter = Math.min(hook.startChapter, authoritativeChapterNumber);
      const lastAdvancedChapter = Math.min(hook.lastAdvancedChapter, authoritativeChapterNumber);
      if (startChapter !== hook.startChapter || lastAdvancedChapter !== hook.lastAdvancedChapter) {
        changed = true;
      }
      if (startChapter === hook.startChapter && lastAdvancedChapter === hook.lastAdvancedChapter) {
        return hook;
      }
      return {
        ...hook,
        startChapter,
        lastAdvancedChapter,
      };
    });

    if (delta.chapterSummary?.chapter !== undefined && delta.chapterSummary.chapter !== authoritativeChapterNumber) {
      changed = true;
    }
    if (!changed) {
      return delta;
    }

    return {
      ...delta,
      chapter: authoritativeChapterNumber,
      hookOps: {
        ...hookOps,
        upsert: normalizedUpserts,
      },
      chapterSummary: delta.chapterSummary
        ? {
            ...delta.chapterSummary,
            chapter: authoritativeChapterNumber,
          }
        : undefined,
    };
  }

  private async buildRuntimeStateArtifactsIfPresent(
    bookDir: string,
    delta: RuntimeStateDelta,
    language: "zh" | "en",
    authoritativeChapterNumber?: number,
    allowReapply?: boolean,
    baselineChapter?: number,
    allowNewHooks?: boolean,
  ): Promise<RuntimeStateArtifacts> {
    const safeDelta = authoritativeChapterNumber === undefined
      ? delta
      : this.normalizeRuntimeStateDeltaChapter(delta, authoritativeChapterNumber);
    if (baselineChapter === undefined) {
      return buildRuntimeStateArtifacts({
        bookDir,
        delta: safeDelta,
        language,
        allowReapply,
        allowNewHooks,
      });
    }
    const snapshot = await loadRuntimeStateSnapshotAtChapter({
      bookDir,
      chapterNumber: baselineChapter,
      language,
    });
    return buildRuntimeStateArtifactsFromSnapshot({
      snapshot,
      delta: safeDelta,
      language,
      allowReapply,
      allowNewHooks,
    });
  }

  private async resolveRuntimeStateArtifactsForOutput(
    bookDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en",
  ): Promise<RuntimeStateArtifacts> {
    const safeDelta = this.normalizeRuntimeStateDeltaChapter(
      output.runtimeStateDelta,
      output.chapterNumber,
    );
    if (
      safeDelta === output.runtimeStateDelta
      && output.runtimeStateSnapshot
      && output.updatedChapterSummaries
      && output.updatedState
      && output.updatedHooks
    ) {
      return {
        snapshot: output.runtimeStateSnapshot,
        resolvedDelta: safeDelta,
        currentStateMarkdown: output.updatedState,
        hooksMarkdown: output.updatedHooks,
        chapterSummariesMarkdown: output.updatedChapterSummaries,
      };
    }

    return buildRuntimeStateArtifacts({
      bookDir,
      delta: safeDelta,
      language,
    });
  }

  private sanitizeFilename(title: string): string {
    return title
      .replace(/[/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 50);
  }
}
