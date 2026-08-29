import type { ChapterIntent, ChapterMemo, ContextPackage } from "../models/input-governance.js";

/**
 * Render a ChapterMemo + optional ChapterIntent into a sanitized narrative
 * control block for the writer / reviser prompt.
 *
 * The model-authored memo remains intact. Code adds only host-owned metadata.
 */
export function renderMemoAsNarrativeBlock(
  memo: ChapterMemo,
  intent: ChapterIntent | undefined,
  language: "zh" | "en" = "zh",
): string {
  const isEn = language === "en";
  const sections: string[] = [];

  sections.push(`## ${isEn ? "Goal" : "目标"}\n- ${memo.goal}`);

  if (intent?.arcContext) {
    sections.push(`## ${isEn ? "Arc Context" : "弧线背景"}\n- ${intent.arcContext}`);
  }

  if (memo.threadRefs.length > 0) {
    const threads = memo.threadRefs.map((id) => `- ${id}`).join("\n");
    sections.push(`## ${isEn ? "Thread Refs" : "关联线索"}\n${threads}`);
  }

  sections.push(`## ${isEn ? "Opening phase" : "开篇阶段"}\n- ${memo.isGoldenOpening ? (isEn ? "yes" : "是") : (isEn ? "no" : "否")}`);

  // Emit the 7-section memo body at top level so each heading is a task.
  if (memo.body.trim().length > 0) {
    sections.push(memo.body);
  }

  return sections.join("\n\n");
}

export function buildNarrativeIntentBrief(
  chapterIntent: string,
  language: "zh" | "en" = "zh",
): string {
  const sections = [
    { heading: "## Goal", label: language === "en" ? "Goal" : "目标" },
    { heading: "## Outline Node", label: language === "en" ? "Outline Node" : "当前节点" },
    { heading: "## Must Keep", label: language === "en" ? "Keep" : "保留" },
    { heading: "## Must Avoid", label: language === "en" ? "Avoid" : "避免" },
    { heading: "## Style Emphasis", label: language === "en" ? "Style" : "风格" },
    { heading: "## Structured Directives", label: language === "en" ? "Directives" : "指令" },
  ] as const;

  const rendered = sections
    .map(({ heading, label }) => {
      const section = extractMarkdownSection(chapterIntent, heading);
      if (!section) return null;

      const lines = section
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !["- none", "- 无", "- 本轮无", "(not found)"].includes(line));
      if (lines.length === 0) return null;

      const normalized = lines
        .map((line) => line.startsWith("- ") ? line.slice(2) : line)
        .filter(Boolean)
        .map((line) => `- ${line}`)
        .join("\n");

      return `## ${label}\n${normalized}`;
    })
    .filter((section): section is string => Boolean(section));

  return rendered.join("\n\n");
}

export function renderNarrativeSelectedContext(
  entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
  language: "zh" | "en" = "zh",
): string {
  const heading = language === "en" ? "Evidence" : "证据";
  const reasonLabel = language === "en" ? "reason" : "原因";
  const detailLabel = language === "en" ? "detail" : "细节";

  return entries
    .map((entry, index) => {
      const lines = [
        `### ${heading} ${index + 1}`,
        `- ${reasonLabel}: ${entry.reason}`,
        entry.excerpt ? `- ${detailLabel}: ${entry.excerpt}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

function extractMarkdownSection(content: string, heading: string): string | undefined {
  const lines = content.split("\n");
  let buffer: string[] | null = null;

  for (const line of lines) {
    if (line.trim() === heading) {
      buffer = [];
      continue;
    }

    if (buffer && line.startsWith("## ") && line.trim() !== heading) {
      break;
    }

    if (buffer) {
      buffer.push(line);
    }
  }

  const section = buffer?.join("\n").trim();
  return section && section.length > 0 ? section : undefined;
}
