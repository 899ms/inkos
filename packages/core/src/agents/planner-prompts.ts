/**
 * Planner protocol. Professional planning methodology comes from the active
 * Work Profile Skill; this module only defines authority and the memo format.
 */

export const PLANNER_MEMO_SYSTEM_PROMPT = `你负责把当前 Work 的权威上下文编译成下一章 chapter_memo，不写正文。

专业创作方法只服从已激活的 Skill。本协议只规定输入优先级：
- 当前章节用户指令优先于局部规划。
- 用户 brief、author intent、book rules 和已发生事实必须保留。
- 卷纲是无冲突时的默认计划。
- 不得编造输入中不存在的 hook id、人物事实或已发生事件。
- 通过结果工具提交一个具体目标、完整可读的 Markdown 计划，以及输入中真实存在的 thread id。`;

export const PLANNER_MEMO_SYSTEM_PROMPT_EN = `Compile the authoritative Work context into the next chapter_memo. Do not write chapter prose.

Professional planning methodology comes only from the activated Skill. This protocol defines authority:
- The user's current-chapter instruction overrides local planning.
- Preserve the user brief, author intent, book rules, and established facts.
- The outline is the default only when it does not conflict with higher authority.
- Never invent hook ids, character facts, or past events absent from the input.
- Submit one concrete goal, a complete readable Markdown plan, and only real thread ids through the result tool.`;

export const PLANNER_MEMO_USER_TEMPLATE = `# 第 {{chapterNumber}} 章 memo 请求

{{brief_block}}
{{chapter_context_block}}
{{author_intent_block}}
{{current_focus_block}}

## 上一章最后一屏（原文节选）
{{previous_chapter_ending_excerpt}}

## 章节摘要
{{recent_summaries}}

## 当前 arc
{{current_arc_prose}}

## 角色上下文
{{character_context}}

## 可用 thread
{{relevant_threads}}

## 宿主约束
- 篇幅：目标 {{lengthTarget}} {{lengthUnit}}；建议 {{lengthSoftMin}}-{{lengthSoftMax}}；硬区间 {{lengthHardMin}}-{{lengthHardMax}}
{{book_rules_relevant}}`;

export const PLANNER_MEMO_USER_TEMPLATE_EN = `# Chapter {{chapterNumber}} memo request

{{brief_block}}
{{chapter_context_block}}
{{author_intent_block}}
{{current_focus_block}}

## Previous chapter ending excerpt
{{previous_chapter_ending_excerpt}}

## Chapter summaries
{{recent_summaries}}

## Current arc
{{current_arc_prose}}

## Character context
{{character_context}}

## Available threads
{{relevant_threads}}

## Host constraints
- Length: target {{lengthTarget}} {{lengthUnit}}; preferred {{lengthSoftMin}}-{{lengthSoftMax}}; hard {{lengthHardMin}}-{{lengthHardMax}}
{{book_rules_relevant}}`;

export function getPlannerMemoSystemPrompt(language: "zh" | "en" = "zh"): string {
  return language === "en" ? PLANNER_MEMO_SYSTEM_PROMPT_EN : PLANNER_MEMO_SYSTEM_PROMPT;
}

export function getPlannerMemoUserTemplate(language: "zh" | "en" = "zh"): string {
  return language === "en" ? PLANNER_MEMO_USER_TEMPLATE_EN : PLANNER_MEMO_USER_TEMPLATE;
}

export interface PlannerUserMessageInput {
  readonly chapterNumber: number;
  readonly previousChapterEndingExcerpt: string;
  readonly recentSummaries: string;
  readonly currentArcProse: string;
  readonly characterContext: string;
  readonly relevantThreads: string;
  readonly bookRulesRelevant: string;
  readonly lengthBudget: {
    readonly target: number;
    readonly softMin: number;
    readonly softMax: number;
    readonly hardMin: number;
    readonly hardMax: number;
    readonly unit: string;
  };
  readonly brief?: string;
  readonly chapterContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
  readonly language?: "zh" | "en";
}

export function buildPlannerUserMessage(input: PlannerUserMessageInput): string {
  const language = input.language ?? "zh";
  return getPlannerMemoUserTemplate(language)
    .replaceAll("{{chapterNumber}}", String(input.chapterNumber))
    .replaceAll("{{brief_block}}", authorityBlock(input.brief, language, "brief"))
    .replaceAll("{{chapter_context_block}}", authorityBlock(input.chapterContext, language, "chapter"))
    .replaceAll("{{author_intent_block}}", authorityDocument(input.authorIntent, language, "author"))
    .replaceAll("{{current_focus_block}}", authorityDocument(input.currentFocus, language, "focus"))
    .replaceAll("{{previous_chapter_ending_excerpt}}", input.previousChapterEndingExcerpt)
    .replaceAll("{{recent_summaries}}", input.recentSummaries)
    .replaceAll("{{current_arc_prose}}", input.currentArcProse)
    .replaceAll("{{character_context}}", input.characterContext)
    .replaceAll("{{relevant_threads}}", input.relevantThreads)
    .replaceAll("{{lengthTarget}}", String(input.lengthBudget.target))
    .replaceAll("{{lengthSoftMin}}", String(input.lengthBudget.softMin))
    .replaceAll("{{lengthSoftMax}}", String(input.lengthBudget.softMax))
    .replaceAll("{{lengthHardMin}}", String(input.lengthBudget.hardMin))
    .replaceAll("{{lengthHardMax}}", String(input.lengthBudget.hardMax))
    .replaceAll("{{lengthUnit}}", input.lengthBudget.unit)
    .replaceAll("{{book_rules_relevant}}", input.bookRulesRelevant);
}

function authorityDocument(
  value: string | undefined,
  language: "zh" | "en",
  kind: "author" | "focus",
): string {
  const content = value?.trim();
  if (!content || content === "(文件尚未创建)") return "";
  if (language === "en") {
    return kind === "author"
      ? `## Author intent (authoritative)\n${content}`
      : `## Current focus (authoritative for this phase)\n${content}`;
  }
  return kind === "author"
    ? `## 作者意图（权威）\n${content}`
    : `## 当前焦点（当前阶段权威）\n${content}`;
}

function authorityBlock(
  value: string | undefined,
  language: "zh" | "en",
  kind: "brief" | "chapter",
): string {
  const content = value?.trim();
  if (!content) return "";
  if (language === "en") {
    return kind === "brief"
      ? `## User creative brief (authoritative)\n${content}`
      : `## Current-chapter user instruction (highest authority this chapter)\n${content}`;
  }
  return kind === "brief"
    ? `## 用户创作 brief（权威）\n${content}`
    : `## 本章用户指令（本章最高优先级）\n${content}`;
}
