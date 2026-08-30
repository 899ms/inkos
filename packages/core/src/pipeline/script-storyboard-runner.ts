import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentContext } from "../agents/base.js";
import { generateStoryGraph } from "../interactive-film/generate.js";
import type { StoryGraph } from "../interactive-film/graph-schema.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  InteractiveFilmCreationAgent,
  ProductionDocumentCompilerAgent,
  ScriptCreationAgent,
  StoryboardCreationAgent,
  renderInteractiveFilmSpec,
  renderScriptSpec,
  renderStoryboardSpec,
  type InteractiveFilmCreationInput,
  type ScriptCreationInput,
  type ScriptTargetFormat,
  type StoryboardCreationInput,
} from "../agents/script-storyboard.js";
import { safeChildPath } from "../utils/path-safety.js";
import { toPosixPath } from "../utils/posix-path.js";
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from "../harness/source-sync.js";

export interface ScriptCreationRunOptions {
  readonly projectRoot: string;
  readonly runtime: AgentContext;
  readonly title: string;
  readonly instruction: string;
  readonly sourceKind?: string;
  readonly targetFormat?: ScriptTargetFormat;
  readonly sourceText?: string;
  readonly sourcePath?: string;
  readonly requirements?: string;
  readonly episodeCount?: number;
  readonly episodeDuration?: string;
  readonly language?: "zh" | "en";
  readonly projectId?: string;
  readonly onProgress?: (message: string) => void;
}

export interface StoryboardCreationRunOptions {
  readonly projectRoot: string;
  readonly runtime: AgentContext;
  readonly title: string;
  readonly instruction: string;
  readonly sourceKind?: string;
  readonly sourceText?: string;
  readonly sourcePath?: string;
  readonly requirements?: string;
  readonly visualStyle?: string;
  readonly aspectRatio?: string;
  readonly granularity?: string;
  readonly maxShots?: number;
  readonly language?: "zh" | "en";
  readonly projectId?: string;
  readonly onProgress?: (message: string) => void;
}

export interface InteractiveFilmCreationRunOptions {
  readonly projectRoot: string;
  readonly runtime: AgentContext;
  readonly title: string;
  readonly instruction: string;
  readonly sourceKind?: string;
  readonly sourceText?: string;
  readonly sourcePath?: string;
  readonly requirements?: string;
  readonly targetAudience?: string;
  readonly episodeCount?: number;
  readonly episodeDuration?: string;
  readonly budget?: string;
  readonly referenceMode?: string;
  readonly language?: "zh" | "en";
  readonly projectId?: string;
  readonly onProgress?: (message: string) => void;
}

export interface ScriptCreationRunResult {
  readonly projectId: string;
  readonly baseDir: string;
  readonly specPath: string;
  readonly scriptPath: string;
}

export interface InteractiveFilmCreationRunResult {
  readonly projectId: string;
  readonly baseDir: string;
  readonly storyGraphPath: string;
  readonly specPath: string;
  readonly storyTreePath: string;
  readonly flagsPath: string;
  readonly scriptPath: string;
  readonly storyboardPath: string;
  readonly imagePromptsPath: string;
  readonly assetsManifestPath: string;
  readonly assetsDir: string;
}

export interface StoryboardCreationRunResult {
  readonly projectId: string;
  readonly baseDir: string;
  readonly specPath: string;
  readonly storyboardPath: string;
  readonly imagePromptsPath: string;
  readonly assetsManifestPath: string;
  readonly assetsDir: string;
}

export interface StoryboardImageAssetVariant {
  readonly id: string;
  readonly path: string;
  readonly status: "pending" | "generated" | "selected" | "failed";
  readonly model?: string;
  readonly provider?: string;
  readonly createdAt?: string;
  readonly error?: string;
}

export interface StoryboardImageAsset {
  readonly shotId: string;
  readonly prompt: string;
  readonly sourceRefs: readonly string[];
  readonly variants: readonly StoryboardImageAssetVariant[];
  readonly selectedPath?: string;
  readonly status: "prompt_ready" | "generated" | "selected" | "failed";
}

export interface StoryboardAssetsManifest {
  readonly version: 1;
  readonly kind: "storyboard_assets";
  readonly title: string;
  readonly projectId: string;
  readonly baseDir: string;
  readonly storyboardPath: string;
  readonly imagePromptsPath: string;
  readonly assetsDir: string;
  readonly sourceDir: string;
  readonly generatedDir: string;
  readonly selectedDir: string;
  readonly createdAt: string;
  readonly assets: readonly StoryboardImageAsset[];
}

