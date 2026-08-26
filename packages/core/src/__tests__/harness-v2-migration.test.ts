import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWorkManifest,
  migrateLegacyProject,
  scanLegacyWorks,
} from "../harness/index.js";

describe("v2 legacy work migration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("discovers every legacy creation root and resolves duplicate ids", async () => {
    const root = await createLegacyProject();
    const candidates = await scanLegacyWorks(root);
    expect(candidates.map((candidate) => candidate.profileId)).toEqual([
      "longform-novel",
      "short-fiction",
      "script",
      "storyboard",
      "interactive-film",
      "translation",
      "interactive-world",
      "visual-asset",
    ]);
    expect(new Set(candidates.map((candidate) => candidate.workId)).size).toBe(8);
    expect(candidates.find((candidate) => candidate.sourceDirectory === "books")).toMatchObject({
      workId: "同名项目",
      title: "长篇原作",
      language: "zh",
    });
    expect(candidates.find((candidate) => candidate.sourceDirectory === "shorts")?.workId)
      .toBe("shorts-同名项目");
  });

  it("dry-runs without changing the project", async () => {
    const root = await createLegacyProject();
    const report = await migrateLegacyProject({
      projectRoot: root,
      dryRun: true,
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(report.status).toBe("planned");
    await expect(access(join(root, "books", "同名项目", "book.json"))).resolves.toBeUndefined();
    await expect(access(join(root, "works"))).rejects.toThrow();
  });

  it("backs up the old layout, creates validated works, and is idempotent", async () => {
    const root = await createLegacyProject();
    const first = await migrateLegacyProject({
      projectRoot: root,
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(first.status).toBe("completed");
    await expect(access(join(root, "books"))).rejects.toThrow();
    await expect(access(join(root, ".inkos", "migration-backups", "work-layout-v1", "books", "同名项目", "book.json")))
      .resolves.toBeUndefined();

    const book = await loadWorkManifest(root, "同名项目");
    expect(book.profileId).toBe("longform-novel");
    expect(book.artifacts.length).toBeGreaterThan(1);
    const bookJson = book.artifacts.find((artifact) => artifact.metadata.legacyPath === "book.json");
    expect(bookJson?.currentRevisionId).toBe("imported-v1");
    await expect(access(join(root, "works", "同名项目", bookJson!.revisions[0]!.path))).resolves.toBeUndefined();

    const second = await migrateLegacyProject({ projectRoot: root });
    expect(second).toEqual(first);
    expect((await stat(join(root, "works"))).isDirectory()).toBe(true);
  });

  it("preserves long-form parent lineage", async () => {
    const root = await createLegacyProject();
    await mkdir(join(root, "books", "番外"), { recursive: true });
    await writeFile(join(root, "books", "番外", "book.json"), JSON.stringify({
      id: "番外",
      title: "番外",
      language: "zh",
      parentBookId: "同名项目",
    }));
    await migrateLegacyProject({ projectRoot: root, now: "2026-08-26T00:00:00.000Z" });
    expect((await loadWorkManifest(root, "番外")).lineage).toEqual([
      { relation: "derived-from", sourceWorkId: "同名项目" },
    ]);
  });

  async function createLegacyProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-migrate-"));
    roots.push(root);
    await writeFile(join(root, "inkos.json"), JSON.stringify({ language: "zh" }));
    const fixtures = [
      ["books", "book.json", JSON.stringify({ id: "同名项目", title: "长篇原作", language: "zh" })],
      ["shorts", "status.json", JSON.stringify({ id: "同名项目", status: "complete" })],
      ["dramas", "status.json", JSON.stringify({ id: "同名项目", status: "complete" })],
      ["storyboards", "status.json", JSON.stringify({ id: "同名项目", status: "complete" })],
      ["interactive-films", "story-graph.json", JSON.stringify({ id: "同名项目", title: "互动影游" })],
      ["translations", "manifest.json", JSON.stringify({ id: "同名项目", sourceTitle: "Translation", targetLanguage: "en" })],
      ["worlds", "world.json", JSON.stringify({ id: "同名项目", title: "开放世界", language: "zh" })],
      ["covers", "cover-prompt.md", "# Cover\n"],
    ] as const;
    for (const [directory, file, content] of fixtures) {
      await mkdir(join(root, directory, "同名项目"), { recursive: true });
      await writeFile(join(root, directory, "同名项目", file), content);
    }
    await mkdir(join(root, "books", "同名项目", "chapters"), { recursive: true });
    await writeFile(join(root, "books", "同名项目", "chapters", "0001.md"), "# 第一章\n\n正文");
    return root;
  }
});

