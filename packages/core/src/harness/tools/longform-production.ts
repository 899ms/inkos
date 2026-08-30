import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { PipelineRunner } from "../../pipeline/runner.js";
import type { ActionPayload } from "../../interaction/action-envelope.js";
import type { ReviseMode } from "../../agents/reviser.js";
import type { ActivatedSkillGuidance } from "../../agent/skill-tool.js";
import { defaultChapterLength } from "../../utils/length-metrics.js";
import { assertSafeBookId, deriveBookIdFromTitle } from "../../utils/book-id.js";
import { mergeActivatedSkillGuidance } from "../../skills/activations.js";
import { runAsWorkflowTrajectory } from "../../llm/agent-trajectory.js";

interface LongformToolOptions {
  readonly actionPayload?: ActionPayload;
  readonly language?: "zh" | "en";
  readonly activeSkills?: () => ReadonlyArray<ActivatedSkillGuidance>;
  readonly workerSkills?: (worker: string) => ReadonlyArray<ActivatedSkillGuidance>;
}

const BookCreateParams = Type.Object({
  instruction: Type.String(),
  title: Type.Optional(Type.String()),
  bookId: Type.Optional(Type.String()),
  genre: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String({ minLength: 1 })),
  language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
  targetChapters: Type.Optional(Type.Integer({ minimum: 1 })),
  chapterWordCount: Type.Optional(Type.Integer({ minimum: 1 })),
});

const FoundationRevisionParams = Type.Object({
  instruction: Type.String(),
  bookId: Type.Optional(Type.String()),
});

