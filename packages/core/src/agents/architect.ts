import { BaseAgent } from "./base.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { readGenreProfile } from "./rules-reader.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { renderHookSnapshot } from "../utils/memory-retrieval.js";
import { BookRulesSchema, type BookRules } from "../models/book-rules.js";
import { FoundationDetailsToolSchema, FoundationOutlineToolSchema } from "./architect-tool.js";

// Architect owns the five-section persistence protocol. Foundation craft is
// supplied by the active long-writing and derivative-work Skills.

export interface ArchitectRole {
  readonly tier: "major" | "minor";
  readonly name: string;
  readonly content: string;
}

export interface ArchitectOutput {
  readonly storyFrame: string;
  readonly volumeMap: string;
  readonly roles: ReadonlyArray<ArchitectRole>;
  readonly bookRules: string;
  readonly bookRulesData: BookRules;
  readonly pendingHooks: string;
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

    const systemPrompt = resolvedLanguage === "en"
      ? this.buildEnglishFoundationPrompt(book, gp, contextBlock, reviewFeedbackBlock)
      : this.buildChineseFoundationPrompt(book, gp, contextBlock, reviewFeedbackBlock);

    const langPrefix = resolvedLanguage === "en"
      ? "【LANGUAGE OVERRIDE】All submitted foundation content, character names, place names, and prose must be in English.\n\n"
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
    return `\n\n## 既有架构稿修订
按已激活 Skill 使用以下权威原稿和用户要求，返回当前五块 foundation 协议。

【story_bible / story_frame 全文】
${reviseFrom.storyBible || "（无）"}

【volume_outline / volume_map 全文】
${reviseFrom.volumeOutline || "（无）"}

【book_rules 全文】
${reviseFrom.bookRules || "（无）"}

【character_matrix / roles 全文】
${reviseFrom.characterMatrix || "（无）"}

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
  ): string {
    return this.buildFoundationProtocol({ book, gp, contextBlock, reviewFeedbackBlock, language: "zh" });
  }

  private buildEnglishFoundationPrompt(
    book: BookConfig,
    gp: GenreProfile,
    contextBlock: string,
    reviewFeedbackBlock: string,
  ): string {
    return this.buildFoundationProtocol({ book, gp, contextBlock, reviewFeedbackBlock, language: "en" });
  }

  private buildFoundationProtocol(params: {
    readonly book: BookConfig;
    readonly gp: GenreProfile;
    readonly contextBlock: string;
    readonly reviewFeedbackBlock: string;
    readonly language: "zh" | "en";
  }): string {
    const { book, gp, contextBlock, reviewFeedbackBlock, language } = params;
    const metadata = language === "en"
      ? `Platform: ${book.platform}\nGenre: ${gp.name} (${book.genre})\nTarget chapters: ${book.targetChapters}\nChapter length: ${book.chapterWordCount}\nTitle: ${book.title}`
      : `平台：${book.platform}\n题材：${gp.name}（${book.genre}）\n目标章数：${book.targetChapters}\n每章字数：${book.chapterWordCount}\n标题：${book.title}`;
    return language === "en"
      ? `Create the Work foundation using the activated professional Skills and supplied authority.${contextBlock}${reviewFeedbackBlock}\n\n## Work metadata\n${metadata}\n\nSubmit readable foundation artifacts and the small structured rules surface through the required tools.`
      : `按已激活的专业 Skill 和输入权威生成作品基础设定。${contextBlock}${reviewFeedbackBlock}\n\n## 作品元信息\n${metadata}\n\n通过指定工具提交可读基础资产和少量结构化规则。`;
  }
  async writeFoundationFiles(
    bookDir: string,
    output: ArchitectOutput,
    language: "zh" | "en" = "zh",
    mode: "init" | "revise" = "init",
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    const rolesMajorDir = join(storyDir, "roles", "主要角色");
    const rolesMinorDir = join(storyDir, "roles", "次要角色");

    await Promise.all([
      mkdir(outlineDir, { recursive: true }),
      mkdir(rolesMajorDir, { recursive: true }),
      mkdir(rolesMinorDir, { recursive: true }),
    ]);
    if (mode === "revise") {
      await rm(rolesMajorDir, { recursive: true, force: true });
      await rm(rolesMinorDir, { recursive: true, force: true });
      await mkdir(rolesMajorDir, { recursive: true });
      await mkdir(rolesMinorDir, { recursive: true });
    }

    const writes: Array<Promise<void>> = [
      writeFile(join(outlineDir, "story_frame.md"), output.storyFrame.trim(), "utf-8"),
      writeFile(join(outlineDir, "volume_map.md"), output.volumeMap.trim(), "utf-8"),
      writeFile(join(storyDir, "book_rules.md"), `${output.bookRules.trim()}\n`, "utf-8"),
      writeFile(join(storyDir, "book_rules.json"), `${JSON.stringify(output.bookRulesData, null, 2)}\n`, "utf-8"),
    ];
    for (const role of output.roles) {
      const targetDir = role.tier === "major" ? rolesMajorDir : rolesMinorDir;
      const safeName = role.name.replace(/[/\\:*?"<>|]/g, "_").trim();
      if (safeName) writes.push(writeFile(join(targetDir, `${safeName}.md`), role.content, "utf-8"));
    }

    if (mode === "init") {
      const currentStateSeed = language === "en"
        ? "# Current State\n\n> Chapter settlement projects explicit story state here.\n"
        : "# 当前状态\n\n> 章节结算会把正文明确状态投影到这里。\n";
      writes.push(
        writeFile(join(storyDir, "current_state.md"), currentStateSeed, "utf-8"),
        writeFile(join(storyDir, "pending_hooks.md"), output.pendingHooks, "utf-8"),
        writeFile(
          join(storyDir, "emotional_arcs.md"),
          language === "en"
            ? "# Emotional Arcs\n\n| Character | Chapter | Emotional State | Trigger Event | Arc Direction |\n| --- | --- | --- | --- | --- |\n"
            : "# 情感弧线\n\n| 角色 | 章节 | 情绪状态 | 触发事件 | 弧线方向 |\n| --- | --- | --- | --- | --- |\n",
          "utf-8",
        ),
      );
    }

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

    const isSeries = options?.importMode === "series";

    const continuationDirective = resolvedLanguage === "en"
      ? `## Import mode\n${isSeries ? "series" : "continuation"}`
      : `## 导入模式\n${isSeries ? "系列新作" : "原线续写"}`;

    const systemPrompt = this.buildFoundationProtocol({
      book,
      gp,
      contextBlock,
      reviewFeedbackBlock,
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

    const canonBlock = resolvedLanguage === "en"
      ? `\n\n## Fanfic mode: ${fanficMode}\n\n## Source canon\n${fanficCanon}`
      : `\n\n## 同人模式：${fanficMode}\n\n## 原作正典\n${fanficCanon}`;
    const systemPrompt = this.buildFoundationProtocol({
      book,
      gp,
      contextBlock: canonBlock,
      reviewFeedbackBlock,
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
    const { result: outline } = await this.submitStructured(
      [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userMessage },
      ],
      {
        name: "submit_foundation_outline",
        label: input.language === "en" ? "Submit foundation outline" : "提交基础框架",
        description: input.language === "en"
          ? "Submit the readable story frame and volume map."
          : "提交可读的故事框架与卷纲。",
        parameters: FoundationOutlineToolSchema,
      },
      { temperature: input.temperature },
    );
    const detailsPrompt = input.language === "en"
      ? `${input.userMessage}\n\n<accepted_story_frame>\n${outline.storyFrame}\n</accepted_story_frame>\n\n<accepted_volume_map>\n${outline.volumeMap}\n</accepted_volume_map>\n\nComplete the roles, readable book rules, structured rule data, and initial unresolved hooks.`
      : `${input.userMessage}\n\n<accepted_story_frame>\n${outline.storyFrame}\n</accepted_story_frame>\n\n<accepted_volume_map>\n${outline.volumeMap}\n</accepted_volume_map>\n\n继续完成角色卡、可读本书规则、结构化规则数据和初始未解伏笔。`;
    const { result: details } = await this.submitStructured(
      [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: detailsPrompt },
      ],
      {
        name: "submit_foundation_details",
        label: input.language === "en" ? "Submit foundation details" : "提交基础详情",
        description: input.language === "en"
          ? "Submit role cards, book rules, and initial unresolved hooks grounded in the accepted outline."
          : "提交服从已接受框架的角色卡、本书规则和初始未解伏笔。",
        parameters: FoundationDetailsToolSchema,
      },
      { temperature: input.temperature },
    );
    const bookRulesData = BookRulesSchema.parse(details.bookRulesData);
    const pendingHooks = renderHookSnapshot(details.pendingHooks.map((hook) => ({
      hookId: hook.hookId.trim(),
      startChapter: 0,
      type: hook.type.trim(),
      status: "deferred",
      lastAdvancedChapter: 0,
      expectedPayoff: hook.expectedPayoff?.trim() ?? "",
      notes: hook.notes?.trim() ?? "",
    })), input.language);

    return {
      storyFrame: outline.storyFrame.trim(),
      volumeMap: outline.volumeMap.trim(),
      roles: details.roles.map((role) => ({
        tier: role.tier,
        name: role.name.trim(),
        content: role.content.trim(),
      })),
      bookRules: details.bookRules.trim(),
      bookRulesData,
      pendingHooks,
    };
  }
  private buildReviewFeedbackBlock(
    reviewFeedback: string | undefined,
    language: "zh" | "en",
  ): string {
    const trimmed = reviewFeedback?.trim();
    if (!trimmed) return "";

    if (language === "en") {
      return `\n\n## Previous Review Feedback
Apply the following requested changes to the foundation instead of paraphrasing the same design:

${trimmed}\n`;
    }

    return `\n\n## 上一轮审核反馈
按以下要求修改基础设定，不能只换措辞重写同一套方案：

${trimmed}\n`;
  }

}
