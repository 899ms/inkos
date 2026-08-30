import type { BookConfig } from "../models/book.js";
import type { BookRules } from "../models/book-rules.js";

export function buildSettlerSystemPrompt(
  book: BookConfig,
  bookRules: BookRules | null,
  language: "zh" | "en",
): string {
  const fullCast = bookRules?.enableFullCastTracking
    ? language === "en"
      ? "Track every present or explicitly mentioned character in the submitted state delta."
      : "在提交的状态变更中追踪本章出场或明确被提及的角色。"
    : "";
  return language === "en"
    ? `Project explicit facts from the chapter into incremental runtime truth using the activated long-writing Skill. Preserve unrelated state and stable ids. Plans are not completed events. ${fullCast}\nWork: ${book.title}.`
    : `按已激活的长篇写作 Skill，把正文明确事实投影为增量运行时 truth。保留无关状态和稳定 id，不把计划当成已发生事件。${fullCast}\n作品：${book.title}。`;
}

export function buildSettlerUserPrompt(params: {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly currentState: string;
  readonly ledger: string;
  readonly hooks: string;
  readonly chapterSummaries: string;
  readonly subplotBoard: string;
  readonly emotionalArcs: string;
  readonly characterMatrix: string;
  readonly volumeOutline: string;
  readonly selectedEvidenceBlock?: string;
  readonly governedControlBlock?: string;
  readonly validationFeedback?: string;
  readonly language?: "zh" | "en";
}): string {
  const isEnglish = params.language === "en";
  const heading = (en: string, zh: string) => isEnglish ? en : zh;
  const block = (title: string, value: string) => value && value !== "(文件尚未创建)"
    ? `\n## ${title}\n${value}\n`
    : "";
  const controlBlock = params.governedControlBlock ?? "";

  return `${isEnglish ? `Project Chapter ${params.chapterNumber} "${params.title}" into runtime truth.` : `把第${params.chapterNumber}章「${params.title}」投影到运行时 truth。`}
${params.validationFeedback ? block(heading("Reconciliation observations", "状态对账观察"), params.validationFeedback) : ""}
## ${heading("Chapter body", "本章正文")}
${params.content}
${controlBlock}
${block(heading("Current state", "当前状态"), params.currentState)}
${block(heading("Resource ledger", "资源账本"), params.ledger)}
${block(heading("Current hook pool", "当前伏笔池"), params.hooks)}
${block(heading("Selected long-range evidence", "已选长程证据"), params.selectedEvidenceBlock ?? "")}
${block(heading("Chapter summaries", "章节摘要"), params.chapterSummaries)}
${block(heading("Subplots", "支线进度"), params.subplotBoard)}
${block(heading("Emotional arcs", "情感弧线"), params.emotionalArcs)}
${block(heading("Character matrix", "角色关系"), params.characterMatrix)}
${controlBlock.length === 0 ? block(heading("Volume map", "卷纲"), params.volumeOutline) : ""}`;
}