const WriteChaptersParams = Type.Object({
  instruction: Type.String(),
  bookId: Type.Optional(Type.String()),
  chapterCount: Type.Optional(Type.Integer({ minimum: 1 })),
  chapterWordCount: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ReviewChapterParams = Type.Object({
  bookId: Type.Optional(Type.String()),
  chapterNumber: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ReviseChapterParams = Type.Object({
  instruction: Type.String(),
  bookId: Type.Optional(Type.String()),
  chapterNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  mode: Type.Optional(Type.Union([
    Type.Literal("spot-fix"), Type.Literal("polish"), Type.Literal("rewrite"),
    Type.Literal("rework"), Type.Literal("anti-detect"),
  ])),
});

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function resolveBookId(tool: string, requested: string | undefined, activeBookId: string | null): string {
  const id = assertSafeBookId(requested ?? activeBookId ?? "", `${tool}.bookId`);
  if (!id) throw new Error(`${tool} requires an active Work or bookId.`);
  if (requested && activeBookId && id !== activeBookId) {
    throw new Error(`${tool}.bookId must match the active Work.`);
  }
  return id;
}

function activatedSkills(options: LongformToolOptions, worker: string): ActivatedSkillGuidance[] {
  return mergeActivatedSkillGuidance(
    options.workerSkills?.(worker) ?? [],
    options.activeSkills?.() ?? [],
  );
}

function runPipeline<T>(
  pipeline: PipelineRunner,
  signal: AbortSignal | undefined,
  options: LongformToolOptions,
  task: () => Promise<T>,
): Promise<T> {
  return runAsWorkflowTrajectory(() => pipeline.runWithAgentContext({
    signal,
    workerSkills: (agent) => activatedSkills(options, agent),
  }, task));
}

function progress(onUpdate: AgentToolUpdateCallback | undefined, message: string): void {
  onUpdate?.(textResult(message, undefined));
}

export function createBookFoundationTool(
  pipeline: PipelineRunner,
  options: LongformToolOptions = {},
): AgentTool<typeof BookCreateParams> {
  return {
    name: "create_book",
    label: "Create long-form Work",
    description: "Create one long-form Work foundation from the confirmed instruction.",
    parameters: BookCreateParams,
    async execute(_toolCallId, params: Static<typeof BookCreateParams>, signal, onUpdate) {
        const payload = options.actionPayload?.createBook;
        const title = payload?.title?.trim() || params.title?.trim();
        if (!title) throw new Error("create_book requires title.");
        const id = payload?.title
          ? deriveBookIdFromTitle(payload.title) || `book-${Date.now().toString(36)}`
          : params.bookId
            ? assertSafeBookId(params.bookId, "create_book.bookId")
            : deriveBookIdFromTitle(title) || `book-${Date.now().toString(36)}`;
        const language = payload?.language ?? params.language ?? options.language ?? "zh";
        const skills = activatedSkills(options, "architect");
        const now = new Date().toISOString();
        progress(onUpdate, `Creating foundation for "${id}"...`);
        const book = {
          id,
          title,
          genre: payload?.genre ?? params.genre ?? "other",
          platform: payload?.platform ?? params.platform ?? "other",
          language,
          status: "outlining",
          targetChapters: payload?.targetChapters ?? params.targetChapters ?? 200,
          chapterWordCount: payload?.chapterWordCount ?? params.chapterWordCount ?? defaultChapterLength(language),
          createdAt: now,
          updatedAt: now,
        } as const;
        await runPipeline(pipeline, signal, options, () => (
          pipeline.initBook(book, { externalContext: params.instruction })
        ));
        return textResult(`Created long-form Work "${title}" (${id}).`, {
          kind: "book_created",
          workId: id,
          bookId: id,
          title,
          skillIds: skills.map((skill) => skill.skill.id),
        });
    },
  };
}

export function createFoundationRevisionTool(
  pipeline: PipelineRunner,
  activeBookId: string,
  options: LongformToolOptions = {},
): AgentTool<typeof FoundationRevisionParams> {
  return {
    name: "revise_foundation",
    label: "Revise foundation",
    description: "Rebuild the active Work foundation from an explicit revision instruction.",
    parameters: FoundationRevisionParams,
    async execute(_toolCallId, params: Static<typeof FoundationRevisionParams>, signal, onUpdate) {
        const bookId = resolveBookId("revise_foundation", params.bookId, activeBookId);
        const skills = activatedSkills(options, "architect");
        progress(onUpdate, `Revising foundation for "${bookId}"...`);
        await runPipeline(pipeline, signal, options, () => pipeline.reviseFoundation(bookId, params.instruction));
        return textResult(`Revised foundation for "${bookId}".`, {
          kind: "foundation_revised",
          bookId,
          skillIds: skills.map((skill) => skill.skill.id),
        });
    },
  };
}

export function createWriteChaptersTool(
  pipeline: PipelineRunner,
  activeBookId: string,
  options: LongformToolOptions = {},
): AgentTool<typeof WriteChaptersParams> {
  return {
    name: "write_chapters",
    label: "Write chapters",
    description: "Write one or more consecutive chapters for the active Work.",
    parameters: WriteChaptersParams,
    async execute(_toolCallId, params: Static<typeof WriteChaptersParams>, signal, onUpdate) {
        const bookId = resolveBookId("write_chapters", params.bookId, activeBookId);
        const count = params.chapterCount ?? 1;
        const skills = activatedSkills(options, "writer");
        const results = await runPipeline(pipeline, signal, options, () => pipeline.writeChapters(bookId, count, {
          wordCount: params.chapterWordCount,
          externalContext: params.instruction,
          onChapterComplete(result, completed, total) {
            progress(onUpdate, `Completed chapter ${result.chapterNumber} (${completed}/${total}).`);
          },
        }));
        const first = results[0];
        const observations = results.flatMap((result) => result.review.observations);
        return textResult(`Completed ${results.length} chapter(s) for "${bookId}".`, {
          kind: results.length === 1 ? "chapter_written" : "chapters_written",
          bookId,
          requestedCount: count,
          completedCount: results.length,
          observations,
          skillIds: skills.map((skill) => skill.skill.id),
          ...(results.length === 1 && first
            ? {
                chapterNumber: first.chapterNumber,
                title: first.title,
                wordCount: first.wordCount,
                ...(first.contextTrace ? { contextTrace: first.contextTrace } : {}),
              }
            : {}),
          chapters: results.map((result) => ({
            chapterNumber: result.chapterNumber,
            title: result.title,
            wordCount: result.wordCount,
            observations: result.review.observations,
            ...(result.contextTrace ? { contextTrace: result.contextTrace } : {}),
          })),
        });
    },
  };
}

export function createReviewChapterTool(
  pipeline: PipelineRunner,
  activeBookId: string,
  options: LongformToolOptions = {},
): AgentTool<typeof ReviewChapterParams> {
  return {
    name: "review_chapter",
    label: "Review chapter",
    description: "Review one persisted chapter and record evidence-backed observations.",
    parameters: ReviewChapterParams,
    async execute(_toolCallId, params: Static<typeof ReviewChapterParams>, signal) {
        const bookId = resolveBookId("review_chapter", params.bookId, activeBookId);
        const skills = activatedSkills(options, "auditor");
        const review = await runPipeline(pipeline, signal, options, () => pipeline.reviewChapter(bookId, params.chapterNumber));
        return textResult(`Reviewed chapter ${review.chapterNumber}; ${review.observations.length} observation(s).`, {
          kind: "chapter_review",
          workId: bookId,
          bookId,
          chapterNumber: review.chapterNumber,
          summary: review.summary,
          observations: review.observations,
          skillIds: skills.map((skill) => skill.skill.id),
        });
    },
  };
}

export function createReviseChapterTool(
  pipeline: PipelineRunner,
  activeBookId: string,
  options: LongformToolOptions = {},
): AgentTool<typeof ReviseChapterParams> {
  return {
    name: "revise_chapter",
    label: "Revise chapter",
    description: "Revise one persisted chapter from the user's explicit instruction and current observations.",
    parameters: ReviseChapterParams,
    async execute(_toolCallId, params: Static<typeof ReviseChapterParams>, signal) {
        const bookId = resolveBookId("revise_chapter", params.bookId, activeBookId);
        const mode = (params.mode ?? "rewrite") as ReviseMode;
        const skills = activatedSkills(options, "reviser");
        const result = await runPipeline(
          pipeline,
          signal,
          options,
          () => pipeline.reviseDraft(bookId, params.chapterNumber, mode, params.instruction),
        );
        return textResult(
          result.changed ? `Revised chapter ${result.chapterNumber}.` : `Chapter ${result.chapterNumber} was unchanged.`,
          {
            kind: "chapter_revision",
            workId: bookId,
            bookId,
            chapterNumber: result.chapterNumber,
            mode,
            wordCount: result.wordCount,
            changed: result.changed,
            observations: result.observations,
            skillIds: skills.map((skill) => skill.skill.id),
          },
        );
    },
  };
}
