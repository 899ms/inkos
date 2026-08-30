import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { z } from "zod";
import {
  HARNESS_VERSION,
  ArtifactManifestSchema,
  ArtifactRevisionSchema,
  WorkManifestSchema,
  type ArtifactManifest,
  type WorkLineage,
  type WorkManifest,
} from "./contracts.js";

const MIGRATION_ID = "work-layout-v2";
const MIGRATION_REPORT = join(".inkos", "migrations", `${MIGRATION_ID}.json`);
const MIGRATION_STAGE = join(".inkos", "migrations", `${MIGRATION_ID}-stage`);
const MIGRATION_BACKUP = join(".inkos", "migration-backups", "work-layout-v1");

const LEGACY_ROOTS = [
  { directory: "books", profileId: "longform-novel" },
  { directory: "shorts", profileId: "short-fiction" },
  { directory: "dramas", profileId: "script" },
  { directory: "storyboards", profileId: "storyboard" },
  { directory: "interactive-films", profileId: "interactive-film" },
  { directory: "translations", profileId: "translation" },
  { directory: "worlds", profileId: "interactive-world" },
  { directory: "covers", profileId: "visual-asset" },
] as const;

export interface LegacyMigrationCandidate {
  readonly sourceDirectory: string;
  readonly sourceId: string;
  readonly workId: string;
  readonly profileId: string;
  readonly title: string;
  readonly language: string;
  readonly parentSourceId?: string;
  readonly files: ReadonlyArray<string>;
  readonly skippedSymlinks: ReadonlyArray<string>;
}

export interface LegacyMigrationReport {
  readonly version: 2;
  readonly migrationId: typeof MIGRATION_ID;
  readonly status: "planned" | "completed";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly backupPath: string;
  readonly works: ReadonlyArray<LegacyMigrationCandidate>;
  readonly warnings: ReadonlyArray<string>;
}

const LegacyMigrationReportSchema = z.object({
  version: z.literal(HARNESS_VERSION),
  migrationId: z.literal(MIGRATION_ID),
  status: z.enum(["planned", "completed"]),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  backupPath: z.string().min(1),
  works: z.array(z.object({
    sourceDirectory: z.string().min(1),
    sourceId: z.string().min(1),
    workId: z.string().min(1),
    profileId: z.string().min(1),
    title: z.string().min(1),
    language: z.string().min(1),
    parentSourceId: z.string().min(1).optional(),
    files: z.array(z.string()),
    skippedSymlinks: z.array(z.string()),
  }).strict()),
  warnings: z.array(z.string()),
}).strict();

export async function scanLegacyWorks(projectRoot: string): Promise<LegacyMigrationCandidate[]> {
  const defaultLanguage = await readProjectLanguage(projectRoot);
  const raw: Array<Omit<LegacyMigrationCandidate, "workId">> = [];
  for (const root of LEGACY_ROOTS) {
    const rootPath = join(projectRoot, root.directory);
    const entries = await readDirectories(rootPath);
    for (const sourceId of entries) {
      const sourcePath = join(rootPath, sourceId);
      const metadata = await readLegacyMetadata(root.directory, sourcePath, sourceId, defaultLanguage);
      const inventory = await listRegularFiles(sourcePath);
      raw.push({
        sourceDirectory: root.directory,
        sourceId,
        profileId: root.profileId,
        title: metadata.title,
        language: metadata.language,
        ...(metadata.parentSourceId ? { parentSourceId: metadata.parentSourceId } : {}),
        files: inventory.files,
        skippedSymlinks: inventory.skippedSymlinks,
      });
    }
  }

  const used = new Set<string>();
  return raw.map((candidate) => {
    const preferred = safeResourceId(candidate.sourceId, `${candidate.sourceDirectory}-${candidate.sourceId}`);
    const workId = uniqueWorkId(preferred, candidate.sourceDirectory, used);
    used.add(workId);
    return { ...candidate, workId };
  });
}

