import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { PipelineRunner } from "../pipeline/runner.js";
import { defaultChapterLength } from "../utils/length-metrics.js";
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StateManager } from "../state/manager.js";
import { deleteLatestChapter } from "../state/chapter-delete.js";
import { assertSafeBookId, deriveBookIdFromTitle } from "../utils/book-id.js";
import { safeChildPath } from "../utils/path-safety.js";
import { toPosixPath } from "../utils/posix-path.js";
import {
  type Platform,
  type BookConfig,
  type FanficMode,
} from "../models/book.js";
import { generateShortFictionCover, runShortFictionProduction } from "../pipeline/short-fiction-runner.js";
import { runInteractiveFilmCreation, runScriptCreation, runStoryboardCreation } from "../pipeline/script-storyboard-runner.js";
import { runResearchReport } from "../agents/researcher.js";
import { ingestMaterial } from "../materials/ingest.js";
import { retrieveMaterials } from "../materials/retrieve.js";
import {
  bindBookReference,
  listBookReferences,
  unbindBookReference,
} from "../references/book-references.js";
import { loadChaptersFromPath } from "./chapter-import-source.js";
import { splitChapters } from "../utils/chapter-splitter.js";
import type { ScriptTargetFormat } from "../agents/script-storyboard.js";
import { createPlayDB, type PlayGraphDB } from "../play/play-db-factory.js";
import { PlayRunner, type PlayOpeningSeedResult, type PlayReplayResult, type PlayStepResult, type PlayVariantRestoreResult } from "../play/play-runner.js";
import { PlayStore } from "../play/play-store.js";
import type { AgentContext } from "../agents/base.js";
import {
  ActionPayloadSchema,
  type ActionPayload,
} from "../interaction/action-envelope.js";
import { ResearchSearchConfigSchema } from "../models/project.js";
import { searchWeb } from "../utils/web-search.js";
import { runAsWorkflowTrajectory } from "../llm/agent-trajectory.js";
import type { ActivatedSkillGuidance } from "./skill-tool.js";
import {
  activatedSkillIds,
  mergeActivatedSkillGuidance,
} from "../skills/activations.js";
import { listWorkManifests, loadWorkManifest, mergeWorkMetadata } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { StoryNodeToolSchema } from "../interactive-film/tool-schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<undefined>;
function textResult<T>(text: string, details: T): AgentToolResult<T>;
function textResult<T = undefined>(text: string, details?: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details: details as T };
}

/**
 * Resolve a user-supplied relative path against the books root and guard
 * against path-traversal (../ etc.).
 */
function safeBooksPath(booksRoot: string, relativePath: string): string {
  return safeChildPath(booksRoot, relativePath);
}

function resolveToolBookId(
  toolName: string,
  paramsBookId: string | undefined,
  activeBookId: string | null,
): string {
  const resolvedBookId = paramsBookId ?? activeBookId ?? undefined;
  if (!resolvedBookId) {
    throw new Error(`${toolName} requires bookId when there is no active book.`);
  }
  const safeBookId = assertSafeBookId(resolvedBookId, `${toolName}.bookId`);
  if (paramsBookId && activeBookId && safeBookId !== activeBookId) {
    throw new Error(`${toolName}.bookId must match the active book.`);
  }
  return safeBookId;
}

