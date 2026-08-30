import type { Fact, StoredHook, StoredSummary } from "../state/memory-db.js";
import { normalizeStoredHookStatus } from "./hook-lifecycle.js";

export function renderSummarySnapshot(
  summaries: ReadonlyArray<StoredSummary>,
  language: "zh" | "en" = "zh",
): string {
  if (summaries.length === 0) return "- none";

  const headers = language === "en"
    ? [
      "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    : [
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];

  return [
    ...headers,
    ...summaries.map((summary) => [
      summary.chapter,
      summary.title,
      summary.characters,
      summary.events,
      summary.stateChanges,
      summary.hookActivity,
      summary.mood,
      summary.chapterType,
    ].map(escapeTableCell).join(" | ")).map((row) => `| ${row} |`),
  ].join("\n");
}

export function renderHookSnapshot(
  hooks: ReadonlyArray<StoredHook>,
  language: "zh" | "en" = "zh",
): string {
  if (hooks.length === 0) return "- none";

  const headers = language === "en"
    ? [
      "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    : [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];

  return [
    ...headers,
    ...hooks.map((hook) => [
      hook.hookId,
      hook.startChapter,
      hook.type,
      hook.status,
      hook.lastAdvancedChapter,
      hook.expectedPayoff,
      hook.notes,
    ].map((cell) => escapeTableCell(String(cell))).join(" | ")).map((row) => `| ${row} |`),
  ].join("\n");
}

export function parseChapterSummariesMarkdown(markdown: string): StoredSummary[] {
  const rows = parseMarkdownTableRows(markdown)
    .filter((row) => /^\d+$/.test(row[0] ?? ""));

  return rows.map((row) => ({
    chapter: parseInt(row[0]!, 10),
    title: row[1] ?? "",
    characters: row[2] ?? "",
    events: row[3] ?? "",
    stateChanges: row[4] ?? "",
    hookActivity: row[5] ?? "",
    mood: row[6] ?? "",
    chapterType: row[7] ?? "",
  }));
}

export function parsePendingHooksMarkdown(markdown: string): StoredHook[] {
  const tableRows = parseMarkdownTableRows(markdown)
    .filter((row) => (row[0] ?? "").toLowerCase() !== "hook_id");

  if (tableRows.length > 0) {
    return tableRows
      .filter((row) => normalizeHookId(row[0]).length > 0)
      .map((row) => parsePendingHookRow(row));
  }

  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, ""))
    .filter(Boolean)
    .map((line, index) => ({
      hookId: `hook-${index + 1}`,
      startChapter: 0,
      type: "unspecified",
      status: "open",
      lastAdvancedChapter: 0,
      expectedPayoff: "",
      notes: line,
    }));
}

export function parseCurrentStateFacts(
  markdown: string,
  fallbackChapter: number,
): Fact[] {
  const tableRows = parseMarkdownTableRows(markdown);
  const fieldValueRows = tableRows
    .filter((row) => row.length >= 2)
    .filter((row) => !isStateTableHeaderRow(row));

  if (fieldValueRows.length > 0) {
    const chapterFromTable = fieldValueRows.find((row) => isCurrentChapterLabel(row[0] ?? ""));
    const stateChapter = parseInteger(chapterFromTable?.[1]) || fallbackChapter;

    return fieldValueRows
      .filter((row) => !isCurrentChapterLabel(row[0] ?? ""))
      .flatMap((row): Fact[] => {
        const label = (row[0] ?? "").trim();
        const value = (row[1] ?? "").trim();
        if (!label || !value) return [];

        return [{
          subject: "current_state",
          predicate: label,
          object: value,
          validFromChapter: stateChapter,
          validUntilChapter: null,
          sourceChapter: stateChapter,
        }];
      });
  }

  const bulletFacts = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, ""))
    .filter(Boolean);

  return bulletFacts.map((line, index) => ({
    subject: "current_state",
    predicate: `note_${index + 1}`,
    object: line,
    validFromChapter: fallbackChapter,
    validUntilChapter: null,
    sourceChapter: fallbackChapter,
  }));
}

