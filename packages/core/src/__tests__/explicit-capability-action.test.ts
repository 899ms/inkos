import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  CreativeEpisodeStore,
  createExportBookTool,
  createWriteTruthFileTool,
  createWorkManifest,
  executeExplicitCapabilityTool,
  loadWorkManifest,
  saveWorkManifest,
  syncWorkSourceArtifacts,
  workDirectory,
} from "../harness/index.js";
import { StateManager } from "../state/manager.js";
import { createReadTool } from "../agent/agent-tools.js";

describe("explicit capability actions", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("exports a Work through a typed action and records a completed Episode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-explicit-action-"));
    roots.push(root);
    const work = createWorkManifest({
      id: "demo-book",
      title: "Demo Book",
      profileId: "longform-novel",
      language: "en",
    });
    await saveWorkManifest(root, work);
    const sourceDir = join(workDirectory(root, work.id), "source");
    await mkdir(join(sourceDir, "chapters"), { recursive: true });
    await writeFile(join(sourceDir, "chapters", "0001_Opening.md"), "# Opening\n\nA real chapter.\n");
    const outputPath = join(sourceDir, "demo-book.md");
    const state = {
      bookDir: () => sourceDir,
      loadBookConfig: async () => ({ title: work.title, language: work.language }),
      loadChapterIndex: async () => [{ number: 1, status: "approved", wordCount: 3 }],
    };

    const result = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: {
        capabilityId: "longform",
        actionId: "export_book",
        profileId: "longform-novel",
      },
      tool: createExportBookTool(state, work.id, { outputPath }),
      parameters: { format: "md", approvedOnly: true },
      workId: work.id,
      episodeId: "episode-export",
    });

    expect(result).toMatchObject({
      status: "success",
      data: { outputPath, chaptersExported: 1, format: "md" },
    });
    await expect(readFile(outputPath, "utf-8")).resolves.toContain("A real chapter.");
    const episodes = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
    expect(episodes.requireEpisode("episode-export")).toMatchObject({
      workId: work.id,
      profileId: "longform-novel",
      status: "completed",
    });
    expect(episodes.listEvents("episode-export").map((event) => event.type)).toEqual([
      "episode-started",
      "action-started",
      "action-completed",
      "episode-completed",
    ]);
    episodes.close();
  });

  it("refreshes Work artifact revisions after a deterministic edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-explicit-edit-"));
    roots.push(root);
    const work = createWorkManifest({
      id: "edit-book",
      title: "Edit Book",
      profileId: "longform-novel",
      language: "en",
    });
    await saveWorkManifest(root, work);
    const state = new StateManager(root);
    await state.saveBookConfig(work.id, {
      id: work.id,
      title: work.title,
      platform: "other",
      genre: "mystery",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2000,
      language: "en",
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
    });
    await state.ensureControlDocuments(work.id);
    await syncWorkSourceArtifacts({ projectRoot: root, workId: work.id });

    const result = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: {
        capabilityId: "longform",
        actionId: "write_truth_file",
        profileId: "longform-novel",
      },
      tool: createWriteTruthFileTool(root, work.id),
      parameters: {
        fileName: "current_focus.md",
        content: "# Current Focus\n\nFollow the missing ledger.\n",
      },
      workId: work.id,
      episodeId: "episode-edit",
    });

    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ workId: work.id, path: "source/story/current_focus.md" }),
    ]));
    const updated = await loadWorkManifest(root, work.id);
    const focus = updated.artifacts.find((artifact) => (
      artifact.revisions.some((revision) => revision.path === "source/story/current_focus.md")
    ));
    expect(focus?.revisions).toHaveLength(2);
    expect(focus?.currentRevisionId).toBe(focus?.revisions[1]?.id);
  });

  it("records an incomplete architect result as a failed action instead of success", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-explicit-incomplete-"));
    roots.push(root);
    const result = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: {
        capabilityId: "longform",
        actionId: "sub_agent",
        profileId: "longform-novel",
      },
      tool: {
        name: "sub_agent",
        label: "Create book",
        description: "Create a book.",
        parameters: Type.Object({ agent: Type.String() }),
        async execute() {
          return {
            content: [{ type: "text", text: "Foundation incomplete." }],
            details: { kind: "architect_incomplete", missing: ["story_frame"] },
          };
        },
      } as any,
      parameters: { agent: "architect" },
      episodeId: "episode-incomplete",
    });

    expect(result).toMatchObject({ status: "error", retry: { allowed: true } });
    const episodes = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
    expect(episodes.requireEpisode("episode-incomplete").status).toBe("failed");
    episodes.close();
  });

  it("does not mutate or resync Work metadata for concurrent read actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-explicit-read-"));
    roots.push(root);
    const work = createWorkManifest({
      id: "read-work",
      title: "Read Work",
      profileId: "longform-novel",
      language: "en",
    });
    await saveWorkManifest(root, work);
    await mkdir(join(workDirectory(root, work.id), "source"), { recursive: true });
    await writeFile(join(workDirectory(root, work.id), "source", "note.md"), "Stable note.\n");
    const runRead = (episodeId: string) => executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "workspace", actionId: "read", profileId: "workspace-default" },
      tool: createReadTool(root, { scope: "project" }),
      parameters: { path: "works/read-work/source/note.md" },
      workId: work.id,
      episodeId,
    });

    const [first, second] = await Promise.all([runRead("episode-read-1"), runRead("episode-read-2")]);

    expect(first.content).toContain("Stable note.");
    expect(second.content).toContain("Stable note.");
    expect(await loadWorkManifest(root, work.id)).toEqual(work);
  });

  it("keeps deleted source history but removes its authoritative current revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-source-removal-"));
    roots.push(root);
    const work = createWorkManifest({
      id: "removal-work",
      title: "Removal Work",
      profileId: "script",
      language: "en",
    });
    await saveWorkManifest(root, work);
    const sourceDir = join(workDirectory(root, work.id), "source");
    await mkdir(sourceDir, { recursive: true });
    const scriptPath = join(sourceDir, "script.md");
    await writeFile(scriptPath, "# Draft\n");
    const first = await syncWorkSourceArtifacts({ projectRoot: root, workId: work.id });
    const original = first.artifacts.find((artifact) => (
      artifact.revisions.some((revision) => revision.path === "source/script.md")
    ));
    expect(original?.currentRevisionId).toBeTruthy();

    await unlink(scriptPath);
    const second = await syncWorkSourceArtifacts({ projectRoot: root, workId: work.id });
    const removed = second.artifacts.find((artifact) => artifact.id === original?.id);
    expect(removed?.currentRevisionId).toBeNull();
    expect(removed?.revisions).toEqual(original?.revisions);
    expect(removed?.metadata).toMatchObject({ removedPath: "source/script.md" });
  });
});
