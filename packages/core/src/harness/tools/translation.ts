import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { PipelineRunner } from "../../pipeline/runner.js";
import {
  createLLMTranslationModel,
  createTranslationProjectFromFile,
  runTranslationProject,
  writeTranslationExport,
} from "../../translation/index.js";
import type { ActivatedSkillGuidance } from "../../agent/skill-tool.js";
import type { TranslationModelPort } from "../../translation/types.js";
import { mergeActivatedSkillGuidance } from "../../skills/activations.js";
import { activatedSkillIds } from "../../skills/activations.js";
import type { ActionPayload } from "../../interaction/action-envelope.js";
import { safeChildPath } from "../../utils/path-safety.js";

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

const TranslationCreateParams = Type.Object({
  filePath: Type.String({ description: "Project-relative EPUB/PDF/TXT/Markdown source file path." }),
  sourceLanguage: Type.String({ description: "Human-readable source language or Auto detect." }),
  targetLanguage: Type.String({ description: "Human-readable target language." }),
  title: Type.Optional(Type.String()),
  segmentMaxChars: Type.Optional(Type.Number()),
});

export function createTranslationCreateTool(
  projectRoot: string,
  options: { readonly actionPayload?: ActionPayload } = {},
): AgentTool<typeof TranslationCreateParams> {
  return {
    name: "translation_create",
    label: "Create Translation Work",
    description: "Create a translation Work by ingesting and segmenting an EPUB, PDF, text, or Markdown source.",
    parameters: TranslationCreateParams,
    async execute(_toolCallId, params: Static<typeof TranslationCreateParams>) {
      const payload = options.actionPayload?.translationCreate;
      const result = await createTranslationProjectFromFile(projectRoot, {
        filePath: payload?.filePath ?? params.filePath,
        sourceLanguage: payload?.sourceLanguage ?? params.sourceLanguage,
        targetLanguage: payload?.targetLanguage ?? params.targetLanguage,
        title: payload?.title ?? params.title,
        segmentMaxChars: payload?.segmentMaxChars ?? params.segmentMaxChars,
      });
      return textResult(
        `Translation Work "${result.manifest.title}" created with ${result.manifest.chapters.length} chapter(s).`,
        { kind: "translation_project_created", workId: result.manifest.id, ...result },
      );
    },
  };
}

const TranslationRunParams = Type.Object({
  batchSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 256 })),
});

export function createTranslationRunTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  workId: string,
  options: {
    readonly defaultSkills?: ReadonlyArray<ActivatedSkillGuidance>;
    readonly activeSkills?: () => ReadonlyArray<ActivatedSkillGuidance>;
    readonly createModel?: (input: {
      readonly client: ReturnType<PipelineRunner["createAgentContext"]>["client"];
      readonly model: string;
      readonly maxTokens?: number;
      readonly activatedSkills: ReadonlyArray<ActivatedSkillGuidance>;
      readonly signal?: AbortSignal;
    }) => TranslationModelPort;
  } = {},
): AgentTool<typeof TranslationRunParams> {
  return {
    name: "translation_run",
    label: "Run Translation",
    description: "Translate all pending segments in the current translation Work and persist review results.",
    parameters: TranslationRunParams,
    async execute(_toolCallId, params: Static<typeof TranslationRunParams>, signal) {
      const skills = mergeActivatedSkillGuidance(options.defaultSkills ?? [], options.activeSkills?.() ?? []);
      const result = await pipeline.runWithAgentContext({ signal, activatedSkills: skills }, async () => {
        const context = pipeline.createAgentContext("translation", workId);
        return runTranslationProject(projectRoot, workId, {
          model: (options.createModel ?? createLLMTranslationModel)({
            client: context.client,
            model: context.model,
            maxTokens: params.maxTokens,
            activatedSkills: skills,
            signal,
          }),
          batchSize: params.batchSize,
        });
      });
      return textResult(
        `Translated ${result.translatedSegments} segment(s) and reviewed ${result.reviewedChapters} chapter(s).`,
        { kind: "translation_completed", workId, ...result, skillIds: activatedSkillIds(skills) },
      );
    },
  };
}

const TranslationExportParams = Type.Object({
  format: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("txt"), Type.Literal("epub")])),
  outputPath: Type.Optional(Type.String()),
});

export function createTranslationExportTool(
  projectRoot: string,
  workId: string,
): AgentTool<typeof TranslationExportParams> {
  return {
    name: "translation_export",
    label: "Export Translation",
    description: "Export the current translated Work as Markdown, text, or EPUB.",
    parameters: TranslationExportParams,
    async execute(_toolCallId, params: Static<typeof TranslationExportParams>) {
      const result = await writeTranslationExport(projectRoot, workId, {
        format: params.format,
        ...(params.outputPath ? { outputPath: safeChildPath(projectRoot, params.outputPath) } : {}),
      });
      return textResult(
        `Exported ${result.chaptersExported} translated chapter(s) to ${result.outputPath}.`,
        { kind: "translation_exported", workId, ...result },
      );
    },
  };
}