function buildAgentBookConfig(input: {
  readonly title: string;
  readonly genre?: string;
  readonly platform?: Platform;
  readonly language?: "zh" | "en";
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly parentBookId?: string;
  readonly fanficMode?: FanficMode;
}, defaults: { readonly targetChapters?: number; readonly chapterWordCount?: number } = {}): BookConfig {
  const now = new Date().toISOString();
  const id = deriveBookIdFromTitle(input.title);
  if (!id) throw new Error(`Could not derive a valid book id from title: ${JSON.stringify(input.title)}`);
  return {
    id,
    title: input.title.trim(),
    platform: input.platform ?? "other",
    genre: input.genre?.trim() || "other",
    status: "outlining",
    targetChapters: input.targetChapters ?? defaults.targetChapters ?? 200,
    chapterWordCount: input.chapterWordCount
      ?? defaults.chapterWordCount
      ?? defaultChapterLength(input.language === "en" ? "en" : "zh"),
    language: input.language ?? "zh",
    ...(input.parentBookId ? { parentBookId: input.parentBookId } : {}),
    ...(input.fanficMode ? { fanficMode: input.fanficMode } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

async function assertBookCreatable(projectRoot: string, bookId: string): Promise<boolean> {
  try {
    const work = await loadWorkManifest(projectRoot, bookId);
    if (work.status === "draft") return true;
    throw new Error(`Book "${bookId}" already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await stat(new StateManager(projectRoot).bookDir(bookId));
        throw new Error(`Book "${bookId}" already exists without a Work manifest.`);
      } catch (sourceError) {
        if ((sourceError as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw sourceError;
      }
    }
    throw error;
  }
}

async function loadCreationSource(input: {
  readonly projectRoot: string;
  readonly sourceText?: string;
  readonly sourcePath?: string;
  readonly sourceName?: string;
  readonly purpose: "reference";
}): Promise<{ readonly text: string; readonly name: string }> {
  if (input.sourceText?.trim()) {
    return {
      text: input.sourceText.trim(),
      name: input.sourceName?.trim() || "source",
    };
  }
  if (!input.sourcePath?.trim()) {
    throw new Error("A sourceText or sourcePath is required.");
  }
  if (isAbsolute(input.sourcePath)) {
    throw new Error("Creation sourcePath must be project-relative. Upload or ingest the file first.");
  }
  const sourcePath = safeChildPath(input.projectRoot, input.sourcePath);
  const material = await ingestMaterial(input.projectRoot, {
    sourceKind: "file",
    filePath: sourcePath,
    filename: basename(sourcePath),
    title: input.sourceName?.trim() || basename(sourcePath).replace(/\.[^.]+$/u, ""),
    purpose: input.purpose,
  });
  return {
    text: await readFile(join(input.projectRoot, material.markdownPath), "utf-8"),
    name: input.sourceName?.trim() || material.title,
  };
}

function closePlayDB(db: PlayGraphDB): void {
  db.close?.();
}

// runnerFactory 注入的测试替身没有 close 方法，可选调用兜底。
function closePlayRunner(runner: unknown): void {
  (runner as { close?: () => void } | null | undefined)?.close?.();
}

function safePlayId(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  if (raw.length > 80 || !raw || raw === "." || raw === ".." || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    throw new Error(`Invalid play id: ${JSON.stringify(value)}`);
  }
  return raw;
}

const SuggestedActionParam = Type.String({ description: "A short clickable player action." });

type SuggestedActionParamType = Static<typeof SuggestedActionParam>;

function validateSuggestedActions(value: readonly SuggestedActionParamType[] | undefined): string[] {
  if (value === undefined) return [];
  const actions = value.map((action) => action.trim());
  if (actions.some((action) => !action)) throw new Error("Play suggestedActions cannot contain an empty action.");
  if (new Set(actions).size !== actions.length) throw new Error("Play suggestedActions must be unique.");
  return actions;
}

// ---------------------------------------------------------------------------
// 1. Proposed Action Tool (propose_action)
// ---------------------------------------------------------------------------

const ProposeActionParams = Type.Object({
  action: Type.Union([
    Type.Literal("create_book"),
    Type.Literal("short_run"),
    Type.Literal("play_start"),
    Type.Literal("generate_cover"),
    Type.Literal("fanfic_init"),
    Type.Literal("continuation_import"),
    Type.Literal("spinoff_create"),
    Type.Literal("style_imitation"),
    Type.Literal("script_create"),
    Type.Literal("storyboard_create"),
    Type.Literal("interactive_film_create"),
    Type.Literal("translation_create"),
    Type.Literal("draft_structure"),
    Type.Literal("connect_choice"),
    Type.Literal("remove_node"),
  ], {
    description: "The production or assisted Studio workflow the user appears to want, but which needs explicit confirmation from general chat.",
  }),
  instruction: Type.String({ minLength: 1,
    description: "The exact production instruction to run after the user confirms. It must be self-contained: include title, story direction, active target, output directory, cover visual direction, or any referenced context that would otherwise be lost when switching sessions.",
  }),
  title: Type.String({ minLength: 1,
    description: "Short user-facing title for the confirmation card.",
  }),
  summary: Type.String({ minLength: 1,
    description: "One or two sentences explaining what will happen if the user confirms.",
  }),
  createBook: Type.Optional(Type.Object({
    title: Type.String({
      description: "Confirmed long-form book title.",
    }),
    genre: Type.Optional(Type.String({
      description: "Confirmed book genre/category.",
    })),
    platform: Type.Optional(Type.String({ minLength: 1, description: "Confirmed target platform, preserved exactly as Work metadata." })),
    language: Type.Optional(Type.Union([
      Type.Literal("zh"),
      Type.Literal("en"),
    ], { description: "Confirmed writing language." })),
    targetChapters: Type.Optional(Type.Number({
      description: "Confirmed total chapter count.",
    })),
    chapterWordCount: Type.Optional(Type.Number({
      description: "Confirmed per-chapter length in the book's native unit.",
    })),
  }, { description: "Structured execution args for action=create_book. Put platform/length here; do not leave them only in instruction text." })),
  shortRun: Type.Optional(Type.Object({
    title: Type.String({
      description: "Confirmed standalone short title or working title. The host uses it as the stable project identity.",
    }),
    direction: Type.String({
      description: "Confirmed standalone short direction.",
    }),
    reference: Type.Optional(Type.String({
      description: "Optional confirmed reference notes or constraints.",
    })),
    storyId: Type.Optional(Type.String({
      description: "Optional confirmed Work id for the generated short fiction.",
    })),
    language: Type.Optional(Type.Union([
      Type.Literal("zh"),
      Type.Literal("en"),
    ], { description: "Output language of the short fiction. Fill the language the user asked the story to be written in; it may differ from the conversation language (e.g. a Chinese chat asking for an English short => en). When the user does not name one, it defaults to the conversation language." })),
    chapters: Type.Optional(Type.Number({
      minimum: 1,
      description: "Confirmed complete short chapter count. Preserve the user's explicit scale.",
    })),
    charsPerChapter: Type.Optional(Type.Number({
      minimum: 1,
      description: "Confirmed per-chapter length in the story language's native unit. Preserve the user's explicit target; do not put total story length here.",
    })),
    cover: Type.Optional(Type.Boolean({
      description: "Whether to attempt cover generation.",
    })),
  }, { description: "Structured execution args for action=short_run." })),
  playStart: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed interactive world title." }),
    premise: Type.String({ description: "Confirmed playable premise." }),
    worldContract: Type.Optional(Type.String({
      description: "Confirmed durable world contract in natural language: time semantics, role autonomy, object/clue/relationship rules, taboos, or other long-lived rules the user explicitly asked for. Do not invent RPG/level systems.",
    })),
    visualContract: Type.Optional(Type.String({
      description: "Confirmed visual contract for Play illustrations in natural language. Only include user-defined visual semantics; do not invent game frames, colored tiers, UI, or stats.",
    })),
    mode: Type.Optional(Type.Union([
      Type.Literal("open"),
      Type.Literal("guided"),
    ], { description: "Confirmed play mode: open for free actions, guided for suggested choices." })),
    initialScene: Type.String({
      description: "Confirmed opening scene shown to the player after confirmation. It must be pure narrative prose, not a title/setup/rules summary, not a question prompt, and not an action/options list.",
    }),
    suggestedActions: Type.Optional(Type.Array(SuggestedActionParam, {
      description: "Optional action springboards shown as separate UI chips. Do not include these in initialScene.",
    })),
  }, { description: "Structured execution args for action=play_start." })),
  generateCover: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed cover title." }),
    intro: Type.Optional(Type.String({ description: "Confirmed synopsis/hook for the cover." })),
    sellingPoints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Confirmed selling points for the cover." })),
    coverPrompt: Type.Optional(Type.String({ description: "Confirmed visual direction." })),
    outputDir: Type.Optional(Type.String({ description: "Confirmed output directory." })),
  }, { description: "Structured execution args for action=generate_cover." })),
  scriptCreate: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed script project title." }),
    sourceKind: Type.Optional(Type.String({ description: "Source type, e.g. novel excerpt, original idea, outline, existing script." })),
    targetFormat: Type.Optional(Type.String({ description: "Confirmed script output format in the user's own terms." })),
    sourceText: Type.Optional(Type.String({ description: "User-provided source text. For long sources, prefer sourcePath instead of summarizing." })),
    sourcePath: Type.Optional(Type.String({ description: "Optional project-relative source file path." })),
    requirements: Type.Optional(Type.String({ description: "Confirmed script format, production constraints, tone, episode structure, or user preferences." })),
    episodeCount: Type.Optional(Type.Number({ description: "Optional target episode/segment count." })),
    episodeDuration: Type.Optional(Type.String({ description: "Optional per-episode/per-segment duration." })),
    projectId: Type.Optional(Type.String({ description: "Optional stable Script Work ID." })),
  }, { description: "Structured execution args for action=script_create." })),
  storyboardCreate: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed storyboard project title." }),
    sourceKind: Type.Optional(Type.String({ description: "Source type, e.g. script, novel excerpt, idea, scene list." })),
    sourceText: Type.Optional(Type.String({ description: "User-provided source text. For long sources, prefer sourcePath instead of summarizing." })),
    sourcePath: Type.Optional(Type.String({ description: "Optional project-relative source file path." })),
    requirements: Type.Optional(Type.String({ description: "Confirmed shot/storyboard requirements." })),
    visualStyle: Type.Optional(Type.String({ description: "Confirmed visual style, if the user specified one." })),
    aspectRatio: Type.Optional(Type.String({ description: "Confirmed aspect ratio, e.g. 9:16, 16:9, 1:1." })),
    granularity: Type.Optional(Type.String({ description: "Confirmed storyboard granularity." })),
    maxShots: Type.Optional(Type.Number({ description: "Optional max shot count." })),
    projectId: Type.Optional(Type.String({ description: "Optional stable Work ID." })),
  }, { description: "Structured execution args for action=storyboard_create." })),
  interactiveFilmCreate: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed interactive-film project title." }),
    sourceKind: Type.Optional(Type.String({ description: "Source type, e.g. novel excerpt, script, outline, original idea." })),
    sourceText: Type.Optional(Type.String({ description: "User-provided source text. For long sources, prefer sourcePath instead of summarizing." })),
    sourcePath: Type.Optional(Type.String({ description: "Optional project-relative source file path." })),
    requirements: Type.Optional(Type.String({ description: "Confirmed branching, variable/flag, ending, production, visual, or market requirements." })),
    targetAudience: Type.Optional(Type.String({ description: "Confirmed target audience or market." })),
    episodeCount: Type.Optional(Type.Number({ description: "Optional target episode/segment count." })),
    episodeDuration: Type.Optional(Type.String({ description: "Optional per-episode/per-segment duration." })),
    budget: Type.Optional(Type.String({ description: "Optional budget or production constraints." })),
    referenceMode: Type.Optional(Type.String({ description: "Optional reference mode, e.g. 盛世天下-style multi-ending interactive drama." })),
    projectId: Type.Optional(Type.String({ description: "Optional stable Work ID." })),
  }, { description: "Structured execution args for action=interactive_film_create." })),
  translationCreate: Type.Optional(Type.Object({
    filePath: Type.String({ description: "Project-relative EPUB/PDF/TXT/Markdown source file path to translate." }),
    sourceLanguage: Type.String({ description: "Source language as a human-readable name, e.g. Auto detect, Japanese, English, Chinese (Simplified), 繁体中文（台湾）. Do not require ISO abbreviations." }),
    targetLanguage: Type.String({ description: "Target language as a human-readable name, e.g. Chinese (Simplified), English, Japanese, Korean, Brazilian Portuguese. Do not require ISO abbreviations." }),
    title: Type.Optional(Type.String({ description: "Optional translation project title." })),
    segmentMaxChars: Type.Optional(Type.Number({ description: "Optional long-paragraph split threshold." })),
  }, { description: "Structured execution args for action=translation_create." })),
  fanficCreate: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed fanfiction book title." }),
    sourceText: Type.Optional(Type.String({ description: "Provided canon/source text. Prefer sourcePath for uploaded or long files." })),
    sourcePath: Type.Optional(Type.String({ description: "Project-relative uploaded canon/source file path." })),
    sourceName: Type.Optional(Type.String({ description: "Human-readable source work name." })),
    mode: Type.Optional(Type.String({ description: "Confirmed fanfiction boundary in the user's own terms." })),
    genre: Type.Optional(Type.String({ description: "Confirmed genre." })),
    platform: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    targetChapters: Type.Optional(Type.Number({ description: "Confirmed total chapter count." })),
    chapterWordCount: Type.Optional(Type.Number({ description: "Confirmed per-chapter length." })),
  }, { description: "Structured execution args for action=fanfic_init. This creates the book directly after confirmation." })),
  continuationImport: Type.Optional(Type.Object({
    bookId: Type.Optional(Type.String({ description: "Existing target book id. Omit when creating a new continuation book." })),
    title: Type.Optional(Type.String({ description: "New continuation book title when bookId is omitted." })),
    sourcePath: Type.String({ description: "Project-relative uploaded novel file or chapter directory." }),
    splitPattern: Type.Optional(Type.String({ description: "Optional custom chapter-heading regex source." })),
    resumeFrom: Type.Optional(Type.Number({ description: "Existing Work only: resume an interrupted import from this 1-based source chapter. Omit when creating a new continuation Work." })),
    genre: Type.Optional(Type.String({ description: "Genre for a newly created continuation book." })),
    platform: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    targetChapters: Type.Optional(Type.Number({ description: "Target total chapters for a new book." })),
    chapterWordCount: Type.Optional(Type.Number({ description: "Per-chapter length for a new book." })),
  }, { description: "Structured execution args for action=continuation_import. This imports and rebuilds state directly after confirmation." })),
  spinoffCreate: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed side-story title." }),
    parentBookId: Type.String({ description: "Existing InkOS parent book id whose canon is inherited." }),
    direction: Type.Optional(Type.String({ description: "Confirmed standalone side-story direction." })),
    genre: Type.Optional(Type.String({ description: "Optional genre override; defaults to the parent book." })),
    platform: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    targetChapters: Type.Optional(Type.Number({ description: "Optional chapter count; defaults to the parent book." })),
    chapterWordCount: Type.Optional(Type.Number({ description: "Optional chapter length; defaults to the parent book." })),
  }, { description: "Structured execution args for action=spinoff_create. This creates the side-story directly after confirmation." })),
  imitationCreate: Type.Optional(Type.Object({
    title: Type.String({ description: "Confirmed original imitation-project title." }),
    referenceText: Type.Optional(Type.String({ description: "Reference prose. Prefer referencePath for uploaded or long files." })),
    referencePath: Type.Optional(Type.String({ description: "Project-relative uploaded reference-work path." })),
    storyIdea: Type.String({ description: "Confirmed original story idea; do not copy the reference plot." }),
    sourceName: Type.Optional(Type.String({ description: "Human-readable reference work name." })),
    genre: Type.Optional(Type.String({ description: "Confirmed genre." })),
    platform: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    targetChapters: Type.Optional(Type.Number({ description: "Confirmed total chapter count." })),
    chapterWordCount: Type.Optional(Type.Number({ description: "Confirmed per-chapter length." })),
  }, { description: "Structured execution args for action=style_imitation. This creates an original book and style guide directly after confirmation." })),
  draftStructure: Type.Optional(Type.Object({
    projectId: Type.Optional(Type.String({ minLength: 1 })),
    instruction: Type.String({ description: "Confirmed instruction for the branching structure draft." }),
  }, { description: "Structured execution args for action=draft_structure." })),
  connectChoice: Type.Optional(Type.Object({
    projectId: Type.Optional(Type.String({ minLength: 1 })),
    node: StoryNodeToolSchema,
  }, { description: "Structured execution args for action=connect_choice." })),
  removeNode: Type.Optional(Type.Object({
    projectId: Type.Optional(Type.String({ minLength: 1 })),
    nodeId: Type.String({ minLength: 1 }),
  }, { description: "Structured execution args for action=remove_node." })),
});

type ProposeActionParamsType = Static<typeof ProposeActionParams>;
export type ProposedActionName = ProposeActionParamsType["action"];
type ProposeActionToolOptions = {
  readonly sameSession?: boolean;
  readonly proposalAction?: ProposedActionName;
  readonly playMode?: "open" | "guided";
  readonly requestedSkillIds?: () => ReadonlyArray<string>;
  readonly attachmentPaths?: () => ReadonlyArray<string>;
};

const PROPOSAL_PAYLOAD_KEYS: Readonly<Partial<Record<ProposeActionParamsType["action"], keyof ProposeActionParamsType>>> = {
  create_book: "createBook",
  short_run: "shortRun",
  play_start: "playStart",
  generate_cover: "generateCover",
  script_create: "scriptCreate",
  storyboard_create: "storyboardCreate",
  interactive_film_create: "interactiveFilmCreate",
  translation_create: "translationCreate",
  fanfic_init: "fanficCreate",
  continuation_import: "continuationImport",
  spinoff_create: "spinoffCreate",
  style_imitation: "imitationCreate",
  draft_structure: "draftStructure",
  connect_choice: "connectChoice",
  remove_node: "removeNode",
};

function proposalParameters(
  action: ProposeActionParamsType["action"] | undefined,
  playMode?: "open" | "guided",
) {
  const payloadKey = action ? PROPOSAL_PAYLOAD_KEYS[action] : undefined;
  if (!action || !payloadKey) return ProposeActionParams;
  const properties = (ProposeActionParams as any).properties as Record<string, any>;
  let payloadSchema = properties[payloadKey];
  if (action === "play_start" && playMode === "open") {
    const { suggestedActions: _suggestedActions, ...openWorldProperties } = payloadSchema.properties;
    payloadSchema = Type.Object(openWorldProperties, {
      description: "Structured execution args for an open-world play_start. The player responds with free text, so fixed suggested actions are not part of this surface.",
    });
  }
  const requiredPayload = Type.Required(Type.Object({ [payloadKey]: payloadSchema } as any)) as any;
  return Type.Object({
    action: Type.Literal(action),
    instruction: properties.instruction,
    title: properties.title,
    summary: properties.summary,
    [payloadKey]: requiredPayload.properties[payloadKey],
  } as any, { additionalProperties: false });
}

type ProposedSessionKind = "book-create" | "short" | "play" | "script" | "storyboard" | "interactive-film" | "interactive-film-authoring" | "chat";

const PROPOSED_ACTION_SESSION_KIND: Readonly<Record<ProposedActionName, ProposedSessionKind>> = {
  create_book: "book-create",
  short_run: "short",
  play_start: "play",
  generate_cover: "short",
  fanfic_init: "chat",
  continuation_import: "chat",
  spinoff_create: "chat",
  style_imitation: "chat",
  script_create: "script",
  storyboard_create: "storyboard",
  interactive_film_create: "interactive-film",
  translation_create: "chat",
  draft_structure: "interactive-film-authoring",
  connect_choice: "interactive-film-authoring",
  remove_node: "interactive-film-authoring",
};

function proposedActionSessionKind(action: ProposedActionName): ProposedSessionKind {
  return PROPOSED_ACTION_SESSION_KIND[action];
}

function proposedActionPayload(
  params: ProposeActionParamsType,
  language: "zh" | "en",
): ActionPayload | undefined {
  const payloadKey = PROPOSAL_PAYLOAD_KEYS[params.action];
  if (!payloadKey) return undefined;
  const value = params[payloadKey] as Record<string, unknown> | undefined;
  if (!value) return undefined;
  return ActionPayloadSchema.parse({
    [payloadKey]: payloadKey === "shortRun" ? { language, ...value } : value,
  });
}

function validateProposedActionPayload(payload: ActionPayload | undefined): {
  readonly payload?: ActionPayload;
  readonly error?: string;
} {
  if (!payload) return {};
  const parsed = ActionPayloadSchema.safeParse(payload);
  if (parsed.success) return { payload: parsed.data };
  return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

function withSingleAttachmentFallback(
  params: ProposeActionParamsType,
  payload: ActionPayload | undefined,
  attachmentPaths: ReadonlyArray<string>,
): ActionPayload | undefined {
  const paths = [...new Set(attachmentPaths.map((path) => path.trim()).filter(Boolean))];
  if (!payload || paths.length !== 1) return payload;
  const [path] = paths;
  const useHostAttachment = (candidate: string | undefined): boolean => {
    const value = candidate?.trim();
    return !value || (value.startsWith(".inkos/uploads/") && value !== path);
  };

  if (params.action === "translation_create" && payload.translationCreate && useHostAttachment(payload.translationCreate.filePath)) {
    return { ...payload, translationCreate: { ...payload.translationCreate, filePath: path } };
  }
  if (
    params.action === "fanfic_init"
    && payload.fanficCreate
    && !payload.fanficCreate.sourceText?.trim()
    && useHostAttachment(payload.fanficCreate.sourcePath)
  ) {
    return { ...payload, fanficCreate: { ...payload.fanficCreate, sourcePath: path } };
  }
  if (
    params.action === "continuation_import"
    && payload.continuationImport
    && useHostAttachment(payload.continuationImport.sourcePath)
  ) {
    return { ...payload, continuationImport: { ...payload.continuationImport, sourcePath: path } };
  }
  if (
    params.action === "style_imitation"
    && payload.imitationCreate
    && !payload.imitationCreate.referenceText?.trim()
    && useHostAttachment(payload.imitationCreate.referencePath)
  ) {
    return { ...payload, imitationCreate: { ...payload.imitationCreate, referencePath: path } };
  }
  return payload;
}

function requireProposedText(value: string | undefined, label: string): void {
  if (typeof value === "string" && value.trim().length > 0) return;
  throw new Error(`propose_action is missing ${label}; retry with that field in the structured payload, not only in summary or instruction.`);
}

function assertExecutableProposedAction(params: ProposeActionParamsType, payload: ActionPayload | undefined): void {
  if (params.action === "create_book") {
    requireProposedText(payload?.createBook?.title, "createBook.title");
    return;
  }
  if (params.action === "play_start") {
    requireProposedText(payload?.playStart?.title, "playStart.title");
    requireProposedText(payload?.playStart?.premise, "playStart.premise");
    requireProposedText(payload?.playStart?.initialScene, "playStart.initialScene");
    return;
  }
  if (params.action === "short_run") {
    requireProposedText(payload?.shortRun?.title, "shortRun.title");
    requireProposedText(payload?.shortRun?.direction, "shortRun.direction");
    return;
  }
  if (params.action === "generate_cover") {
    requireProposedText(payload?.generateCover?.title, "generateCover.title");
    return;
  }
  if (params.action === "script_create") {
    requireProposedText(payload?.scriptCreate?.title, "scriptCreate.title");
    return;
  }
  if (params.action === "storyboard_create") {
    requireProposedText(payload?.storyboardCreate?.title, "storyboardCreate.title");
    return;
  }
  if (params.action === "interactive_film_create") {
    requireProposedText(payload?.interactiveFilmCreate?.title, "interactiveFilmCreate.title");
    return;
  }
  if (params.action === "translation_create") {
    requireProposedText(payload?.translationCreate?.filePath, "translationCreate.filePath");
    requireProposedText(payload?.translationCreate?.sourceLanguage, "translationCreate.sourceLanguage");
    requireProposedText(payload?.translationCreate?.targetLanguage, "translationCreate.targetLanguage");
    return;
  }
  if (params.action === "fanfic_init") {
    requireProposedText(payload?.fanficCreate?.title, "fanficCreate.title");
    if (!payload?.fanficCreate?.sourceText?.trim() && !payload?.fanficCreate?.sourcePath?.trim()) {
      throw new Error("propose_action is missing fanficCreate.sourceText/sourcePath; ask for or use the attached source before proposing production.");
    }
    return;
  }
  if (params.action === "continuation_import") {
    requireProposedText(payload?.continuationImport?.sourcePath, "continuationImport.sourcePath");
    if (!payload?.continuationImport?.bookId?.trim() && !payload?.continuationImport?.title?.trim()) {
      throw new Error("propose_action requires continuationImport.bookId or continuationImport.title.");
    }
    return;
  }
  if (params.action === "spinoff_create") {
    requireProposedText(payload?.spinoffCreate?.title, "spinoffCreate.title");
    requireProposedText(payload?.spinoffCreate?.parentBookId, "spinoffCreate.parentBookId");
    return;
  }
  if (params.action === "style_imitation") {
    requireProposedText(payload?.imitationCreate?.title, "imitationCreate.title");
    requireProposedText(payload?.imitationCreate?.storyIdea, "imitationCreate.storyIdea");
    if (!payload?.imitationCreate?.referenceText?.trim() && !payload?.imitationCreate?.referencePath?.trim()) {
      throw new Error("propose_action is missing imitationCreate.referenceText/referencePath; ask for or use the attached reference before proposing production.");
    }
    return;
  }
  if (params.action === "draft_structure") {
    if (!payload?.draftStructure) throw new Error("propose_action is missing draftStructure payload.");
    return;
  }
  if (params.action === "connect_choice") {
    if (!payload?.connectChoice?.node) throw new Error("propose_action is missing connectChoice.node.");
    return;
  }
  if (params.action === "remove_node") {
    requireProposedText(payload?.removeNode?.nodeId, "removeNode.nodeId");
  }
}

export function createProposeActionTool(
  language: "zh" | "en" = "zh",
  options: ProposeActionToolOptions = {},
): AgentTool<any, unknown> {
  const parameters = proposalParameters(options.proposalAction, options.playMode);
  return {
    name: "propose_action",
    description:
      "Ask the user to confirm a production action from general chat. " +
      "Use this before creating books, generating shorts/covers, or starting play worlds when the user has not clicked a confirmation.",
    label: "Confirm Action",
    parameters,
    async execute(_toolCallId: string, params: ProposeActionParamsType): Promise<AgentToolResult<unknown>> {
      const targetSessionKind = proposedActionSessionKind(params.action);
      const title = params.title.trim();
      const summary = params.summary.trim();
      const instruction = params.instruction.trim();
      if (!title || !summary || !instruction) {
        throw new Error("propose_action requires non-empty title, summary, and instruction.");
      }
      const proposedPayload = validateProposedActionPayload(withSingleAttachmentFallback(
        params,
        proposedActionPayload(params, language),
        options.attachmentPaths?.() ?? [],
      ));
      if (proposedPayload.error) {
        throw new Error(`Invalid proposed action payload: ${proposedPayload.error}`);
      }
      const actionPayload = proposedPayload.payload;
      assertExecutableProposedAction(params, actionPayload);
      const requestedSkills = normalizeProposedSkillIds(options.requestedSkillIds?.());
      return textResult(
        [
          title,
          summary,
          "",
          `Instruction: ${instruction}`,
        ].join("\n"),
        {
          kind: "proposed_action",
          action: params.action,
          targetSessionKind,
          sameSession: options.sameSession === true,
          title,
          summary,
          instruction,
          ...(requestedSkills.length > 0 ? { requestedSkills } : {}),
          ...(actionPayload ? { actionPayload } : {}),
        },
      );
    },
  };
}

function normalizeProposedSkillIds(values: ReadonlyArray<string> | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const id = value.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared production-tool execution helpers
// ---------------------------------------------------------------------------

function runPipelineWithAgentContext<T>(
  pipeline: PipelineRunner,
  signal: AbortSignal | undefined,
  activatedSkills: ReadonlyArray<ActivatedSkillGuidance>,
  task: () => Promise<T>,
): Promise<T> {
  return runAsWorkflowTrajectory(() => (
    pipeline.runWithAgentContext({ signal, activatedSkills }, task)
  ));
}

function runPipelineWithAbortSignal<T>(
  pipeline: PipelineRunner,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return runPipelineWithAgentContext(pipeline, signal, [], task);
}

interface SkillAwareProductionOptions {
  readonly defaultSkills?: ReadonlyArray<ActivatedSkillGuidance>;
  readonly activeSkills?: () => ReadonlyArray<ActivatedSkillGuidance>;
}

function resolveProductionToolSkills(options: SkillAwareProductionOptions): ActivatedSkillGuidance[] {
  return mergeActivatedSkillGuidance(
    options.defaultSkills ?? [],
    options.activeSkills?.() ?? [],
  );
}

// ---------------------------------------------------------------------------
// 2. Research Tool (research_web)
// ---------------------------------------------------------------------------

const ResearchWebParams = Type.Object({
  topic: Type.String({
    description: "Research question or topic, e.g. 1990s county cold-storage accounting workflow or Tang dynasty courier stations.",
  }),
  purpose: Type.String({
    description: "Why this research is needed, in the user's own terms. Research reports are references only and must not directly mutate story state.",
  }),
  depth: Type.Optional(Type.Union([
    Type.Literal("quick"),
    Type.Literal("standard"),
    Type.Literal("deep"),
  ], {
    description: "Research depth. Default standard.",
  })),
});

type ResearchWebParamsType = Static<typeof ResearchWebParams>;

export function createResearchWebTool(projectRoot: string): AgentTool<typeof ResearchWebParams> {
  return {
    name: "research_web",
    description:
      "Collect traceable web research for worldbuilding, era, profession, market, or fact-check questions. " +
      "Saves a Markdown report under .inkos/research/. It is reference material only; it must not modify books, chapters, or truth files.",
    label: "Research Web",
    parameters: ResearchWebParams,
    async execute(
      _toolCallId: string,
      params: ResearchWebParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.(textResult(`Researching: ${params.topic}`));
      const searchConfig = await readResearchSearchConfig(projectRoot);
      const searchOptions = searchConfig.enabled
        ? {
            apiKey: searchConfig.apiKey,
            apiKeyEnv: searchConfig.apiKeyEnv,
            baseUrl: searchConfig.baseUrl,
          }
        : {};
      const report = await runResearchReport({
        topic: params.topic,
        purpose: params.purpose,
        depth: params.depth ?? "standard",
      }, {
        search: (query, maxResults) => searchWeb(query, maxResults, searchOptions),
      });
      const reportDir = join(projectRoot, ".inkos", "research");
      await mkdir(reportDir, { recursive: true });
      const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugResearchTopic(params.topic)}.md`;
      const reportPath = join(reportDir, fileName);
      await writeFile(reportPath, report.markdown, "utf-8");
      return textResult(
        [
          `Research report saved: ${reportPath}`,
          `Sources collected: ${report.sources.length}.`,
          report.partialFailures.length > 0 ? `Partial failures: ${report.partialFailures.length}.` : "Partial failures: none.",
        ].join("\n"),
        {
          kind: "research_report",
          reportPath,
          topic: params.topic,
          purpose: params.purpose,
          depth: params.depth ?? "standard",
          sources: report.sources,
          partialFailures: report.partialFailures,
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Material Ingestion Tool (ingest_material)
// ---------------------------------------------------------------------------

const IngestMaterialParams = Type.Object({
  sourceKind: Type.Union([
    Type.Literal("url"),
    Type.Literal("file"),
  ], {
    description: "Use url for an external URL; use file for a user-uploaded file path shown in the Uploaded Files block.",
  }),
  url: Type.Optional(Type.String({
    description: "HTTP/HTTPS URL to fetch and extract. Supports HTML/text/JSON/PDF.",
  })),
  filePath: Type.Optional(Type.String({
    description: "Project-relative stored_path from the Uploaded Files block, e.g. .inkos/uploads/session/file.pdf.",
  })),
  filename: Type.Optional(Type.String({
    description: "Original filename when known.",
  })),
  mimeType: Type.Optional(Type.String({
    description: "MIME type when known, e.g. application/pdf or text/markdown.",
  })),
  title: Type.Optional(Type.String({
    description: "Human-readable material title.",
  })),
  purpose: Type.Optional(Type.String({
    description: "Why this material is being ingested. It remains reference material unless the user explicitly promotes it.",
  })),
});

type IngestMaterialParamsType = Static<typeof IngestMaterialParams>;

export function createIngestMaterialTool(projectRoot: string): AgentTool<typeof IngestMaterialParams> {
  return {
    name: "ingest_material",
    description:
      "Extract and archive a user-provided URL or uploaded file into .inkos/materials as traceable Markdown. " +
      "Supports HTML/text/JSON/Markdown/PDF. This creates reference material only; it must not mutate canon, chapters, scripts, or play state.",
    label: "Ingest Material",
    parameters: IngestMaterialParams,
    async execute(
      _toolCallId: string,
      params: IngestMaterialParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.(textResult(params.sourceKind === "url"
        ? `Extracting URL: ${params.url ?? "(missing)"}`
        : `Extracting file: ${params.filePath ?? params.filename ?? "(missing)"}`));
      const asset = await ingestMaterial(projectRoot, {
        sourceKind: params.sourceKind,
        url: params.url,
        filePath: params.filePath,
        filename: params.filename,
        mimeType: params.mimeType,
        title: params.title,
        purpose: params.purpose ?? "reference",
      });
      return textResult(
        [
          `Material ingested: ${asset.markdownPath}`,
          `Material ID: ${asset.id}`,
          `Kind: ${asset.kind}; chars: ${asset.charCount}; source: ${asset.source}`,
          asset.totalPages !== undefined ? `PDF pages: ${asset.totalPages}` : "",
          `Use retrieve_material for task-relevant passages or read ${asset.markdownPath} for the complete source.`,
        ].filter(Boolean).join("\n"),
        {
          kind: "material_ingested",
          asset,
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Material Retrieval Tool (retrieve_material)
// ---------------------------------------------------------------------------

const RetrieveMaterialParams = Type.Object({
  query: Type.String({
    description: "Natural-language query written by the agent from the user's current task, e.g. 冷库赔偿款 0607 账页 or storyboard shot requirements.",
  }),
  purpose: Type.Optional(Type.String({
    description: "Optional material purpose filter.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum number of material snippets to return. Default 5.",
  })),
});

type RetrieveMaterialParamsType = Static<typeof RetrieveMaterialParams>;

export function createRetrieveMaterialTool(projectRoot: string): AgentTool<typeof RetrieveMaterialParams> {
  return {
    name: "retrieve_material",
    description:
      "Retrieve traceable snippets from previously ingested .inkos/materials reference cards. " +
      "The agent supplies the semantic query; InkOS returns evidence pointers. This must not mutate canon, chapters, scripts, or play state.",
    label: "Retrieve Material",
    parameters: RetrieveMaterialParams,
    async execute(
      _toolCallId: string,
      params: RetrieveMaterialParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.(textResult(`Retrieving materials: ${params.query}`));
      const results = await retrieveMaterials(projectRoot, {
        query: params.query,
        purpose: params.purpose,
        limit: params.limit,
      });
      if (results.length === 0) {
        return textResult(
          "No matching archived materials were found. Ask the user to upload or ingest relevant material if needed.",
          {
            kind: "material_retrieval",
            query: params.query,
            purpose: params.purpose,
            results: [],
          },
        );
      }
      return textResult(
        [
          `Retrieved ${results.length} material snippet${results.length === 1 ? "" : "s"}.`,
          "",
          ...results.flatMap((result, index) => [
            `## ${index + 1}. ${result.title}`,
            `- material_id: ${result.id}`,
            `- source: ${result.source}`,
            `- path: ${result.markdownPath}:${result.charStart}-${result.charEnd}`,
            `- purpose: ${result.purpose}`,
            `- score: ${result.score.toFixed(2)}`,
            "",
            result.excerpt,
            "",
          ]),
        ].join("\n"),
        {
          kind: "material_retrieval",
          query: params.query,
          purpose: params.purpose,
          results,
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Book Reference Binding Tool (manage_book_reference)
// ---------------------------------------------------------------------------

const ManageBookReferenceParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("bind"),
    Type.Literal("unbind"),
  ], {
    description: "list = inspect bindings; bind = attach an ingested material to this book; unbind = remove that attachment without deleting the project asset.",
  }),
  materialId: Type.Optional(Type.String({
    description: "Exact material asset id returned by ingest_material. Required for bind and unbind.",
  })),
  uses: Type.Optional(Type.Array(Type.String(), {
    description: "bind only: user-defined natural-language purposes, e.g. 开篇机制, 人物关系, 调查节奏. Preserve the user's words instead of mapping them to a fixed taxonomy.",
  })),
  note: Type.Optional(Type.String({
    description: "bind only: optional user instruction that limits how this reference may be used.",
  })),
});

type ManageBookReferenceParamsType = Static<typeof ManageBookReferenceParams>;

export function createManageBookReferenceTool(
  projectRoot: string,
  activeBookId: string,
): AgentTool<typeof ManageBookReferenceParams> {
  const bookId = assertSafeBookId(activeBookId, "manage_book_reference.bookId");
  return {
    name: "manage_book_reference",
    description:
      "Bind already-ingested project materials to the active book with user-defined purposes, list current bindings, or unbind them. " +
      "The material remains stored once under .inkos/materials. Binding never copies prose into the book and never changes canon by itself.",
    label: "Manage Book Reference",
    parameters: ManageBookReferenceParams,
    async execute(
      _toolCallId: string,
      params: ManageBookReferenceParamsType,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      signal?.throwIfAborted();
      if (params.action === "list") {
        const listed = await listBookReferences(projectRoot, bookId);
        const references = listed.references.map((reference) => ({
          materialId: reference.materialId,
          title: reference.title,
          uses: reference.uses,
          note: reference.note,
          available: reference.available,
          error: reference.error,
        }));
        return textResult(
          references.length === 0
            ? `No reference materials are bound to book "${bookId}".`
            : [
                `Bound references for "${bookId}":`,
                ...references.map((reference) => [
                  `- ${reference.title ?? reference.materialId} (${reference.materialId})`,
                  `  uses: ${reference.uses.join("; ")}`,
                  reference.note ? `  note: ${reference.note}` : undefined,
                  reference.available ? undefined : `  unavailable: ${reference.error ?? "material missing"}`,
                ].filter(Boolean).join("\n")),
              ].join("\n"),
          { kind: "book_reference_list", bookId, references },
        );
      }

      const materialId = params.materialId?.trim();
      if (!materialId) throw new Error(`manage_book_reference.${params.action} requires materialId.`);
      if (params.action === "unbind") {
        onUpdate?.(textResult(`Unbinding reference ${materialId} from ${bookId}...`));
        const result = await unbindBookReference(projectRoot, bookId, materialId);
        return textResult(
          result.removed
            ? `Reference ${materialId} was unbound from "${bookId}". The project asset was kept.`
            : `Reference ${materialId} was not bound to "${bookId}".`,
          { kind: "book_reference_unbound", bookId, materialId, removed: result.removed },
        );
      }

      const uses = params.uses ?? [];
      onUpdate?.(textResult(`Binding reference ${materialId} to ${bookId}...`));
      const manifest = await bindBookReference(projectRoot, bookId, {
        materialId,
        uses,
        note: params.note,
      });
      const binding = manifest.bindings.find((entry) => entry.materialId === materialId)!;
      return textResult(
        [
          `Reference ${materialId} was bound to "${bookId}".`,
          `Uses: ${binding.uses.join("; ")}`,
          binding.note ? `Note: ${binding.note}` : undefined,
          "Future chapter composition may select relevant sections; the reference does not override author intent or canon.",
        ].filter(Boolean).join("\n"),
        {
          kind: "book_reference_bound",
          bookId,
          materialId,
          uses: binding.uses,
          note: binding.note,
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Chapter Import Tool (import_chapters)
// ---------------------------------------------------------------------------

const ImportChaptersParams = Type.Object({
  bookId: Type.Optional(Type.String({
    description: "Target book ID to import into. In active-book sessions, omit it to use the current active book; if provided, it must match the active book. In general chat there is no active book, so it is required and must be an existing book.",
  })),
  sourcePath: Type.Optional(Type.String({
    description: "Local path of the chapter source: either the stored_path from the Uploaded Files block (project-relative, e.g. .inkos/uploads/<session>/novel.txt) or an absolute path on this machine that the user provided. A directory imports each .md/.txt file as one chapter in filename order; a single file is split into chapters automatically by heading lines.",
  })),
  sourceText: Type.Optional(Type.String({
    description: "Complete source text supplied by a deterministic host surface. Agent callers should prefer sourcePath for uploaded or long material.",
  })),
  sourceName: Type.Optional(Type.String({ description: "Human-readable source name used in progress output." })),
  splitPattern: Type.Optional(Type.String({
    description: "Single-file mode only: custom JavaScript regex source matching chapter heading lines. Omit to use the default pattern, which matches \"第X章/第X回\" and \"Chapter N\" headings.",
  })),
  resumeFrom: Type.Optional(Type.Number({
    description: "Resume an interrupted import from chapter N (1-based). Required when the book already has chapters: replay starts at chapter N and earlier chapters are kept. Omit for a fresh import into an empty book.",
  })),
  importMode: Type.Optional(Type.Union([
    Type.Literal("continuation"),
    Type.Literal("series"),
  ], {
    description: "continuation (default): the book picks up exactly where the imported text left off, no new spacetime. series: shared universe but an independent new story, so a new spacetime is generated.",
  })),
});

type ImportChaptersParamsType = Static<typeof ImportChaptersParams>;

export function createImportChaptersTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  projectRoot: string,
  options: SkillAwareProductionOptions = {},
): AgentTool<typeof ImportChaptersParams> {
  return {
    name: "import_chapters",
    description:
      "Import an existing novel's chapters from a local file or directory into an InkOS book as real chapters (not reference material). " +
      "InkOS reverse-engineers foundation/truth files from the imported text and replays every chapter to rebuild story state, so the book can be continued afterwards. " +
      "Use ingest_material instead when the user only wants to archive reference material without touching book chapters.",
    label: "Import Chapters",
    parameters: ImportChaptersParams,
    async execute(
      _toolCallId: string,
      params: ImportChaptersParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const targetBookId = resolveToolBookId("import_chapters", params.bookId, activeBookId);

      const state = new StateManager(projectRoot);
      const existingChapterCount = (await state.getNextChapterNumber(targetBookId)) - 1;
      if (existingChapterCount > 0 && params.resumeFrom === undefined) {
        throw new Error(
          `Book "${targetBookId}" already has ${existingChapterCount} chapter(s). ` +
          `Pass resumeFrom=<n> to resume/append from chapter n, or ask the user to clear the existing chapters first.`,
        );
      }

      const sourceText = params.sourceText?.trim();
      const sourcePath = params.sourcePath?.trim();
      if (!sourceText && !sourcePath) throw new Error("import_chapters requires sourcePath or sourceText.");
      if (sourceText && sourcePath) throw new Error("import_chapters accepts sourcePath or sourceText, not both.");
      let chapters;
      if (sourceText) {
        onUpdate?.(textResult(`Reading chapters from ${params.sourceName?.trim() || "inline source"}...`));
        chapters = [...splitChapters(sourceText, params.splitPattern)];
      } else {
        const resolvedSourcePath = isAbsolute(sourcePath!)
          ? sourcePath!
          : resolve(projectRoot, sourcePath!);
        onUpdate?.(textResult(`Reading chapters from ${resolvedSourcePath}...`));
        chapters = await loadChaptersFromPath(resolvedSourcePath, params.splitPattern);
      }

      onUpdate?.(textResult(`Found ${chapters.length} chapter(s); importing into "${targetBookId}"...`));
      const activatedSkills = resolveProductionToolSkills(options);
      const result = await runPipelineWithAgentContext(
        pipeline,
        _signal,
        activatedSkills,
        () => pipeline.importChapters({
          bookId: targetBookId,
          chapters,
          resumeFrom: params.resumeFrom,
          importMode: params.importMode,
        }),
      );

      const regeneratedFoundation = (params.resumeFrom ?? 1) === 1;
      return textResult(
        [
          `Imported ${result.importedCount} chapter(s) into book "${result.bookId}".`,
          `Total imported length: ${result.totalWords}. Next chapter to write: ${result.nextChapter}.`,
          regeneratedFoundation
            ? "Foundation and truth files were reverse-engineered from the imported text; chapter files and the chapter index were rebuilt by sequential replay."
            : `Resumed replay from chapter ${params.resumeFrom}; earlier chapters and the existing foundation were kept.`,
          `The book can now be continued with write_chapters in the book session.`,
        ].join("\n"),
        {
          kind: "chapters_imported",
          bookId: result.bookId,
          importedCount: result.importedCount,
          totalWords: result.totalWords,
          nextChapter: result.nextChapter,
          importMode: params.importMode ?? "continuation",
          skillIds: activatedSkillIds(activatedSkills),
        },
      );
    },
  };
}

const ImportCanonParams = Type.Object({
  parentBookId: Type.String({ minLength: 1, description: "Existing parent Work whose canon should be projected into the active Work." }),
});

export function createImportCanonTool(
  pipeline: PipelineRunner,
  activeBookId: string,
): AgentTool<typeof ImportCanonParams> {
  const bookId = assertSafeBookId(activeBookId, "import_canon.bookId");
  return {
    name: "import_canon",
    label: "Import parent canon",
    description: "Project an existing parent Work's canonical foundation, state, hooks, summaries, and style into the active derived Work without changing the parent.",
    parameters: ImportCanonParams,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const parentBookId = assertSafeBookId(params.parentBookId, "import_canon.parentBookId");
      const canon = await runPipelineWithAbortSignal(
        pipeline,
        signal,
        () => pipeline.importCanon(bookId, parentBookId),
      );
      return textResult(`Imported canon from "${parentBookId}" into "${bookId}".`, {
        kind: "parent_canon_imported",
        workId: bookId,
        bookId,
        parentBookId,
        canonLength: canon.length,
      });
    },
  };
}

const RefreshFanficCanonParams = Type.Object({
  sourceText: Type.Optional(Type.String({ description: "Source/canon text supplied directly by the user or deterministic host surface." })),
  sourcePath: Type.Optional(Type.String({ description: "Project-relative uploaded source/canon path." })),
  sourceName: Type.Optional(Type.String({ description: "Human-readable source title." })),
  mode: Type.Optional(Type.String({ description: "Fan-fiction boundary in the user's own terms." })),
});

export function createRefreshFanficCanonTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string,
  options: SkillAwareProductionOptions = {},
): AgentTool<typeof RefreshFanficCanonParams> {
  const bookId = assertSafeBookId(activeBookId, "refresh_fanfic_canon.bookId");
  return {
    name: "refresh_fanfic_canon",
    label: "Refresh fan-fiction canon",
    description: "Recompile the active fan-fiction Work's source-grounded canon from user-provided material while preserving the existing Work and chapters.",
    parameters: RefreshFanficCanonParams,
    async execute(_toolCallId, params, signal) {
      const source = await loadCreationSource({
        projectRoot,
        sourceText: params.sourceText,
        sourcePath: params.sourcePath,
        sourceName: params.sourceName,
        purpose: "reference",
      });
      const book = await new StateManager(projectRoot).loadBookConfig(bookId);
      const mode = params.mode?.trim() || book.fanficMode || "canon";
      const activatedSkills = resolveProductionToolSkills(options);
      await runPipelineWithAgentContext(
        pipeline,
        signal,
        activatedSkills,
        () => pipeline.importFanficCanon(bookId, source.text, source.name, mode),
      );
      return textResult(`Refreshed fan-fiction canon for "${bookId}" from "${source.name}".`, {
        kind: "fanfic_canon_refreshed",
        workId: bookId,
        bookId,
        sourceName: source.name,
        mode,
        skillIds: activatedSkillIds(activatedSkills),
      });
    },
  };
}

const FanficCreateParams = Type.Object({
  title: Type.String({ description: "Fanfiction book title." }),
  sourceText: Type.Optional(Type.String({ description: "Canon/source text. Prefer sourcePath for long material." })),
  sourcePath: Type.Optional(Type.String({ description: "Project-relative uploaded canon/source path." })),
  sourceName: Type.Optional(Type.String({ description: "Human-readable source work name." })),
  mode: Type.Optional(Type.String({ description: "Fanfiction boundary in the user's own terms." })),
  genre: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String({ minLength: 1 })),
  language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
  targetChapters: Type.Optional(Type.Integer({ minimum: 1 })),
  chapterWordCount: Type.Optional(Type.Integer({ minimum: 1 })),
});

type FanficCreateParamsType = Static<typeof FanficCreateParams>;

export function createFanficBookTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: SkillAwareProductionOptions = {},
): AgentTool<typeof FanficCreateParams> {
  return {
    name: "fanfic_create",
    description: "Create an InkOS fanfiction book directly from supplied canon/source material after user confirmation.",
    label: "Create Fanfiction",
    parameters: FanficCreateParams,
    async execute(_toolCallId, params: FanficCreateParamsType, signal, onUpdate) {
      const source = await loadCreationSource({
        projectRoot,
        sourceText: params.sourceText,
        sourcePath: params.sourcePath,
        sourceName: params.sourceName,
        purpose: "reference",
      });
      const mode = params.mode ?? "canon";
      const book = buildAgentBookConfig({
        ...params,
        fanficMode: mode,
      }, { targetChapters: 100 });
      await assertBookCreatable(projectRoot, book.id);
      const activatedSkills = resolveProductionToolSkills(options);
      onUpdate?.(textResult(`Creating fanfiction book "${book.title}" from ${source.name}...`));
      await runPipelineWithAgentContext(pipeline, signal, activatedSkills, () => (
        pipeline.initFanficBook(book, source.text, source.name, mode)
      ));
      await mergeWorkMetadata(projectRoot, book.id, { creationKind: "fanfic" });
      return textResult(
        `Created fanfiction book "${book.title}" (${book.id}) in ${mode} mode.`,
        {
          kind: "book_created",
          creationKind: "fanfic",
          workId: book.id,
          bookId: book.id,
          title: book.title,
          fanficMode: mode,
          sourceName: source.name,
          skillIds: activatedSkillIds(activatedSkills),
        },
      );
    },
  };
}

const SpinoffCreateParams = Type.Object({
  title: Type.String({ description: "Standalone side-story title." }),
  parentBookId: Type.String({ description: "Existing InkOS parent book id." }),
  direction: Type.Optional(Type.String({ description: "Side-story direction that must not advance the parent mainline." })),
  genre: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String({ minLength: 1 })),
  language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
  targetChapters: Type.Optional(Type.Integer({ minimum: 1 })),
  chapterWordCount: Type.Optional(Type.Integer({ minimum: 1 })),
});

type SpinoffCreateParamsType = Static<typeof SpinoffCreateParams>;

export function createSpinoffBookTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: SkillAwareProductionOptions = {},
): AgentTool<typeof SpinoffCreateParams> {
  return {
    name: "spinoff_create",
    description: "Create a standalone side story that inherits canon from an existing InkOS parent book.",
    label: "Create Side Story",
    parameters: SpinoffCreateParams,
    async execute(_toolCallId, params: SpinoffCreateParamsType, signal, onUpdate) {
      const parentBookId = assertSafeBookId(params.parentBookId, "spinoff_create.parentBookId");
      const state = new StateManager(projectRoot);
      const parent = await state.loadBookConfig(parentBookId);
      const book = buildAgentBookConfig({
        ...params,
        parentBookId,
        genre: params.genre ?? parent.genre,
        platform: params.platform ?? parent.platform,
        language: params.language ?? parent.language,
        targetChapters: params.targetChapters ?? parent.targetChapters,
        chapterWordCount: params.chapterWordCount ?? parent.chapterWordCount,
      });
      await assertBookCreatable(projectRoot, book.id);
      const activatedSkills = resolveProductionToolSkills(options);
      onUpdate?.(textResult(`Creating side story "${book.title}" from parent book "${parent.title}"...`));
      await runPipelineWithAgentContext(pipeline, signal, activatedSkills, () => (
        pipeline.initSpinoffBook(book, parentBookId, params.direction)
      ));
      await mergeWorkMetadata(projectRoot, book.id, { creationKind: "spinoff" });
      return textResult(
        `Created side-story book "${book.title}" (${book.id}) from "${parent.title}".`,
        {
          kind: "book_created",
          creationKind: "spinoff",
          workId: book.id,
          bookId: book.id,
          title: book.title,
          parentBookId,
          skillIds: activatedSkillIds(activatedSkills),
        },
      );
    },
  };
}

const ImitationCreateParams = Type.Object({
  title: Type.String({ description: "Original imitation-project title." }),
  referenceText: Type.Optional(Type.String({ description: "Reference prose. Prefer referencePath for long material." })),
  referencePath: Type.Optional(Type.String({ description: "Project-relative uploaded reference-work path." })),
  storyIdea: Type.String({ description: "Original story idea. The reference contributes prose style, not plot or characters." }),
  sourceName: Type.Optional(Type.String({ description: "Human-readable reference work name." })),
  genre: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String({ minLength: 1 })),
  language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
  targetChapters: Type.Optional(Type.Integer({ minimum: 1 })),
  chapterWordCount: Type.Optional(Type.Integer({ minimum: 1 })),
});

type ImitationCreateParamsType = Static<typeof ImitationCreateParams>;

export function createImitationBookTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: SkillAwareProductionOptions = {},
): AgentTool<typeof ImitationCreateParams> {
  return {
    name: "imitation_create",
    description: "Create an original InkOS book and derive its prose style guide from supplied reference writing.",
    label: "Create Style Imitation",
    parameters: ImitationCreateParams,
    async execute(_toolCallId, params: ImitationCreateParamsType, signal, onUpdate) {
      const reference = await loadCreationSource({
        projectRoot,
        sourceText: params.referenceText,
        sourcePath: params.referencePath,
        sourceName: params.sourceName,
        purpose: "reference",
      });
      const book = buildAgentBookConfig(params);
      await assertBookCreatable(projectRoot, book.id);
      const activatedSkills = resolveProductionToolSkills(options);
      onUpdate?.(textResult(`Creating original book "${book.title}" with style reference ${reference.name}...`));
      await runPipelineWithAgentContext(pipeline, signal, activatedSkills, () => (
        pipeline.initImitationBook(book, reference.text, params.storyIdea, reference.name)
      ));
      await mergeWorkMetadata(projectRoot, book.id, { creationKind: "imitation" });
      return textResult(
        `Created imitation book "${book.title}" (${book.id}) with a persisted style guide.`,
        {
          kind: "book_created",
          creationKind: "imitation",
          workId: book.id,
          bookId: book.id,
          title: book.title,
          sourceName: reference.name,
          skillIds: activatedSkillIds(activatedSkills),
        },
      );
    },
  };
}

const ContinuationImportParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Existing target book id. Omit to create a new continuation book." })),
  title: Type.Optional(Type.String({ description: "New book title when bookId is omitted." })),
  sourcePath: Type.String({ description: "Project-relative uploaded novel file or chapter directory." }),
  splitPattern: Type.Optional(Type.String({ description: "Optional custom chapter-heading regex source." })),
  resumeFrom: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Existing Work only: resume an interrupted import from this 1-based source chapter. Omit for a new continuation Work.",
  })),
  genre: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String({ minLength: 1 })),
  language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
  targetChapters: Type.Optional(Type.Integer({ minimum: 1 })),
  chapterWordCount: Type.Optional(Type.Integer({ minimum: 1 })),
});

type ContinuationImportParamsType = Static<typeof ContinuationImportParams>;

export function createContinuationImportTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  projectRoot: string,
  options: SkillAwareProductionOptions = {},
): AgentTool<typeof ContinuationImportParams> {
  return {
    name: "continuation_import",
    description: "Import an uploaded novel into an existing or newly created InkOS book, rebuild story state, and prepare it for continuation.",
    label: "Import for Continuation",
    parameters: ContinuationImportParams,
    async execute(_toolCallId, params: ContinuationImportParamsType, signal, onUpdate) {
      if (isAbsolute(params.sourcePath)) {
        throw new Error("continuation_import.sourcePath must be project-relative. Upload the source first.");
      }
      const sourcePath = safeChildPath(projectRoot, params.sourcePath);
      const state = new StateManager(projectRoot);
      const requestedBookId = params.bookId ?? activeBookId ?? undefined;
      let bookId: string;
      let created = false;
      if (requestedBookId) {
        bookId = resolveToolBookId("continuation_import", requestedBookId, activeBookId);
        await state.loadBookConfig(bookId);
      } else {
        if (!params.title?.trim()) {
          throw new Error("continuation_import requires title when no existing bookId is selected.");
        }
        const book = buildAgentBookConfig({ ...params, title: params.title.trim() });
        const resumingDraft = await assertBookCreatable(projectRoot, book.id);
        await pipeline.prepareDraftBook(book);
        bookId = book.id;
        created = true;
        if (resumingDraft) {
          onUpdate?.(textResult(`Resuming continuation import for draft Work "${bookId}"...`));
        }
      }

      const existingChapterCount = (await state.getNextChapterNumber(bookId)) - 1;
      const draftWork = created ? await loadWorkManifest(projectRoot, bookId) : null;
      if (existingChapterCount > 0 && params.resumeFrom === undefined && draftWork?.status !== "draft") {
        throw new Error(`Book "${bookId}" already has ${existingChapterCount} chapter(s); resumeFrom is required.`);
      }
      const chapters = await loadChaptersFromPath(sourcePath, params.splitPattern);
      const resumeFrom = existingChapterCount > 0 && draftWork?.status === "draft"
        ? params.resumeFrom ?? existingChapterCount + 1
        : created ? undefined : params.resumeFrom;
      const activatedSkills = resolveProductionToolSkills(options);
      onUpdate?.(textResult(`Importing ${chapters.length} chapter(s) into "${bookId}" and rebuilding story state...`));
      let result: Awaited<ReturnType<PipelineRunner["importChapters"]>>;
      try {
        result = await runPipelineWithAgentContext(pipeline, signal, activatedSkills, () => (
          pipeline.importChapters({
            bookId,
            chapters,
            resumeFrom,
            importMode: "continuation",
          })
        ));
        if (result.importedCount < 1) {
          throw new Error(`Continuation import produced no persisted chapters for "${bookId}".`);
        }
      } catch (error) {
        if (created) {
          await syncWorkSourceArtifacts({ projectRoot, workId: bookId, accept: false });
          throw new Error(
            `Continuation import is incomplete; draft Work "${bookId}" and imported candidate artifacts were preserved. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        throw error;
      }
      await mergeWorkMetadata(projectRoot, bookId, { creationKind: "continuation" });
      return textResult(
        `Imported ${result.importedCount} chapter(s) into "${bookId}". Next chapter: ${result.nextChapter}.`,
        {
          kind: created ? "book_created" : "chapters_imported",
          creationKind: "continuation",
          workId: bookId,
          bookId,
          importedCount: result.importedCount,
          totalWords: result.totalWords,
          nextChapter: result.nextChapter,
          skillIds: activatedSkillIds(activatedSkills),
        },
      );
    },
  };
}

function slugResearchTopic(topic: string): string {
  const slug = topic
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "research";
}

async function readResearchSearchConfig(projectRoot: string) {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, "inkos.json"), "utf-8")) as Record<string, unknown>;
    return ResearchSearchConfigSchema.parse(raw.researchSearch ?? {});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return ResearchSearchConfigSchema.parse({});
  }
}

// ---------------------------------------------------------------------------
// 3. Standalone Short Fiction Tool
// ---------------------------------------------------------------------------

const ShortFictionRunParams = Type.Object({
  title: Type.Optional(Type.String({
    description: "Confirmed title or working title. When present, the host uses it as the stable project identity instead of guessing from generated outline prose.",
  })),
  direction: Type.String({
    description: "Required short fiction direction, e.g. 女频短篇 婚姻背叛 证据反杀. Include genre, protagonist pressure, conflict, and desired payoff when known.",
  }),
  reference: Type.Optional(Type.String({
    description: "Optional user-provided reference notes or constraints. Do not paste copyrighted source text unless the user explicitly provided it.",
  })),
  storyId: Type.Optional(Type.String({
    description: "Optional short-fiction Work id. Leave empty to derive it from the generated title.",
  })),
  chapters: Type.Optional(Type.Number({
    description: "User-requested complete chapter count. Omit when the user leaves it open.",
  })),
  charsPerChapter: Type.Optional(Type.Number({
    description: "User-requested per-chapter length in the story language's native unit: Chinese characters for zh or words for en. Do not use total story length here.",
  })),
  cover: Type.Optional(Type.Boolean({
    description: "Whether to attempt cover image generation after synopsis and cover prompt. Default true; use false if the user only wants text assets.",
  })),
  coverBaseUrl: Type.Optional(Type.String({
    description: "Optional OpenAI-compatible Responses API base URL for cover generation.",
  })),
  coverEndpoint: Type.Optional(Type.String({
    description: "Optional exact Responses endpoint for cover generation. Overrides coverBaseUrl.",
  })),
  coverModel: Type.Optional(Type.String({
    description: "Optional image-capable Responses model. Default gpt-image-2.",
  })),
  coverSize: Type.Optional(Type.String({
    description: "Optional image size, default 1024x1360.",
  })),
  coverApiKeyEnv: Type.Optional(Type.String({
    description: "Optional env var containing the cover API key. Default INKOS_COVER_API_KEY.",
  })),
});

type ShortFictionRunParamsType = Static<typeof ShortFictionRunParams>;

export function createShortFictionRunTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: {
    readonly actionPayload?: ActionPayload;
    readonly language?: "zh" | "en";
  } & SkillAwareProductionOptions = {},
): AgentTool<typeof ShortFictionRunParams> {
  return {
    name: "short_fiction_run",
    description:
      "Create a standalone short fiction project from a direction. " +
      "Runs outline -> complete draft -> review observation -> synopsis/selling points/cover prompt -> optional cover image. " +
      "Uses the user's direction and optional reference notes as input.",
    label: "Short Fiction",
    parameters: ShortFictionRunParams,
    async execute(
      _toolCallId: string,
      params: ShortFictionRunParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const progress = (message: string) => onUpdate?.(textResult(message));
      const shortPayload = options.actionPayload?.shortRun;
      const language = shortPayload?.language ?? options.language;
      const charsPerChapter = shortPayload?.charsPerChapter ?? params.charsPerChapter;
      const activatedSkills = resolveProductionToolSkills(options);
      const result = await runPipelineWithAgentContext(
        pipeline,
        _signal,
        activatedSkills,
        () => runShortFictionProduction({
          projectRoot,
          title: shortPayload?.title ?? params.title,
          direction: shortPayload?.direction ?? params.direction,
          runtimes: {
            planner: pipeline.createAgentContext("short-outline"),
            writer: pipeline.createAgentContext("short-writer"),
            draftReview: pipeline.createAgentContext("short-draft-review"),
            package: pipeline.createAgentContext("short-package"),
          },
          ...((shortPayload?.reference ?? params.reference) ? { reference: { text: shortPayload?.reference ?? params.reference! } } : {}),
          storyId: shortPayload?.storyId ?? params.storyId,
          chapterCount: shortPayload?.chapters ?? params.chapters,
          charsPerChapter,
          language,
          cover: shortPayload?.cover ?? params.cover,
          coverBaseUrl: params.coverBaseUrl,
          coverEndpoint: params.coverEndpoint,
          coverModel: params.coverModel,
          coverSize: params.coverSize,
          coverApiKeyEnv: params.coverApiKeyEnv,
          signal: _signal,
          onProgress: progress,
        }),
      );

      return textResult(
        [
          `Short fiction "${result.storyId}" completed with ${result.observations.length} observation(s).`,
          `Final: ${result.finalMarkdownPath}`,
          `Sales package: ${result.salesPackagePath}`,
          `Cover prompt: ${result.coverPromptPath}`,
          result.coverImagePath
            ? `Cover image: ${result.coverImagePath}`
            : [
                "Cover image: not generated.",
                `Cover image reason: ${result.coverError ?? "not generated"}`,
                "The short fiction draft, synopsis, selling points, and cover prompt were still written successfully.",
              ].join("\n"),
        ].join("\n"),
        {
          kind: "short_fiction_created",
          workId: result.storyId,
          ...result,
          skillIds: activatedSkillIds(activatedSkills),
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Script and Storyboard tools
// ---------------------------------------------------------------------------

const ScriptCreateParams = Type.Object({
  title: Type.String({
    description: "Required script project title.",
  }),
  instruction: Type.String({
    description: "Confirmed script creation instruction, including format, source, and user preferences.",
  }),
  sourceKind: Type.Optional(Type.String({
    description: "Source type, e.g. novel excerpt, original idea, outline, existing script.",
  })),
  targetFormat: Type.Optional(Type.String({ description: "Confirmed script output format in the user's own terms." })),
  sourceText: Type.Optional(Type.String({
    description: "User-provided source text. For long sources, prefer sourcePath instead of summarizing.",
  })),
  sourcePath: Type.Optional(Type.String({
    description: "Optional project-relative source file path.",
  })),
  requirements: Type.Optional(Type.String({
    description: "Confirmed script format, production constraints, tone, episode structure, or user preferences.",
  })),
  episodeCount: Type.Optional(Type.Number({
    description: "Optional target episode/segment count.",
  })),
  episodeDuration: Type.Optional(Type.String({
    description: "Optional per-episode/per-segment duration.",
  })),
  projectId: Type.Optional(Type.String({
    description: "Optional stable Script Work ID.",
  })),
});

type ScriptCreateParamsType = Static<typeof ScriptCreateParams>;

export function createScriptCreationTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: {
    readonly actionPayload?: ActionPayload;
    readonly language?: "zh" | "en";
  } & SkillAwareProductionOptions = {},
): AgentTool<typeof ScriptCreateParams> {
  return {
    name: "script_create",
    description:
      "Create a script project from a novel excerpt, idea, outline, or existing script. " +
      "Writes human-readable Markdown spec and script artifacts into a Script Work.",
    label: "Script Creation",
    parameters: ScriptCreateParams,
    async execute(
      _toolCallId: string,
      params: ScriptCreateParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const progress = (message: string) => onUpdate?.(textResult(message));
      const payload = options.actionPayload?.scriptCreate;
      const activatedSkills = resolveProductionToolSkills(options);
      const result = await runPipelineWithAgentContext(pipeline, _signal, activatedSkills, () => runScriptCreation({
        projectRoot,
        runtime: pipeline.createAgentContext("script-creation"),
        title: payload?.title ?? params.title,
        instruction: params.instruction,
        sourceKind: payload?.sourceKind ?? params.sourceKind,
        targetFormat: (payload?.targetFormat ?? params.targetFormat) as ScriptTargetFormat | undefined,
        sourceText: payload?.sourceText ?? params.sourceText,
        sourcePath: payload?.sourcePath ?? params.sourcePath,
        requirements: payload?.requirements ?? params.requirements,
        episodeCount: payload?.episodeCount ?? params.episodeCount,
        episodeDuration: payload?.episodeDuration ?? params.episodeDuration,
        language: options.language,
        projectId: payload?.projectId ?? params.projectId,
        onProgress: progress,
      }));

      return textResult(
        [
          `Script "${result.projectId}" completed.`,
          `Spec: ${result.specPath}`,
          `Script: ${result.scriptPath}`,
        ].join("\n"),
        { kind: "script_created", workId: result.projectId, ...result, skillIds: activatedSkillIds(activatedSkills) },
      );
    },
  };
}

const StoryboardCreateParams = Type.Object({
  title: Type.String({
    description: "Required storyboard project title.",
  }),
  instruction: Type.String({
    description: "Confirmed storyboard creation instruction, including source, style, aspect ratio, and shot granularity.",
  }),
  sourceKind: Type.Optional(Type.String({
    description: "Source type, e.g. script, novel excerpt, idea, scene list.",
  })),
  sourceText: Type.Optional(Type.String({
    description: "User-provided source text. For long sources, prefer sourcePath instead of summarizing.",
  })),
  sourcePath: Type.Optional(Type.String({
    description: "Optional project-relative source file path.",
  })),
  requirements: Type.Optional(Type.String({
    description: "Confirmed shot/storyboard requirements.",
  })),
  visualStyle: Type.Optional(Type.String({
    description: "Confirmed visual style, if the user specified one.",
  })),
  aspectRatio: Type.Optional(Type.String({
    description: "Confirmed aspect ratio, e.g. 9:16, 16:9, 1:1.",
  })),
  granularity: Type.Optional(Type.String({
    description: "Confirmed storyboard granularity.",
  })),
  maxShots: Type.Optional(Type.Number({
    description: "Optional max shot count.",
  })),
  projectId: Type.Optional(Type.String({
    description: "Optional stable Work ID.",
  })),
});

type StoryboardCreateParamsType = Static<typeof StoryboardCreateParams>;

export function createStoryboardCreationTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: {
    readonly actionPayload?: ActionPayload;
    readonly language?: "zh" | "en";
  } & SkillAwareProductionOptions = {},
): AgentTool<typeof StoryboardCreateParams> {
  return {
    name: "storyboard_create",
    description:
      "Create a storyboard project and image prompts from a script, novel excerpt, idea, or scene list. " +
      "Writes human-readable Markdown spec, storyboard, and image prompt artifacts into a Storyboard Work.",
    label: "Storyboard Creation",
    parameters: StoryboardCreateParams,
    async execute(
      _toolCallId: string,
      params: StoryboardCreateParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const progress = (message: string) => onUpdate?.(textResult(message));
      const payload = options.actionPayload?.storyboardCreate;
      const activatedSkills = resolveProductionToolSkills(options);
      const result = await runPipelineWithAgentContext(pipeline, _signal, activatedSkills, () => runStoryboardCreation({
        projectRoot,
        runtime: pipeline.createAgentContext("storyboard-creation"),
        title: payload?.title ?? params.title,
        instruction: params.instruction,
        sourceKind: payload?.sourceKind ?? params.sourceKind,
        sourceText: payload?.sourceText ?? params.sourceText,
        sourcePath: payload?.sourcePath ?? params.sourcePath,
        requirements: payload?.requirements ?? params.requirements,
        visualStyle: payload?.visualStyle ?? params.visualStyle,
        aspectRatio: payload?.aspectRatio ?? params.aspectRatio,
        granularity: payload?.granularity ?? params.granularity,
        maxShots: payload?.maxShots ?? params.maxShots,
        language: options.language,
        projectId: payload?.projectId ?? params.projectId,
        onProgress: progress,
      }));

      return textResult(
        [
          `Storyboard "${result.projectId}" completed.`,
          `Spec: ${result.specPath}`,
          `Storyboard: ${result.storyboardPath}`,
          `Image prompts: ${result.imagePromptsPath}`,
          `Image assets: ${result.assetsManifestPath}`,
        ].join("\n"),
        { kind: "storyboard_created", workId: result.projectId, ...result, skillIds: activatedSkillIds(activatedSkills) },
      );
    },
  };
}

const InteractiveFilmCreateParams = Type.Object({
  title: Type.String({
    description: "Required interactive-film project title.",
  }),
  instruction: Type.String({
    description: "Confirmed interactive-film creation instruction, including branching, variables/flags, endings, source, and user preferences.",
  }),
  sourceKind: Type.Optional(Type.String({
    description: "Source type, e.g. novel excerpt, script, outline, original idea.",
  })),
  sourceText: Type.Optional(Type.String({
    description: "User-provided source text. For long sources, prefer sourcePath instead of summarizing.",
  })),
  sourcePath: Type.Optional(Type.String({
    description: "Optional project-relative source file path.",
  })),
  requirements: Type.Optional(Type.String({
    description: "Confirmed branching, variable/flag, ending, production, visual, or market requirements.",
  })),
  targetAudience: Type.Optional(Type.String({
    description: "Optional confirmed target audience or market.",
  })),
  episodeCount: Type.Optional(Type.Number({
    description: "Optional target episode/segment count.",
  })),
  episodeDuration: Type.Optional(Type.String({
    description: "Optional per-episode/per-segment duration.",
  })),
  budget: Type.Optional(Type.String({
    description: "Optional budget or production constraints.",
  })),
  referenceMode: Type.Optional(Type.String({
    description: "Optional reference mode, e.g. 盛世天下-style multi-ending interactive drama.",
  })),
  projectId: Type.Optional(Type.String({
    description: "Optional stable Work ID.",
  })),
});

type InteractiveFilmCreateParamsType = Static<typeof InteractiveFilmCreateParams>;

export function createInteractiveFilmCreationTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: {
    readonly actionPayload?: ActionPayload;
    readonly language?: "zh" | "en";
  } & SkillAwareProductionOptions = {},
): AgentTool<typeof InteractiveFilmCreateParams> {
  return {
    name: "interactive_film_create",
    description:
      "Create an interactive film/game script package with story tree, variables/flags, endings, script, storyboard, and image prompts. " +
      "Writes human-readable artifacts into an interactive-film Work.",
    label: "Interactive Film Creation",
    parameters: InteractiveFilmCreateParams,
    async execute(
      _toolCallId: string,
      params: InteractiveFilmCreateParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const progress = (message: string) => onUpdate?.(textResult(message));
      const payload = options.actionPayload?.interactiveFilmCreate;
      const activatedSkills = resolveProductionToolSkills(options);
      const result = await runPipelineWithAgentContext(pipeline, _signal, activatedSkills, () => runInteractiveFilmCreation({
        projectRoot,
        runtime: pipeline.createAgentContext("interactive-film-creation"),
        title: payload?.title ?? params.title,
        instruction: params.instruction,
        sourceKind: payload?.sourceKind ?? params.sourceKind,
        sourceText: payload?.sourceText ?? params.sourceText,
        sourcePath: payload?.sourcePath ?? params.sourcePath,
        requirements: payload?.requirements ?? params.requirements,
        targetAudience: payload?.targetAudience ?? params.targetAudience,
        episodeCount: payload?.episodeCount ?? params.episodeCount,
        episodeDuration: payload?.episodeDuration ?? params.episodeDuration,
        budget: payload?.budget ?? params.budget,
        referenceMode: payload?.referenceMode ?? params.referenceMode,
        language: options.language,
        projectId: payload?.projectId ?? params.projectId,
        onProgress: progress,
      }));

      return textResult(
        [
          `Interactive film "${result.projectId}" completed.`,
          `Spec: ${result.specPath}`,
          `Story graph: ${result.storyGraphPath}`,
          `Story tree: ${result.storyTreePath}`,
          `Flags: ${result.flagsPath}`,
          `Script: ${result.scriptPath}`,
          `Storyboard: ${result.storyboardPath}`,
          `Image prompts: ${result.imagePromptsPath}`,
          `Image assets: ${result.assetsManifestPath}`,
        ].join("\n"),
        { kind: "interactive_film_created", workId: result.projectId, ...result, skillIds: activatedSkillIds(activatedSkills) },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Standalone Cover Tool
// ---------------------------------------------------------------------------

const GenerateCoverParams = Type.Object({
  title: Type.String({
    description: "Required book or short-fiction title. Use the real story title when regenerating an existing cover.",
  }),
  intro: Type.Optional(Type.String({
    description: "Optional synopsis or one-paragraph story hook to guide the cover.",
  })),
  sellingPoints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Optional concrete selling points for the cover.",
  })),
  coverPrompt: Type.Optional(Type.String({
    description: "Optional concrete or revised visual direction. Use this when the user changes the cover prompt through chat. Keep it short and commercial; do not paste the whole story.",
  })),
  outputDir: Type.Optional(Type.String({
    description: "Optional project-relative directory for cover-prompt.md and cover.png. For an existing short or cover prompt revision, use its existing final/cover directory to overwrite that cover.",
  })),
  coverBaseUrl: Type.Optional(Type.String({
    description: "Optional image API base URL. Usually omit and use Studio cover config.",
  })),
  coverEndpoint: Type.Optional(Type.String({
    description: "Optional exact image endpoint. Overrides coverBaseUrl.",
  })),
  coverModel: Type.Optional(Type.String({
    description: "Optional image model. Usually omit and use Studio cover config.",
  })),
  coverSize: Type.Optional(Type.String({
    description: "Optional image size, default 1024x1360.",
  })),
  coverApiKeyEnv: Type.Optional(Type.String({
    description: "Optional env var containing the cover API key. Usually omit and use Studio cover config.",
  })),
});

type GenerateCoverParamsType = Static<typeof GenerateCoverParams>;

export function createGenerateCoverTool(
  projectRoot: string,
  options: { readonly actionPayload?: ActionPayload } = {},
): AgentTool<typeof GenerateCoverParams> {
  return {
    name: "generate_cover",
    description:
      "Generate only a cover image and cover prompt from a title/synopsis/visual direction. " +
      "Use this when the user asks to create/regenerate a cover or revise the cover prompt through chat, without rerunning story generation.",
    label: "Generate Cover",
    parameters: GenerateCoverParams,
    async execute(
      _toolCallId: string,
      params: GenerateCoverParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.(textResult("Generating cover image..."));
      const coverPayload = options.actionPayload?.generateCover;
      const result = await generateShortFictionCover({
        projectRoot,
        title: coverPayload?.title ?? params.title,
        intro: coverPayload?.intro ?? params.intro,
        sellingPoints: coverPayload?.sellingPoints ?? params.sellingPoints,
        coverPrompt: coverPayload?.coverPrompt ?? params.coverPrompt,
        outputDir: coverPayload?.outputDir ?? params.outputDir,
        coverBaseUrl: params.coverBaseUrl,
        coverEndpoint: params.coverEndpoint,
        coverModel: params.coverModel,
        coverSize: params.coverSize,
        coverApiKeyEnv: params.coverApiKeyEnv,
        signal: _signal,
      });
      return textResult(
        [
          `Cover generated for "${result.title}".`,
          `Cover prompt: ${result.coverPromptPath}`,
          `Cover image: ${result.coverImagePath}`,
        ].join("\n"),
        { kind: "cover_generated", ...result },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Interactive Play tools
// ---------------------------------------------------------------------------

const PlayStartParams = Type.Object({
  title: Type.String({
    description: "Interactive world title. Use the user's natural direction as a short playable world title.",
  }),
  premise: Type.Optional(Type.String({
    description: "Playable premise: player role, location, pressure, and core conflict. Keep it concise.",
  })),
  worldContract: Type.Optional(Type.String({
    description: "Durable world contract in natural language. Preserve only user-defined long-lived rules: semantic time, role autonomy, object/clue/relationship systems, taboos, or setting laws. Leave empty when the user did not define rules; do not invent RPG/level systems.",
  })),
  visualContract: Type.Optional(Type.String({
    description: "Visual contract for Play illustrations. Preserve only user-defined visual rules; leave empty when unspecified. Do not invent game frames, colored tiers, UI, or stats.",
  })),
  mode: Type.Optional(Type.Union([
    Type.Literal("open"),
    Type.Literal("guided"),
  ], { description: "open = free actions; guided = emphasize suggested actions. Default open." })),
  initialScene: Type.Optional(Type.String({
    description: "Opening scene shown to the player. Write pure narrative prose for the first playable moment, not a config summary, not a question prompt, and not an action/options list.",
  })),
  suggestedActions: Type.Optional(Type.Array(SuggestedActionParam)),
});

type PlayStartParamsType = Static<typeof PlayStartParams>;

export interface PlayStartToolOptions extends SkillAwareProductionOptions {
  readonly actionPayload?: ActionPayload;
  readonly language?: "zh" | "en";
  readonly runnerFactory?: (input: {
    readonly projectRoot: string;
    readonly worldId: string;
    readonly runId: string;
    readonly ctx: AgentContext;
    readonly db: PlayGraphDB;
  }) => { seedOpening(input: { sceneText: string; suggestedActions?: readonly string[] }): Promise<PlayOpeningSeedResult | null> };
}

export function createPlayStartTool(
  pipeline: PipelineRunner | null,
  projectRoot: string,
  sessionId: string,
  playMode?: "open" | "guided",
  options: PlayStartToolOptions = {},
): AgentTool<typeof PlayStartParams> {
  return {
    name: "play_start",
    description:
      "Start an interactive InkOS Play world directly from chat. " +
      "Use when the user asks to play, roleplay, run an open-world interactive story, or start a Tavern-like scene.",
    label: "Start Play",
    parameters: PlayStartParams,
    async execute(
      _toolCallId: string,
      params: PlayStartParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      _signal?.throwIfAborted();
      onUpdate?.(textResult("Starting interactive world..."));
      if (!pipeline) {
        throw new Error("play_start requires an initialized InkOS pipeline to create authoritative world state.");
      }
      const playPayload = options.actionPayload?.playStart;
      const activatedSkills = resolveProductionToolSkills(options);
      const store = new PlayStore(projectRoot);
      // The play world is bound 1:1 to the chat session: worldId IS the
      // sessionId. This removes any "which world?" ambiguity, so two play
      // sessions never advance each other's world.
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const title = playPayload?.title ?? params.title;
      const premise = playPayload?.premise ?? params.premise;
      const worldContract = playPayload?.worldContract ?? params.worldContract;
      const visualContract = playPayload?.visualContract ?? params.visualContract;
      const initialScene = playPayload?.initialScene?.trim() || params.initialScene;
      const playLanguage = playPayload?.language ?? options.language ?? "zh";
      const existingWorld = await store.loadWorld(worldId);
      const world = existingWorld
        ? await store.updateWorld(worldId, {
            premise: premise?.trim() ?? existingWorld.premise,
            worldContract: worldContract?.trim() ?? existingWorld.worldContract,
            visualContract: visualContract?.trim() ?? existingWorld.visualContract,
            mode: playMode ?? params.mode ?? existingWorld.mode,
          }, { accept: false })
        : await store.createWorld({
            id: worldId,
            title: title.trim(),
            premise: premise?.trim() ?? "",
            worldContract: worldContract?.trim() ?? "",
            visualContract: visualContract?.trim() ?? "",
            mode: playMode ?? params.mode ?? "open",
            language: playLanguage,
          });
      await store.ensureRun(world.id, runId);

      const existingTranscript = await store.readTranscript(world.id, runId);
      const sceneText = (initialScene?.trim() || (world.language === "en"
        ? [`You enter "${world.title}".`, world.premise || "The scene is set. Make your first move."].join("\n")
        : [`你进入「${world.title}」。`, world.premise || "场景已经就位，等待你的第一个动作。"].join("\n"))).trim();
      const suggestedActions = world.mode === "guided"
        ? validateSuggestedActions(playPayload?.suggestedActions ?? params.suggestedActions)
        : [];
      let seed: PlayOpeningSeedResult | null = null;
      let graph;
      try {
        const db = createPlayDB(store.runDir(world.id, runId));
        try {
          seed = await runPipelineWithAgentContext(
            pipeline,
            _signal,
            activatedSkills,
            () => {
              const ctx = pipeline.createAgentContext("play");
              const runner = options.runnerFactory?.({
                projectRoot,
                worldId: world.id,
                runId,
                ctx,
                db,
              }) ?? new PlayRunner({
                projectRoot,
                worldId: world.id,
                runId,
                ctx,
                db,
              });
              return runner.seedOpening({ sceneText, suggestedActions });
            },
          );
          _signal?.throwIfAborted();
          graph = db.snapshot();
        } finally {
          closePlayDB(db);
        }

        if (!graph?.entities?.some((entity) => entity.id === "actor_player")
          || !graph.entities.some((entity) => entity.id !== "actor_player")) {
          throw new Error(world.language === "en"
            ? "Play opening state is incomplete: no usable player/world graph was created."
            : "互动世界开场状态不完整：没有生成可用的玩家与世界图谱。");
        }

        if (existingTranscript.length === 0) {
          await store.writeProjection(world.id, runId, "projections/scene.md", `${sceneText}\n`);
          await store.saveCurrentState(world.id, runId, {
            turn: 0,
            worldId: world.id,
            runId,
            mode: world.mode,
            premise: world.premise,
            worldContract: world.worldContract,
            visualContract: world.visualContract,
          });
          await store.appendTranscriptTurn(world.id, runId, {
            role: "assistant",
            content: sceneText,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        _signal?.throwIfAborted();
        await syncWorkSourceArtifacts({ projectRoot, workId: world.id, accept: false });
        throw error;
      }

      return textResult(
        sceneText,
        {
          kind: "play_world_started",
          presentation: "immersive-scene",
          workId: world.id,
          worldId: world.id,
          runId,
          title: world.title,
          mode: world.mode,
          premise: world.premise,
          worldContract: world.worldContract,
          visualContract: world.visualContract,
          sceneText,
          suggestedActions,
          skillIds: activatedSkillIds(activatedSkills),
          ...(seed ? { seedMutation: seed.mutation } : {}),
          ...(graph ? { graph } : {}),
        },
      );
    },
  };
}

const PlayStepParams = Type.Object({
  input: Type.String({
    description:
      "Copy the player's actual next action or chosen option here. Preserve its meaning and scope; " +
      "do not invent the outcome, scene prose, discoveries, or extra actions for the player.",
  }),
});

type PlayStepParamsType = Static<typeof PlayStepParams>;

export interface PlayStepToolOptions extends SkillAwareProductionOptions {
  readonly language?: "zh" | "en";
  readonly runnerFactory?: (input: {
    readonly projectRoot: string;
    readonly worldId: string;
    readonly runId: string;
    readonly ctx: AgentContext;
  }) => { step(input: string): Promise<PlayStepResult> };
}

const PlayReviseParams = Type.Object({
  action: Type.Union([
    Type.Literal("regenerate_last"),
    Type.Literal("edit_last_input"),
    Type.Literal("restore_variant"),
  ], {
    description: "How to revise the latest play turn: regenerate the same player input, edit the previous player input, or restore a saved variant.",
  }),
  input: Type.Optional(Type.String({
    description: "Replacement player input when action=edit_last_input.",
  })),
  turn: Type.Optional(Type.Number({
    description: "Turn number when restoring a saved variant.",
  })),
  variantId: Type.Optional(Type.String({
    description: "Saved variant id when action=restore_variant.",
  })),
});

type PlayReviseParamsType = Static<typeof PlayReviseParams>;

export interface PlayReviseToolOptions extends SkillAwareProductionOptions {
  readonly language?: "zh" | "en";
  readonly runnerFactory?: (input: {
    readonly projectRoot: string;
    readonly worldId: string;
    readonly runId: string;
    readonly ctx: AgentContext;
  }) => {
    regenerateLastTurn(input?: string): Promise<PlayReplayResult>;
    restoreVariant(input: { readonly turn: number; readonly variantId: string }): Promise<PlayVariantRestoreResult>;
  };
}

const PlayEntityUpdateParam = Type.Object({
  id: Type.Optional(Type.String({
    description: "Existing entity id to update. Use actor_player for the player persona.",
  })),
  label: Type.Optional(Type.String({
    description: "Existing entity label to update when id is unknown.",
  })),
  type: Type.Optional(Type.Union([
    Type.Literal("actor"),
    Type.Literal("location"),
    Type.Literal("item"),
    Type.Literal("evidence"),
    Type.Literal("clue"),
    Type.Literal("claim"),
    Type.Literal("proof_chain"),
    Type.Literal("organization"),
    Type.Literal("rule"),
    Type.Literal("scene"),
    Type.Literal("event"),
  ], { description: "Entity type when creating a missing entity. Usually actor for character/persona edits." })),
  summary: Type.Optional(Type.String({
    description: "Replacement or enriched entity summary, including goals/motives/persona when relevant.",
  })),
  status: Type.Optional(Type.String({
    description: "Natural-language current status. Do not invent numeric meters unless the user asked for them.",
  })),
});

type PlayEntityUpdateParamType = Static<typeof PlayEntityUpdateParam>;

const PlayContractReplacementParam = Type.Object({
  from: Type.String({
    description: "Exact old wording to replace in the existing contract.",
  }),
  to: Type.String({
    description: "New wording that should replace the old wording.",
  }),
});

type PlayContractReplacementParamType = Static<typeof PlayContractReplacementParam>;

const PlayEditParams = Type.Object({
  worldContract: Type.Optional(Type.String({
    description: "Full updated world contract after applying the user's requested rule change. Use when the user edits world rules, time semantics, item semantics, role autonomy, taboos, or costs.",
  })),
  worldContractReplacements: Type.Optional(Type.Array(PlayContractReplacementParam, {
    description: "Exact replacements for existing world-contract wording. Use when the user says to change/replace X into Y; do not append the new rule while leaving the old wording in place.",
  })),
  worldContractAppend: Type.Optional(Type.String({
    description: "A narrow new world-contract addition. Do not use this for replacements such as 'change X to Y'; use worldContractReplacements or full worldContract instead.",
  })),
  visualContract: Type.Optional(Type.String({
    description: "Full updated visual contract after applying the user's requested image/visual-rule change.",
  })),
  visualContractReplacements: Type.Optional(Type.Array(PlayContractReplacementParam, {
    description: "Exact replacements for existing visual-contract wording. Use when the user says to change/replace one visual rule into another.",
  })),
  visualContractAppend: Type.Optional(Type.String({
    description: "A narrow new visual-contract addition. Do not use this for replacements such as 'change X to Y'; use visualContractReplacements or full visualContract instead.",
  })),
  premise: Type.Optional(Type.String({
    description: "Updated world premise only when the user explicitly changes premise/backstory. Do not rewrite premise for ordinary turns.",
  })),
  playerPersona: Type.Optional(Type.String({
    description: "Updated player persona/identity/goals. This updates the reserved actor_player entity.",
  })),
  entityUpdates: Type.Optional(Type.Array(PlayEntityUpdateParam, {
    description: "Character, object, place, or rule-card updates requested by the user. Use for role goals, status, motives, taboos, or known facts.",
  })),
  note: Type.Optional(Type.String({
    description: "Short human-readable note summarizing what changed.",
  })),
});

type PlayEditParamsType = Static<typeof PlayEditParams>;

export function createPlayEditTool(
  projectRoot: string,
  sessionId: string,
  language: "zh" | "en" = "zh",
): AgentTool<typeof PlayEditParams> {
  return {
    name: "play_edit",
    description:
      "Persistently edit the active InkOS Play world card, visual contract, player persona, or entity/role cards without advancing time or narrating a turn. " +
      "Use when the user says to change world rules, visual rules, character goals/persona/status, or long-lived play contracts.",
    label: "Edit Play World",
    parameters: PlayEditParams,
    async execute(
      _toolCallId: string,
      params: PlayEditParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const store = new PlayStore(projectRoot);
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const world = await store.loadWorld(worldId);
      if (!world) {
        throw new Error(language === "en"
          ? "There is no interactive world to edit yet. Start one with play_start first."
          : "还没有可编辑的互动世界。先用 play_start 开一局。");
      }
      const isZh = (world.language ?? "zh") !== "en";

      const patch: Parameters<PlayStore["updateWorld"]>[1] = {};
      const nextWorldContract = mergeContract(
        world.worldContract,
        params.worldContract,
        params.worldContractReplacements,
        params.worldContractAppend,
      );
      const nextVisualContract = mergeContract(
        world.visualContract,
        params.visualContract,
        params.visualContractReplacements,
        params.visualContractAppend,
      );
      if (nextWorldContract !== world.worldContract) patch.worldContract = nextWorldContract;
      if (nextVisualContract !== world.visualContract) patch.visualContract = nextVisualContract;
      const premise = params.premise?.trim();
      if (premise && premise !== world.premise) patch.premise = premise;
      const updatedWorld = Object.keys(patch).length > 0
        ? await store.updateWorld(worldId, patch)
        : world;

      await store.ensureRun(worldId, runId);
      const db = createPlayDB(store.runDir(worldId, runId));
      let updatedEntities = 0;
      try {
        const playerPersona = params.playerPersona?.trim();
        if (playerPersona) {
          const existingPlayer = db.getEntity("actor_player");
          upsertPlayEditEntity(db, {
            id: "actor_player",
            type: "actor",
            label: existingPlayer?.label ?? (isZh ? "玩家" : "Player"),
            summary: playerPersona,
            status: isZh ? "已更新" : "Updated",
          });
          updatedEntities += 1;
        }
        for (const update of params.entityUpdates ?? []) {
          if (upsertPlayEditEntity(db, update)) updatedEntities += 1;
        }
        const graph = db.snapshot();
        const currentState = await store.loadCurrentState(worldId, runId);
        await store.saveCurrentState(worldId, runId, {
          ...(currentState ?? {}),
          worldContract: updatedWorld.worldContract,
          visualContract: updatedWorld.visualContract,
          premise: updatedWorld.premise,
          graphEditedAt: new Date().toISOString(),
        });
        return textResult(
          params.note?.trim() || (isZh ? "互动世界设定已更新。" : "Interactive world settings updated."),
          {
            kind: "play_world_updated",
            workId: worldId,
            worldId,
            runId,
            world: updatedWorld,
            updatedWorldContract: nextWorldContract !== world.worldContract,
            updatedVisualContract: nextVisualContract !== world.visualContract,
            updatedPremise: Boolean(patch.premise),
            updatedEntities,
            graph,
          },
        );
      } finally {
        closePlayDB(db);
      }
    },
  };
}

export function createPlayStepTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  sessionId: string,
  options: PlayStepToolOptions = {},
): AgentTool<typeof PlayStepParams> {
  return {
    name: "play_step",
    description:
      "Advance the current InkOS Play world by one player action. " +
      "Use after play_start when the user keeps acting in the interactive scene. " +
      "Pass through what the player chose; the Play runtime, not this outer agent, resolves the outcome.",
    label: "Play Step",
    parameters: PlayStepParams,
    async execute(
      _toolCallId: string,
      params: PlayStepParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const input = params.input.trim();
      if (!input) throw new Error("Play input is empty.");
      const store = new PlayStore(projectRoot);
      // The play world is bound to this chat session (worldId === sessionId).
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const world = await store.loadWorld(worldId);
      if (!world) {
        throw new Error(options.language === "en"
          ? "There is no interactive world to advance yet. Start one with play_start first."
          : "还没有可推进的互动世界。先用 play_start 开一局。");
      }
      const target = { worldId, runId, world };
      const activatedSkills = resolveProductionToolSkills(options);
      onUpdate?.(textResult(`Advancing "${target.worldId}" / "${target.runId}"...`));
      const db = createPlayDB(store.runDir(target.worldId, target.runId));
      let runner: ({ step(input: string): Promise<PlayStepResult> } & { close?: () => void }) | undefined;
      try {
        const step = await runPipelineWithAgentContext(pipeline, _signal, activatedSkills, () => {
          const ctx = pipeline.createAgentContext("play");
          const activeRunner = options.runnerFactory?.({
            projectRoot,
            worldId: target.worldId,
            runId: target.runId,
            ctx,
          }) ?? new PlayRunner({
            projectRoot,
            worldId: target.worldId,
            runId: target.runId,
            ctx,
            db,
          });
          runner = activeRunner;
          return activeRunner.step(input);
        });
        const graph = db.snapshot();
        const currentState = await store.loadCurrentState(target.worldId, target.runId);

        return textResult(
          step.sceneText,
          {
            kind: "play_turn_advanced",
            presentation: "immersive-scene",
            workId: target.worldId,
            worldId: target.worldId,
            runId: target.runId,
            title: target.world?.title,
            sceneText: step.sceneText,
            suggestedActions: step.suggestedActions,
            action: step.action,
            mutation: step.mutation,
            observations: step.mutation.blocked
              ? [{
                  code: "play-action-blocked",
                  summary: step.mutation.blockedReason || step.mutation.summary,
                  evidence: [],
                }]
              : [],
            currentState,
            graph,
            skillIds: activatedSkillIds(activatedSkills),
          },
        );
      } finally {
        closePlayRunner(runner);
        closePlayDB(db);
      }
    },
  };
}

export function createPlayReviseTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  sessionId: string,
  options: PlayReviseToolOptions = {},
): AgentTool<typeof PlayReviseParams> {
  return {
    name: "play_revise",
    description:
      "Regenerate, edit, or restore the latest InkOS Play turn using saved turn checkpoints. " +
      "Use when the user says to redo the previous turn, try another version, swipe, or replace their last player input.",
    label: "Revise Play Turn",
    parameters: PlayReviseParams,
    async execute(
      _toolCallId: string,
      params: PlayReviseParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const store = new PlayStore(projectRoot);
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const world = await store.loadWorld(worldId);
      if (!world) {
        throw new Error(options.language === "en"
          ? "There is no interactive world to redo yet. Start one with play_start first."
          : "还没有可重做的互动世界。先用 play_start 开一局。");
      }
      const isZh = (world.language ?? "zh") !== "en";
      const activatedSkills = resolveProductionToolSkills(options);
      const db = createPlayDB(store.runDir(worldId, runId));
      let runner: ({
        regenerateLastTurn(input?: string): Promise<PlayReplayResult>;
        restoreVariant(input: { readonly turn: number; readonly variantId: string }): Promise<PlayVariantRestoreResult>;
      } & { close?: () => void }) | undefined;
      const runWithPlayRunner = <T>(
        task: (activeRunner: NonNullable<typeof runner>) => Promise<T>,
      ): Promise<T> => runPipelineWithAgentContext(pipeline, _signal, activatedSkills, () => {
        const ctx = pipeline.createAgentContext("play");
        const activeRunner = options.runnerFactory?.({ projectRoot, worldId, runId, ctx }) ?? new PlayRunner({
          projectRoot,
          worldId,
          runId,
          ctx,
          db,
        });
        runner = activeRunner;
        return task(activeRunner);
      });

      let replay: PlayReplayResult;
      // finally 关闭 runner 自建的 play.db 连接：句柄不关闭时 Windows 上无法删除数据库文件。
      try {
        if (params.action === "restore_variant") {
          const turn = params.turn;
          const variantId = params.variantId?.trim();
          if (typeof turn !== "number" || !Number.isFinite(turn) || !variantId) {
            throw new Error(isZh
              ? "恢复版本需要 turn 和 variantId。"
              : "Restoring a variant requires both turn and variantId.");
          }
          onUpdate?.(textResult(`Restoring play variant "${variantId}"...`));
          const restored = await runWithPlayRunner((activeRunner) => activeRunner.restoreVariant({
            turn: Math.trunc(turn),
            variantId,
          }));
          return textResult(
            restored.sceneText || (isZh ? "已切换到指定互动回合版本。" : "Switched to the requested play turn variant."),
            {
              kind: "play_variant_restored",
              presentation: "immersive-scene",
              workId: worldId,
              worldId,
              runId,
              title: world.title,
              turn: restored.turn,
              variantId: restored.variantId,
              sceneText: restored.sceneText,
              skillIds: activatedSkillIds(activatedSkills),
            },
          );
        }

        const replacement = params.action === "edit_last_input" ? params.input?.trim() : undefined;
        if (params.action === "edit_last_input" && !replacement) {
          throw new Error(isZh
            ? "编辑上一条玩家动作需要提供新的 input。"
            : "Editing the previous player action requires a new input.");
        }
        onUpdate?.(textResult(params.action === "edit_last_input" ? "Replaying edited play turn..." : "Regenerating last play turn..."));
        replay = await runWithPlayRunner((activeRunner) => activeRunner.regenerateLastTurn(replacement));
        const graph = db.snapshot();
        const currentState = await store.loadCurrentState(worldId, runId);

        return textResult(
          replay.sceneText,
          {
            kind: "play_turn_revised",
            presentation: "immersive-scene",
            workId: worldId,
            worldId,
            runId,
            title: world.title,
            sceneText: replay.sceneText,
            suggestedActions: replay.suggestedActions,
            action: replay.action,
            mutation: replay.mutation,
            replayedInput: replay.replayedInput,
            previousVariantId: replay.previousVariantId,
            variantId: replay.variantId,
            currentState,
            graph,
            skillIds: activatedSkillIds(activatedSkills),
          },
        );
      } finally {
        closePlayRunner(runner);
        closePlayDB(db);
      }
    },
  };
}

function mergeContract(
  existing: string,
  replacement: string | undefined,
  replacements: PlayContractReplacementParamType[] | undefined,
  addition: string | undefined,
): string {
  const next = replacement?.trim();
  if (next) return next;
  let current = existing;
  for (const patch of replacements ?? []) {
    const from = patch.from.trim();
    const to = patch.to.trim();
    if (!from || !to) throw new Error("Contract replacements require non-empty from and to text.");
    const first = current.indexOf(from);
    if (first < 0) throw new Error(`Contract replacement target was not found: ${from}`);
    if (current.indexOf(from, first + from.length) >= 0) {
      throw new Error(`Contract replacement target is ambiguous: ${from}`);
    }
    current = `${current.slice(0, first)}${to}${current.slice(first + from.length)}`;
  }
  const add = addition?.trim();
  if (!add) return current;
  if (current.includes(add)) return current;
  return current.trim() ? `${current.trim()}\n- ${add}` : add;
}

function upsertPlayEditEntity(db: PlayGraphDB, update: PlayEntityUpdateParamType): boolean {
  const summary = update.summary?.trim();
  const status = update.status?.trim();
  const label = update.label?.trim();
  const entityId = resolvePlayEditEntityId(db, update);
  if (!entityId && !label) throw new Error("Play entity updates require an exact id or label.");
  const existing = entityId ? db.getEntity(entityId) : null;
  const id = entityId || playEditEntityId(update.type ?? "actor", label!);
  db.upsertEntity({
    id,
    type: update.type ?? existing?.type ?? "actor",
    label: label || existing?.label || id,
    summary: summary ?? existing?.summary ?? "",
    status: status ?? existing?.status ?? "",
    createdEventId: existing?.createdEventId ?? "manual-edit",
    updatedEventId: "manual-edit",
  });
  return true;
}

function resolvePlayEditEntityId(db: PlayGraphDB, update: PlayEntityUpdateParamType): string | undefined {
  const id = update.id?.trim();
  if (id) return id;
  const label = update.label?.trim();
  if (!label) return undefined;
  const snapshot = db.snapshot();
  const match = snapshot.entities.find((entity) => entity.label === label || entity.id === label);
  return match?.id;
}

function playEditEntityId(type: string, label: string): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `${type}_${ascii || Date.now().toString(36)}`;
}

const DeleteLatestChapterParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Optional(Type.Number({
    description: "Latest chapter number expected by the user. The tool rejects middle-chapter deletion.",
  })),
});

export function createDeleteLatestChapterTool(
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof DeleteLatestChapterParams> {
  return {
    name: "delete_latest_chapter",
    description:
      "Safely delete only the latest chapter, preserve its manuscript under chapters/.trash, " +
      "and roll story state back to the previous chapter snapshot. Never deletes a middle chapter.",
    label: "Delete Latest Chapter",
    parameters: DeleteLatestChapterParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const bookId = resolveToolBookId("delete_latest_chapter", params.bookId, activeBookId);
      const state = new StateManager(projectRoot);
      const releaseLock = await state.acquireBookLock(bookId);
      try {
        const result = await deleteLatestChapter(state, bookId, {
          chapterNumber: params.chapterNumber,
        });
        return textResult(
          `Deleted latest chapter ${result.deletedChapter} from "${bookId}", preserved it in trash, and rolled story state back to chapter ${result.rolledBackTo}.`,
          {
            kind: "chapter_deleted",
            ...result,
          },
        );
      } finally {
        await releaseLock();
      }
    },
  };
}

const ResyncChapterStateParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Optional(Type.Number({ description: "Latest chapter number to rebuild from its persisted body. Omit to use the latest chapter." })),
  allowNewHooks: Type.Optional(Type.Boolean({
    description:
      "Whether settlement may create brand-new hook IDs. Set false when the user asks to preserve stable hook IDs, avoid replacement hooks, or only repair existing truth state.",
  })),
});

export function createResyncChapterStateTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  options: SkillAwareProductionOptions & { readonly language?: "zh" | "en" } = {},
): AgentTool<typeof ResyncChapterStateParams> {
  return {
    name: "resync_chapter_state",
    description:
      "Keep the persisted chapter body unchanged, rebuild its derived story state, summaries, and hooks from the previous chapter snapshot, then run a fresh audit. " +
      "Use after an explicit chapter edit or when the user asks to repair/synchronize truth state without rewriting prose. Only the latest chapter is supported.",
    label: "Resync Chapter State",
    parameters: ResyncChapterStateParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const bookId = resolveToolBookId("resync_chapter_state", params.bookId, activeBookId);
      const activatedSkills = resolveProductionToolSkills(options);
      const result = await runPipelineWithAgentContext(
        pipeline,
        signal,
        activatedSkills,
        () => pipeline.resyncChapterStateAndAudit(bookId, params.chapterNumber, {
          allowNewHooks: params.allowNewHooks,
        }),
      );
      const observations = result.audit.observations;
      const zh = options.language !== "en";
      const summary = [
        zh
          ? `第 ${result.chapter.chapterNumber} 章正文未改动；状态、摘要与伏笔已重建，记录 ${observations.length} 条审查观察。`
          : `Chapter ${result.chapter.chapterNumber} prose was unchanged; state, summaries, and hooks were rebuilt with ${observations.length} review observation(s).`,
        ...observations.map((observation) => `- ${observation.code}: ${observation.summary}`),
      ].join("\n");
      return textResult(summary, {
        kind: "chapter_state_resynced",
        workId: bookId,
        bookId,
        chapterNumber: result.chapter.chapterNumber,
        observations,
        summary: result.audit.summary,
        skillIds: activatedSkillIds(activatedSkills),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Read Tool
// ---------------------------------------------------------------------------

const ReadParams = Type.Object({
  path: Type.String({ description: "File path relative to the tool's permitted read root, or an absolute path when system path reading is enabled." }),
});

export interface ReadToolOptions {
  readonly allowSystemPaths?: boolean;
  readonly scope?: "works" | "project";
}

function resolveReadPath(readRoot: string, requestedPath: string, options: ReadToolOptions): string {
  if (options.allowSystemPaths && isAbsolute(requestedPath)) {
    return resolve(requestedPath);
  }
  return safeChildPath(readRoot, requestedPath);
}

export function createReadTool(
  projectRoot: string,
  options: ReadToolOptions = {},
): AgentTool<typeof ReadParams> {
  const readRoot = options.scope === "project" ? projectRoot : join(projectRoot, "works");
  const description = options.allowSystemPaths
    ? "Read a file. Relative paths resolve under works/; absolute paths read from the system filesystem."
    : options.scope === "project"
      ? "Read a UTF-8 file inside the current InkOS project. Path is relative to the project root."
    : "Read a file from the Work store. Path is relative to works/.";

  return {
    name: "read",
    description,
    label: "Read File",
    parameters: ReadParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ReadParams>,
    ): Promise<AgentToolResult<undefined>> {
      const filePath = resolveReadPath(readRoot, params.path, options);
      const content = await readFile(filePath, "utf-8");
      return textResult(content);
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Work Catalog / Grep Tools
// ---------------------------------------------------------------------------

const ListWorksParams = Type.Object({
  profileId: Type.Optional(Type.String({
    description: "Optional Work Profile ID filter, for example longform-novel, short-fiction, or translation.",
  })),
});

export function createListWorksTool(projectRoot: string): AgentTool<typeof ListWorksParams> {
  return {
    name: "list_works",
    description:
      "List usable creative Works from the canonical works/ catalog. " +
      "Use this before deriving from an existing work when the user gives a title but not an exact Work ID; never guess legacy paths such as .inkos/books.",
    label: "List Works",
    parameters: ListWorksParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ListWorksParams>,
    ): Promise<AgentToolResult<undefined>> {
      const works = await listWorkManifests(projectRoot, params.profileId?.trim() || undefined);
      if (works.length === 0) {
        return textResult(params.profileId
          ? `No usable Works found for profile "${params.profileId}".`
          : "No usable Works found.");
      }
      return textResult(works.map((work) => (
        `- title=${JSON.stringify(work.title)} | id=${JSON.stringify(work.id)} | profile=${work.profileId} | status=${work.status}`
      )).join("\n") + "\nUse workspace__inspect_work with an exact id to inspect its canonical artifact paths.");
    },
  };
}

const InspectWorkParams = Type.Object({
  workId: Type.String({ description: "Exact Work ID returned by workspace__list_works." }),
});

export function createInspectWorkTool(projectRoot: string): AgentTool<typeof InspectWorkParams> {
  return {
    name: "inspect_work",
    description:
      "Inspect one Work manifest and return canonical current artifact paths. " +
      "Use these paths with workspace__read; never invent truth.md or another filename.",
    label: "Inspect Work",
    parameters: InspectWorkParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof InspectWorkParams>,
    ): Promise<AgentToolResult<undefined>> {
      const work = await loadWorkManifest(projectRoot, params.workId);
      const artifacts = work.artifacts.flatMap((artifact) => {
        const revision = artifact.revisions.find((candidate) => candidate.id === artifact.currentRevisionId);
        return revision
          ? [`- artifact=${JSON.stringify(artifact.id)} | kind=${artifact.kind} | path=${JSON.stringify(`works/${work.id}/${revision.path}`)}`]
          : [];
      });
      return textResult([
        `title=${JSON.stringify(work.title)}`,
        `id=${JSON.stringify(work.id)}`,
        `profile=${work.profileId}`,
        `language=${work.language}`,
        `status=${work.status}`,
        `lineage=${JSON.stringify(work.lineage)}`,
        "Artifacts:",
        ...(artifacts.length > 0 ? artifacts : ["- none"]),
      ].join("\n"));
    },
  };
}

const GrepParams = Type.Object({
  bookId: Type.String({ description: "Book ID to search within" }),
  pattern: Type.String({ description: "Search pattern (plain text or regex)" }),
});

export function createGrepTool(projectRoot: string): AgentTool<typeof GrepParams> {
  const worksRoot = join(projectRoot, "works");

  return {
    name: "grep",
    description:
      "Search for a text pattern across a book's story/ and chapters/ directories. Returns matching lines.",
    label: "Search",
    parameters: GrepParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof GrepParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const bookDir = safeBooksPath(worksRoot, join(params.bookId, "source"));
        const regex = new RegExp(params.pattern, "gi");
        const results: string[] = [];

        async function searchDir(dir: string, prefix: string) {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return; // directory doesn't exist
          }
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            const entryStat = await stat(fullPath);
            if (entryStat.isDirectory()) {
              await searchDir(fullPath, `${prefix}${entry}/`);
            } else if (entry.endsWith(".md") || entry.endsWith(".txt") || entry.endsWith(".json")) {
              const content = await readFile(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${prefix}${entry}:${i + 1}: ${lines[i]}`);
                  regex.lastIndex = 0; // reset for next test
                }
              }
            }
          }
        }

        await Promise.all([
          searchDir(join(bookDir, "story"), "story/"),
          searchDir(join(bookDir, "chapters"), "chapters/"),
        ]);

        if (results.length === 0) {
          return textResult(`No matches for "${params.pattern}" in book "${params.bookId}".`);
        }

        return textResult(results.join("\n"));
      } catch (err) {
        throw new Error(`Grep failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Ls Tool
// ---------------------------------------------------------------------------

const LsParams = Type.Object({
  bookId: Type.String({ description: "Book ID" }),
  subdir: Type.Optional(
    Type.String({ description: "Subdirectory within the book, e.g. 'story', 'chapters', 'story/runtime'" }),
  ),
});

export function createLsTool(projectRoot: string): AgentTool<typeof LsParams> {
  const worksRoot = join(projectRoot, "works");

  return {
    name: "ls",
    description: "List files in a Work source directory. Returns canonical project-relative paths that can be passed directly to workspace__read.",
    label: "List Files",
    parameters: LsParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof LsParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const base = safeBooksPath(worksRoot, join(params.bookId, "source"));
        const target = params.subdir ? safeBooksPath(base, params.subdir) : base;

        const entries = await readdir(target);
        const details: string[] = [];

        for (const entry of entries) {
          const fullPath = join(target, entry);
          try {
            const entryStat = await stat(fullPath);
            const suffix = entryStat.isDirectory() ? "/" : ` (${entryStat.size} bytes)`;
            details.push(`${toPosixPath(join("works", params.bookId, "source", params.subdir ?? "", entry))}${suffix}`);
          } catch {
            details.push(toPosixPath(join("works", params.bookId, "source", params.subdir ?? "", entry)));
          }
        }

        if (details.length === 0) {
          return textResult(`Directory is empty: ${params.bookId}/${params.subdir ?? ""}`);
        }

        return textResult(details.join("\n"));
      } catch (err) {
        throw new Error(
          `Failed to list "${params.bookId}/${params.subdir ?? ""}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
