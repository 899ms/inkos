import { BaseAgent } from "./base.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import {
  buildGovernedHookWorkingSet,
} from "../utils/governed-working-set.js";
import { applySpotFixPatches } from "../utils/spot-fix-patches.js";
import { ChapterRewriteToolSchema, ChapterSpotFixToolSchema } from "./reviser-tool.js";
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

export type ReviseMode = "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "rewrite";

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

const MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
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

    const issueList = issues
      .map((i) => `- [${i.severity}] ${i.category}: ${i.description}\n  ${isEnglish ? "Suggestion" : "建议"}: ${i.suggestion}`)
      .join("\n");

    const protagonistBlock = bookRules?.protagonist
      ? (isEnglish
          ? `\n\nProtagonist lock: ${bookRules.protagonist.name} — ${bookRules.protagonist.personalityLock.join(", ")}. Revisions must not violate the protagonist profile.`
          : `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`)
      : "";
    const lengthGuardrail = options?.lengthSpec
      ? (isEnglish
          ? "\n8. Keep the chapter word count within the target range; only allow minor deviation when fixing critical issues truly requires it"
          : "\n8. 保持章节字数在目标区间内；只有在修复关键问题确实需要时才允许轻微偏离")
      : "";
    const langPrefix = isEnglish
      ? "【LANGUAGE OVERRIDE】All submitted text must be in English.\n\n"
      : "";
    const governedMode = Boolean(options?.chapterIntent && options?.contextPackage && options?.ruleStack);
    const hooksWorkingSet = governedMode && options?.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: options.contextPackage,
          language: resolvedLanguage,
        })
      : hooks;
    const chapterSummariesWorkingSet = chapterSummaries;
    const characterMatrixWorkingSet = characterMatrix;

    const systemPromptBase = this.buildSystemPrompt({ langPrefix, protagonistBlock, lengthGuardrail, mode });
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.reviser");

    const ledgerBlock = ledger !== "(文件不存在)" && ledger.trim().length > 0
      ? `\n## 资源账本\n${ledger}`
      : "";
    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;
    const referencedHooksBlock = governedMemoryBlocks?.referencedHooksBlock ?? "";
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
    const lengthGuidanceBlock = options?.lengthSpec
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
${referencedHooksBlock}${hooksBlock}${volumeSummariesBlock}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## 待修正章节
${chapterContent}`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const output = mode === "spot-fix"
      ? await this.submitSpotFix(messages, chapterContent)
      : await this.submitRewrite(messages);
    const wordCount = options?.lengthSpec
      ? countChapterLength(output.revisedContent, options.lengthSpec.countingMode)
      : output.wordCount;
    return { ...output, wordCount };
  }

  private async submitSpotFix(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
    originalChapter: string,
  ): Promise<ReviseOutput> {
    const { result, usage } = await this.submitStructured(
      messages,
      {
        name: "submit_chapter_patches",
        label: "Submit chapter patches",
        description: "Submit local exact-text replacements for host application.",
        parameters: ChapterSpotFixToolSchema,
      },
      { temperature: 0.3 },
    );
    const patchResult = applySpotFixPatches(originalChapter, result.patches);
    return {
      revisedContent: patchResult.revisedContent,
      wordCount: patchResult.revisedContent.length,
      fixedIssues: patchResult.applied ? result.fixedIssues : [],
      tokenUsage: usage,
    };
  }

  private async submitRewrite(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
  ): Promise<ReviseOutput> {
    const { result, usage } = await this.submitStructured(
      messages,
      {
        name: "submit_revised_chapter",
        label: "Submit revised chapter",
        description: "Submit the complete revised chapter and the addressed observations.",
        parameters: ChapterRewriteToolSchema,
      },
      { temperature: 0.3 },
    );
    return {
      revisedContent: result.revisedContent,
      wordCount: result.revisedContent.length,
      fixedIssues: result.fixedIssues,
      tokenUsage: usage,
    };
  }

  private buildSystemPrompt(params: {
    langPrefix: string;
    protagonistBlock: string;
    lengthGuardrail: string;
    mode: ReviseMode;
  }): string {
    const { langPrefix, protagonistBlock, lengthGuardrail, mode } = params;
    const modeDesc = MODE_DESCRIPTIONS[mode];
    return `${langPrefix}按审稿问题、权威上下文和已激活的专业 Skill 修订章节。${protagonistBlock}

修稿模式：${modeDesc}
正文必须服从既有事实和伏笔约束；不要输出或重写状态文件。${lengthGuardrail}
${mode === "spot-fix" ? "\nspot-fix 只能通过结果工具提交局部补丁；targetText 必须从原文精确复制并唯一命中。" : "\n通过结果工具提交完整修订正文。"}`;
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

### 当前覆盖
${overrides}\n`;
  }
}
