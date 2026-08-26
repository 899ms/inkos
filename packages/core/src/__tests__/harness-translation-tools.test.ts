import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CreativeEpisodeStore,
  createTranslationCreateTool,
  createTranslationExportTool,
  createTranslationRunTool,
  executeExplicitCapabilityTool,
  loadWorkManifest,
} from "../harness/index.js";

describe("translation capability tools", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates, runs, and exports one translation Work through Episodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-translation-capability-"));
    roots.push(root);
    await writeFile(join(root, "source.md"), "# Arrival\n\nThe rain began.\n");
    const created = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "translation", actionId: "translation_create", profileId: "translation" },
      tool: createTranslationCreateTool(root),
      parameters: {
        filePath: "source.md",
        sourceLanguage: "English",
        targetLanguage: "Chinese (Simplified)",
        title: "Rain Translation",
      },
      episodeId: "episode-translation-create",
    });
    const workId = (created.data as { manifest: { id: string } }).manifest.id;
    await expect(loadWorkManifest(root, workId)).resolves.toMatchObject({ profileId: "translation" });

    const pipeline = {
      runWithAgentContext: async (_context: unknown, task: () => Promise<unknown>) => task(),
      createAgentContext: () => ({ client: {}, model: "fake" }),
    };
    const run = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "translation", actionId: "translation_run", profileId: "translation" },
      tool: createTranslationRunTool(pipeline as never, root, workId, {
        createModel: () => ({
          translateSegments: async (request) => ({
            segments: request.segments.map((segment) => ({ index: segment.index, target: `译：${segment.source}` })),
            glossary: [],
          }),
          reviewChapter: async () => ({ passed: true, summary: "OK", issues: [] }),
        }),
      }),
      workId,
      parameters: { batchSize: 8 },
      episodeId: "episode-translation-run",
    });
    expect(run).toMatchObject({ status: "success", data: { kind: "translation_completed", workId } });

    const exported = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "translation", actionId: "translation_export", profileId: "translation" },
      tool: createTranslationExportTool(root, workId),
      workId,
      parameters: { format: "md" },
      episodeId: "episode-translation-export",
    });
    const outputPath = (exported.data as { outputPath: string }).outputPath;
    await expect(readFile(outputPath, "utf-8")).resolves.toContain("译：The rain began.");

    const episodes = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
    expect(episodes.listEpisodes({ workId })).toHaveLength(2);
    expect(episodes.requireEpisode("episode-translation-create").workId).toBeNull();
    episodes.close();
  });
});
