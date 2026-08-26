import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CreativeEpisodeStore,
  createExportBookTool,
  createWorkManifest,
  executeExplicitCapabilityTool,
  saveWorkManifest,
  workDirectory,
} from "../harness/index.js";

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
});
