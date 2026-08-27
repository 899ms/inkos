import { describe, expect, it } from "vitest";
import { buildShortFictionWriterUserPrompt } from "../prompts/short-fiction.js";

describe("short-fiction writer craft prompt", () => {
  const prompt = buildShortFictionWriterUserPrompt({
    direction: "悬疑短篇 旧书店失踪案 反转",
    outlineMarkdown: "## 大纲\n第1章 入局",
    chapterCount: 12,
    charsPerChapter: 1000,
  });

  it("tells the writer to play out the climax as a scene, not summarize it (B3)", () => {
    expect(prompt).toContain("高潮即场景");
    expect(prompt).toContain("不要梗概"); // already-present discipline still holds
  });

  it("restrains simile over-reliance (B2)", () => {
    expect(prompt).toContain("明喻节制");
  });

  it("carries prior batches as continuity context without asking for rewrites", () => {
    const continued = buildShortFictionWriterUserPrompt({
      direction: "悬疑短篇",
      outlineMarkdown: "## 大纲",
      chapterCount: 12,
      charsPerChapter: 1000,
      chapterNumbers: [5, 6, 7, 8],
      previousDraftMarkdown: "=== CHAPTER 4 CONTENT ===\n钥匙落进排水沟。",
    });
    expect(continued).toContain("已写章节（权威连续性上下文）");
    expect(continued).toContain("钥匙落进排水沟");
    expect(continued).toContain("不要重写");
  });
});
