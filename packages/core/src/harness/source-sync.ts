import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { toPosixPath } from "../utils/posix-path.js";
import {
  ArtifactManifestSchema,
  ArtifactRevisionSchema,
  WorkManifestSchema,
  type ArtifactManifest,
  type WorkManifest,
} from "./contracts.js";
import { loadWorkManifest, saveWorkManifest, workDirectory } from "./work-store.js";
import { createWorkManifest } from "./work-store.js";
import { createCurrentArtifact } from "./artifact-revisions.js";
import type { AtomicFileWrite } from "../utils/atomic-file-set.js";

export function createInitialWorkManifestWrite(input: {
  readonly workId: string;
  readonly title: string;
  readonly profileId: string;
  readonly language: string;
  readonly writes: ReadonlyArray<AtomicFileWrite>;
  readonly createdAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): { readonly manifest: WorkManifest; readonly write: AtomicFileWrite } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const workRoot = join("works", input.workId);
  const work = createWorkManifest({
    id: input.workId,
    title: input.title,
    profileId: input.profileId,
    language: input.language,
    now: createdAt,
    metadata: input.metadata,
  });
  const artifacts = input.writes.map((write) => {
    const workPath = toPosixPath(relative(workRoot, write.relativePath));
    if (workPath === ".." || workPath.startsWith("../")) {
      throw new Error(`Initial work artifact is outside ${workRoot}: ${write.relativePath}`);
    }
    return createCurrentArtifact({
      artifactId: artifactIdFor(workPath),
      artifactKind: artifactKindFor(workPath),
      path: workPath,
      content: write.content,
      contentType: contentTypeFor(workPath),
      createdAt,
      metadata: { sourcePath: toPosixPath(write.relativePath) },
    });
  });
  const manifest = WorkManifestSchema.parse({ ...work, artifacts });
  return {
    manifest,
    write: {
      relativePath: join(workRoot, "work.json"),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  };
}

export async function syncWorkSourceArtifacts(input: {
  readonly projectRoot: string;
  readonly workId: string;
  readonly accept: boolean;
  readonly episodeId?: string;
  readonly updatedAt?: string;
}): Promise<WorkManifest> {
  const manifest = await loadWorkManifest(input.projectRoot, input.workId);
  const root = workDirectory(input.projectRoot, input.workId);
  const sourceRoot = join(root, "source");
  const files = await listFiles(sourceRoot);
  const presentWorkPaths = new Set(files.map((file) => toPosixPath(join("source", file))));
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const artifacts = [...manifest.artifacts];

  for (const file of files) {
    const workPath = toPosixPath(join("source", file));
    const bytes = await readFile(join(sourceRoot, file));
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const existingIndex = artifacts.findIndex((artifact) => (
      artifact.revisions.some((revision) => revision.path === workPath)
    ));
    if (existingIndex < 0) {
      const revisionId = revisionIdFor(checksum);
      const revision = ArtifactRevisionSchema.parse({
        id: revisionId,
        parentRevisionId: null,
        path: workPath,
        contentType: contentTypeFor(file),
        status: input.accept ? "current" : "candidate",
        checksum,
        byteLength: bytes.byteLength,
        episodeId: input.episodeId,
        createdAt: updatedAt,
      });
      artifacts.push(ArtifactManifestSchema.parse({
        id: artifactIdFor(file),
        kind: artifactKindFor(file),
        currentRevisionId: input.accept ? revision.id : null,
        revisions: [revision],
        metadata: { sourcePath: toPosixPath(join("works", input.workId, workPath)) },
      }));
      continue;
    }
    const existing = artifacts[existingIndex]!;
    const current = existing.revisions.find((revision) => revision.id === existing.currentRevisionId);
    if (current?.checksum === checksum) continue;
    const revisionId = revisionIdFor(checksum);
    const prior = existing.revisions.find((revision) => revision.id === revisionId);
    const revision = prior ?? ArtifactRevisionSchema.parse({
      id: revisionId,
      parentRevisionId: existing.currentRevisionId,
      path: workPath,
      contentType: contentTypeFor(file),
      status: input.accept ? "current" : "candidate",
      checksum,
      byteLength: bytes.byteLength,
      episodeId: input.episodeId,
      createdAt: updatedAt,
    });
    artifacts[existingIndex] = ArtifactManifestSchema.parse({
      ...existing,
      currentRevisionId: input.accept ? revision.id : existing.currentRevisionId,
      revisions: prior
        ? existing.revisions.map((item) => {
            if (item.id === prior.id && input.accept) return { ...item, status: "current" as const };
            if (input.accept && item.status === "current") return { ...item, status: "superseded" as const };
            return item;
          })
        : [
            ...existing.revisions.map((item) => (
              input.accept && item.status === "current" ? { ...item, status: "superseded" as const } : item
            )),
            revision,
          ],
    });
  }

  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index]!;
    const current = artifact.revisions.find((revision) => revision.id === artifact.currentRevisionId);
    if (!input.accept || !current?.path.startsWith("source/") || presentWorkPaths.has(current.path)) continue;
    artifacts[index] = ArtifactManifestSchema.parse({
      ...artifact,
      currentRevisionId: null,
      revisions: artifact.revisions.map((revision) => (
        revision.id === artifact.currentRevisionId && revision.status === "current"
          ? { ...revision, status: "superseded" as const }
          : revision
      )),
      metadata: { ...artifact.metadata, removedAt: updatedAt, removedPath: current.path },
    });
  }

  const next = WorkManifestSchema.parse({ ...manifest, artifacts, updatedAt });
  await saveWorkManifest(input.projectRoot, next);
  return next;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if ((await lstat(path)).isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  await visit(root);
  return files;
}

function revisionIdFor(checksum: string): string {
  return `rev-${checksum.slice("sha256:".length, "sha256:".length + 16)}`;
}

function artifactIdFor(path: string): string {
  const readable = basename(path, extname(path))
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "artifact";
  return `${readable}-${createHash("sha256").update(path).digest("hex").slice(0, 10)}`;
}

function artifactKindFor(path: string): string {
  if (path.endsWith("manifest.json")) return "manifest";
  if (path.endsWith("glossary.json")) return "glossary";
  if (path.endsWith("review-report.md")) return "review";
  if (path.endsWith("script.md")) return "script";
  if (path.endsWith("storyboard.md")) return "storyboard";
  if (path.endsWith("image-prompts.md")) return "image-prompt";
  if (path.endsWith("assets.json")) return "asset-manifest";
  if (path.endsWith("story-graph.json")) return "story-graph";
  if (path.includes(`${join("translated", "")}`)) return "translation-chapter";
  if (path.includes(`${join("source", "")}`)) return "source-chapter";
  if (/\.(?:png|jpe?g|webp|gif)$/iu.test(path)) return "image";
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
