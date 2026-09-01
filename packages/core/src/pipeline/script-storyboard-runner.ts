import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentContext } from "../agents/base.js";
import { materializeStoryGraph } from "../interactive-film/generate.js";
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
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";

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
  await ensureDraftWork(options.projectRoot, projectId, options.title, "script", options.language ?? "zh");
  await persistCandidateArtifacts(options.projectRoot, projectId, [
    textArtifact(join(baseDir, "script-spec.md"), spec),
  ]);

  options.onProgress?.("Writing script draft...");
  const agent = new ScriptCreationAgent(options.runtime);
  const script = await agent.writeScript(input);
  const artifacts = [
    textArtifact(join(baseDir, "script-spec.md"), spec),
    textArtifact(join(baseDir, "script.md"), script),
  ];
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({
    rootDir: options.projectRoot,
    writes: artifacts,
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
  await ensureDraftWork(options.projectRoot, projectId, options.title, "interactive-film", options.language ?? "zh");
  await persistCandidateArtifacts(options.projectRoot, projectId, [
    textArtifact(join(baseDir, "interactive-spec.md"), spec),
  ]);

  options.onProgress?.("Writing story tree, flags, script, storyboard, and image prompts...");
  const agent = new InteractiveFilmCreationAgent(options.runtime);
  const compiled = await agent.createInteractiveFilmPackage(input);
  const { storyTree, flags, script, storyboard } = compiled;
  const imagePromptItems = compiled.imagePrompts;
  const imagePrompts = renderImagePrompts(imagePromptItems);
  const storyGraphPath = relPath(baseDir, "story-graph.json");
  await persistCandidateArtifacts(options.projectRoot, projectId, [
    textArtifact(join(baseDir, "story-tree.md"), storyTree),
    textArtifact(join(baseDir, "flags.md"), flags),
    textArtifact(join(baseDir, "script.md"), script),
    textArtifact(join(baseDir, "storyboard.md"), storyboard),
    textArtifact(join(baseDir, "image-prompts.md"), imagePrompts),
  ]);

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

  options.onProgress?.("Validating interactive-film story graph...");
  const graph = materializeStoryGraph({
    projectId,
    title: options.title,
    content: compiled.storyGraph,
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
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({
    rootDir: options.projectRoot,
    writes: artifacts,
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
  await ensureDraftWork(options.projectRoot, projectId, options.title, "storyboard", options.language ?? "zh");
  await persistCandidateArtifacts(options.projectRoot, projectId, [
    textArtifact(join(baseDir, "storyboard-spec.md"), spec),
  ]);

  options.onProgress?.("Writing storyboard and image prompts...");
  const agent = new StoryboardCreationAgent(options.runtime);
  const storyboard = await agent.writeStoryboard(input);
  const compiler = new ProductionDocumentCompilerAgent(options.runtime);
  await persistCandidateArtifacts(options.projectRoot, projectId, [
    textArtifact(join(baseDir, "storyboard.md"), storyboard),
  ]);
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
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({
    rootDir: options.projectRoot,
    writes: artifacts,
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

async function ensureDraftWork(
  projectRoot: string,
  projectId: string,
  title: string,
  profileId: "script" | "storyboard" | "interactive-film",
  language: "zh" | "en",
): Promise<void> {
  try {
    const existing = await loadWorkManifest(projectRoot, projectId);
    if (existing.profileId !== profileId) {
      throw new Error(`Work "${projectId}" uses profile "${existing.profileId}", not "${profileId}".`);
    }
    if (existing.status !== "draft") {
      throw new Error(`Work "${projectId}" already exists. Revise its artifacts instead of recreating it.`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await saveWorkManifest(projectRoot, createWorkManifest({
    id: projectId,
    title,
    profileId,
    language,
    status: "draft",
  }));
}

async function persistCandidateArtifacts(
  projectRoot: string,
  projectId: string,
  artifacts: ReadonlyArray<{ readonly relativePath: string; readonly content: string }>,
): Promise<void> {
  assertNonEmptyArtifacts(artifacts);
  await commitAtomicFileSet({ rootDir: projectRoot, writes: artifacts });
  await syncWorkSourceArtifacts({ projectRoot, workId: projectId, accept: false });
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
