import type { LLMClient } from "../llm/provider.js";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import { Type } from "@sinclair/typebox";
import { appendActivatedSkillGuidance } from "../agents/base.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import type { TranslationGlossaryTerm, TranslationModelPort, TranslationSegment } from "./types.js";

const TranslationResultToolSchema = Type.Object({
  chapterTitle: Type.Optional(Type.String()),
  segments: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0 }),
    target: Type.String(),
    notes: Type.Optional(Type.String()),
  })),
  glossary: Type.Optional(Type.Array(Type.Object({
    source: Type.String(),
    target: Type.String(),
    note: Type.Optional(Type.String()),
  }))),
});

const TranslationReviewToolSchema = Type.Object({
  summary: Type.String(),
  issues: Type.Array(Type.String()),
});

export function createLLMTranslationModel(input: {
  readonly client: LLMClient;
  readonly model: string;
  readonly maxTokens?: number;
  readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
  readonly signal?: AbortSignal;
}): TranslationModelPort {
  return {
    async translateSegments(request) {
      const parsed = await runWorkerAgentTool(input.client, input.model, appendActivatedSkillGuidance([
        {
          role: "system",
          content: [
            "Translate the chapter title and all segments with the activated translation Skill.",
            "Submit the complete translation through the translation result tool.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            chapterTitle: request.chapterTitle,
            glossary: request.glossary,
            segments: request.segments.map((segment) => ({
              index: segment.index,
              source: segment.source,
            })),
          }, null, 2),
        },
      ], input.activatedSkills), {
        name: "submit_translation",
        label: "Submit translation",
        description: "Submit translated segments and glossary updates.",
        parameters: TranslationResultToolSchema,
      }, { temperature: 0.2, maxTokens: input.maxTokens ?? 8192, signal: input.signal });
      return {
        ...(typeof parsed.chapterTitle === "string" && parsed.chapterTitle.trim()
          ? { chapterTitle: parsed.chapterTitle.trim() }
          : {}),
        segments: parseTranslatedSegments(parsed.segments, request.segments),
        glossary: parseGlossary(parsed.glossary),
      };
    },
    async reviewChapter(request) {
      const parsed = await runWorkerAgentTool(input.client, input.model, appendActivatedSkillGuidance([
        {
          role: "system",
          content: [
            "Review the translation with the activated translation Skill.",
            "Submit the review summary and concrete issues through the review result tool. An empty issues array is valid.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            chapterTitle: request.chapterTitle,
            glossary: request.glossary,
            segments: request.segments.map((segment) => ({
              index: segment.index,
              source: segment.source,
              target: segment.target ?? "",
            })),
          }, null, 2),
        },
      ], input.activatedSkills), {
        name: "submit_translation_review",
        label: "Submit translation review",
        description: "Submit the translation review.",
        parameters: TranslationReviewToolSchema,
      }, { temperature: 0.1, maxTokens: 4096, signal: input.signal });
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : "Translation review completed.",
        issues: Array.isArray(parsed.issues) ? parsed.issues.filter((issue): issue is string => typeof issue === "string") : [],
      };
    },
  };
}

function parseTranslatedSegments(value: unknown, sourceSegments: ReadonlyArray<TranslationSegment>): ReadonlyArray<{
  readonly index: number;
  readonly target: string;
  readonly notes?: string;
}> {
  if (!Array.isArray(value)) {
    throw new Error("Translation model did not return a segments array.");
  }
  const sourceIndex = new Set(sourceSegments.map((segment) => segment.index));
  const parsed = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const target = typeof record.target === "string" ? record.target.trim() : "";
    if (!Number.isInteger(index) || !sourceIndex.has(index) || !target) return [];
    return [{
      index,
      target,
      ...(typeof record.notes === "string" && record.notes.trim() ? { notes: record.notes.trim() } : {}),
    }];
  });
  if (parsed.length === 0) throw new Error("Translation model returned no usable translated segments.");
  return parsed;
}

function parseGlossary(value: unknown): ReadonlyArray<TranslationGlossaryTerm> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const source = typeof record.source === "string" ? record.source.trim() : "";
    const target = typeof record.target === "string" ? record.target.trim() : "";
    if (!source || !target) return [];
    return [{
      source,
      target,
      ...(typeof record.note === "string" && record.note.trim() ? { note: record.note.trim() } : {}),
    }];
  });
}
