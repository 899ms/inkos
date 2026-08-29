import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  migrateLegacyProject,
} from "../harness/index.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

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
          reviewChapter: async () => ({ passed: true, summary: "OK", issues: [] }),
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
          return ActionResultSchema.parse({ status: "success", summary: "committed" });
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

  it("moves every legacy creation root into canonical Works once", async () => {
    const root = await tempProject("migration");
    const fixtures = [
      ["books", "book.json", { id: "same", title: "Novel", language: "en" }],
      ["shorts", "status.json", { id: "same", status: "complete" }],
      ["dramas", "status.json", { id: "same", status: "complete" }],
      ["storyboards", "status.json", { id: "same", status: "complete" }],
      ["interactive-films", "story-graph.json", { id: "same", title: "Film" }],
      ["translations", "manifest.json", { id: "same", sourceTitle: "Translation", targetLanguage: "en" }],
      ["worlds", "world.json", { id: "same", title: "World", language: "en" }],
      ["covers", "cover-prompt.md", null],
    ] as const;
    for (const [directory, file, value] of fixtures) {
      await mkdir(join(root, directory, "same"), { recursive: true });
      await writeFile(join(root, directory, "same", file), value === null ? "# Cover\n" : JSON.stringify(value));
    }
    await mkdir(join(root, "books", "spinoff"), { recursive: true });
    await writeFile(join(root, "books", "spinoff", "book.json"), JSON.stringify({
      id: "spinoff",
      title: "Spinoff",
      language: "en",
      parentBookId: "same",
    }));

    const first = await migrateLegacyProject({ projectRoot: root, now: "2026-08-26T00:00:00.000Z" });
    const second = await migrateLegacyProject({ projectRoot: root });
    const workDirectories = (await readdir(join(root, "works"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    const remainingRoots: string[] = [];
    for (const [directory] of fixtures) {
      if (await access(join(root, directory)).then(() => true).catch(() => false)) remainingRoots.push(directory);
    }

    expect({
      status: first.status,
      idempotent: second,
      workCount: workDirectories.length,
      remainingRoots,
      lineage: (await loadWorkManifest(root, "spinoff")).lineage,
    }).toEqual({
      status: "completed",
      idempotent: first,
      workCount: 9,
      remainingRoots: [],
      lineage: [{ relation: "derived-from", sourceWorkId: "same" }],
    });
  });

  async function tempProject(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `inkos-${name}-flow-`));
    roots.push(root);
    await writeFile(join(root, "inkos.json"), JSON.stringify({ language: "en" }));
    return root;
  }
});
