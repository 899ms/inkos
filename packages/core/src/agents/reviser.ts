import { BaseAgent } from "./base.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { filterSummaries } from "../utils/context-filter.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
} from "../utils/governed-working-set.js";
import { applySpotFixPatches, parseSpotFixPatches } from "../utils/spot-fix-patches.js";
import {
  buildNarrativeIntentBrief,
  renderMemoAsNarrativeBlock,
  renderNarrativeSelectedContext,
} from "../utils/narrative-control.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readStoryFrame,
  readVolumeMap,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";

export type ReviseMode = "auto" | "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "auto";

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

type AutoOutputMode = "patch-only" | "rewrite-only" | "allow-full";

function buildTieredIssueList(
  issues: ReadonlyArray<AuditIssue>,
  isEnglish: boolean,
): string {
  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];

  for (const issue of issues) {
    const line = `- ${issue.category}: ${issue.description}`;
    if (issue.severity === "critical") {
      critical.push(line);
    } else if (issue.severity === "warning") {
      high.push(line);
    } else {
      medium.push(line);
    }
  }

  const parts: string[] = [];
  if (critical.length > 0) {
    parts.push(isEnglish
      ? `## Critical — Must Fix\n${critical.join("\n")}`
      : `## Critical（必须解决）\n${critical.join("\n")}`);
  }
  if (high.length > 0) {
    parts.push(isEnglish
      ? `## High — Should Improve\n${high.join("\n")}`
      : `## High（应当改善）\n${high.join("\n")}`);
  }
  if (medium.length > 0) {
    parts.push(isEnglish
      ? `## Medium — Reference\n${medium.join("\n")}`
      : `## Medium（参考建议）\n${medium.join("\n")}`);
  }

  return parts.join("\n\n");
}

const MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
  auto: "", // auto mode uses buildAutoSystemPrompt instead
  polish: "只改文字表面，不改变事实、事件、人物或因果。",
  rewrite: "围绕问题段落重写；只有问题跨越整章时才重写整章。",
  rework: "允许重构场景与冲突，但不得改动权威设定和既成事实。",
  "anti-detect": "保持剧情、事实、人物和因果不变，只调整文字表面。",
  "spot-fix": "只输出能在原文唯一命中的局部替换，未命中的内容保持原样。",
};

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    genre?: string,
    options?: {
      chapterIntent?: string;
      chapterMemo?: ChapterMemo;
      chapterIntentData?: ChapterIntent;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      lengthSpec?: LengthSpec;
      baselineChapter?: number;
    },
  ): Promise<ReviseOutput> {
    const baselineStoryDir = options?.baselineChapter === undefined
      ? join(bookDir, "story")
      : join(bookDir, "story", "snapshots", String(options.baselineChapter));
    const [currentState, ledger, hooks, styleGuideRaw, volumeOutline, storyBible, characterMatrix, chapterSummaries, parentCanon, fanficCanon] = await Promise.all([
      options?.baselineChapter === undefined
        ? readCurrentStateWithFallback(bookDir, "(文件不存在)")
        : this.readFileSafe(join(baselineStoryDir, "current_state.md")),
      this.readFileSafe(join(baselineStoryDir, "particle_ledger.md")),
      this.readFileSafe(join(baselineStoryDir, "pending_hooks.md")),
      this.readFileSafe(join(bookDir, "story/style_guide.md")),
      readVolumeMap(bookDir, "(文件不存在)"),
      readStoryFrame(bookDir, "(文件不存在)"),
      options?.baselineChapter === undefined
        ? readCharacterContext(bookDir, "(文件不存在)")
        : this.readSnapshotCharacterContext(bookDir, baselineStoryDir),
      this.readFileSafe(join(baselineStoryDir, "chapter_summaries.md")),
      this.readFileSafe(join(bookDir, "story/parent_canon.md")),
      this.readFileSafe(join(bookDir, "story/fanfic_canon.md")),
    ]);

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

    const isEnglish = (bookLanguage ?? gp.language) === "en";
    const resolvedLanguage = isEnglish ? "en" : "zh";

    const issueList = mode === "auto"
      ? buildTieredIssueList(issues, isEnglish)
      : issues
          .map((i) => `- [${i.severity}] ${i.category}: ${i.description}\n  ${isEnglish ? "Suggestion" : "建议"}: ${i.suggestion}`)
          .join("\n");

    const numericalRule = gp.numericalSystem
      ? (isEnglish
          ? "\n3. Numerical errors must be fixed precisely — cross-check before and after"
          : "\n3. 数值错误必须精确修正，前后对账")
      : "";
    const protagonistBlock = bookRules?.protagonist
      ? (isEnglish
          ? `\n\nProtagonist lock: ${bookRules.protagonist.name} — ${bookRules.protagonist.personalityLock.join(", ")}. Revisions must not violate the protagonist profile.`
          : `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`)
      : "";
    // Length guardrail only used by legacy modes (manual CLI revise).
    // Auto mode delegates length to normalize, not reviser.
    const lengthGuardrail = mode !== "auto" && options?.lengthSpec
      ? (isEnglish
          ? "\n8. Keep the chapter word count within the target range; only allow minor deviation when fixing critical issues truly requires it"
          : "\n8. 保持章节字数在目标区间内；只有在修复关键问题确实需要时才允许轻微偏离")
      : "";
    const langPrefix = isEnglish
      ? `【LANGUAGE OVERRIDE】ALL output (FIXED_ISSUES, PATCHES, REVISED_CONTENT) MUST be in English.\n\n`
      : "";
    const governedMode = Boolean(options?.chapterIntent && options?.contextPackage && options?.ruleStack);
    const hooksWorkingSet = governedMode && options?.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: options.contextPackage,
          chapterNumber,
          language: resolvedLanguage,
        })
      : hooks;
    const chapterSummariesWorkingSet = governedMode
      ? filterSummaries(chapterSummaries, chapterNumber)
      : chapterSummaries;
    const characterMatrixWorkingSet = governedMode
      ? buildGovernedCharacterMatrixWorkingSet({
          matrixMarkdown: characterMatrix,
          chapterIntent: options?.chapterIntent ?? volumeOutline,
          contextPackage: options!.contextPackage!,
          protagonistName: bookRules?.protagonist?.name,
        })
      : characterMatrix;

    const autoOutputMode = mode === "auto" ? resolveAutoOutputMode(issues) : "allow-full";
    const systemPromptBase = mode === "auto"
      ? this.buildAutoSystemPrompt({ langPrefix, protagonistBlock, numericalRule, lengthGuardrail, resolvedLanguage, lengthSpec: options?.lengthSpec, autoOutputMode })
      : this.buildLegacySystemPrompt({ langPrefix, protagonistBlock, numericalRule, lengthGuardrail, mode, resolvedLanguage });
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.reviser");

    const ledgerBlock = gp.numericalSystem
      ? `\n## 资源账本\n${ledger}`
      : "";
    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;
    const hookDebtBlock = governedMemoryBlocks?.hookDebtBlock ?? "";
    const hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? `\n## 伏笔池\n${hooksWorkingSet}\n`;
    const outlineBlock = volumeOutline !== "(文件不存在)"
      ? `\n## 卷纲\n${volumeOutline}\n`
      : "";
    const bibleBlock = !governedMode && storyBible !== "(文件不存在)"
      ? `\n## 世界观设定\n${storyBible}\n`
      : "";
    const matrixBlock = characterMatrixWorkingSet !== "(文件不存在)"
      ? `\n## 角色交互矩阵\n${characterMatrixWorkingSet}\n`
      : "";
    const summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (chapterSummariesWorkingSet !== "(文件不存在)"
        ? `\n## 章节摘要\n${chapterSummariesWorkingSet}\n`
        : "");
    const volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    const hasParentCanon = parentCanon !== "(文件不存在)";
    const hasFanficCanon = fanficCanon !== "(文件不存在)";

    const canonBlock = hasParentCanon
      ? `\n## 正传正典参照（修稿专用）\n本书为番外作品。修改时参照正典约束，不可改变正典事实。\n${parentCanon}\n`
      : "";

    const fanficCanonBlock = hasFanficCanon
      ? `\n## 同人正典参照（修稿专用）\n本书为同人作品。修改时参照正典角色档案和世界规则，不可违反正典事实。角色对话必须保留原作语癖。\n${fanficCanon}\n`
      : "";
    const reducedControlBlock = options?.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.chapterMemo, options.chapterIntentData, options.chapterIntent, options.contextPackage, options.ruleStack)
      : "";
    // Length guardrail only in legacy modes — auto mode delegates length to normalize.
    const lengthGuidanceBlock = mode !== "auto" && options?.lengthSpec
      ? `\n## 字数护栏\n目标字数：${options.lengthSpec.target}\n允许区间：${options.lengthSpec.softMin}-${options.lengthSpec.softMax}\n极限区间：${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}\n如果修正后超出允许区间，请优先压缩冗余解释、重复动作和弱信息句，不得新增支线或删掉核心事实。\n`
      : "";
    const styleGuideBlock = reducedControlBlock.length === 0
      ? `\n## 文风指南\n${styleGuide}`
      : "";

    const userPrompt = `请修正第${chapterNumber}章。

## 审稿问题
${issueList}

## 当前状态卡
${currentState}
${ledgerBlock}
${hookDebtBlock}${hooksBlock}${volumeSummariesBlock}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## 待修正章节
${chapterContent}`;

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.3 },
    );

    const output = this.parseOutput(
      response.content,
      mode,
      chapterContent,
      autoOutputMode,
    );
    const wordCount = options?.lengthSpec
      ? countChapterLength(output.revisedContent, options.lengthSpec.countingMode)
      : output.wordCount;
    return { ...output, wordCount, tokenUsage: response.usage };
  }

  private parseOutput(
    content: string,
    mode: ReviseMode,
    originalChapter: string,
    autoOutputMode: AutoOutputMode = "allow-full",
  ): ReviseOutput {
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const fixedRaw = extract("FIXED_ISSUES");
    const fixedIssues = fixedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const makeResult = (revisedContent: string, applied: boolean): ReviseOutput => ({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: applied ? fixedIssues : [],
    });

    // Auto mode obeys the auditor's structured repair scope. It never infers
    // semantic intent from issue prose.
    if (mode === "auto") {
      if (autoOutputMode === "patch-only") {
        const patchesRaw = extract("PATCHES");
        if (patchesRaw) {
          const patches = parseSpotFixPatches(patchesRaw);
          if (patches.length > 0) {
            const patchResult = applySpotFixPatches(originalChapter, patches);
            if (patchResult.applied && patchResult.appliedPatchCount / patches.length >= 0.5) {
              return makeResult(patchResult.revisedContent, true);
            }
          }
        }
        return makeResult(originalChapter, false);
      }

      if (autoOutputMode === "rewrite-only") {
        const revisedContent = extract("REVISED_CONTENT");
        if (revisedContent) {
          return makeResult(revisedContent, true);
        }
        // No rewrite produced — don't fall back to patches; structural issues
        // cannot be safely patched. Return original unchanged.
        return makeResult(originalChapter, false);
      }

      const revisedContent = extract("REVISED_CONTENT");
      if (revisedContent) {
        return makeResult(revisedContent, true);
      }
      const patchesRaw = extract("PATCHES");
      if (patchesRaw) {
        const patches = parseSpotFixPatches(patchesRaw);
        if (patches.length > 0) {
          const patchResult = applySpotFixPatches(originalChapter, patches);
          if (patchResult.applied && patchResult.appliedPatchCount / patches.length >= 0.5) {
            return makeResult(patchResult.revisedContent, true);
          }
        }
      }
      // Both empty — no fix
      return makeResult(originalChapter, false);
    }

    // Legacy spot-fix mode: patches only
    if (mode === "spot-fix") {
      const patches = parseSpotFixPatches(extract("PATCHES"));
      const patchResult = applySpotFixPatches(originalChapter, patches);
      return makeResult(patchResult.revisedContent, patchResult.applied);
    }

    // Legacy rewrite/polish/rework/anti-detect: full content
    const revisedContent = extract("REVISED_CONTENT");
    return makeResult(revisedContent || originalChapter, revisedContent.length > 0);
  }

  private buildAutoSystemPrompt(params: {
    langPrefix: string;
    protagonistBlock: string;
    numericalRule: string;
    lengthGuardrail: string;
    resolvedLanguage: "zh" | "en";
    lengthSpec?: LengthSpec;
    autoOutputMode: AutoOutputMode;
  }): string {
    const { langPrefix, protagonistBlock, numericalRule, resolvedLanguage, lengthSpec, autoOutputMode } = params;
    // lengthGuardrail intentionally not used in auto mode — length constraint is embedded in REVISED_CONTENT description
    const en = resolvedLanguage === "en";
    const rewriteLengthConstraint = lengthSpec
      ? (en
          ? `\n  HARD CONSTRAINT: The revised chapter must stay within ${lengthSpec.softMin}-${lengthSpec.softMax} characters (target: ${lengthSpec.target}, ±25%). This is non-negotiable — do not exceed this range.`
          : `\n  硬性约束：重写后的章节必须控制在 ${lengthSpec.softMin}-${lengthSpec.softMax} 字以内（目标 ${lengthSpec.target} 字，±25%）。这是不可突破的底线。`)
      : "";

    const routingDirectiveEn = autoOutputMode === "rewrite-only"
      ? "\n\nROUTING: You MUST output REVISED_CONTENT and omit PATCHES. If a safe rewrite is impossible, explain in FIXED_ISSUES and leave REVISED_CONTENT empty."
      : autoOutputMode === "patch-only"
        ? "\n\nROUTING: You MUST output PATCHES only and omit REVISED_CONTENT. If a unique local replacement is impossible, leave PATCHES empty."
        : "";
    const routingDirectiveZh = autoOutputMode === "rewrite-only"
      ? "\n\n分流指令：你必须输出 REVISED_CONTENT，禁止输出 PATCHES。无法安全重写时在 FIXED_ISSUES 说明，并留空 REVISED_CONTENT。"
      : autoOutputMode === "patch-only"
        ? "\n\n分流指令：你必须只输出 PATCHES，禁止输出 REVISED_CONTENT。无法唯一命中局部原文时留空 PATCHES。"
        : "";

    return en
      ? `${langPrefix}Revise the chapter according to the supplied issues, governed context, and activated professional skills.${protagonistBlock}${routingDirectiveEn}${numericalRule}${rewriteLengthConstraint}

PATCHES preserve all untouched text and require an exact source quote. REVISED_CONTENT returns the complete replacement chapter.

Output format:

=== FIXED_ISSUES ===
(List each fix on its own line; if a safe local fix is not possible, explain here)

=== PATCHES ===
(Output local patches if applicable. Omit this section entirely if using REVISED_CONTENT)
--- PATCH 1 ---
TARGET_TEXT:
(Exact quote from the original that identifies the passage to change)
REPLACEMENT_TEXT:
(Replacement text for this passage)
--- END PATCH ---

=== REVISED_CONTENT ===
(Full revised chapter content — only when PATCHES cannot solve the problem. Omit this section if using PATCHES)`
      : `${langPrefix}按审稿问题、权威上下文和已激活的专业 Skill 修订章节。${protagonistBlock}${routingDirectiveZh}${numericalRule}${rewriteLengthConstraint}

PATCHES 必须精确引用原文，未涉及内容保持不变；REVISED_CONTENT 返回完整替换正文。

输出格式：

=== FIXED_ISSUES ===
(逐条说明修正了什么)

=== PATCHES ===
(局部补丁——仅用于局部文字问题。有全章级问题时省略此区块)
--- PATCH 1 ---
TARGET_TEXT:
(从原文中精确引用要修改的段落)
REPLACEMENT_TEXT:
(替换后的文本)
--- END PATCH ---

=== REVISED_CONTENT ===
(修正后的完整正文——用于字数/结构/节奏等全章级问题。仅局部问题时省略此区块)`;
  }

  private buildLegacySystemPrompt(params: {
    langPrefix: string;
    protagonistBlock: string;
    numericalRule: string;
    lengthGuardrail: string;
    mode: ReviseMode;
    resolvedLanguage: "zh" | "en";
  }): string {
    const { langPrefix, protagonistBlock, numericalRule, lengthGuardrail, mode } = params;
    const modeDesc = MODE_DESCRIPTIONS[mode];
    const outputFormat = mode === "spot-fix"
      ? `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条；如果无法安全定点修复，也在这里说明)

=== PATCHES ===
--- PATCH 1 ---
TARGET_TEXT:
(必须从原文中精确复制、且能唯一命中的原句或原段)
REPLACEMENT_TEXT:
(替换后的局部文本)
--- END PATCH ---`
      : `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条)

=== REVISED_CONTENT ===
(修正后的完整正文)`;

    return `${langPrefix}按审稿问题、权威上下文和已激活的专业 Skill 修订章节。${protagonistBlock}

修稿模式：${modeDesc}
正文必须服从既有事实和伏笔约束；不要输出或重写状态文件。${numericalRule}${lengthGuardrail}
${mode === "spot-fix" ? "\nspot-fix 只能输出局部补丁；TARGET_TEXT 必须在原文中唯一命中。" : ""}

输出格式：

${outputFormat}`;
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }

  private async readSnapshotCharacterContext(
    bookDir: string,
    snapshotStoryDir: string,
  ): Promise<string> {
    const snapshotMatrix = await this.readFileSafe(join(snapshotStoryDir, "character_matrix.md"));
    if (snapshotMatrix !== "(文件不存在)") return snapshotMatrix;
    return readCharacterContext(bookDir, "(文件不存在)");
  }

  private buildReducedControlBlock(
    memo: ChapterMemo | undefined,
    intent: ChapterIntent | undefined,
    chapterIntent: string | undefined,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
  ): string {
    const selectedContext = renderNarrativeSelectedContext(contextPackage.selectedContext, "zh")
      .replace(/^### /gm, "- ");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";
    // Prefer memo-based narrative block; fall back to legacy intent markdown
    const narrativeBlock = memo
      ? renderMemoAsNarrativeBlock(memo, intent, "zh")
      : chapterIntent
        ? buildNarrativeIntentBrief(chapterIntent, "zh")
        : "(无)";

    return `\n## 本章控制输入（由 Planner/Composer 编译）
${narrativeBlock}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }
}

function resolveAutoOutputMode(issues: ReadonlyArray<AuditIssue>): AutoOutputMode {
  if (issues.length === 0) {
    return "allow-full";
  }
  const scopedBlocking = issues.filter((issue) => issue.severity !== "info" && issue.repairScope);
  if (scopedBlocking.length > 0) {
    if (scopedBlocking.some((issue) => issue.repairScope === "structural")) {
      return "rewrite-only";
    }
    if (
      scopedBlocking.length === issues.filter((issue) => issue.severity !== "info").length
      && scopedBlocking.every((issue) => issue.repairScope === "local")
    ) {
      return "patch-only";
    }
  }

  const blocking = issues.filter((issue) => issue.severity !== "info");
  if (blocking.length === 0) {
    return "patch-only"; // only hints / info — at most local polish
  }
  // Unknown scope is intentionally not guessed from natural-language labels.
  // The reviser may choose the safest representation from the actual issue text.
  return "allow-full";
}
