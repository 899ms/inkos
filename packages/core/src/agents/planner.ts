import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { LengthSpec } from "../models/length-governance.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import {
  ChapterIntentSchema,
  ChapterMemoSchema,
  type ChapterIntent,
  type ChapterMemo,
} from "../models/input-governance.js";
import { loadPlanningSeedMaterials } from "../utils/planning-materials.js";
import { ChapterMemoToolSchema } from "./planner-tool.js";
import {
  buildPlannerUserMessage,
  getPlannerMemoSystemPrompt,
} from "./planner-prompts.js";
import {
  readBookRules,
  readCharacterMatrix,
  readEmotionalArcs,
  readSubplotBoard,
} from "./planner-context.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
}

export interface PlanChapterOutput {
  readonly intent: ChapterIntent;
  readonly memo: ChapterMemo;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
}

/**
 * The model submits the semantic plan through a typed Pi tool. The host owns
 * chapter identity and persists a readable projection separately.
 */
export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const seedMaterials = await loadPlanningSeedMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
    });
    const plannerInputs = [
      join(storyDir, "author_intent.md"),
      join(storyDir, "current_focus.md"),
      join(storyDir, "outline", "story_frame.md"),
      join(storyDir, "outline", "volume_map.md"),
      join(storyDir, "chapter_summaries.md"),
      join(storyDir, "book_rules.md"),
      join(storyDir, "current_state.md"),
      join(storyDir, "pending_hooks.md"),
    ];

    const lengthSpec = buildLengthSpec(
      input.book.chapterWordCount,
      input.book.language ?? "zh",
    );
    const memo = await this.planChapterMemo({
      storyDir,
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      authorIntent: seedMaterials.authorIntent,
      currentFocus: seedMaterials.currentFocus,
      chapterSummariesRaw: seedMaterials.chapterSummariesRaw,
      previousEndingExcerpt: seedMaterials.previousEndingExcerpt,
      brief: seedMaterials.brief,
      chapterContext: [
        seedMaterials.storyBible,
        seedMaterials.volumeOutline,
        seedMaterials.currentState,
        input.externalContext,
      ].filter(Boolean).join("\n\n"),
      language: input.book.language ?? "zh",
      lengthSpec,
    });

    const intent = ChapterIntentSchema.parse({
      chapter: input.chapterNumber,
      goal: memo.goal,
    });

    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      memo,
    );
    await writeFile(runtimePath, intentMarkdown, "utf-8");

    return {
      intent,
      memo,
      intentMarkdown,
      plannerInputs,
      runtimePath,
    };
  }

  /** Compile the governed context into a typed semantic chapter memo. */
  async planChapterMemo(input: {
    readonly storyDir: string;
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly authorIntent: string;
    readonly currentFocus: string;
    readonly chapterSummariesRaw: string;
    readonly previousEndingExcerpt?: string;
    readonly brief?: string;
    readonly chapterContext?: string;
    readonly language?: "zh" | "en";
    readonly lengthSpec: LengthSpec;
  }): Promise<ChapterMemo> {
    const [characterMatrix, subplotBoard, emotionalArcs, bookRulesRaw, pendingHooks] = await Promise.all([
      readCharacterMatrix(input.storyDir),
      readSubplotBoard(input.storyDir),
      readEmotionalArcs(input.storyDir),
      readBookRules(input.storyDir),
      this.readFileOrDefault(join(input.storyDir, "pending_hooks.md")),
    ]);

    const language = input.language ?? "zh";
    const noPriorChapter = language === "en"
      ? "(this is the opening chapter — no prior chapter)"
      : "（本章为起始章，无前章）";
    const noBookRules = language === "en"
      ? "(no book_rules entries)"
      : "（暂无 book_rules 条目）";

    const userMessage = buildPlannerUserMessage({
      chapterNumber: input.chapterNumber,
      previousChapterEndingExcerpt: input.previousEndingExcerpt?.trim()
        ? input.previousEndingExcerpt.trim()
        : noPriorChapter,
      recentSummaries: input.chapterSummariesRaw,
      currentArcProse: [subplotBoard, emotionalArcs].filter(Boolean).join("\n\n"),
      characterContext: characterMatrix,
      relevantThreads: [pendingHooks, subplotBoard].filter(Boolean).join("\n\n"),
      bookRulesRelevant: bookRulesRaw.trim().length > 0 ? bookRulesRaw.trim() : noBookRules,
      lengthBudget: {
        target: input.lengthSpec.target,
        softMin: input.lengthSpec.softMin,
        softMax: input.lengthSpec.softMax,
        hardMin: input.lengthSpec.hardMin,
        hardMax: input.lengthSpec.hardMax,
        unit: input.lengthSpec.countingMode === "en_words" ? "words" : "字",
      },
      brief: input.brief ?? "",
      chapterContext: input.chapterContext ?? "",
      authorIntent: input.authorIntent,
      currentFocus: input.currentFocus,
      language,
    });

    const systemPrompt = getPlannerMemoSystemPrompt(language);

    const { result } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        name: "submit_chapter_memo",
        label: "Submit chapter memo",
        description: "Submit the complete semantic chapter plan for host persistence.",
        parameters: ChapterMemoToolSchema,
      },
      { temperature: 0.7 },
    );
    return ChapterMemoSchema.parse({
      chapter: input.chapterNumber,
      goal: result.goal,
      body: result.body,
      threadRefs: result.threadRefs,
    });
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    memo: ChapterMemo,
  ): string {
    const memoBody = memo.body.trim();
    const threadRefsLine = memo.threadRefs.length > 0
      ? memo.threadRefs.map((id) => `- ${id}`).join("\n")
      : "- (none)";

    return [
      "# Chapter Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Chapter Memo",
      "### Thread Refs",
      threadRefsLine,
      "",
      "### Body",
      memoBody,
    ].join("\n");
  }

  // Kept for potential subclasses reading seed files directly.
  protected async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }
}
