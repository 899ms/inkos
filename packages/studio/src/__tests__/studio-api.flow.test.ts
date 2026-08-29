import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAndPersistBookSession,
  createInitialWorkManifestWrite,
} from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";
import { loadStudioTaskSnapshot, saveStudioTaskSnapshot } from "../api/task-store.js";

describe("Studio API mini-flows", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-flow-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "flow-project",
      version: "2.0.0",
      language: "zh",
      llm: { model: "test-model", provider: "openai" },
      notify: [],
    }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes canonical Works and their accepted artifacts", async () => {
    const initial = createInitialWorkManifestWrite({
      workId: "night-script",
      title: "Night Script",
      profileId: "script",
      language: "en",
      writes: [{ relativePath: "works/night-script/source/script.md", content: "# Night Script\n" }],
    });
    await mkdir(join(root, "works", "night-script", "source"), { recursive: true });
    await writeFile(join(root, "works", "night-script", "source", "script.md"), "# Night Script\n");
    await writeFile(join(root, initial.write.relativePath), initial.write.content);
    const app = createStudioServer({} as never, root);

    const list = await app.request("/api/v1/works");
    const detail = await app.request("/api/v1/works/night-script");
    const listBody = await list.json() as { works: Array<{ id: string; profileId: string }> };
    const detailBody = await detail.json() as { work: { id: string; artifacts: unknown[] } };

    expect({
      listStatus: list.status,
      detailStatus: detail.status,
      works: listBody.works.map((work) => [work.id, work.profileId]),
      artifactCount: detailBody.work.artifacts.length,
    }).toEqual({
      listStatus: 200,
      detailStatus: 200,
      works: [["night-script", "script"]],
      artifactCount: 1,
    });
  });

  it("takes a translation upload through creation, inspection, and export", async () => {
    const app = createStudioServer({} as never, root);
    const source = "# 第一章 雨夜\n\n雨水落在旧码头。\n";
    const upload = await app.request("/api/v1/translations/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "source.md",
        dataUrl: `data:text/markdown;base64,${Buffer.from(source).toString("base64")}`,
      }),
    });
    const uploaded = await upload.json() as { storedPath: string };
    const create = await app.request("/api/v1/translations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: uploaded.storedPath,
        sourceLanguage: "zh",
        targetLanguage: "en",
        title: "Rain Translation",
      }),
    });
    const created = await create.json() as { projectId: string; manifest: { chapters: unknown[] } };
    const list = await app.request("/api/v1/translations");
    const listBody = await list.json() as { translations: Array<{ projectId: string }> };
    const detail = await app.request(`/api/v1/translations/${created.projectId}`);
    const detailBody = await detail.json() as { manifest: { id: string } };
    const exported = await app.request(`/api/v1/translations/${created.projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "md" }),
    });
    const exportBody = await exported.json() as { outputPath: string; chaptersExported: number };

    expect({
      statuses: [upload.status, create.status, list.status, detail.status, exported.status],
      projectId: detailBody.manifest.id,
      listedIds: listBody.translations.map((item) => item.projectId),
      sourceChapters: created.manifest.chapters.length,
      exportedChapters: exportBody.chaptersExported,
    }).toEqual({
      statuses: [200, 200, 200, 200, 200],
      projectId: created.projectId,
      listedIds: [created.projectId],
      sourceChapters: 1,
      exportedChapters: 1,
    });
    await expect(access(exportBody.outputPath)).resolves.toBeUndefined();
    expect((await readFile(exportBody.outputPath)).byteLength).toBeGreaterThan(0);
  });

  it("turns a server-interrupted task snapshot into a terminal session result", async () => {
    const sessionId = "flow-session";
    await createAndPersistBookSession(root, null, sessionId, "short");
    await saveStudioTaskSnapshot(root, {
      version: 1,
      sessionId,
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "short-task",
        tool: "short-fiction__short_fiction_run",
        label: "Short production",
        status: "running",
        startedAt: 10,
      },
    });
    const app = createStudioServer({} as never, root);

    const response = await app.request(`/api/v1/sessions/${sessionId}`);
    const body = await response.json() as { task: { execution: { status: string; completedAt?: number } } };
    const persisted = await loadStudioTaskSnapshot(root, sessionId);

    expect({
      responseStatus: response.status,
      responseTask: body.task.execution.status,
      persistedTask: persisted?.execution.status,
      completed: typeof body.task.execution.completedAt === "number",
    }).toEqual({
      responseStatus: 200,
      responseTask: "error",
      persistedTask: "error",
      completed: true,
    });
  });
});