export function parseMarkdownTableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .filter((line) => !line.includes("---"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.some(Boolean));
}

export function isStateTableHeaderRow(row: ReadonlyArray<string>): boolean {
  const first = (row[0] ?? "").trim().toLowerCase();
  const second = (row[1] ?? "").trim().toLowerCase();
  return (first === "字段" && second === "值") || (first === "field" && second === "value");
}

export function isCurrentChapterLabel(label: string): boolean {
  return /^(当前章节|current chapter)$/i.test(label.trim());
}

export function parseInteger(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Strict integer parse — only accepts cells that are purely numeric
 * (after stripping markdown formatting). Returns 0 for cells containing
 * prose like "第141号文明" to prevent narrative numbers from being
 * mistaken for chapter/progress values.
 */
function parseStrictChapterInteger(value: string | undefined): number {
  if (!value) return 0;
  const stripped = normalizeHookId(value);
  return /^\d+$/.test(stripped) ? parseInt(stripped, 10) : 0;
}

export function normalizeHookId(value: string | undefined): string {
  let normalized = (value ?? "").trim();
  let previous = "";
  while (normalized && normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(/^\[(.+?)\]\([^)]+\)$/u, "$1")
      .replace(/^\*\*(.+)\*\*$/u, "$1")
      .replace(/^__(.+)__$/u, "$1")
      .replace(/^\*(.+)\*$/u, "$1")
      .replace(/^_(.+)_$/u, "$1")
      .replace(/^`(.+)`$/u, "$1")
      .replace(/^~~(.+)~~$/u, "$1")
      .trim();
  }
  normalized = normalized
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  return /[a-z0-9\u4e00-\u9fff]/iu.test(normalized) ? normalized : "";
}

function parsePendingHookRow(row: ReadonlyArray<string | undefined>): StoredHook {
  // Row shapes by length:
  //   7 (current): id, ch, type, status, last_adv, expected, notes
  //   8 (legacy):  id, ch, type, status, last_adv, expected, timing, notes
  // Historical wider rows are accepted during import, but new projections use
  // the seven-column explicit-state contract.
  const phase7Promoted = row.length >= 13;
  const phase7HalfLife = row.length === 12;
  const phase7Compact = row.length === 11;
  const phase7 = phase7Promoted || phase7HalfLife || phase7Compact;
  const notes = phase7Promoted
    ? (row[12] ?? "")
    : phase7HalfLife
      ? (row[11] ?? "")
      : phase7Compact
        ? (row[10] ?? "")
        : row.length >= 8
          ? (row[7] ?? "")
          : (row[6] ?? "");

  const base = {
    hookId: normalizeHookId(row[0]),
    startChapter: parseStrictChapterInteger(row[1]),
    type: row[2] ?? "",
    status: normalizeStoredHookStatus(row[3] ?? "open"),
    lastAdvancedChapter: parseStrictChapterInteger(row[4]),
    expectedPayoff: row[5] ?? "",
    notes,
  };

  if (!phase7) return base;

  return {
    ...base,
    dependsOn: parseDependsOn(row[7] ?? ""),
    paysOffInArc: (row[8] ?? "").trim(),
  };
}

function parseDependsOn(cell: string): ReadonlyArray<string> {
  const trimmed = cell.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  if (lower === "none" || lower === "n/a" || lower === "-" || trimmed === "无") return [];

  // Accept [H01, H02] or H01, H02 or H01/H02.
  const stripped = trimmed.replace(/^[\[\(]\s*/, "").replace(/\s*[\]\)]$/, "");
  return stripped
    .split(/[,，、\/]+/)
    .map((item) => normalizeHookId(item))
    .filter((item) => item.length > 0);
}


function escapeTableCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").trim();
}
