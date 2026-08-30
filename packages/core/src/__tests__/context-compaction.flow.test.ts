import { mkdtemp, rm } from "node:fs/promises";
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
  type ContextFragment,
} from "../harness/index.js";

describe("context assembly mini-flow", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reloads Work identity while leaving domain source selection to capabilities", async () => {
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
      includesDomainSourceText: secondContext.content.includes("author_intent.md") || secondContext.content.includes("current_focus.md"),
      messageCount: second.length,
    }).toEqual({
      firstHasOldTitle: true,
      secondHasNewTitle: true,
      includesDomainSourceText: false,
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

  it("compacts the complete historical middle only after the session budget is exceeded", async () => {
    const profile = createBuiltInWorkProfileRegistry().require("workspace-default");
    const history = "Earlier decision and tool outcome. ".repeat(200);
    let receivedHistory = "";
    const phases: string[] = [];
    const transform = createHarnessContextTransform({
      projectRoot: "/tmp",
      work: null,
      profile,
      budgetTokens: 220,
      conversationCompactor: async (request) => {
        receivedHistory = request.history;
        return "- The user approved the earlier decision.\n- The tool completed the artifact.";
      },
      onContextCompression: (event) => phases.push(event.phase),
    });
    const result = await transform([
      { role: "user", content: history, timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: history }], timestamp: 2 },
      { role: "user", content: "Apply that decision to the next chapter.", timestamp: 3 },
    ] as never);

    expect(receivedHistory).toContain("Earlier decision and tool outcome");
    expect(JSON.stringify(result)).toContain("conversation_summary");
    expect(JSON.stringify(result)).toContain("Apply that decision to the next chapter");
    expect(phases).toEqual(["start", "end"]);
  });
});
