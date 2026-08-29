import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { FanficMode } from "../models/book.js";
import type { ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { readFile, readdir } from "node:fs/promises";
import { filterHooks, filterSummaries, filterSubplots, filterEmotionalArcs, filterCharacterMatrix } from "../utils/context-filter.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import {
  readVolumeMap,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";
import { join } from "node:path";

export interface AuditResult {
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly summary: string;
  /** True when the reviewer response itself was not parseable. */
  readonly parseFailed?: boolean;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface AuditIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
  readonly repairScope?: "local" | "structural" | "unknown";
}

type PromptLanguage = "zh" | "en";

function normalizeRepairScope(value: unknown): AuditIssue["repairScope"] {
  if (value === "local" || value === "structural" || value === "unknown") return value;
  return undefined;
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function resolveGenreLabel(genreId: string, profileName: string, language: PromptLanguage): string {
  if (language === "zh" || !containsChinese(profileName)) {
    return profileName;
  }

  if (genreId === "other") {
    return "general";
  }

  return genreId.replace(/[_-]+/g, " ");
}

function joinLocalized(items: ReadonlyArray<string>, language: PromptLanguage): string {
  return items.join(language === "en" ? ", " : "、");
}

function buildReviewConfiguration(
  gp: GenreProfile,
  bookRules: BookRules | null,
  language: PromptLanguage,
  hasParentCanon: boolean,
  fanficMode?: FanficMode,
): string {
  const words = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
    ? bookRules.fatigueWordsOverride
    : gp.fatigueWords;
  const custom = bookRules?.additionalAuditDimensions ?? [];
  const era = [bookRules?.eraConstraints?.period, bookRules?.eraConstraints?.region].filter(Boolean);
  const values = {
    profileDimensionIds: gp.auditDimensions,
    customDimensions: custom,
    fatigueWords: words,
    payoffTypes: gp.satisfactionTypes,
    eraResearch: gp.eraResearch || bookRules?.eraConstraints?.enabled === true,
    era,
    parentCanon: hasParentCanon,
    fanficMode: fanficMode ?? null,
    allowedFanficDeviations: bookRules?.allowedDeviations ?? [],
  };
  return language === "en"
    ? `Apply the activated review Skill to this runtime configuration:\n${JSON.stringify(values)}`
    : `按已激活的审稿 Skill 解释并应用以下运行时配置：\n${JSON.stringify(values)}`;
}

export class ContinuityAuditor extends BaseAgent {
  get name(): string {
    return "continuity-auditor";
  }

  async auditChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    genre?: string,
    options?: {
      temperature?: number;
      chapterIntent?: string;
      chapterMemo?: ChapterMemo;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      truthFileOverrides?: {
        currentState?: string;
        ledger?: string;
        hooks?: string;
      };
    },
  ): Promise<AuditResult> {
    const [diskCurrentState, diskLedger, diskHooks, styleGuideRaw, subplotBoard, emotionalArcs, characterMatrix, chapterSummaries, parentCanon, fanficCanon, volumeOutline] =
      await Promise.all([
        // Phase 5 consolidation: derive initial state from roles + seed hooks
        // when current_state.md is still the architect seed placeholder.
        readCurrentStateWithFallback(bookDir, "(文件不存在)"),
        this.readFileSafe(join(bookDir, "story/particle_ledger.md")),
        this.readFileSafe(join(bookDir, "story/pending_hooks.md")),
        this.readFileSafe(join(bookDir, "story/style_guide.md")),
        this.readFileSafe(join(bookDir, "story/subplot_board.md")),
        this.readFileSafe(join(bookDir, "story/emotional_arcs.md")),
        readCharacterContext(bookDir, "(文件不存在)"),
        this.readFileSafe(join(bookDir, "story/chapter_summaries.md")),
        this.readFileSafe(join(bookDir, "story/parent_canon.md")),
        this.readFileSafe(join(bookDir, "story/fanfic_canon.md")),
        readVolumeMap(bookDir, "(文件不存在)"),
      ]);
    const currentState = options?.truthFileOverrides?.currentState ?? diskCurrentState;
    const ledger = options?.truthFileOverrides?.ledger ?? diskLedger;
    const hooks = options?.truthFileOverrides?.hooks ?? diskHooks;

    const hasParentCanon = parentCanon !== "(文件不存在)";
    const hasFanficCanon = fanficCanon !== "(文件不存在)";

    // Load last chapter full text for fine-grained continuity checking
    const previousChapter = await this.loadPreviousChapter(bookDir, chapterNumber);

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    const [{ profile: gp }, bookLanguage] = await Promise.all([
      readGenreProfile(this.ctx.projectRoot, genreId),
      readBookLanguage(bookDir),
    ]);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;

    // Fallback: use book_rules body when style_guide.md doesn't exist.
    // Phase 5 hotfix 2: parsedRules.body is only populated for legacy
    // book_rules.md sources — story_frame.md frontmatter yields an empty
    // body, and an empty string is NOT a usable style guide. Treat
    // missing/empty body as "no fallback available".
    const legacyRulesBody = parsedRules?.body?.trim();
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (legacyRulesBody || "(无文风指南)");

    const resolvedLanguage = bookLanguage ?? gp.language;
    const isEnglish = resolvedLanguage === "en";
    const fanficMode = hasFanficCanon ? (bookRules?.fanficMode as FanficMode | undefined) : undefined;
    const reviewConfiguration = buildReviewConfiguration(gp, bookRules, resolvedLanguage, hasParentCanon, fanficMode);
    const genreLabel = resolveGenreLabel(genreId, gp.name, resolvedLanguage);

    const protagonistBlock = bookRules?.protagonist
      ? isEnglish
        ? `\n\nProtagonist lock: ${bookRules.protagonist.name}; personality locks: ${joinLocalized(bookRules.protagonist.personalityLock, resolvedLanguage)}; behavioral constraints: ${joinLocalized(bookRules.protagonist.behavioralConstraints, resolvedLanguage)}.`
        : `\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}，行为约束：${bookRules.protagonist.behavioralConstraints.join("、")}`
      : "";

    const searchNote = gp.eraResearch
      ? isEnglish
        ? "\n\nYou have web-search capability (search_web / fetch_url). For real-world eras, people, events, geography, or policies, you must verify with search_web instead of relying on memory. Cross-check at least 2 sources."
        : "\n\n你有联网搜索能力（search_web / fetch_url）。对于涉及真实年代、人物、事件、地理、政策的内容，你必须用search_web核实，不可凭记忆判断。至少对比2个来源交叉验证。"
      : "";

    const systemPromptBase = isEnglish
      ? `Audit this ${genreLabel} chapter against the activated review skill and the supplied governed context. Review structure and delivery; prose-surface notes are info only. ALL OUTPUT MUST BE IN ENGLISH.${protagonistBlock}${searchNote}

Do not estimate chapter length; the host computes it. Use only concrete evidence.
${reviewConfiguration}

Return JSON only:
{"issues":[{"severity":"critical|warning|info","repair_scope":"local|structural|unknown","category":"dimension name","description":"evidence-backed issue","suggestion":"actionable repair"}],"summary":"one-sentence conclusion"}
An empty issues array is valid.`
      : `按已激活的审稿 Skill 和输入的权威上下文审查这篇${gp.name}章节，只审结构与交付；文字表面问题只能记为 info。${protagonistBlock}${searchNote}

不要估算章节字数，宿主会确定性计算。只报告有证据的问题。
${reviewConfiguration}

只返回 JSON：
{"issues":[{"severity":"critical|warning|info","repair_scope":"local|structural|unknown","category":"审查维度名称","description":"有证据的具体问题","suggestion":"可执行修复"}],"summary":"一句话结论"}
issues 为空是合法结果。`;
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.auditor");

    const ledgerBlock = gp.numericalSystem
      ? isEnglish
        ? `\n## Resource Ledger\n${ledger}`
        : `\n## 资源账本\n${ledger}`
      : "";

    // Smart context filtering for auditor — same logic as writer
    const bookRulesForFilter = parsedRules?.rules ?? null;
    const filteredSubplots = filterSubplots(subplotBoard);
    const filteredArcs = filterEmotionalArcs(emotionalArcs, chapterNumber);
    const filteredMatrix = filterCharacterMatrix(characterMatrix, volumeOutline, bookRulesForFilter?.protagonist?.name);
    const filteredSummaries = filterSummaries(chapterSummaries, chapterNumber);
    const filteredHooks = filterHooks(hooks);

    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;

    const hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? (filteredHooks !== "(文件不存在)"
        ? isEnglish
          ? `\n## Pending Hooks\n${filteredHooks}\n`
          : `\n## 伏笔池\n${filteredHooks}\n`
        : "");
    const subplotBlock = filteredSubplots !== "(文件不存在)"
      ? isEnglish
        ? `\n## Subplot Board\n${filteredSubplots}\n`
        : `\n## 支线进度板\n${filteredSubplots}\n`
      : "";
    const emotionalBlock = filteredArcs !== "(文件不存在)"
      ? isEnglish
        ? `\n## Emotional Arcs\n${filteredArcs}\n`
        : `\n## 情感弧线\n${filteredArcs}\n`
      : "";
    const matrixBlock = filteredMatrix !== "(文件不存在)"
      ? isEnglish
        ? `\n## Character Interaction Matrix\n${filteredMatrix}\n`
        : `\n## 角色交互矩阵\n${filteredMatrix}\n`
      : "";
    const summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (filteredSummaries !== "(文件不存在)"
        ? isEnglish
          ? `\n## Chapter Summaries (for pacing checks)\n${filteredSummaries}\n`
          : `\n## 章节摘要（用于节奏检查）\n${filteredSummaries}\n`
        : "");
    const volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    const canonBlock = hasParentCanon
      ? isEnglish
        ? `\n## Mainline Canon Reference (for spinoff audit)\n${parentCanon}\n`
        : `\n## 正传正典参照（番外审查专用）\n${parentCanon}\n`
      : "";

    const fanficCanonBlock = hasFanficCanon
      ? isEnglish
        ? `\n## Fanfic Canon Reference (for fanfic audit)\n${fanficCanon}\n`
        : `\n## 同人正典参照（同人审查专用）\n${fanficCanon}\n`
      : "";

    const memoBlock = options?.chapterMemo
      ? isEnglish
        ? `\n## Chapter Memo (for memo drift checks)\nGoal: ${options.chapterMemo.goal}\n\n${options.chapterMemo.body}\n`
        : `\n## 章节备忘（用于 memo 偏离检测）\ngoal：${options.chapterMemo.goal}\n\n${options.chapterMemo.body}\n`
      : "";
    const reducedControlBlock = options?.chapterIntent && options.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.chapterIntent, options.contextPackage, options.ruleStack, resolvedLanguage)
      : "";
    const styleGuideBlock = reducedControlBlock.length === 0
      ? isEnglish
        ? `\n## Style Guide\n${styleGuide}`
        : `\n## 文风指南\n${styleGuide}`
      : "";

    const prevChapterBlock = previousChapter
      ? isEnglish
        ? `\n## Previous Chapter Full Text (for transition checks)\n${previousChapter}\n`
        : `\n## 上一章全文（用于衔接检查）\n${previousChapter}\n`
      : "";

    const userPrompt = isEnglish
      ? `Review chapter ${chapterNumber}.

## Current State Card
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## Chapter Content Under Review
${chapterContent}`
      : `请审查第${chapterNumber}章。

## 当前状态卡
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## 待审章节内容
${chapterContent}`;

    const chatMessages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const chatOptions = { temperature: options?.temperature ?? 0.3 };

    // Use web search for fact verification when eraResearch is enabled
    const response = gp.eraResearch
      ? await this.chatWithSearch(chatMessages, chatOptions)
      : await this.chat(chatMessages, chatOptions);

    const result = this.parseAuditResult(response.content, resolvedLanguage);
    return { ...result, tokenUsage: response.usage };
  }

  private parseAuditResult(content: string, language: PromptLanguage): AuditResult {
    // Try multiple JSON extraction strategies (handles small/local models)

    // Strategy 1: Find balanced JSON object (not greedy)
    const balanced = this.extractBalancedJson(content);
    if (balanced) {
      const result = this.tryParseAuditJson(balanced, language);
      if (result) return result;
    }

    // Strategy 2: Try the whole content as JSON (some models output pure JSON)
    const trimmed = content.trim();
    if (trimmed.startsWith("{")) {
      const result = this.tryParseAuditJson(trimmed, language);
      if (result) return result;
    }

    // Strategy 3: Look for ```json code blocks
    const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      const result = this.tryParseAuditJson(codeBlockMatch[1]!.trim(), language);
      if (result) return result;
    }

    return {
      parseFailed: true,
      issues: [{
        severity: "warning",
        category: "review-unavailable",
        description: language === "en"
          ? "Audit output format was invalid and could not be parsed as JSON."
          : "审稿输出格式异常，无法解析为 JSON",
        suggestion: language === "en"
          ? "The model may not support reliable structured output. Try a stronger model or inspect the API response format."
          : "可能是模型不支持结构化输出。尝试换一个更大的模型，或检查 API 返回格式。",
      }],
      summary: language === "en" ? "Audit output parsing failed" : "审稿输出解析失败",
    };
  }

  private buildReducedControlBlock(
    chapterIntent: string,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
    language: PromptLanguage,
  ): string {
    const selectedContext = contextPackage.selectedContext
      .map((entry) => `- ${entry.source}: ${entry.reason}${entry.excerpt ? ` | ${entry.excerpt}` : ""}`)
      .join("\n");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";

    return language === "en"
      ? `\n## Chapter Control Inputs (compiled by Planner/Composer)
${chapterIntent}

### Selected Context
${selectedContext || "- none"}

### Rule Stack
- Hard guardrails: ${ruleStack.sections.hard.join(", ") || "(none)"}
- Soft constraints: ${ruleStack.sections.soft.join(", ") || "(none)"}
- Diagnostic rules: ${ruleStack.sections.diagnostic.join(", ") || "(none)"}

### Active Overrides
${overrides}\n`
      : `\n## 本章控制输入（由 Planner/Composer 编译）
${chapterIntent}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }

  private extractBalancedJson(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  private tryParseAuditJson(json: string, language: PromptLanguage = "zh"): AuditResult | null {
    try {
      const parsed = JSON.parse(json);
      return {
        issues: Array.isArray(parsed.issues)
	          ? parsed.issues.map((i: Record<string, unknown>) => ({
	              severity: (i.severity as string) ?? "warning",
	              category: (i.category as string) ?? (language === "en" ? "Uncategorized" : "未分类"),
	              description: (i.description as string) ?? "",
	              suggestion: (i.suggestion as string) ?? "",
	              repairScope: normalizeRepairScope(i.repair_scope ?? i.repairScope),
	            }))
          : [],
        summary: String(parsed.summary ?? ""),
      };
    } catch {
      return null;
    }
  }

  private async loadPreviousChapter(bookDir: string, currentChapter: number): Promise<string> {
    if (currentChapter <= 1) return "";
    const chaptersDir = join(bookDir, "chapters");
    try {
      const files = await readdir(chaptersDir);
      const paddedPrev = String(currentChapter - 1).padStart(4, "0");
      const prevFile = files.find((f) => f.startsWith(paddedPrev) && f.endsWith(".md"));
      if (!prevFile) return "";
      return await readFile(join(chaptersDir, prevFile), "utf-8");
    } catch {
      return "";
    }
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }
}
