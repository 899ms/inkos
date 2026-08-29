/**
 * Planner protocol. Professional planning methodology comes from the active
 * Work Profile Skill; this module only defines authority and the memo format.
 */

export const PLANNER_MEMO_SYSTEM_PROMPT = `你负责把当前 Work 的权威上下文编译成下一章 chapter_memo，不写正文。

专业创作方法只服从已激活的 Skill。本协议只规定输入优先级和输出结构：
- 当前章节用户指令优先于局部规划。
- 用户 brief、author intent、book rules 和已发生事实必须保留。
- 卷纲是无冲突时的默认计划。
- 不得编造输入中不存在的 hook id、人物事实或已发生事件。

输出普通 Markdown，不要 YAML、JSON、代码围栏或解释：

# 第 N 章 memo

## 本章目标
<一句具体目标>

## 关联线索
- <真实 id；没有写“无”>

## 章节计划
<按已激活 Skill 给出本章可执行计划；包含所需场景、长度分配、人物选择、承诺处理、章尾变化和真实 hook id>`;

export const PLANNER_MEMO_SYSTEM_PROMPT_EN = `Compile the authoritative Work context into the next chapter_memo. Do not write chapter prose.

Professional planning methodology comes only from the activated Skill. This protocol defines authority and output structure:
- The user's current-chapter instruction overrides local planning.
- Preserve the user brief, author intent, book rules, and established facts.
- The outline is the default only when it does not conflict with higher authority.
- Never invent hook ids, character facts, or past events absent from the input.

Output plain Markdown without YAML, JSON, code fences, or commentary:

# Chapter N memo

## Chapter goal
<one concrete goal>

## Thread refs
- <real id; write "none" when empty>

## Chapter plan
<an executable plan following the activated Skill; include needed scenes, length allocation, character choices, promise handling, end-state change, and real hook ids>`;

export const PLANNER_MEMO_USER_TEMPLATE = `# 第 {{chapterNumber}} 章 memo 请求

{{brief_block}}
{{chapter_context_block}}

## 上一章最后一屏（原文节选）
{{previous_chapter_ending_excerpt}}

## 最近 3 章摘要
{{recent_summaries}}

## 当前 arc
{{current_arc_prose}}

## 主角 / 对手 / 协作者
主角：{{protagonist_matrix_row}}
对手：{{opponent_rows}}
协作者：{{collaborator_rows}}

## 可用 thread 与陈旧 hook
{{relevant_threads}}
{{recyclable_hooks}}

## 宿主约束
- 黄金开篇：{{isGoldenOpening}}
- 篇幅：目标 {{lengthTarget}} {{lengthUnit}}；建议 {{lengthSoftMin}}-{{lengthSoftMax}}；硬区间 {{lengthHardMin}}-{{lengthHardMax}}
{{book_rules_relevant}}`;

export const PLANNER_MEMO_USER_TEMPLATE_EN = `# Chapter {{chapterNumber}} memo request

{{brief_block}}
{{chapter_context_block}}

## Previous chapter ending excerpt
{{previous_chapter_ending_excerpt}}

## Recent three-chapter summaries
{{recent_summaries}}

## Current arc
{{current_arc_prose}}

## Protagonist / opposition / collaborators
Protagonist: {{protagonist_matrix_row}}
Opposition: {{opponent_rows}}
Collaborators: {{collaborator_rows}}

## Available threads and stale hooks
{{relevant_threads}}
{{recyclable_hooks}}

## Host constraints
- Opening chapter: {{isGoldenOpening}}
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
  readonly protagonistMatrixRow: string;
  readonly opponentRows: string;
  readonly collaboratorRows: string;
  readonly relevantThreads: string;
  readonly recyclableHooks: string;
  readonly isGoldenOpening: boolean;
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
  readonly language?: "zh" | "en";
}

export function buildPlannerUserMessage(input: PlannerUserMessageInput): string {
  const language = input.language ?? "zh";
  return getPlannerMemoUserTemplate(language)
    .replaceAll("{{chapterNumber}}", String(input.chapterNumber))
    .replaceAll("{{brief_block}}", authorityBlock(input.brief, language, "brief"))
    .replaceAll("{{chapter_context_block}}", authorityBlock(input.chapterContext, language, "chapter"))
    .replaceAll("{{previous_chapter_ending_excerpt}}", input.previousChapterEndingExcerpt)
    .replaceAll("{{recent_summaries}}", input.recentSummaries)
    .replaceAll("{{current_arc_prose}}", input.currentArcProse)
    .replaceAll("{{protagonist_matrix_row}}", input.protagonistMatrixRow)
    .replaceAll("{{opponent_rows}}", input.opponentRows)
    .replaceAll("{{collaborator_rows}}", input.collaboratorRows)
    .replaceAll("{{relevant_threads}}", input.relevantThreads)
    .replaceAll("{{recyclable_hooks}}", input.recyclableHooks)
    .replaceAll("{{isGoldenOpening}}", input.isGoldenOpening ? (language === "en" ? "yes" : "是") : (language === "en" ? "no" : "否"))
    .replaceAll("{{lengthTarget}}", String(input.lengthBudget.target))
    .replaceAll("{{lengthSoftMin}}", String(input.lengthBudget.softMin))
    .replaceAll("{{lengthSoftMax}}", String(input.lengthBudget.softMax))
    .replaceAll("{{lengthHardMin}}", String(input.lengthBudget.hardMin))
    .replaceAll("{{lengthHardMax}}", String(input.lengthBudget.hardMax))
    .replaceAll("{{lengthUnit}}", input.lengthBudget.unit)
    .replaceAll("{{book_rules_relevant}}", input.bookRulesRelevant);
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
