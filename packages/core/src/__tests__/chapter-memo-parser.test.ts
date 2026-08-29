import { describe, expect, it } from "vitest";
import { parseMemo } from "../utils/chapter-memo-parser.js";

describe("chapter memo protocol", () => {
  it("keeps the model-authored Markdown while the host owns chapter metadata", () => {
    const raw = [
      "# Chapter 4 memo",
      "## Chapter goal",
      "Mara opens the sealed observatory",
      "## Thread refs",
      "H03, clue-7",
      "## Scene plan",
      "A sparse but valid plan in the active Skill's preferred shape.",
    ].join("\n");

    const memo = parseMemo(raw, 12, true);
    expect({ chapter: memo.chapter, golden: memo.isGoldenOpening, refs: memo.threadRefs }).toEqual({
      chapter: 12,
      golden: true,
      refs: ["H03", "clue-7"],
    });
    expect(memo.body).toContain("## Scene plan");
    expect(memo.body).toContain("A sparse but valid plan");
  });

  it("accepts a fenced memo after leading assistant prose", () => {
    const memo = parseMemo([
      "Here is the memo:",
      "```markdown",
      "# Chapter 2 memo",
      "## Chapter goal",
      "Cross the flooded square",
      "## Thread refs",
      "none",
      "## Notes",
      "Follow the active Skill and governed context.",
      "```",
    ].join("\n"), 2, false);
    expect(memo.goal).toBe("Cross the flooded square");
    expect(memo.threadRefs).toEqual([]);
  });

  it("preserves a long goal in the body while shortening only its display label", () => {
    const goal = "The protagonist traces the forged harbor permits through three witnesses without exposing the protected informant";
    const raw = `## Chapter goal\n${goal}\n\n## Notes\nUse the supplied evidence.`;
    const memo = parseMemo(raw, 3, false);
    expect(memo.goal.length).toBeLessThanOrEqual(50);
    expect(memo.body).toContain(goal);
  });

  it("requires only the semantic chapter goal", () => {
    expect(() => parseMemo("## Notes\nNo goal was supplied.", 1, false)).toThrow("goal must be a non-empty string");
  });
});
