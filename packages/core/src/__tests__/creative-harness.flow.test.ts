import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionConfirmationRequiredError,
  ActionResultSchema,
  CapabilityRegistry,
  CreativeEpisodeStore,
  CreativeHarnessRuntime,
  createBuiltInWorkProfileRegistry,
  createInitialWorkManifestWrite,
  createReplaceWorkArtifactTool,
  createTranslationCreateTool,
  createTranslationExportTool,
  createTranslationRunTool,
  defineCapabilityAction,
  executeExplicitCapabilityTool,
  loadWorkManifest,
  listWorkManifests,
} from "../harness/index.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { loadTranslationManifest } from "../translation/run-store.js";

describe("creative harness mini-flows", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates, runs, exports, and traces one translation Work", async () => {
    const root = await tempProject("translation");
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
      episodeId: "episode-create",
    });
    const workId = (created.data as { manifest: { id: string } }).manifest.id;
    const pipeline = {
      runWithAgentContext: async (_context: unknown, task: () => Promise<unknown>) => task(),
      createAgentContext: () => ({ client: {}, model: "scripted" }),
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
          reviewChapter: async () => ({ summary: "OK", issues: [] }),
        }),
      }),
      workId,
      parameters: { batchSize: 8 },
      episodeId: "episode-run",
    });
    const exported = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "translation", actionId: "translation_export", profileId: "translation" },
      tool: createTranslationExportTool(root, workId),
      workId,
      parameters: { format: "md" },
      episodeId: "episode-export",
    });

    const manifest = await loadWorkManifest(root, workId);
    const outputPath = (exported.data as { outputPath: string }).outputPath;
    const episodes = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
    expect({
      create: created.status,
      run: run.status,
      export: exported.status,
      profile: manifest.profileId,
      episodes: episodes.listEpisodes({ workId }).map((episode) => episode.status),
    }).toEqual({
      create: "success",
      run: "success",
      export: "success",
      profile: "translation",
      episodes: ["completed", "completed", "completed"],
    });
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    expect((await readFile(outputPath)).byteLength).toBeGreaterThan(0);
    expect(episodes.requireEpisode("episode-create").workId).toBe(workId);
    episodes.close();
  });

  it("enforces action authority, versions an accepted artifact, and recovers interruption", async () => {
    const root = await tempProject("mutation");
    const initial = createInitialWorkManifestWrite({
      workId: "script-work",
      title: "Script Work",
      profileId: "script",
      language: "en",
      writes: [{ relativePath: "works/script-work/source/script.md", content: "# Draft\n" }],
    });
    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "works/script-work/source/script.md", content: "# Draft\n" },
        initial.write,
      ],
    });
    const before = await loadWorkManifest(root, "script-work");
    const currentRevisionId = before.artifacts[0]!.currentRevisionId!;
    await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "workspace", actionId: "replace_work_artifact", profileId: "script" },
      tool: createReplaceWorkArtifactTool(root, "script-work"),
      workId: "script-work",
      parameters: {
        path: "source/script.md",
        content: "# Revised\n",
        expectedRevisionId: currentRevisionId,
      },
      episodeId: "episode-edit",
    });

    const capabilities = new CapabilityRegistry();
    capabilities.register({
      id: "script",
      title: "Script",
      description: "",
      actions: [defineCapabilityAction({
        id: "commit",
        title: "Commit",
        description: "Commit script state.",
        risk: "recoverable-write",
        requiresConfirmation: true,
        parameters: Type.Object({}),
        async execute() {
          return ActionResultSchema.parse({
            status: "success",
            summary: "committed",
            nextActions: [],
            artifacts: [],
            observations: [],
          });
        },
      })],
    });
    const episodes = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
    const runtime = new CreativeHarnessRuntime(root, capabilities, createBuiltInWorkProfileRegistry(), episodes);
    const handle = runtime.startEpisode({
      episodeId: "episode-authority",
      profileId: "script",
      work: await loadWorkManifest(root, "script-work"),
    });
    await expect(runtime.executeAction({
      handle,
      capabilityId: "script",
      actionId: "commit",
      parameters: {},
      source: "agent",
    })).rejects.toBeInstanceOf(ActionConfirmationRequiredError);
    await runtime.executeAction({
      handle,
      capabilityId: "script",
      actionId: "commit",
      parameters: {},
      source: "agent",
      confirmed: true,
    });
    runtime.finishEpisode(handle, "completed");
    episodes.create({
      version: 2,
      id: "episode-interrupted",
      workId: "script-work",
      profileId: "script",
      status: "running",
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
    });
    expect(episodes.recoverInterruptedEpisodes("2026-08-26T00:01:00.000Z")).toBe(1);

    const after = await loadWorkManifest(root, "script-work");
    expect({
      revisions: after.artifacts[0]?.revisions.length,
      currentRevisionChanged: after.artifacts[0]?.currentRevisionId !== currentRevisionId,
      authorityEpisode: episodes.requireEpisode("episode-authority").status,
      interruptedEpisode: episodes.requireEpisode("episode-interrupted").status,
    }).toEqual({
      revisions: 2,
      currentRevisionChanged: true,
      authorityEpisode: "completed",
      interruptedEpisode: "failed",
    });
    episodes.close();
  });

  it("lists canonical Works without treating runtime-only directories as Works", async () => {
    const root = await tempProject("work-list");
    const initial = createInitialWorkManifestWrite({
      workId: "script-work",
      title: "Script Work",
      profileId: "script",
      language: "en",
      writes: [{ relativePath: "works/script-work/source/script.md", content: "# Draft\n" }],
    });
    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "works/script-work/source/script.md", content: "# Draft\n" },
        initial.write,
      ],
    });
    await mkdir(join(root, "works", "play-session", "source", "runs", "main"), { recursive: true });

    expect((await listWorkManifests(root)).map((work) => work.id)).toEqual(["script-work"]);
  });

  async function tempProject(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `inkos-${name}-flow-`));
    roots.push(root);
    await writeFile(join(root, "inkos.json"), JSON.stringify({ language: "en" }));
    return root;
  }
});
