import { describe, expect, it, vi } from "vitest";
import {
  ContextCompilationRequiredError,
  ContextSourceRegistry,
  ProtectedContextOverflowError,
  WorkProfileSchema,
  compileContext,
  type ContextFragment,
  type SemanticContextCompileRequest,
} from "../harness/index.js";

const profile = WorkProfileSchema.parse({
  version: 2,
  id: "longform-novel",
  title: "Long-form novel",
  capabilityIds: ["longform"],
});

describe("v2 context compiler", () => {
  it("keeps original fragments when they fit the budget", async () => {
    const sources = registry([
      fragment("intent", "author intent", "必须保持第一人称。", "protected", 100),
      fragment("summary", "chapter summary", "上一章抵达车站。", "compressible", 50),
    ]);
    const compiled = await compileContext({
      recipe: { id: "chapter-draft", sourceIds: ["test"] },
      sources,
      request: request(),
      budgetTokens: 200,
    });
    expect(compiled.fragments.map((item) => item.id)).toEqual(["intent", "summary"]);
    expect(compiled.trace.compressionTriggered).toBe(false);
  });

  it("only sends compressible context through semantic compilation", async () => {
    const protectedText = "第一人称不可变。".repeat(10);
    const compressibleText = "很久以前发生的背景。".repeat(100);
    const sources = registry([
      fragment("intent", "author intent", protectedText, "protected", 100),
      fragment("old-background", "old background", compressibleText, "compressible", 10),
    ]);
    const compiler = vi.fn(async (input: SemanticContextCompileRequest) => ({
      content: "旧背景摘要。",
      sourceIds: input.fragments.map((item) => item.id),
    }));
    const compiled = await compileContext({
      recipe: { id: "chapter-draft", sourceIds: ["test"] },
      sources,
      request: request(),
      budgetTokens: 120,
      compiler,
    });
    expect(compiler).toHaveBeenCalledWith(expect.objectContaining({
      fragments: [expect.objectContaining({ id: "old-background" })],
    }));
    expect(compiler.mock.calls[0]![0].fragments).not.toContainEqual(expect.objectContaining({ id: "intent" }));
    expect(compiled.markdown).toContain(protectedText);
    expect(compiled.trace.compiledSourceIds).toEqual(["old-background"]);
  });

  it("fails loudly instead of truncating when protected context alone overflows", async () => {
    const sources = registry([
      fragment("canon", "canon", "不可压缩正史。".repeat(500), "protected", 100),
    ]);
    await expect(compileContext({
      recipe: { id: "chapter-draft", sourceIds: ["test"] },
      sources,
      request: request(),
      budgetTokens: 30,
      compiler: async () => ({ content: "unused", sourceIds: [] }),
    })).rejects.toBeInstanceOf(ProtectedContextOverflowError);
  });

  it("requires a semantic compiler instead of silently dropping over-budget context", async () => {
    const sources = registry([
      fragment("history", "history", "历史内容。".repeat(500), "compressible", 10),
    ]);
    await expect(compileContext({
      recipe: { id: "chat", sourceIds: ["test"] },
      sources,
      request: request(),
      budgetTokens: 20,
    })).rejects.toBeInstanceOf(ContextCompilationRequiredError);
  });
});

function registry(fragments: ReadonlyArray<ContextFragment>): ContextSourceRegistry {
  const sources = new ContextSourceRegistry();
  sources.register({ id: "test", async load() { return fragments; } });
  return sources;
}

function fragment(
  id: string,
  source: string,
  content: string,
  protection: "protected" | "compressible",
  priority: number,
): ContextFragment {
  return { id, source, content, protection, priority };
}

function request() {
  return {
    projectRoot: "/tmp/demo",
    work: null,
    profile,
    actionId: "draft",
    intent: "继续写下一章",
  };
}
