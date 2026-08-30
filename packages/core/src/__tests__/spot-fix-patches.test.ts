import { describe, expect, it } from "vitest";
import { applySpotFixPatches } from "../utils/spot-fix-patches.js";

describe("spot-fix action boundary", () => {
  it("applies every uniquely targeted replacement", () => {
    const original = "门轴响了。\n林越没有进去。\n窗外很静。";
    expect(applySpotFixPatches(original, [
      { targetText: "林越没有进去。", replacementText: "林越停在门槛外。" },
      { targetText: "窗外很静。", replacementText: "窗外传来虫鸣。" },
    ])).toBe("门轴响了。\n林越停在门槛外。\n窗外传来虫鸣。");
  });

  it("rejects the whole result when any target is absent or ambiguous", () => {
    const original = "他停了一下。\n门里的人也停了一下。\n窗外很静。";
    expect(() => applySpotFixPatches(original, [
      { targetText: "窗外很静。", replacementText: "窗外传来虫鸣。" },
      { targetText: "停了一下", replacementText: "顿了顿" },
    ])).toThrow(/not unique/);
  });
});
