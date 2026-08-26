import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  HARNESS_VERSION,
  WorkResourceIdSchema,
  WorkManifestSchema,
  type WorkManifest,
} from "./contracts.js";

export const WORKS_DIRECTORY = "works";
export const WORK_MANIFEST_FILE = "work.json";

export function workDirectory(projectRoot: string, workId: string): string {
  return join(projectRoot, WORKS_DIRECTORY, WorkResourceIdSchema.parse(workId));
}

export function workManifestPath(projectRoot: string, workId: string): string {
  return join(workDirectory(projectRoot, workId), WORK_MANIFEST_FILE);
}

export function createWorkManifest(input: {
  readonly id: string;
  readonly title: string;
  readonly profileId: string;
  readonly language: string;
  readonly now?: string;
  readonly lineage?: WorkManifest["lineage"];
  readonly metadata?: WorkManifest["metadata"];
}): WorkManifest {
  const now = input.now ?? new Date().toISOString();
  return WorkManifestSchema.parse({
    version: HARNESS_VERSION,
    id: input.id,
    title: input.title,
    profileId: input.profileId,
    language: input.language,
    status: "active",
    lineage: input.lineage ?? [],
    artifacts: [],
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
}

export async function loadWorkManifest(projectRoot: string, workId: string): Promise<WorkManifest> {
  const content = await readFile(workManifestPath(projectRoot, workId), "utf-8");
  return WorkManifestSchema.parse(JSON.parse(content));
}

export async function saveWorkManifest(projectRoot: string, manifest: WorkManifest): Promise<void> {
  const parsed = WorkManifestSchema.parse(manifest);
  await commitAtomicFileSet({
    rootDir: projectRoot,
    writes: [{
      relativePath: join(WORKS_DIRECTORY, parsed.id, WORK_MANIFEST_FILE),
      content: `${JSON.stringify(parsed, null, 2)}\n`,
    }],
  });
}
