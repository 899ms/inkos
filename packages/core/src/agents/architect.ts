import { BaseAgent } from "./base.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { readGenreProfile } from "./rules-reader.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { renderHookSnapshot } from "../utils/memory-retrieval.js";
import {
  shouldPromoteHook,
  type PromotionContext,
  type VolumeBoundary,
} from "../utils/hook-promotion.js";
import type { StoredHook } from "../state/memory-db.js";

// ---------------------------------------------------------------------------
// Phase 5 (v13) — Static 骨架 layer collapse
// Phase 5 consolidation — 7 sections → 5 sections (output shrinks ~25–40%).
//
// Architect now produces 2 prose outline files + one-file-per-character roles/
// folder, plus compat pointer shims. The LLM output contract is 5 blocks:
//
//   === SECTION: story_frame ===   4 散文段（主题 / 冲突 / 世界铁律+质感 / 终局）
//   === SECTION: volume_map ===    5 散文段 + 尾段「6 条节奏原则（具体化 + 通用）」
//   === SECTION: roles ===         一人一卡；主角卡承载完整弧线（起点→终点→代价）
//   === SECTION: book_rules ===    普通 Markdown 规则卡，宿主负责结构化解析
//   === SECTION: pending_hooks ===  13-column 表；可含 startChapter=0 种子行
//
// Consolidation rules (MUST reflect in prompt):
//   - 主角弧线只写在 roles/<主角>.md，不在 story_frame 重复
//   - 世界铁律/世界质感只写在 story_frame.世界观底色，不在 book_rules 重复
//   - 节奏原则只写在 volume_map 尾段，不作为独立 section
//     （至少 3 条具体化，其余可为通用原则）
//   - 初始状态拆分：角色当前现状 → roles.当前现状；初始钩子 → pending_hooks (startChapter=0)；
//     环境/时代锚（仅历史/年代题材需要）→ 自然融入 story_frame.世界观底色
//   - 独立的 current_state section 已删除。现状只在运行时写入 current_state.md
//     （consolidator 每章追加），建书时架构师不产出结构化初始态。
//
// Budget table (4 content items — LLM sections):
//   story_frame ≤ 3000 chars / volume_map ≤ 5000 chars / roles 总 ≤ 8000 chars
//   book_rules ≤ 1000 chars (Markdown rules card) / pending_hooks ≤ 2000 chars
//
// 输出落盘 contract（未变）：
//   outline/story_frame.md      ← 4 prose sections
//   outline/volume_map.md       ← 5 prose sections + 节奏原则尾段
//   roles/主要角色/<name>.md    ← one file per major character
//   roles/次要角色/<name>.md    ← one file per minor character
//   story_bible.md              ← compat shim
//   character_matrix.md         ← compat shim
//   book_rules.md               ← authoritative Markdown rules card
//   current_state.md            ← seed 占位文件（运行时 consolidator 每章追加）
//   pending_hooks.md            ← 架构师初始伏笔池
//   emotional_arcs.md           ← runtime state
//
// 「散文密度」= 架构师 LLM 的输出密度。所有 prose 都写死在架构师 prompt 里，
// 不从模板复制。v6 灵气的起点在这里。
// ---------------------------------------------------------------------------

export interface ArchitectRole {
  readonly tier: "major" | "minor";
  readonly name: string;
  readonly content: string;
}

export interface ArchitectOutput {
  // Legacy shape — kept for back-compat with consumers that still read the
  // old file names. Filled from the new prose sections below when Phase 5
  // architect runs; external callers see the same surface.
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
  readonly currentState: string;
  readonly pendingHooks: string;
  // Phase 5 new shape. Optional in the type surface so legacy test fixtures
  // that mock only the old fields continue to compile — the architect itself
  // always fills these at runtime.
  readonly storyFrame?: string;
  readonly volumeMap?: string;
  readonly rhythmPrinciples?: string;
  readonly roles?: ReadonlyArray<ArchitectRole>;
}

export class ArchitectIncompleteFoundationError extends Error {
  readonly missing: readonly string[];
  readonly partialContent: string;

  constructor(missing: readonly string[], partialContent: string, message?: string) {
    super(message ?? `Architect foundation incomplete; missing sections: ${missing.join(", ")}`);
    this.name = "ArchitectIncompleteFoundationError";
    this.missing = missing;
    this.partialContent = partialContent;
  }
}

class MissingArchitectSectionsError extends Error {
  readonly missing: readonly string[];
  readonly content: string;

  constructor(missing: readonly string[], content: string) {
    super(`Architect output missing required section${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    this.name = "MissingArchitectSectionsError";
    this.missing = missing;
    this.content = content;
  }
}

export class ArchitectAgent extends BaseAgent {
  get name(): string {
    return "architect";
  }

  async generateFoundation(
    book: BookConfig,
    externalContext?: string,
    reviewFeedback?: string,
    options?: {
      reviseFrom?: {
        storyBible: string;
        volumeOutline: string;
        bookRules: string;
        characterMatrix: string;
        userFeedback: string;
      };
    },
  ): Promise<ArchitectOutput> {
    const { profile: gp } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;

    const contextBlock = externalContext
      ? `\n\n## 外部指令\n以下是来自外部系统的创作指令，请将其融入设定中：\n\n${externalContext}\n`
      : "";
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);
    const revisePrompt = options?.reviseFrom
      ? this.buildRevisePrompt(options.reviseFrom)
      : "";

    const numericalBlock = gp.numericalSystem
      ? "- 有明确的数值/资源体系可追踪\n- 在 book_rules 中写清核心资源、硬上限和不可突破规则"
      : "- 本题材无数值系统，不需要资源账本";
    const powerBlock = gp.powerScaling ? "- 有明确的战力等级体系" : "";
    const eraBlock = gp.eraResearch ? "- 需要年代考据支撑（在 story_frame 中织入时代锚，在 book_rules 中写清不可违背的年代限制）" : "";

    const systemPrompt = resolvedLanguage === "en"
      ? this.buildEnglishFoundationPrompt(book, gp, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock)
      : this.buildChineseFoundationPrompt(book, gp, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock);

    const langPrefix = resolvedLanguage === "en"
      ? `【LANGUAGE OVERRIDE】ALL output (story_frame, volume_map, roles, book_rules, pending_hooks) MUST be written in English. Character names, place names, and all prose must be in English. The === SECTION: === tags remain unchanged. Do NOT emit rhythm_principles or current_state sections — rhythm principles live inside the last paragraph of volume_map; environment/era anchors (when relevant) are woven into story_frame's world-tonal-ground paragraph.\n\n`
      : "";
    const userMessage = resolvedLanguage === "en"
      ? `Generate the complete foundation for a ${gp.name} novel titled "${book.title}". Write everything in English.`
      : `请为标题为"${book.title}"的${gp.name}小说生成完整基础设定。`;

    return this.generateFoundationInStages({
      systemPrompt: langPrefix + systemPrompt + revisePrompt,
      userMessage,
      language: resolvedLanguage,
      temperature: 0.8,
    });
  }