export async function runScriptCreation(
  options: ScriptCreationRunOptions,
): Promise<ScriptCreationRunResult> {
  const projectId = safeSegment(options.projectId ?? slugify(options.title));
  const baseDir = relPath("works", projectId, "source");
  const sourceText = await resolveSourceText(options.projectRoot, options.sourceText, options.sourcePath);
  const input: ScriptCreationInput = {
    title: options.title,
    sourceKind: options.sourceKind,
    targetFormat: options.targetFormat,
    sourceText,
    requirements: mergeRequirements(options.instruction, options.requirements, options.language),
    episodeCount: options.episodeCount,
    episodeDuration: options.episodeDuration,
    language: options.language,
  };

  options.onProgress?.("Writing script creation spec...");
  const spec = renderScriptSpec(input);

  options.onProgress?.("Writing script draft...");
  const agent = new ScriptCreationAgent(options.runtime);
  const script = await agent.writeScript(input);
  const artifacts = [
    textArtifact(join(baseDir, "script-spec.md"), spec),
    textArtifact(join(baseDir, "script.md"), script),
  ];
  const work = createInitialWorkManifestWrite({
    workId: projectId,
    title: options.title,
    profileId: "script",
    language: options.language ?? "zh",
    writes: artifacts,
  });
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({
    rootDir: options.projectRoot,
    writes: [...artifacts, work.write],
  });
  await syncWorkSourceArtifacts({ projectRoot: options.projectRoot, workId: projectId, accept: true });

  return {
    projectId,
    baseDir,
    specPath: relPath(baseDir, "script-spec.md"),
    scriptPath: relPath(baseDir, "script.md"),
  };
}

export async function runInteractiveFilmCreation(
  options: InteractiveFilmCreationRunOptions,
): Promise<InteractiveFilmCreationRunResult> {
  const projectId = safeSegment(options.projectId ?? slugify(options.title));
  const baseDir = relPath("works", projectId, "source");
  const sourceText = await resolveSourceText(options.projectRoot, options.sourceText, options.sourcePath);
  const input: InteractiveFilmCreationInput = {
    title: options.title,
    sourceKind: options.sourceKind,
    sourceText,
    requirements: mergeRequirements(options.instruction, options.requirements, options.language),
    targetAudience: options.targetAudience,
    episodeCount: options.episodeCount,
    episodeDuration: options.episodeDuration,
    budget: options.budget,
    referenceMode: options.referenceMode,
    language: options.language,
  };

  options.onProgress?.("Writing interactive-film creation spec...");
  const spec = renderInteractiveFilmSpec(input);

  options.onProgress?.("Writing story tree, flags, script, storyboard, and image prompts...");
  const agent = new InteractiveFilmCreationAgent(options.runtime);
  const packageMarkdown = await agent.writeInteractiveFilm(input);
  const compiler = new ProductionDocumentCompilerAgent(options.runtime);
  const compiled = await compiler.compileInteractiveFilmPackage(packageMarkdown, options.language ?? "zh");
  const { storyTree, flags, script, storyboard } = compiled;
  const imagePromptItems = compiled.imagePrompts;
  const imagePrompts = renderImagePrompts(imagePromptItems);
  const storyGraphPath = relPath(baseDir, "story-graph.json");

  await ensureProjectDir(options.projectRoot, join(baseDir, "assets", "source"));
  await ensureProjectDir(options.projectRoot, join(baseDir, "assets", "generated"));
  await ensureProjectDir(options.projectRoot, join(baseDir, "assets", "selected"));
  const assetsManifest = createStoryboardAssetsManifest({
    title: options.title,
    projectId,
    baseDir,
    storyboardPath: join(baseDir, "storyboard.md"),
    imagePromptsPath: join(baseDir, "image-prompts.md"),
    imagePrompts: imagePromptItems,
    createdAt: new Date().toISOString(),
  });

  options.onProgress?.("Writing interactive-film story graph...");
  const graph = await createInteractiveFilmStoryGraph(options.runtime, {
    projectId,
    title: options.title,
    input,
    storyTree,
    flags,
    script,
    imagePrompts,
    onProgress: options.onProgress,
  });
  const artifacts = [
    textArtifact(join(baseDir, "interactive-spec.md"), spec),
    textArtifact(join(baseDir, "story-tree.md"), storyTree),
    textArtifact(join(baseDir, "flags.md"), flags),
    textArtifact(join(baseDir, "script.md"), script),
    textArtifact(join(baseDir, "storyboard.md"), storyboard),
    textArtifact(join(baseDir, "image-prompts.md"), imagePrompts),
    textArtifact(join(baseDir, "assets.json"), JSON.stringify(assetsManifest, null, 2)),
    textArtifact(storyGraphPath, JSON.stringify(graph, null, 2)),
  ];
  const work = createInitialWorkManifestWrite({
    workId: projectId,
    title: options.title,
    profileId: "interactive-film",
    language: options.language ?? "zh",
    writes: artifacts,
  });
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({
    rootDir: options.projectRoot,
    writes: [...artifacts, work.write],
  });
  await syncWorkSourceArtifacts({ projectRoot: options.projectRoot, workId: projectId, accept: true });

  return {
    projectId,
    baseDir,
    storyGraphPath,
    specPath: relPath(baseDir, "interactive-spec.md"),
    storyTreePath: relPath(baseDir, "story-tree.md"),
    flagsPath: relPath(baseDir, "flags.md"),
    scriptPath: relPath(baseDir, "script.md"),
    storyboardPath: relPath(baseDir, "storyboard.md"),
    imagePromptsPath: relPath(baseDir, "image-prompts.md"),
    assetsManifestPath: relPath(baseDir, "assets.json"),
    assetsDir: relPath(baseDir, "assets"),
  };
}

