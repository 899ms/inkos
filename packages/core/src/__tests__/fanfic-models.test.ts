import { describe, expect, it } from "vitest";
import { BookConfigSchema } from "../models/book.js";
import { BookRulesSchema } from "../models/book-rules.js";

const book = {
  id: "test",
  title: "Test",
  platform: "other",
  genre: "other",
  language: "en",
  status: "outlining",
  targetChapters: 100,
  chapterWordCount: 2000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const rules = {
  version: "2",
  prohibitions: [],
  enableFullCastTracking: false,
  allowedDeviations: [],
} as const;

describe("fanfic metadata contracts", () => {
  it("keeps derivative metadata explicit across every supported mode", () => {
    const modes = ["canon", "au", "ooc", "cp"] as const;
    expect(modes.map((fanficMode) => BookConfigSchema.parse({
      ...book,
      fanficMode,
      parentBookId: "parent-book",
    }).fanficMode)).toEqual(modes);
  });

  it("rejects unknown fanfic modes", () => {
    expect(() => BookConfigSchema.parse({ ...book, fanficMode: "invalid" })).toThrow();
  });

  it("requires the complete v2 book-rules surface", () => {
    expect(BookRulesSchema.parse({
      ...rules,
      fanficMode: "au",
      allowedDeviations: ["timeline shifted"],
    }).allowedDeviations).toEqual(["timeline shifted"]);
    expect(() => BookRulesSchema.parse({ version: "2" })).toThrow();
  });
});
