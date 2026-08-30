import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../api/server.js";
import { createAndPersistBookSession, createWorkManifest, loadStoryGraph, saveWorkManifest } from "@actalk/inkos-core";

const INKOS_CONFIG = JSON.stringify({
  name: "test-project",
  version: "0.1.0",
  language: "zh",
  llm: { model: "test-model", provider: "anthropic" },
  notify: [],
});

describe("Studio Pi mini-flow", () => {
  let root: string;
  const prev = process.env.INKOS_AGENT_LLM_STUB;
  const prevScenario = process.env.INKOS_AGENT_LLM_STUB_SCENARIO;
  beforeAll(() => {
    process.env.INKOS_AGENT_LLM_STUB = "1";
    process.env.INKOS_AGENT_LLM_STUB_SCENARIO = "interactive-film-structure";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.INKOS_AGENT_LLM_STUB;
    else process.env.INKOS_AGENT_LLM_STUB = prev;
    if (prevScenario === undefined) delete process.env.INKOS_AGENT_LLM_STUB_SCENARIO;
    else process.env.INKOS_AGENT_LLM_STUB_SCENARIO = prevScenario;
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "if-confirm-"));
    await writeFile(join(root, "inkos.json"), INKOS_CONFIG, "utf-8");
    await mkdir(join(root, "works", "p", "source"), { recursive: true });
    await saveWorkManifest(root, createWorkManifest({
      id: "p",
      title: "Test Film",
      profileId: "interactive-film",
      language: "zh",
    }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("answers ordinary discussion without creating another Work", async () => {
    const app = createStudioServer({} as never, root);
    const sessionId = "1000000000-chat";
    await createAndPersistBookSession(root, null, sessionId, "chat");
    const before = await readdir(join(root, "works"));

    const response = await app.request("/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "先讨论人物关系，不要开始生产",
        sessionKind: "chat",
        actionSource: "free-text",
        sessionId,
      }),
    });

    expect(response.status).toBe(200);
    expect(await readdir(join(root, "works"))).toEqual(before);
  });

  it("free-text proposes draft_structure, confirm creates the graph", async () => {
    const app = createStudioServer({} as never, root);
    const sessionId = "1000000000-test";
    const bookId = "p";

    // Pre-create the session so the agent endpoint can load it
    await createAndPersistBookSession(root, bookId, sessionId, "interactive-film-authoring");

    const propose = await app.request("/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "帮我搭一个三幕结构",
        activeBookId: bookId,
        sessionKind: "interactive-film-authoring",
        actionSource: "free-text",
        sessionId,
      }),
    });
    const proposeBody = await propose.clone().json();
    expect(propose.status, JSON.stringify(proposeBody)).toBe(200);
    expect(proposeBody.details?.toolExecutions?.[0]).toMatchObject({
      tool: "propose_action",
      status: "completed",
      details: {
        kind: "proposed_action",
        action: "draft_structure",
      },
    });

    const confirm = await app.request("/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "搭建三幕分支结构",
        activeBookId: bookId,
        sessionKind: "interactive-film-authoring",
        actionSource: "button",
        requestedIntent: "draft_structure",
        actionPayload: { draftStructure: { instruction: "三幕分支结构", projectId: bookId } },
        sessionId,
      }),
    });
    const confirmBody = await confirm.clone().json();
    expect(confirm.status, JSON.stringify(confirmBody)).toBe(200);

    const graph = await loadStoryGraph(root, bookId);
    expect(graph?.nodes.length).toBeGreaterThanOrEqual(4);
  });
});