export async function runStoryboardCreation(
  options: StoryboardCreationRunOptions,
): Promise<StoryboardCreationRunResult> {
  const projectId = safeSegment(options.projectId ?? slugify(options.title));
  const baseDir = relPath("works", projectId, "source");
  const sourceText = await resolveSourceText(options.projectRoot, options.sourceText, options.sourcePath);
  const input: StoryboardCreationInput = {
    title: options.title,
    sourceKind: options.sourceKind,
    sourceText,
    requirements: mergeRequirements(options.instruction, options.requirements, options.language),
    visualStyle: options.visualStyle,
    aspectRatio: options.aspectRatio,
    granularity: options.granularity,
    maxShots: options.maxShots,
    language: options.language,
  };

  options.onProgress?.("Writing storyboard creation spec...");
  const spec = renderStoryboardSpec(input);

  options.onProgress?.("Writing storyboard and image prompts...");
  const agent = new StoryboardCreationAgent(options.runtime);
  const storyboard = await agent.writeStoryboard(input);
  const compiler = new ProductionDocumentCompilerAgent(options.runtime);
  const imagePromptItems = await compiler.compileStoryboardAssets(storyboard, options.language ?? "zh");
  const imagePrompts = renderImagePrompts(imagePromptItems);
  await ensureProjectDir(options.projectRoot, join(baseDir, "assets", "source"));
  await ensureProjectDir(options.projectRoot, join(baseDir, "assets", "generated"));
  await ensureProjectDir(options.projectRoot, join(baseDir, "assets", "selected"));
  const assetsManifest = createStoryboardAssetsManifest({
    title: options.title,
    projectId,
    baseDir,
    storyboardPath: join(baseDir, "storyboard.md"),
    imagePromptsPath: join(baseDir, "image-prompts.md"),
    imagePrompts: imagePromptItems,
    createdAt: new Date().toISOString(),
  });
  const artifacts = [
    textArtifact(join(baseDir, "storyboard-spec.md"), spec),
    textArtifact(join(baseDir, "storyboard.md"), storyboard),
    textArtifact(join(baseDir, "image-prompts.md"), imagePrompts),
    textArtifact(join(baseDir, "assets.json"), JSON.stringify(assetsManifest, null, 2)),
  ];
  const work = createInitialWorkManifestWrite({
    workId: projectId,
    title: options.title,
    profileId: "storyboard",
    language: options.language ?? "zh",
    writes: artifacts,
  });
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({
    rootDir: options.projectRoot,
    writes: [...artifacts, work.write],
  });
  await syncWorkSourceArtifacts({ projectRoot: options.projectRoot, workId: projectId, accept: true });

  return {
    projectId,
    baseDir,
    specPath: relPath(baseDir, "storyboard-spec.md"),
    storyboardPath: relPath(baseDir, "storyboard.md"),
    imagePromptsPath: relPath(baseDir, "image-prompts.md"),
    assetsManifestPath: relPath(baseDir, "assets.json"),
    assetsDir: relPath(baseDir, "assets"),
  };
}

async function createInteractiveFilmStoryGraph(
  runtime: AgentContext,
  args: {
    readonly projectId: string;
    readonly title: string;
    readonly input: InteractiveFilmCreationInput;
    readonly storyTree: string;
    readonly flags: string;
    readonly script: string;
    readonly imagePrompts: string;
    readonly onProgress?: (message: string) => void;
  },
): Promise<StoryGraph> {
  args.onProgress?.(args.input.language === "en"
    ? "Building the playable story graph through the structured authoring harness..."
    : "正在通过结构化创作内核生成可玩故事图谱……");
  return generateStoryGraph(runtime.client, runtime.model, {
    projectId: args.projectId,
    title: args.title,
    premise: buildInteractiveFilmGraphPremise(args.input, args.storyTree, args.flags, args.script, args.imagePrompts),
  }, {
    language: args.input.language,
    activatedSkills: runtime.activatedSkills,
    signal: runtime.signal,
  });
}

