import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextSourceRegistry,
  ProtectedContextOverflowError,
  compileContext,
  createBuiltInWorkProfileRegistry,
  createHarnessContextTransform,
  createWorkManifest,
  loadWorkManifest,
  saveWorkManifest,
  workDirectory,
  type ContextFragment,
} from "../harness/index.js";

describe("context assembly mini-flow", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reloads current Work context and keeps protected material outside semantic compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-context-flow-"));
    roots.push(root);
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    const work = createWorkManifest({
      id: "harbor",
      title: "Before",
      profileId: profile.id,
      language: "en",
    });
    await saveWorkManifest(root, work);
    const storyDir = join(workDirectory(root, work.id), "source", "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "author_intent.md"), "Keep the witness alive.");
    await writeFile(join(storyDir, "current_focus.md"), "Interrogate the forged ledger.");
    const transform = createHarnessContextTransform({ projectRoot: root, work, profile, budgetTokens: 8_000 });

    const first = await transform([{ role: "user", content: "status", timestamp: 1 }] as never);
    const current = await loadWorkManifest(root, work.id);
    await saveWorkManifest(root, { ...current, title: "After", updatedAt: new Date().toISOString() });
    const second = await transform([{ role: "user", content: "status", timestamp: 2 }] as never);
    const firstContext = first[0] as { content: string };
    const secondContext = second[0] as { content: string };

    expect({
      firstHasOldTitle: firstContext.content.includes('"title":"Before"'),
      secondHasNewTitle: secondContext.content.includes('"title":"After"'),
      includesTaskFiles: ["author_intent.md", "current_focus.md"].every((name) => secondContext.content.includes(name)),
      messageCount: second.length,
    }).toEqual({
      firstHasOldTitle: true,
      secondHasNewTitle: true,
      includesTaskFiles: true,
      messageCount: 2,
    });

    const protectedText = "First-person canon stays fixed.".repeat(10);
    const fragments: ContextFragment[] = [
      { id: "intent", source: "intent", content: protectedText, protection: "protected", priority: 100 },
      { id: "history", source: "history", content: "Older background. ".repeat(200), protection: "compressible", priority: 10 },
    ];
    const sources = new ContextSourceRegistry();
    sources.register({ id: "flow", async load() { return fragments; } });
    let compiledIds: string[] = [];
    const compiled = await compileContext({
      recipe: { id: "chapter", sourceIds: ["flow"] },
      sources,
      request: { projectRoot: root, work, profile, actionId: "draft", intent: "continue" },
      budgetTokens: 120,
      compiler: async (request) => {
        compiledIds = request.fragments.map((fragment) => fragment.id);
        return { content: "Background summary.", sourceIds: compiledIds };
      },
    });
    expect({ compiledIds, protectedIds: compiled.trace.protectedSourceIds }).toEqual({
      compiledIds: ["history"],
      protectedIds: ["intent"],
    });
  });

  it("fails loudly when protected context alone exceeds the budget", async () => {
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    const sources = new ContextSourceRegistry();
    sources.register({
      id: "protected",
      async load() {
        return [{
          id: "canon",
          source: "canon",
          content: "不可压缩正史。".repeat(500),
          protection: "protected",
          priority: 100,
        } as const];
      },
    });

    await expect(compileContext({
      recipe: { id: "chapter", sourceIds: ["protected"] },
      sources,
      request: { projectRoot: "/tmp", work: null, profile, actionId: "draft", intent: "continue" },
      budgetTokens: 30,
    })).rejects.toBeInstanceOf(ProtectedContextOverflowError);
  });
});