  private buildRevisePrompt(reviseFrom: {
    storyBible: string;
    volumeOutline: string;
    bookRules: string;
    characterMatrix: string;
    userFeedback: string;
  }): string {
    return `\n\n## 既有架构稿修订模式
你在把一本已有书的架构稿从条目式升级为当前的段落式架构稿 + 一人一卡角色目录；如果它已经是 Phase 5 结构，则按用户反馈二次重写。

原书信息（这是权威内容，必须完整保留其中的世界观、角色、主线、伏笔和语气）：

【story_bible / story_frame 全文】
${reviseFrom.storyBible || "（无）"}

【volume_outline / volume_map 全文】
${reviseFrom.volumeOutline || "（无）"}

【book_rules 全文】
${reviseFrom.bookRules || "（无）"}

【character_matrix / roles 全文】
${reviseFrom.characterMatrix || "（无）"}

你的任务：
1. 把现有内容重新组织成当前 5 段 SECTION：story_frame / volume_map / roles / book_rules / pending_hooks
2. story_frame 使用段落式世界观与核心冲突，不要退回条目表格
3. volume_map 使用段落式卷/章级方向，并把节奏原则放进末段
4. roles 必须按一人一卡输出，主要/次要角色判断沿用原内容，缺失才按主线重要性推断
5. pending_hooks 必须保留原有未回收伏笔，不要因为重写架构稿而清空
6. 不要改动已写章节的运行时事实，不要重置 current_state / pending_hooks 之外的运行时日志

用户额外要求：
${reviseFrom.userFeedback || "（无）"}
`;
  }

  // -------------------------------------------------------------------------
  // Foundation artifact protocol. Creative methodology comes from the active
  // long-writing Skill; this code owns only artifact shape and dynamic limits.
  // -------------------------------------------------------------------------
  private buildChineseFoundationPrompt(
    book: BookConfig,
    gp: GenreProfile,
    contextBlock: string,
    reviewFeedbackBlock: string,
    numericalBlock: string,
    powerBlock: string,
    eraBlock: string,
  ): string {
    return this.buildFoundationProtocol({ book, gp, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock, language: "zh" });
  }

  private buildEnglishFoundationPrompt(
    book: BookConfig,
    gp: GenreProfile,
    contextBlock: string,
    reviewFeedbackBlock: string,
    numericalBlock: string,
    powerBlock: string,
    eraBlock: string,
  ): string {
    return this.buildFoundationProtocol({ book, gp, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock, language: "en" });
  }