export async function migrateLegacyProject(input: {
  readonly projectRoot: string;
  readonly dryRun?: boolean;
  readonly now?: string;
}): Promise<LegacyMigrationReport> {
  const existing = await readCompletedReport(input.projectRoot);
  if (existing) return existing;

  const startedAt = input.now ?? new Date().toISOString();
  const works = await scanLegacyWorks(input.projectRoot);
  const warnings = works.flatMap((work) => work.skippedSymlinks.map((path) => (
    `${work.sourceDirectory}/${work.sourceId}/${path}: symbolic link skipped`
  )));
  const planned: LegacyMigrationReport = {
    version: HARNESS_VERSION,
    migrationId: MIGRATION_ID,
    status: "planned",
    startedAt,
    backupPath: MIGRATION_BACKUP,
    works,
    warnings,
  };
  if (input.dryRun) return planned;
  if (works.length === 0) {
    const completed = { ...planned, status: "completed" as const, completedAt: startedAt };
    await writeReport(input.projectRoot, completed);
    return completed;
  }
  if (await pathExists(join(input.projectRoot, "works"))) {
    throw new Error("Cannot migrate legacy layout: works/ already exists without a completed migration report");
  }
  if (await pathExists(join(input.projectRoot, MIGRATION_BACKUP))) {
    throw new Error("Cannot migrate legacy layout: backup destination already exists");
  }

  const stageRoot = join(input.projectRoot, MIGRATION_STAGE);
  const stageWorks = join(stageRoot, "works");
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageWorks, { recursive: true });
  const bySource = new Map(works.map((work) => [`${work.sourceDirectory}\0${work.sourceId}`, work]));

  try {
    for (const candidate of works) {
      const source = join(input.projectRoot, candidate.sourceDirectory, candidate.sourceId);
      const target = join(stageWorks, candidate.workId);
      await mkdir(target, { recursive: true });
      await cp(source, join(target, "source"), {
        recursive: true,
        dereference: false,
        filter: async (path) => !(await lstat(path)).isSymbolicLink(),
      });
      const manifest = await buildMigratedManifest({
        projectRoot: input.projectRoot,
        candidate,
        startedAt,
        resolveParent: (sourceId) => bySource.get(`books\0${sourceId}`)?.workId,
      });
      await writeFile(join(target, "work.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    }

    await validateStagedWorks(stageWorks, works);
    const movedRoots: string[] = [];
    await mkdir(join(input.projectRoot, MIGRATION_BACKUP), { recursive: true });
    try {
      for (const root of LEGACY_ROOTS) {
        const source = join(input.projectRoot, root.directory);
        if (!await pathExists(source)) continue;
        await rename(source, join(input.projectRoot, MIGRATION_BACKUP, root.directory));
        movedRoots.push(root.directory);
      }
      await rename(stageWorks, join(input.projectRoot, "works"));
      const completed: LegacyMigrationReport = {
        ...planned,
        status: "completed",
        completedAt: new Date().toISOString(),
      };
      await writeReport(input.projectRoot, completed);
      await rm(stageRoot, { recursive: true, force: true });
      return completed;
    } catch (error) {
      if (await pathExists(join(input.projectRoot, "works"))) {
        await rename(join(input.projectRoot, "works"), stageWorks).catch(() => undefined);
      }
      for (const directory of movedRoots.reverse()) {
        await rename(
          join(input.projectRoot, MIGRATION_BACKUP, directory),
          join(input.projectRoot, directory),
        ).catch(() => undefined);
      }
      await rm(join(input.projectRoot, MIGRATION_BACKUP), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function buildMigratedManifest(input: {
  readonly projectRoot: string;
  readonly candidate: LegacyMigrationCandidate;
  readonly startedAt: string;
  readonly resolveParent: (sourceId: string) => string | undefined;
}): Promise<WorkManifest> {
  const sourceDir = join(input.projectRoot, input.candidate.sourceDirectory, input.candidate.sourceId);
  const sourceStat = await stat(sourceDir);
  const createdAt = validDate(sourceStat.birthtime) ? sourceStat.birthtime.toISOString() : input.startedAt;
  const updatedAt = validDate(sourceStat.mtime) ? sourceStat.mtime.toISOString() : input.startedAt;
  const artifacts: ArtifactManifest[] = [];
  for (const relativePath of input.candidate.files) {
    const sourcePath = join(sourceDir, relativePath);
    const bytes = await readFile(sourcePath);
    const revision = ArtifactRevisionSchema.parse({
      id: "imported-v1",
      parentRevisionId: null,
      path: join("source", relativePath),
      contentType: contentTypeFor(relativePath),
      status: "accepted",
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.byteLength,
      createdAt: updatedAt,
    });
    artifacts.push(ArtifactManifestSchema.parse({
      id: artifactIdFor(relativePath),
      kind: artifactKindFor(relativePath),
      currentRevisionId: revision.id,
      revisions: [revision],
      metadata: { legacyPath: relativePath },
    }));
  }
  const lineage: WorkLineage[] = [];
  if (input.candidate.parentSourceId) {
    const sourceWorkId = input.resolveParent(input.candidate.parentSourceId);
    if (sourceWorkId) lineage.push({ relation: "derived-from", sourceWorkId });
  }
  return WorkManifestSchema.parse({
    version: HARNESS_VERSION,
    id: input.candidate.workId,
    title: input.candidate.title,
    profileId: input.candidate.profileId,
    language: input.candidate.language,
    status: "active",
    lineage,
    artifacts,
    metadata: {
      migratedFrom: `${input.candidate.sourceDirectory}/${input.candidate.sourceId}`,
    },
    createdAt,
    updatedAt,
  });
}

async function validateStagedWorks(
  stageWorks: string,
  works: ReadonlyArray<LegacyMigrationCandidate>,
): Promise<void> {
  for (const work of works) {
    const raw = await readFile(join(stageWorks, work.workId, "work.json"), "utf-8");
    const manifest = WorkManifestSchema.parse(JSON.parse(raw));
    for (const artifact of manifest.artifacts) {
      const revision = artifact.revisions.find((item) => item.id === artifact.currentRevisionId);
      if (!revision) throw new Error(`Migrated artifact has no accepted revision: ${work.workId}.${artifact.id}`);
      await access(join(stageWorks, work.workId, revision.path));
    }
  }
}

async function readLegacyMetadata(
  directory: string,
  sourcePath: string,
  sourceId: string,
  defaultLanguage: string,
): Promise<{ readonly title: string; readonly language: string; readonly parentSourceId?: string }> {
  const candidates = directory === "books"
    ? ["book.json"]
    : directory === "worlds"
      ? ["world.json"]
      : directory === "translations"
        ? ["manifest.json"]
        : directory === "interactive-films"
          ? ["story-graph.json", "status.json"]
          : ["status.json"];
  for (const file of candidates) {
    try {
      const value = JSON.parse(await readFile(join(sourcePath, file), "utf-8")) as Record<string, unknown>;
      const title = stringValue(value.title) ?? stringValue(value.sourceTitle) ?? sourceId;
      const language = stringValue(value.language) ?? stringValue(value.targetLanguage) ?? defaultLanguage;
      const parentSourceId = stringValue(value.parentBookId);
      return { title, language, ...(parentSourceId ? { parentSourceId } : {}) };
    } catch {
      // Try the next authoritative metadata file.
    }
  }
  const markdownTitle = await firstMarkdownTitle(sourcePath);
  return { title: markdownTitle ?? sourceId, language: defaultLanguage };
}

async function firstMarkdownTitle(root: string): Promise<string | undefined> {
  const inventory = await listRegularFiles(root);
  for (const file of inventory.files.filter((path) => path.endsWith(".md"))) {
    const raw = await readFile(join(root, file), "utf-8").catch(() => "");
    const heading = /^#\s+(.+?)\s*$/mu.exec(raw)?.[1]?.trim();
    if (heading) return heading;
  }
  return undefined;
}

async function listRegularFiles(root: string): Promise<{
  readonly files: string[];
  readonly skippedSymlinks: string[];
}> {
  const files: string[] = [];
  const skippedSymlinks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(relativePath);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  await visit(root);
  return { files, skippedSymlinks };
}

async function readDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readProjectLanguage(projectRoot: string): Promise<string> {
  try {
    const config = JSON.parse(await readFile(join(projectRoot, "inkos.json"), "utf-8")) as Record<string, unknown>;
    return stringValue(config.language) ?? "zh";
  } catch {
    return "zh";
  }
}

function uniqueWorkId(preferred: string, sourceDirectory: string, used: ReadonlySet<string>): string {
  if (!used.has(preferred)) return preferred;
  const prefixed = safeResourceId(`${sourceDirectory}-${preferred}`, sourceDirectory);
  if (!used.has(prefixed)) return prefixed;
  let suffix = 2;
  while (used.has(`${prefixed}-${suffix}`)) suffix += 1;
  return `${prefixed}-${suffix}`;
}

function safeResourceId(value: string, fallback: string): string {
  const clean = value
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\:*?"'`{}<>|]/gu, "-")
    .replace(/\.\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return clean && clean !== "." && clean !== ".."
    ? clean
    : `legacy-${createHash("sha256").update(fallback).digest("hex").slice(0, 12)}`;
}

function artifactIdFor(path: string): string {
  const readable = basename(path, extname(path))
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "artifact";
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}

function artifactKindFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if ([".md", ".txt"].includes(extension)) return "text";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return "image";
  if ([".json", ".jsonl", ".db", ".sqlite"].includes(extension)) return "state";
  return "file";
}

function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  if (extension === ".json" || extension === ".jsonl") return "application/json";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readCompletedReport(projectRoot: string): Promise<LegacyMigrationReport | undefined> {
  try {
    const parsed = LegacyMigrationReportSchema.parse(
      JSON.parse(await readFile(join(projectRoot, MIGRATION_REPORT), "utf-8")),
    );
    return parsed.status === "completed" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeReport(projectRoot: string, report: LegacyMigrationReport): Promise<void> {
  const path = join(projectRoot, MIGRATION_REPORT);
  await mkdir(join(projectRoot, ".inkos", "migrations"), { recursive: true });
  await writeFile(path, `${JSON.stringify(LegacyMigrationReportSchema.parse(report), null, 2)}\n`, "utf-8");
}
