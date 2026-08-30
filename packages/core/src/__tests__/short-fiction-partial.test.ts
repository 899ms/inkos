import { describe, expect, it } from "vitest";
import { renderShortFictionDraftMarkdown } from "../agents/short-fiction.js";

describe("short-fiction partial persistence", () => {
  it("renders completed batches while later chapters are still pending", () => {
    const markdown = renderShortFictionDraftMarkdown({
      storyTitle: "失物招领处",
      chapters: [
        { number: 1, title: "旧钥匙", content: "第一章正文", charCount: 5 },
        { number: 2, title: "", content: "", charCount: 0 },
      ],
      rawContent: "",
    });

    expect(markdown).toContain("第1章 旧钥匙");
    expect(markdown).not.toContain("第2章");
  });
});