  private buildFoundationProtocol(params: {
    readonly book: BookConfig;
    readonly gp: GenreProfile;
    readonly contextBlock: string;
    readonly reviewFeedbackBlock: string;
    readonly numericalBlock: string;
    readonly powerBlock: string;
    readonly eraBlock: string;
    readonly language: "zh" | "en";
  }): string {
    const { book, gp, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock, language } = params;
    const numericalRules = gp.numericalSystem
      ? language === "en"
        ? `## Numerical / Resource Rules\n- Core resources: <types>\n- Hard cap: <unbreakable limit>`
        : `## 数值/资源规则\n- 核心资源：<类型>\n- 硬上限：<不可突破规则>`
      : "";
    const eraRules = gp.eraResearch
      ? language === "en"
        ? `## Era Constraints\n- <2-3 factual constraints>`
        : `## 年代限制\n- <2-3 条事实约束>`
      : "";
    const metadata = language === "en"
      ? `Platform: ${book.platform}\nGenre: ${gp.name} (${book.genre})\nTarget chapters: ${book.targetChapters}\nChapter length: ${book.chapterWordCount}\nTitle: ${book.title}`
      : `平台：${book.platform}\n题材：${gp.name}（${book.genre}）\n目标章数：${book.targetChapters}\n每章字数：${book.chapterWordCount}\n标题：${book.title}`;
    const dynamicRules = [numericalBlock, powerBlock, eraBlock].filter(Boolean).join("\n");

    if (language === "en") {
      return `Create the book foundation using the activated long-writing Skill and the supplied authority.${contextBlock}${reviewFeedbackBlock}

## Book metadata
${metadata}

## Dynamic constraints
${dynamicRules}

Return all five blocks in this exact order. Keep story_frame, volume_map, and roles as readable prose; book_rules and pending_hooks follow the Markdown shapes below. Do not emit separate rhythm_principles or current_state blocks.

Budgets: story_frame <= 3000 chars; volume_map <= 5000; roles <= 8000 total; book_rules <= 1000; pending_hooks <= 2000.

=== SECTION: story_frame ===
## Theme and tone
## Core conflict and story layers
## World rules and sensory ground
## End direction and verifiable book objective
The protagonist arc belongs only in roles; point to the protagonist role card instead of duplicating it here.

=== SECTION: volume_map ===
Write volume-level prose only: volume themes and emotional movement; cross-volume promises; each volume's observable objective and key results; irreversible volume-end changes; book-specific rhythm and any user-requested line proportions. Do not assign chapter-level tasks.

=== SECTION: roles ===
Use one card per character:
---ROLE---
tier: major|minor
name: <name>
---CONTENT---
Major cards cover core traits, contrast detail, formative past, current state, relationships, inner driver, and arc; the protagonist card also owns start, end, and irreversible cost. Minor cards may be compact.

=== SECTION: book_rules ===
## Protagonist
- Name: <name>
- Personality lock: <constraints>
- Behavioral constraints: <boundaries>
## Genre Lock
- Primary: ${book.genre}
- Forbidden: <intrusions>
## Narrative Person
<first person, third person, or none when the user did not choose>
${numericalRules}
${eraRules}
## Prohibitions
- <book-specific prohibitions>

=== SECTION: pending_hooks ===
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |
Use deferred for ordinary seeds not yet advanced in prose. start_chapter and last_advanced_chapter are 0 at creation. payoff_timing is immediate, near-term, mid-arc, slow-burn, or endgame. depends_on contains real hook ids or none. Mark only 3-7 load-bearing hooks as core_hook=true.`;
    }

    return `按已激活的长篇写作 Skill 和输入权威生成基础设定。${contextBlock}${reviewFeedbackBlock}

## 书籍元信息
${metadata}

## 动态约束
${dynamicRules}

严格按顺序返回下面五个块。story_frame、volume_map、roles 使用可读散文；book_rules 和 pending_hooks 使用规定的 Markdown 结构。不要另建 rhythm_principles 或 current_state。

预算：story_frame <= 3000 字符；volume_map <= 5000；roles 总计 <= 8000；book_rules <= 1000；pending_hooks <= 2000。

=== SECTION: story_frame ===
## 主题与基调
## 核心冲突与故事层次
## 世界规则与感官底色
## 终局方向与可验证的全书目标
主角弧线只归 roles 中的主角卡所有，这里只做指针，不重复。

=== SECTION: volume_map ===
只写卷级散文：各卷主题与情绪运动、跨卷承诺、每卷可观察的目标与关键结果、卷尾不可逆变化、本书专属节奏，以及用户要求的剧情线比例。不要分配具体章级任务。

=== SECTION: roles ===
每个角色使用一张卡：
---ROLE---
tier: major|minor
name: <名字>
---CONTENT---
主要角色卡覆盖核心特征、反差细节、关键过去、当前处境、关系、内在驱动和弧线；主角卡额外拥有起点、终点与不可逆代价。次要角色可简写。

=== SECTION: book_rules ===
## 主角
- 名字：<名字>
- 性格锁：<约束>
- 行为约束：<边界>
## 题材锁
- 主类型：${book.genre}
- 禁止混入：<体系或风格>
## 叙事人称
<第一人称、第三人称；用户没指定则写无>
${numericalRules}
${eraRules}
## 禁止事项
- <本书禁忌>

=== SECTION: pending_hooks ===
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |
尚未在正文推进的普通种子使用 deferred；建书时 start_chapter 和 last_advanced_chapter 均为 0。payoff_timing 使用 immediate、near-term、mid-arc、slow-burn 或 endgame。depends_on 只写真实 hook id 或 none。全书只标记 3-7 条承重伏笔为 core_hook=true。`;
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------
  private async parseSectionsWithRepair(content: string, language: "zh" | "en"): Promise<ArchitectOutput> {
    try {
      return this.parseSections(content, language);
    } catch (error) {
      if (!(error instanceof MissingArchitectSectionsError)) {
        throw error;
      }

      const repaired = await this.repairMissingSections(error, language);
      try {
        return this.parseSections(repaired, language);
      } catch (repairError) {
        if (repairError instanceof MissingArchitectSectionsError) {
          const missing = repairError.missing.join("、");
          const message = language === "en"
            ? `The story foundation came back incomplete (missing: ${repairError.missing.join(", ")}). `
              + "This usually means the model didn't write every section in one pass — it's not a problem with your input. "
              + "Try again, or switch to a stronger model (e.g. gpt-5.6-terra / claude-opus-4-8) and regenerate."
            : `基础设定没有生成完整(缺少:${missing})。`
              + "这通常是模型一次没把所有部分写全,不是你的输入有问题。"
              + "点重试,或换更强的模型(如 gpt-5.6-terra / claude-opus-4-8)再生成一次,通常就能解决。";
          throw new ArchitectIncompleteFoundationError(
            repairError.missing,
            repairError.content,
            message,
          );
        }
        throw repairError;
      }
    }
  }

  private async repairMissingSections(
    error: MissingArchitectSectionsError,
    language: "zh" | "en",
  ): Promise<string> {
    const missingList = error.missing.join(", ");
    const system = language === "en"
      ? [
          "You repair InkOS architect output formatting.",
          "The previous draft is partially useful but is missing required SECTION blocks.",
          "Do not invent a new book. Preserve usable existing content and add the missing parts.",
          "Return the complete output with exactly these 5 SECTION blocks in order: story_frame, volume_map, roles, book_rules, pending_hooks.",
          "book_rules must be ordinary Markdown, not YAML. pending_hooks must be a Markdown table.",
          "Do not explain the repair.",
        ].join("\n")
      : [
          "你负责修复 InkOS architect 的输出格式。",
          "上一轮草稿有可用内容，但缺少必需的 SECTION 块。",
          "不要重新发明一本书；保留已有可用内容，只补齐缺失部分并整理成完整输出。",
          "必须按顺序返回完整 5 段 SECTION：story_frame、volume_map、roles、book_rules、pending_hooks。",
          "book_rules 必须是普通 Markdown，不要 YAML；pending_hooks 必须是 Markdown 表格。",
          "不要解释修复过程。",
        ].join("\n");
    const user = language === "en"
      ? `Missing sections: ${missingList}\n\nOriginal partial output:\n\n${error.content}`
      : `缺失 section：${missingList}\n\n原始不完整输出如下：\n\n${error.content}`;

    const response = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], { temperature: 0.2 });
    return response.content;
  }

  private parseSections(content: string, language: "zh" | "en"): ArchitectOutput {
    const parsedSections = this.parseArchitectSectionMap(content);

    // Phase 5 new sections take precedence.
    const storyFrame = parsedSections.get("story_frame") ?? "";
    const volumeMap = parsedSections.get("volume_map") ?? "";
    const rhythmPrinciples = parsedSections.get("rhythm_principles") ?? "";
    const rolesRaw = parsedSections.get("roles") ?? "";

    // Legacy sections (still produced for back-compat where needed).
    // If the model used old section names we still accept them.
    const legacyStoryBible = parsedSections.get("story_bible") ?? "";
    const legacyVolumeOutline = parsedSections.get("volume_outline") ?? "";
    const bookRules = parsedSections.get("book_rules");
    // Phase 5 consolidation: current_state is no longer a required section.
    // Legacy books (v12 / Phase 5 initial / pre-revert) and import/fanfic
    // regenerations may still produce it — accept the value when present,
    // fall through to empty seed when absent (consolidator will populate at
    // runtime). Era/setting anchors that used to motivate a separate
    // current_state block now live naturally inside story_frame.世界观底色
    // for genres that have a real-world year anchor; other genres (修仙/玄幻/
    // 系统文) omit them entirely.
    const currentStateLegacy = parsedSections.get("current_state") ?? "";
    const pendingHooksRaw = parsedSections.get("pending_hooks");

    // 5-section required contract: story_frame (or legacy story_bible),
    // volume_map (or legacy volume_outline), roles, book_rules, pending_hooks.
    //
    // Backward compat: v12 outputs used story_bible/volume_outline and
    // embedded character data inside story_bible — they had no roles block.
    // When the model uses ONLY legacy section names, we accept an empty roles
    // list (consolidator/readers fall back to the character_matrix shim).
    // When the new story_frame / volume_map names are used we require roles.
    const usingLegacyOutlineNames = !storyFrame && !volumeMap
      && (legacyStoryBible.length > 0 || legacyVolumeOutline.length > 0);

    const missing: string[] = [];
    const effectiveStoryFrame = storyFrame || legacyStoryBible;
    const effectiveVolumeMap = volumeMap || legacyVolumeOutline;
    if (!effectiveStoryFrame) missing.push("story_frame");
    if (!effectiveVolumeMap) missing.push("volume_map");
    if (!rolesRaw.trim() && !usingLegacyOutlineNames) missing.push("roles");
    if (!bookRules) missing.push("book_rules");
    if (!pendingHooksRaw) missing.push("pending_hooks");
    if (missing.length > 0) {
      throw new MissingArchitectSectionsError(missing, content);
    }

    const roles = this.parseRoles(rolesRaw);
    const pendingHooks = this.normalizePendingHooksSection(
      this.stripTrailingAssistantCoda(pendingHooksRaw!),
      effectiveVolumeMap,
    );

    // Synthesize legacy-facing content from new prose (so back-compat callers
    // still receive real content instead of empty strings).
    const storyBible = legacyStoryBible || this.buildStoryBibleShim(language);
    const volumeOutline = legacyVolumeOutline || effectiveVolumeMap;

    return {
      storyBible,
      volumeOutline,
      bookRules: bookRules!,
      // currentState: empty string when architect no longer emits the section;
      // writeFoundationFiles seeds current_state.md with a placeholder so
      // consolidator / state-bootstrap readers find a valid file on first boot.
      currentState: currentStateLegacy,
      pendingHooks,
      storyFrame: effectiveStoryFrame,
      volumeMap: effectiveVolumeMap,
      rhythmPrinciples,
      roles,
    };
  }

  private parseArchitectSectionMap(content: string): Map<string, string> {
    // The marker itself is the protocol boundary. Some models prepend a short
    // sentence on the same line before the first marker; do not discard an
    // otherwise complete foundation only because that sentence lacks a line
    // break.
    // Horizontal whitespace only: using \s here consumed the Markdown heading
    // on the line after a marker ("=== SECTION ===\n# Heading").
    const sectionPattern = /(?:#{1,6}[ \t]*)?===[ \t]*SECTION[ \t]*[：:][ \t]*([^\n=]+?)[ \t]*===[ \t]*(?:#+[ \t]*)?/gim;
    const markerMatches = [...content.matchAll(sectionPattern)].map((match) => ({
      name: this.normalizeSectionName(match[1] ?? ""),
      index: match.index ?? 0,
      markerLength: match[0].length,
    }));
    if (markerMatches.length > 0) {
      return this.sliceArchitectSections(content, markerMatches);
    }

    const headingPattern = /^\s{0,3}#{1,3}\s+(.+?)\s*$/gim;
    const headingMatches = [...content.matchAll(headingPattern)]
      .map((match) => ({
        name: this.canonicalSectionNameFromHeading(match[1] ?? ""),
        index: match.index ?? 0,
        markerLength: match[0].length,
      }))
      .filter((match): match is { readonly name: string; readonly index: number; readonly markerLength: number } =>
        Boolean(match.name),
      );
    return this.sliceArchitectSections(content, headingMatches);
  }

  private sliceArchitectSections(
    content: string,
    matches: ReadonlyArray<{ readonly name: string; readonly index: number; readonly markerLength: number }>,
  ): Map<string, string> {
    const parsedSections = new Map<string, string>();
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const start = match.index + match.markerLength;
      const end = matches[i + 1]?.index ?? content.length;
      parsedSections.set(match.name, content.slice(start, end).trim());
    }
    return parsedSections;
  }

  /**
   * Parse ---ROLE---...---CONTENT---... blocks from the roles section.
   * Drops malformed entries silently — this is prose the LLM produced,
   * not machine input.
   */
  private parseRoles(raw: string): ReadonlyArray<ArchitectRole> {
    if (!raw.trim()) return [];

    const blocks = raw.split(/^---ROLE---$/m).map((chunk) => chunk.trim()).filter(Boolean);
    const roles: ArchitectRole[] = [];

    for (const block of blocks) {
      const contentSplit = block.split(/^---CONTENT---$/m);
      if (contentSplit.length < 2) continue;

      const headerRaw = contentSplit[0]!.trim();
      const content = contentSplit.slice(1).join("\n---CONTENT---\n").trim();

      const tierMatch = headerRaw.match(/tier\s*[:：]\s*(major|minor|主要|次要)/i);
      const nameMatch = headerRaw.match(/name\s*[:：]\s*(.+)/i);
      if (!tierMatch || !nameMatch) continue;

      const tierValue = tierMatch[1]!.toLowerCase();
      const tier: "major" | "minor" = (tierValue === "major" || tierValue === "主要") ? "major" : "minor";
      const name = nameMatch[1]!.trim();
      if (!name || !content) continue;

      roles.push({ tier, name, content });
    }

    return roles;
  }

  private buildStoryBibleShim(language: "zh" | "en"): string {
    if (language === "en") {
      return `# Story Bible (compat pointer — deprecated)\n\n> This file is kept for external readers only. The authoritative source is now:\n> - outline/story_frame.md (theme / tonal ground / core conflict / world rules / endgame)\n> - outline/volume_map.md (chapter-granular plot map)\n> - roles/ directory (one-file-per-character sheets)\n`;
    }
    return `# 故事圣经（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。权威来源已迁移至：\n> - outline/story_frame.md（主题 / 基调 / 核心冲突 / 世界铁律 / 终局）\n> - outline/volume_map.md（章级别的分卷地图）\n> - roles/ 文件夹（一人一卡角色档案）\n`;
  }

  private buildCharacterMatrixShim(roles: ReadonlyArray<ArchitectRole>, language: "zh" | "en"): string {
    const majorLines = roles.filter((role) => role.tier === "major")
      .map((role) => `- roles/主要角色/${role.name}.md`);
    const minorLines = roles.filter((role) => role.tier === "minor")
      .map((role) => `- roles/次要角色/${role.name}.md`);

    if (language === "en") {
      return `# Character Matrix (compat pointer — deprecated)\n\n> This file is kept for external readers only. Authoritative source is now the roles/ directory (one-file-per-character).\n\n## Major characters\n\n${majorLines.join("\n") || "(none)"}\n\n## Minor characters\n\n${minorLines.join("\n") || "(none)"}\n`;
    }
    return `# 角色矩阵（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。权威来源已迁移至 roles/ 文件夹（一人一卡）。\n\n## 主要角色\n\n${majorLines.join("\n") || "（无）"}\n\n## 次要角色\n\n${minorLines.join("\n") || "（无）"}\n`;
  }

  // -------------------------------------------------------------------------
  // File writing
  // -------------------------------------------------------------------------
  async writeFoundationFiles(
    bookDir: string,
    output: ArchitectOutput,
    _numericalSystem: boolean = true,
    language: "zh" | "en" = "zh",
    mode: "init" | "revise" = "init",
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    const rolesDir = join(storyDir, "roles");
    const rolesMajorDir = join(rolesDir, "主要角色");
    const rolesMinorDir = join(rolesDir, "次要角色");

    await Promise.all([
      mkdir(storyDir, { recursive: true }),
      mkdir(outlineDir, { recursive: true }),
      mkdir(rolesMajorDir, { recursive: true }),
      mkdir(rolesMinorDir, { recursive: true }),
    ]);

    const writes: Array<Promise<void>> = [];

    const storyFrameBody = output.storyFrame ?? output.storyBible;
    const volumeMap = output.volumeMap ?? output.volumeOutline;
    const rhythmPrinciples = output.rhythmPrinciples ?? "";
    const roles = output.roles ?? [];
    const isPhase5Output = Boolean(output.storyFrame?.trim());

    if (mode === "revise" && !isPhase5Output) {
      throw new Error(
        "Architect revise mode produced legacy-format output (storyFrame empty). " +
        "The book's architecture files have NOT been modified.",
      );
    }

    if (mode === "revise") {
      await rm(rolesMajorDir, { recursive: true, force: true });
      await rm(rolesMinorDir, { recursive: true, force: true });
      await mkdir(rolesMajorDir, { recursive: true });
      await mkdir(rolesMinorDir, { recursive: true });
    }

    if (!isPhase5Output) {
      writes.push(writeFile(join(storyDir, "story_bible.md"), output.storyBible, "utf-8"));
      writes.push(writeFile(join(storyDir, "volume_outline.md"), output.volumeOutline, "utf-8"));
      writes.push(writeFile(join(storyDir, "book_rules.md"), output.bookRules, "utf-8"));
      writes.push(writeFile(
        join(storyDir, "character_matrix.md"),
        language === "en"
          ? "# Character Matrix\n\n<!-- One ## section per character. Add new characters as new ## blocks. -->\n"
          : "# 角色矩阵\n\n<!-- 每个角色一个 ## 块，新角色追加新 ## 即可。 -->\n",
        "utf-8",
      ));

      if (mode === "init") {
        const currentStateSeed = output.currentState?.trim()
          ? output.currentState
          : (language === "en"
              ? "# Current State\n\n> Seeded at book creation. Runtime state is appended by the consolidator after each chapter.\n"
              : "# 当前状态\n\n> 建书时占位。运行时每章之后由 consolidator 追加最新状态。\n");
        writes.push(writeFile(join(storyDir, "current_state.md"), currentStateSeed, "utf-8"));
        writes.push(writeFile(join(storyDir, "pending_hooks.md"), output.pendingHooks, "utf-8"));
        writes.push(writeFile(
          join(storyDir, "emotional_arcs.md"),
          language === "en"
            ? "# Emotional Arcs\n\n| Character | Chapter | Emotional State | Trigger Event | Intensity (1-10) | Arc Direction |\n| --- | --- | --- | --- | --- | --- |\n"
            : "# 情感弧线\n\n| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |\n|------|------|----------|----------|------------|----------|\n",
          "utf-8",
        ));
      }

      await Promise.all(writes);
      return;
    }

    const storyFrame = storyFrameBody.trim();

    // Phase 5 primary prose files
    writes.push(writeFile(join(outlineDir, "story_frame.md"), storyFrame, "utf-8"));
    writes.push(writeFile(join(outlineDir, "volume_map.md"), volumeMap, "utf-8"));
    // Phase 5 consolidation: rhythm principles live inside the last paragraph
    // of volume_map. A separate 节奏原则.md / rhythm_principles.md file is only
    // written only when an imported legacy result still carries a standalone
    // block. Skipping the empty write avoids 0-byte files that mislead the UI
    // and fight against the "no duplication" rule — readers who need the rhythm
    // content already pull it from volume_map's closing paragraph.
    if (rhythmPrinciples.trim()) {
      const rhythmFileName = language === "en" ? "rhythm_principles.md" : "节奏原则.md";
      writes.push(writeFile(join(outlineDir, rhythmFileName), rhythmPrinciples, "utf-8"));
    }

    // Roles — one file per character
    for (const role of roles) {
      const targetDir = role.tier === "major" ? rolesMajorDir : rolesMinorDir;
      const safeName = role.name.replace(/[/\\:*?"<>|]/g, "_").trim();
      if (!safeName) continue;
      writes.push(writeFile(join(targetDir, `${safeName}.md`), role.content, "utf-8"));
    }

    // Compat shims — these are pointer files, not authoritative content.
    writes.push(writeFile(
      join(storyDir, "story_bible.md"),
      this.buildStoryBibleShim(language),
      "utf-8",
    ));
    writes.push(writeFile(
      join(storyDir, "character_matrix.md"),
      this.buildCharacterMatrixShim(roles, language),
      "utf-8",
    ));

    // Cleanup #1: volume_outline.md mirror removed. All readers now resolve
    // through readVolumeMap() in utils/outline-paths.ts, which prefers
    // outline/volume_map.md and falls back to legacy volume_outline.md for
    // books initialized before Phase 5.

    writes.push(writeFile(join(storyDir, "book_rules.md"), output.bookRules.trim() + "\n", "utf-8"));

    // Runtime state files.
    // Phase 5 consolidation: the architect no longer emits a current_state
    // section (only 3 genres — 港综同人/年代文/都市重生 — benefit from a
    // separate era anchor, and those fold naturally into story_frame.世界观底色).
    // We still write current_state.md with a seed placeholder so
    // isCompleteBookDirectory() sees it on first boot and the runtime
    // consolidator has a file to append each chapter's state into.
    // Per-character state lives in roles/*.Current_State; initial hook rows
    // live in pending_hooks with start_chapter=0. Legacy books / imports that
    // still produced the section keep their content as-is.
    if (mode === "init") {
      const currentStateSeed = output.currentState?.trim()
        ? output.currentState
        : (language === "en"
            ? "# Current State\n\n> Seeded at book creation. Runtime state is appended by the consolidator after each chapter. Initial per-character state lives in roles/*.Current_State; load-bearing initial world facts live in pending_hooks rows with start_chapter=0.\n"
            : "# 当前状态\n\n> 建书时占位。运行时每章之后由 consolidator 追加最新状态。每个角色的初始状态详见 roles/*.当前现状；承重的初始世界设定见 pending_hooks 里 startChapter=0 的行。\n");
      writes.push(writeFile(join(storyDir, "current_state.md"), currentStateSeed, "utf-8"));
      writes.push(writeFile(join(storyDir, "pending_hooks.md"), output.pendingHooks, "utf-8"));
      writes.push(writeFile(
        join(storyDir, "emotional_arcs.md"),
        language === "en"
          ? "# Emotional Arcs\n\n| Character | Chapter | Emotional State | Trigger Event | Intensity (1-10) | Arc Direction |\n| --- | --- | --- | --- | --- | --- |\n"
          : "# 情感弧线\n\n| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |\n|------|------|----------|----------|------------|----------|\n",
        "utf-8",
      ));
    }

    // Cleanup #2 (Option B): particle_ledger.md / subplot_board.md /
    // chapter_summaries.md are pure runtime logs appended by the writer's
    // settlement phase. The architect no longer seeds them here — mixing a
    // static "setting" seed with a runtime "append log" was the dual-purpose
    // mess that prompted the cleanup. If they don't exist yet, downstream
    // readers see the placeholder and the first chapter settlement creates
    // them naturally. The `_numericalSystem` parameter is kept for API
    // compatibility with existing callers.

    await Promise.all(writes);
  }

  /**
   * Reverse-engineer foundation from existing chapters.
   */
  async generateFoundationFromImport(
    book: BookConfig,
    chaptersText: string,
    externalContext?: string,
    reviewFeedback?: string,
    options?: { readonly importMode?: "continuation" | "series" },
  ): Promise<ArchitectOutput> {
    const { profile: gp } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);

    const contextBlock = externalContext
      ? (resolvedLanguage === "en"
          ? `\n\n## External Instructions\n${externalContext}\n`
          : `\n\n## 外部指令\n${externalContext}\n`)
      : "";

    const numericalBlock = gp.numericalSystem
      ? (resolvedLanguage === "en"
          ? "- The story uses a trackable numerical/resource system"
          : "- 有明确的数值/资源体系可追踪")
      : (resolvedLanguage === "en"
          ? "- No explicit numerical system"
          : "- 本题材无数值系统");

    const isSeries = options?.importMode === "series";

    const continuationDirective = resolvedLanguage === "en"
      ? (isSeries
          ? `## Continuation Direction Requirements
The continuation portion must open up new narrative space — new conflict vector, new location, new time horizon. Ignite within 5 chapters; at least 50% fresh scenes.`
          : `## Continuation Direction
Naturally extend the existing arc. Advance existing conflicts, pay off planted hooks, introduce new complications organically.`)
      : (isSeries
          ? `## 续写方向要求
续写必须引入新叙事空间——新冲突、新地点、新时间。5章内引爆，50%以上场景新鲜。`
          : `## 续写方向
自然延续已有叙事弧线。推进现有冲突、兑现已埋伏笔、引入有机新变数。`);

    const powerBlock = gp.powerScaling ? (resolvedLanguage === "en" ? "- Preserve the established power system" : "- 保留既有战力体系") : "";
    const eraBlock = gp.eraResearch ? (resolvedLanguage === "en" ? "- Preserve verifiable era facts" : "- 保留可核验的年代事实") : "";
    const systemPrompt = this.buildFoundationProtocol({
      book,
      gp,
      contextBlock,
      reviewFeedbackBlock,
      numericalBlock,
      powerBlock,
      eraBlock,
      language: resolvedLanguage,
    }) + (resolvedLanguage === "en"
      ? `\n\n${continuationDirective}\nDerive every fact from the source package. A compressed package is evidence, not permission to invent missing canon. ALL output MUST be written in English.`
      : `\n\n${continuationDirective}\n所有事实必须从资料包推导；压缩资料包是证据，不是臆造缺失正典的许可。`);

    const userMessage = resolvedLanguage === "en"
      ? `Generate the complete foundation for an imported ${gp.name} novel titled "${book.title}". Write everything in English.\n\n${chaptersText}`
      : `以下是《${book.title}》的已有正文资料包，请从中反向推导完整基础设定：\n\n${chaptersText}`;

    return this.generateFoundationInStages({
      systemPrompt,
      userMessage,
      language: resolvedLanguage,
      temperature: 0.5,
    });
  }

  async generateFanficFoundation(
    book: BookConfig,
    fanficCanon: string,
    fanficMode: FanficMode,
    reviewFeedback?: string,
  ): Promise<ArchitectOutput> {
    const { profile: gp } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);

    const MODE_INSTRUCTIONS: Record<FanficMode, { readonly zh: string; readonly en: string }> = {
      canon: { zh: "发生在原作空白期或未详述角度，不得改动既定事实。", en: "Use an unshown period or viewpoint without changing established canon." },
      au: { zh: "明确 AU 分歧点，分歧后可发展新世界线，但保留角色核心性格。", en: "Name the AU divergence; develop the new line while preserving character cores." },
      ooc: { zh: "明确性格偏离的起点和驱动事件。", en: "Name the point and cause of each intentional character deviation." },
      cp: { zh: "以配对关系为主线，每卷必须产生关系状态变化。", en: "Use the pairing as the main line and change its relationship state in every volume." },
    };
    const numericalBlock = gp.numericalSystem ? (resolvedLanguage === "en" ? "- Preserve canon numerical rules" : "- 保留正典数值规则") : "";
    const powerBlock = gp.powerScaling ? (resolvedLanguage === "en" ? "- Preserve canon power scaling" : "- 保留正典战力体系") : "";
    const eraBlock = gp.eraResearch ? (resolvedLanguage === "en" ? "- Preserve verifiable era facts" : "- 保留可核验的年代事实") : "";
    const canonBlock = resolvedLanguage === "en"
      ? `\n\n## Fanfic mode: ${fanficMode}\n${MODE_INSTRUCTIONS[fanficMode].en}\n\n## Source canon\n${fanficCanon}\nMajor characters and established facts must come from this canon; label original supporting characters.`
      : `\n\n## 同人模式：${fanficMode}\n${MODE_INSTRUCTIONS[fanficMode].zh}\n\n## 原作正典\n${fanficCanon}\n主要角色与既定事实必须来自这份正典；原创配角要明确标注。`;
    const systemPrompt = this.buildFoundationProtocol({
      book,
      gp,
      contextBlock: canonBlock,
      reviewFeedbackBlock,
      numericalBlock,
      powerBlock,
      eraBlock,
      language: resolvedLanguage,
    });

    return this.generateFoundationInStages({
      systemPrompt,
      userMessage: `请为标题为"${book.title}"的${fanficMode}模式同人小说生成基础设定。目标${book.targetChapters}章，每章${book.chapterWordCount}字。`,
      language: resolvedLanguage,
      temperature: 0.7,
    });
  }

  private async generateFoundationInStages(input: {
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly language: "zh" | "en";
    readonly temperature: number;
  }): Promise<ArchitectOutput> {
    const firstStageDirective = input.language === "en"
      ? [
          "## Staged delivery override",
          "The foundation is delivered in two bounded calls. In THIS call output ONLY these SECTION blocks, in order: story_frame, volume_map.",
          "Do not output roles, book_rules, or pending_hooks yet. End immediately after volume_map.",
        ].join("\n")
      : [
          "## 分段交付覆盖指令",
          "基础设定分两次有界交付。本次只输出以下 SECTION，顺序固定：story_frame、volume_map。",
          "暂时不要输出 roles、book_rules、pending_hooks；volume_map 结束后立即停止。",
        ].join("\n");
    const first = await this.chat([
      { role: "system", content: `${input.systemPrompt}\n\n${firstStageDirective}` },
      { role: "user", content: input.userMessage },
    ], { temperature: input.temperature });
    try {
      // Some fast/strict models may still return the complete legacy contract
      // despite the staged instruction. Accept that complete result directly
      // instead of paying for a redundant second call.
      return this.parseSections(first.content, input.language);
    } catch (error) {
      if (!(error instanceof MissingArchitectSectionsError)) throw error;
    }

    const secondStageDirective = input.language === "en"
      ? [
          "## Staged delivery override",
          "The accepted story_frame and volume_map are supplied by the user below.",
          "In THIS call output ONLY these SECTION blocks, in order: roles, book_rules, pending_hooks.",
          "Do not repeat story_frame or volume_map. Preserve their facts and finish immediately after pending_hooks.",
        ].join("\n")
      : [
          "## 分段交付覆盖指令",
          "用户消息会附上已经接受的 story_frame 与 volume_map。",
          "本次只输出以下 SECTION，顺序固定：roles、book_rules、pending_hooks。",
          "不要重复 story_frame 或 volume_map；必须服从其中的事实，pending_hooks 结束后立即停止。",
        ].join("\n");
    const secondUserMessage = input.language === "en"
      ? `${input.userMessage}\n\n<accepted_foundation_part_1>\n${first.content}\n</accepted_foundation_part_1>\n\nComplete part 2 now.`
      : `${input.userMessage}\n\n<accepted_foundation_part_1>\n${first.content}\n</accepted_foundation_part_1>\n\n现在完成第 2 部分。`;
    const second = await this.chat([
      { role: "system", content: `${input.systemPrompt}\n\n${secondStageDirective}` },
      { role: "user", content: secondUserMessage },
    ], { temperature: input.temperature });

    return this.parseSectionsWithRepair(`${first.content}\n\n${second.content}`, input.language);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  private buildReviewFeedbackBlock(
    reviewFeedback: string | undefined,
    language: "zh" | "en",
  ): string {
    const trimmed = reviewFeedback?.trim();
    if (!trimmed) return "";

    if (language === "en") {
      return `\n\n## Previous Review Feedback
The previous foundation draft was rejected. You must explicitly fix the following issues in this regeneration instead of paraphrasing the same design:

${trimmed}\n`;
    }

    return `\n\n## 上一轮审核反馈
上一轮基础设定未通过审核。你必须在这次重生中明确修复以下问题，不能只换措辞重写同一套方案：

${trimmed}\n`;
  }

  private normalizeSectionName(name: string): string {
    return name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[`"'*_]/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  private canonicalSectionNameFromHeading(heading: string): string | null {
    const normalized = this.normalizeSectionName(heading);
    if ([
      "story_frame",
      "story_bible",
      "story_foundation",
      "foundation",
    ].some((name) => normalized.includes(name))
      || /(故事框架|故事圣经|基础设定|世界框架|故事底座)/.test(heading)) {
      return "story_frame";
    }
    if ([
      "volume_map",
      "volume_outline",
      "outline",
      "plot_map",
    ].some((name) => normalized.includes(name))
      || /(分卷地图|卷纲|分卷大纲|章节地图|故事大纲)/.test(heading)) {
      return "volume_map";
    }
    if ([
      "roles",
      "characters",
      "character_cards",
    ].some((name) => normalized.includes(name))
      || /(角色设定|人物设定|角色卡|主要角色|角色|人物)/.test(heading)) {
      return "roles";
    }
    if ([
      "book_rules",
      "rules",
      "writing_rules",
    ].some((name) => normalized.includes(name))
      || /(本书规则|写作规则|运行规则|创作规则|规则卡)/.test(heading)) {
      return "book_rules";
    }
    if ([
      "pending_hooks",
      "hooks",
      "hook_ledger",
    ].some((name) => normalized.includes(name))
      || /(待回收钩子|待回收伏笔|伏笔表|钩子表|钩子|伏笔)/.test(heading)) {
      return "pending_hooks";
    }
    if ([
      "rhythm_principles",
      "rhythm",
    ].some((name) => normalized.includes(name))
      || /(节奏原则|节奏)/.test(heading)) {
      return "rhythm_principles";
    }
    if ([
      "current_state",
      "initial_state",
    ].some((name) => normalized.includes(name))
      || /(当前状态|初始状态)/.test(heading)) {
      return "current_state";
    }
    return null;
  }

  private stripTrailingAssistantCoda(section: string): string {
    const lines = section.split("\n");
    const cutoff = lines.findIndex((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return /^(如果(?:你愿意|需要|想要|希望)|If (?:you(?:'d)? like|you want|needed)|I can (?:continue|next))/i.test(trimmed);
    });

    if (cutoff < 0) {
      return section;
    }

    return lines.slice(0, cutoff).join("\n").trimEnd();
  }

  private normalizePendingHooksSection(section: string, volumeMapRaw: string): string {
    const rows = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"))
      .filter((line) => !line.includes("---"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells.some(Boolean));

    if (rows.length === 0) {
      return section;
    }

    const dataRows = rows.filter((row) => (row[0] ?? "").toLowerCase() !== "hook_id");
    if (dataRows.length === 0) {
      return section;
    }

    const language: "zh" | "en" = /[\u4e00-\u9fff]/.test(section) ? "zh" : "en";
    const normalizedHooks = dataRows.map((row, index) => {
      const rawProgress = row[4] ?? "";
      const normalizedProgress = this.parseHookChapterNumber(rawProgress);
      const seedNote = normalizedProgress === 0 && this.hasNarrativeProgress(rawProgress)
        ? (language === "zh" ? `初始线索：${rawProgress}` : `initial signal: ${rawProgress}`)
        : "";

      const phase7 = row.length >= 12;
      const phase6 = row.length >= 8;
      const noteCellIndex = phase7 ? 11 : phase6 ? 7 : 6;
      const notes = this.mergeHookNotes(row[noteCellIndex] ?? "", seedNote, language);

      const base: Record<string, unknown> = {
        hookId: row[0] || `hook-${index + 1}`,
        startChapter: this.parseHookChapterNumber(row[1]),
        type: row[2] ?? "",
        status: row[3] ?? "open",
        lastAdvancedChapter: normalizedProgress,
        expectedPayoff: row[5] ?? "",
        payoffTiming: phase6 ? row[6] ?? "" : "",
        notes,
      };

      if (phase7) {
        base.dependsOn = this.parseDependsOnCell(row[7] ?? "");
        base.paysOffInArc = (row[8] ?? "").trim();
        base.coreHook = this.parseBooleanCell(row[9]);
        const halfLife = this.parseOptionalInt(row[10]);
        if (halfLife !== undefined) base.halfLifeChapters = halfLife;
      }

      return base as unknown as StoredHook;
    });

    // Phase 7 hotfix 2: pre-promote seeds based on the three structural rules
    // that don't need runtime advanced_count (core_hook / depends_on /
    // cross_volume). advanced_count-based promotion is applied later by the
    // consolidator at volume boundaries.
    const volumeBoundaries = this.parseVolumeBoundariesForPromotion(volumeMapRaw);
    const allSeedStartChapters = new Map<string, number>(
      normalizedHooks.map((hook) => [hook.hookId, hook.startChapter]),
    );
    const promotionContext: PromotionContext = {
      volumeBoundaries,
      currentChapter: 0,
      advancedCounts: new Map(),
      allSeedStartChapters,
    };
    const promotedHooks = normalizedHooks.map((hook) => {
      const decision = shouldPromoteHook(hook, promotionContext);
      const status = !decision.promote && hook.lastAdvancedChapter <= 0
        ? this.normalizeDormantSeedStatus(hook.status, language)
        : hook.status;
      return { ...hook, status, promoted: decision.promote };
    });

    return renderHookSnapshot(
      promotedHooks as unknown as Parameters<typeof renderHookSnapshot>[0],
      language,
    );
  }

  /**
   * Parse `第N卷 (A-B章)` / `Volume N (chapters A-B)` headers from the
   * architect's volume_map prose. Best-effort: missing / unparseable blocks
   * return an empty list and cross-volume promotion simply never fires.
   */
  private parseVolumeBoundariesForPromotion(raw: string): ReadonlyArray<VolumeBoundary> {
    if (!raw) return [];
    const lines = raw.split("\n");
    const volumeHeader = /^(第[一二三四五六七八九十百千万零〇\d]+卷|Volume\s+\d+)/i;
    const rangePattern = /[（(]\s*(?:第|[Cc]hapters?\s+)?(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?\s*[）)]|(?:第|[Cc]hapters?\s+)(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?/i;

    const volumes: VolumeBoundary[] = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/^#+\s*/, "").trim();
      if (!volumeHeader.test(line)) continue;
      const rangeMatch = line.match(rangePattern);
      if (!rangeMatch) continue;
      const startCh = parseInt(rangeMatch[1] ?? rangeMatch[3] ?? "0", 10);
      const endCh = parseInt(rangeMatch[2] ?? rangeMatch[4] ?? "0", 10);
      if (startCh <= 0 || endCh <= 0) continue;
      const rangeIndex = rangeMatch.index ?? line.length;
      const name = line.slice(0, rangeIndex).replace(/[（(]\s*$/, "").trim();
      if (name.length > 0) {
        volumes.push({ name, startCh, endCh });
      }
    }
    return volumes;
  }

  private normalizeDormantSeedStatus(status: string | undefined, language: "zh" | "en"): string {
    const normalized = status?.trim().toLowerCase() ?? "";
    if (!normalized || /^(open|opened|active)$/i.test(normalized)) {
      return language === "zh" ? "暂缓" : "deferred";
    }
    return status?.trim() || (language === "zh" ? "暂缓" : "deferred");
  }

  private parseHookChapterNumber(value: string | undefined): number {
    if (!value) return 0;
    const match = value.match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }

  private parseDependsOnCell(value: string): ReadonlyArray<string> {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    if (lower === "none" || lower === "n/a" || lower === "-" || trimmed === "无") return [];
    const stripped = trimmed.replace(/^[\[\(]\s*/, "").replace(/\s*[\]\)]$/, "");
    return stripped
      .split(/[,，、\/]+/)
      .map((item) => item.trim().replace(/^\*\*(.+)\*\*$/, "$1").trim())
      .filter((item) => item.length > 0);
  }

  private parseBooleanCell(value: string | undefined): boolean {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return /^(true|yes|y|是|核心|core|1|✓|✔)$/.test(normalized);
  }

  private parseOptionalInt(value: string | undefined): number | undefined {
    const normalized = (value ?? "").trim();
    if (!normalized) return undefined;
    const match = normalized.match(/\d+/);
    if (!match) return undefined;
    const parsed = parseInt(match[0], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private hasNarrativeProgress(value: string | undefined): boolean {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return !["0", "none", "n/a", "na", "-", "无", "未推进"].includes(normalized);
  }

  private mergeHookNotes(notes: string, seedNote: string, language: "zh" | "en"): string {
    const trimmedNotes = notes.trim();
    const trimmedSeed = seedNote.trim();
    if (!trimmedSeed) {
      return trimmedNotes;
    }
    if (!trimmedNotes) {
      return trimmedSeed;
    }
    return language === "zh"
      ? `${trimmedNotes}（${trimmedSeed}）`
      : `${trimmedNotes} (${trimmedSeed})`;
  }
}
