import { ChapterMemoSchema, type ChapterMemo } from "../models/input-governance.js";

export class PlannerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerParseError";
  }
}

const GOAL_HEADINGS = ["## 本章目标", "## Chapter goal"] as const;
const THREAD_HEADINGS = ["## 关联线索", "## Thread refs", "## Related threads"] as const;

export function parseMemo(
  raw: string,
  expectedChapter: number,
  isGoldenOpening: boolean,
): ChapterMemo {
  const markdown = dropLeadingProse(stripWrappingFence(raw));
  const goal = extractAnyHeading(markdown, GOAL_HEADINGS)
    .split(/\n|。|\. /)[0]
    ?.trim() ?? "";
  if (!goal) throw new PlannerParseError("goal must be a non-empty string");
  const displayGoal = goal.length <= 50 ? goal : `${goal.slice(0, 47).trimEnd()}...`;
  const planBody = extractPlanBody(markdown);

  return ChapterMemoSchema.parse({
    chapter: expectedChapter,
    goal: displayGoal,
    isGoldenOpening,
    body: goal === displayGoal
      ? planBody
      : `${markdown.includes("## Chapter goal") ? "## Chapter goal" : "## 本章目标"}\n${goal}\n\n${planBody}`,
    threadRefs: extractThreadRefs(markdown),
  });
}

function extractPlanBody(markdown: string): string {
  const metadataHeading = [...THREAD_HEADINGS, ...GOAL_HEADINGS]
    .map((heading) => ({ heading, index: markdown.indexOf(heading) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => right.index - left.index)[0];
  if (!metadataHeading) return markdown;
  const after = markdown.slice(metadataHeading.index + metadataHeading.heading.length);
  const nextHeading = after.match(/\n##\s/);
  if (!nextHeading || nextHeading.index === undefined) return markdown;
  return after.slice(nextHeading.index + 1).trim();
}

function extractSectionContent(body: string, heading: string): string {
  const startIndex = body.indexOf(heading);
  if (startIndex < 0) return "";
  const after = body.slice(startIndex + heading.length);
  const nextHeadingMatch = after.match(/\n##\s/);
  return (nextHeadingMatch ? after.slice(0, nextHeadingMatch.index) : after)
    .replace(/\s+/g, " ")
    .trim();
}

function extractAnyHeading(body: string, headings: ReadonlyArray<string>): string {
  for (const heading of headings) {
    const content = extractSectionContent(body, heading);
    if (content) return content;
  }
  return "";
}

function extractThreadRefs(body: string): string[] {
  const block = extractAnyHeading(body, THREAD_HEADINGS);
  if (!block || /^(无|none|n\/a|na|—|-|\(none\))$/i.test(block)) return [];
  const matches = block.match(/\b[A-Za-z][A-Za-z0-9_-]*\d+[A-Za-z0-9_-]*\b/g) ?? [];
  return [...new Set(matches)];
}

function stripWrappingFence(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.match(/^```(?:md|markdown)?\s*\n([\s\S]*?)\n```\s*$/i)?.[1]?.trim() ?? trimmed;
}

function dropLeadingProse(raw: string): string {
  const markers = ["# 第 ", "# Chapter ", ...GOAL_HEADINGS, ...THREAD_HEADINGS];
  const starts = markers.map((marker) => raw.indexOf(marker)).filter((index) => index >= 0);
  return starts.length > 0 ? raw.slice(Math.min(...starts)).trim() : raw.trim();
}