function buildInteractiveFilmGraphPremise(
  input: InteractiveFilmCreationInput,
  storyTree: string,
  flags: string,
  script: string,
  imagePrompts: string,
): string {
  if ((input.language ?? "zh") === "en") {
    return [
      `Creation brief: ${input.requirements}`,
      input.targetAudience ? `Target audience: ${input.targetAudience}` : "",
      input.episodeCount ? `Segments/episodes: ${input.episodeCount}` : "",
      input.episodeDuration ? `Per-segment duration: ${input.episodeDuration}` : "",
      input.budget ? `Budget: ${input.budget}` : "",
      input.referenceMode ? `Reference mode: ${input.referenceMode}` : "",
      `Story tree:\n${storyTree}`,
      `Variables and flags:\n${flags}`,
      `Interactive script:\n${script}`,
      `Image prompts:\n${imagePrompts}`,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `创作需求：${input.requirements}`,
    input.targetAudience ? `目标受众：${input.targetAudience}` : "",
    input.episodeCount ? `段落/集数：${input.episodeCount}` : "",
    input.episodeDuration ? `单段时长：${input.episodeDuration}` : "",
    input.budget ? `预算：${input.budget}` : "",
    input.referenceMode ? `参考模式：${input.referenceMode}` : "",
    `剧情树：\n${storyTree}`,
    `变量旗标：\n${flags}`,
    `互动剧本：\n${script}`,
    `图像提示词：\n${imagePrompts}`,
  ].filter(Boolean).join("\n\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createStoryboardAssetsManifest(args: {
  readonly title: string;
  readonly projectId: string;
  readonly baseDir: string;
  readonly storyboardPath: string;
  readonly imagePromptsPath: string;
  readonly imagePrompts: ReadonlyArray<string>;
  readonly createdAt: string;
}): StoryboardAssetsManifest {
  const assetsDir = relPath(args.baseDir, "assets");
  return {
    version: 1,
    kind: "storyboard_assets",
    title: args.title,
    projectId: args.projectId,
    baseDir: toPosixPath(args.baseDir),
    storyboardPath: toPosixPath(args.storyboardPath),
    imagePromptsPath: toPosixPath(args.imagePromptsPath),
    assetsDir,
    sourceDir: relPath(assetsDir, "source"),
    generatedDir: relPath(assetsDir, "generated"),
    selectedDir: relPath(assetsDir, "selected"),
    createdAt: args.createdAt,
    assets: args.imagePrompts.map((prompt, index) => {
      const shotId = `shot-${String(index + 1).padStart(3, "0")}`;
      return {
        shotId,
        prompt,
        sourceRefs: [],
        variants: [],
        status: "prompt_ready",
      };
    }),
  };
}

function renderImagePrompts(prompts: ReadonlyArray<string>): string {
  return prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n");
}

async function resolveSourceText(
  projectRoot: string,
  sourceText: string | undefined,
  sourcePath: string | undefined,
): Promise<string | undefined> {
  const direct = sourceText?.trim();
  if (direct) return direct;
  const path = sourcePath?.trim();
  if (!path) return undefined;
  return readFile(safeChildPath(projectRoot, path), "utf-8");
}

function textArtifact(relativePath: string, content: string): {
  readonly relativePath: string;
  readonly content: string;
} {
  return {
    relativePath,
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

function assertNonEmptyArtifacts(
  artifacts: ReadonlyArray<{ readonly relativePath: string; readonly content: string }>,
): void {
  for (const artifact of artifacts) {
    if (!artifact.content.trim()) {
      throw new Error(`Production artifact is empty: ${artifact.relativePath}`);
    }
  }
}

async function ensureProjectDir(projectRoot: string, relativePath: string): Promise<void> {
  await mkdir(safeChildPath(projectRoot, relativePath), { recursive: true });
}

function mergeRequirements(
  instruction: string,
  requirements: string | undefined,
  language: "zh" | "en" = "zh",
): string {
  const extraLabel = language === "en" ? "Additional requirements:" : "补充要求：";
  return [
    instruction.trim(),
    requirements?.trim() ? `\n${extraLabel}\n${requirements.trim()}` : "",
  ].filter(Boolean).join("\n");
}

// Project-relative path for results and manifests: always "/" separators.
function relPath(...segments: string[]): string {
  return toPosixPath(join(...segments));
}

function safeSegment(value: string): string {
  const text = value.trim();
  if (!text || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid project id: ${JSON.stringify(value)}`);
  }
  return text.slice(0, 80);
}

function slugify(value: string): string {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return text || `script-${Date.now()}`;
}

export async function projectFileExists(projectRoot: string, relativePath: string): Promise<boolean> {
  try {
    await access(safeChildPath(projectRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}
