import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SHORT_FICTION_DEFAULT_CHAPTERS,
  SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER,
  activatedSkillIds,
  createBuiltInWorkProfileRegistry,
  createShortFictionRunTool,
  executeExplicitCapabilityTool,
  loadAvailableAgentSkills,
  PipelineRunner,
  resolveProfileSkillActivations,
  type ShortFictionReference,
  type ShortFictionLanguage,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError } from "../utils.js";

export { extractResponsesImageBase64, resolveCoverApiKey } from "@actalk/inkos-core";

export const shortCommand = new Command("short")
  .description("Short fiction production workflow");

shortCommand
  .command("run")
  .description("Run a short fiction chain from a direction")
  .requiredOption("--direction <text>", "Story direction, e.g. \"女频短篇 婚姻背叛 证据反杀\" or \"female-lead short: marriage betrayal, evidence payback\"")
  .option("--reference <path>", "Optional reference notes/text")
  .option("--story-id <id>", "Work id for the generated short fiction")
  .option("--lang <language>", "Writing language: zh or en", "zh")
  .option("--chapters <n>", "Complete short chapter count", String(SHORT_FICTION_DEFAULT_CHAPTERS))
  .option("--chars <n>", "Per-chapter length: zh characters or en words")
  .option("--llm-base-url <url>", "Override LLM base URL")
  .option("--model <model>", "Fallback model for all short stages")
  .option("--planner-model <model>", "Model for outline creation")
  .option("--writer-model <model>", "Model for first full draft")
  .option("--draft-review-model <model>", "Model for draft review")
  .option("--package-model <model>", "Model for synopsis and cover prompt packaging")
  .option("--cover-base-url <url>", "OpenAI-compatible Responses API base URL for cover generation, e.g. https://api.openai.com/v1")
  .option("--cover-endpoint <url>", "Exact Responses endpoint for cover generation; overrides --cover-base-url")
  .option("--cover-model <model>", "Image-capable Responses model for cover generation", "gpt-5.5")
  .option("--cover-size <size>", "Cover image size", "1024x1360")
  .option("--cover-api-key-env <name>", "Env var containing cover API key", "INKOS_COVER_API_KEY")
  .option("--no-cover", "Skip cover image generation")
  .option("--json", "Output JSON")
  .action(async (opts: ShortRunOptions) => {
    try {
      const root = findProjectRoot();
      const language = parseShortFictionLanguage(opts.lang);
      const chapterCount = parsePositiveInteger(
        opts.chapters,
        SHORT_FICTION_DEFAULT_CHAPTERS,
        "chapters",
      );
      const charsPerChapter = opts.chars === undefined
        ? undefined
        : parsePositiveInteger(
            opts.chars,
            language === "en" ? SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER : SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
            "chars",
          );
      const reference = opts.reference ? await readReference(root, opts.reference) : undefined;
      const models = resolveShortRunModels(opts);
      const configuredSkills = await loadAvailableAgentSkills({ projectRoot: root });
      const activatedSkills = resolveProfileSkillActivations(
        configuredSkills.skills,
        createBuiltInWorkProfileRegistry().require("short-fiction"),
      );

      const config = await loadConfig({ projectRoot: root });
      if (opts.llmBaseUrl) config.llm.baseUrl = opts.llmBaseUrl;
      if (opts.model) config.llm.model = opts.model;
      const modelOverrides = { ...(config.modelOverrides ?? {}) };
      const stageModels = {
        "short-outline": models.planner,
        "short-writer": models.writer,
        "short-draft-review": models.draftReview,
        "short-package": models.package,
      };
      for (const [stage, model] of Object.entries(stageModels)) {
        if (model) modelOverrides[stage] = model;
      }
      config.modelOverrides = modelOverrides;
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { quiet: Boolean(opts.json) }));
      const action = await executeExplicitCapabilityTool({
        projectRoot: root,
        binding: { capabilityId: "short-fiction", actionId: "short_fiction_run", profileId: "short-fiction" },
        tool: createShortFictionRunTool(pipeline, root, { language, defaultSkills: activatedSkills }),
        parameters: {
          direction: opts.direction,
          reference: reference?.text,
          storyId: opts.storyId,
          chapters: chapterCount,
          charsPerChapter,
          language,
          cover: opts.cover,
          coverBaseUrl: opts.coverBaseUrl,
          coverEndpoint: opts.coverEndpoint,
          coverModel: opts.coverModel,
          coverSize: opts.coverSize,
          coverApiKeyEnv: opts.coverApiKeyEnv,
        },
        onUpdate: opts.json ? undefined : (update) => {
          const text = (update as { content?: Array<{ type?: string; text?: string }> }).content
            ?.filter((item) => item.type === "text")
            .map((item) => item.text ?? "")
            .join("\n")
            .trim();
          if (text) log(text);
        },
      });
      const result = action.data as {
        storyId: string;
        finalMarkdownPath: string;
        salesPackagePath: string;
        coverImagePath?: string;
        coverError?: string;
      };

      const payload = {
        ...result,
        models,
      };

      if (opts.json) {
        log(JSON.stringify(payload, null, 2));
      } else {
        log(`Skills: ${activatedSkillIds(activatedSkills).join(", ")}`);
        log(`Short run complete: ${result.storyId}`);
        log(`Final: ${payload.finalMarkdownPath}`);
        log(`Sales package: ${payload.salesPackagePath}`);
        log(formatCoverStatus(payload.coverImagePath, payload.coverError));
      }
    } catch (e) {
      logCommandError("Short run failed", e, opts.json);
    }
  });

interface ShortRunOptions {
  readonly direction: string;
  readonly reference?: string;
  readonly storyId?: string;
  readonly lang: string;
  readonly chapters?: string;
  readonly chars?: string;
  readonly llmBaseUrl?: string;
  readonly model?: string;
  readonly plannerModel?: string;
  readonly writerModel?: string;
  readonly draftReviewModel?: string;
  readonly packageModel?: string;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly cover?: boolean;
  readonly json?: boolean;
}

function parseShortFictionLanguage(value: string): ShortFictionLanguage {
  if (value === "zh" || value === "en") return value;
  throw new Error("lang must be zh or en.");
}

interface ShortRunModels {
  readonly planner?: string;
  readonly writer?: string;
  readonly draftReview?: string;
  readonly package?: string;
}

function resolveShortRunModels(options: ShortRunOptions): ShortRunModels {
  return {
    planner: options.plannerModel || options.model,
    writer: options.writerModel || options.model,
    draftReview: options.draftReviewModel || options.model,
    package: options.packageModel || options.model,
  };
}

async function readReference(root: string, path: string): Promise<ShortFictionReference> {
  const resolved = resolve(root, path);
  return {
    path,
    text: await readFile(resolved, "utf-8"),
  };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function formatCoverStatus(coverImagePath?: string, coverError?: string): string {
  if (coverImagePath) return `Cover: ${coverImagePath}`;
  if (coverError) return `Cover: skipped (${coverError})`;
  return "Cover: skipped";
}

function logCommandError(prefix: string, error: unknown, json?: boolean): void {
  if (json) {
    log(JSON.stringify({ error: `${prefix}: ${String(error)}` }, null, 2));
    return;
  }
  logError(`${prefix}: ${String(error)}`);
}
