import { describe, expect, it } from "vitest";
import {
  detectDuplicateTitle,
  detectParagraphLengthDrift,
  detectParagraphShapeWarnings,
  normalizePostWriteSurface,
  resolveDuplicateTitle,
  validatePostWrite,
} from "../agents/post-write-validator.js";
import type { GenreProfile } from "../models/genre-profile.js";

const profile: GenreProfile = {
  id: "test",
  name: "测试",
  language: "zh",
  chapterTypes: [],
  fatigueWords: [],
  pacingRule: "",
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  auditDimensions: [],
  satisfactionTypes: [],
};

describe("post-write structural observations", () => {
  it("removes worker-note protocol lines without rewriting prose punctuation", () => {
    const content = "他推开门——雨声涌进来。\n[writer-note] internal note\n她没有回头。";
    expect(normalizePostWriteSurface(content)).toBe("他推开门——雨声涌进来。\n她没有回头。");
  });

  it("reports objective paragraph overflow", () => {
    const content = [`${"长段落。".repeat(90)}`, `${"另一个长段落。".repeat(70)}`].join("\n\n");
    expect(validatePostWrite(content, profile, null).map((item) => item.rule)).toContain("段落过长");
  });

  it("reports fragmented paragraph shape", () => {
    const content = ["门响了。", "他抬头。", "灯灭了。", "脚步近了。", "钥匙转动。"].join("\n\n");
    const rules = detectParagraphShapeWarnings(content).map((item) => item.rule);
    expect(rules).toContain("段落过碎");
    expect(rules).toContain("连续短段");
  });

  it("reports paragraph-density drift against recent chapters", () => {
    const recent = Array.from({ length: 6 }, () => "这是一段承载完整动作、观察和反应的较长叙事段落。".repeat(5)).join("\n\n");
    const current = Array.from({ length: 6 }, (_, index) => `短段${index}。`).join("\n\n");
    expect(detectParagraphLengthDrift(current, recent).map((item) => item.rule)).toContain("段落密度漂移");
  });

  it("detects exact and punctuation-only duplicate titles", () => {
    expect(detectDuplicateTitle("潮声", ["潮声"])).toHaveLength(1);
    expect(detectDuplicateTitle("潮-声", ["潮声"])).toHaveLength(1);
  });

  it("never invents a replacement title from chapter keywords", () => {
    const result = resolveDuplicateTitle("潮声", ["潮声"], "zh", { content: "灯塔、旧信和雨夜。" });
    expect(result.title).toBe("潮声");
    expect(result.issues).toHaveLength(1);
  });
});
