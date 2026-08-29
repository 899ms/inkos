export type ShortFictionLanguage = "zh" | "en";

export interface ShortFictionReferencePromptInput { readonly text?: string; }
export interface ShortFictionOutlinePromptInput {
  readonly direction: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
  readonly reference?: ShortFictionReferencePromptInput;
}
export interface ShortFictionDraftPromptInput {
  readonly direction: string;
  readonly outlineMarkdown: string;
  readonly chapterCount: number;
  readonly charsPerChapter: number;
  readonly chapterNumbers?: readonly number[];
  readonly previousDraftMarkdown?: string;
}
export interface ShortFictionDraftReviewPromptInput extends ShortFictionDraftPromptInput { readonly draftMarkdown: string; }
export interface ShortFictionPackagePromptInput {
  readonly direction: string;
  readonly outlineMarkdown: string;
  readonly draftMarkdown: string;
  readonly draftTitle: string;
}

export function buildShortFictionOutlineSystemPrompt(language: ShortFictionLanguage = "zh"): string {
  return language === "en"
    ? "Create the complete short-story plan using the activated short-writing Skill and only the supplied material. Return the requested tagged Markdown without analysis or process notes."
    : "按已激活的短篇写作 Skill 和用户材料生成完整短篇方案。只返回规定 tag 格式的 Markdown，不要分析或流程说明。";
}

export function buildShortFictionOutlineUserPrompt(input: ShortFictionOutlinePromptInput, language: ShortFictionLanguage = "zh"): string {
  const reference = input.reference?.text?.trim();
  return language === "en"
    ? [
        "## Creative Direction", input.direction,
        "", "## Target", `${input.chapterCount} chapters; about ${input.charsPerChapter} words per chapter.`,
        ...(reference ? ["", "## Reference", reference] : []),
        "", "## Output contract",
        "=== SHORT_FICTION_PLAN_TITLE ===", "<one title>",
        "=== SHORT_FICTION_PLAN ===", "<complete human-readable Markdown plan>",
      ].join("\n")
    : [
        "## 创作方向", input.direction,
        "", "## 目标", `${input.chapterCount} 章；每章约 ${input.charsPerChapter} 字。`,
        ...(reference ? ["", "## 参考材料", reference] : []),
        "", "## 输出协议",
        "=== SHORT_FICTION_PLAN_TITLE ===", "<一个标题>",
        "=== SHORT_FICTION_PLAN ===", "<完整的人类可读 Markdown 方案>",
      ].join("\n");
}

export function buildShortFictionWriterSystemPrompt(language: ShortFictionLanguage = "zh"): string {
  return language === "en"
    ? "Write exactly the requested chapter batch using the activated short-writing Skill and the full plan. Return only the specified tagged blocks."
    : "按已激活的短篇写作 Skill 和完整方案写本批指定章节，只返回规定 tag 块。";
}

export function buildShortFictionWriterUserPrompt(input: ShortFictionDraftPromptInput, language: ShortFictionLanguage = "zh"): string {
  const chapters = requestedShortFictionChapters(input);
  const previous = input.previousDraftMarkdown?.trim();
  const chapterBlocks = chapters.flatMap((chapter) => [
    `=== CHAPTER ${chapter} TITLE ===`, "<title>",
    `=== CHAPTER ${chapter} CONTENT ===`, language === "en" ? "<complete chapter prose>" : "<完整章节正文>",
  ]);
  return language === "en"
    ? [
        "## Task", `Write only chapters ${chapters.join(", ")} of ${input.chapterCount}; about ${input.charsPerChapter} words each.`,
        "", "## Direction", input.direction,
        "", "## Plan", input.outlineMarkdown,
        ...(previous ? ["", "## Accepted previous chapters", previous] : []),
        "", "## Output contract", "=== SHORT_FICTION_TITLE ===", "<story title>", "=== SHORT_FICTION_OPENING_HOOK ===", "<optional hook>", ...chapterBlocks,
      ].join("\n")
    : [
        "## 任务", `只写第 ${chapters.join("、")} 章；全篇 ${input.chapterCount} 章，每章约 ${input.charsPerChapter} 字。`,
        "", "## 创作方向", input.direction,
        "", "## 故事方案", input.outlineMarkdown,
        ...(previous ? ["", "## 已接受的前文章节", previous] : []),
        "", "## 输出协议", "=== SHORT_FICTION_TITLE ===", "<短篇标题>", "=== SHORT_FICTION_OPENING_HOOK ===", "<可选开篇钩子>", ...chapterBlocks,
      ].join("\n");
}

export function buildShortFictionDraftReviewSystemPrompt(language: ShortFictionLanguage = "zh"): string {
  return language === "en"
    ? "Review the draft with the activated short-writing Skill. Use no score. Return Markdown separating concrete reader-stopping defects from acceptable blemishes."
    : "按已激活的短篇写作 Skill 审查成稿，不打分。用 Markdown 区分会让读者停下的具体问题与可接受的小瑕疵。";
}

export function buildShortFictionDraftReviewUserPrompt(input: ShortFictionDraftReviewPromptInput, language: ShortFictionLanguage = "zh"): string {
  return [
    language === "en" ? "## Direction" : "## 创作方向", input.direction,
    "", language === "en" ? "## Accepted plan" : "## 已接受方案", input.outlineMarkdown,
    "", language === "en" ? "## Draft under review" : "## 待审正文", input.draftMarkdown,
  ].join("\n");
}

export function buildShortFictionPackageSystemPrompt(language: ShortFictionLanguage = "zh"): string {
  return language === "en"
    ? "Package the accepted draft using the activated short-writing Skill. Preserve its actual title and plot. Return only the requested tagged fields."
    : "按已激活的短篇写作 Skill 包装已接受正文，保留实际标题与剧情。只返回规定 tag 字段。";
}

export function buildShortFictionPackageUserPrompt(input: ShortFictionPackagePromptInput, language: ShortFictionLanguage = "zh"): string {
  return [
    language === "en" ? "## Direction" : "## 创作方向", input.direction,
    "", language === "en" ? "## Plan" : "## 故事方案", input.outlineMarkdown.trim(),
    "", language === "en" ? "## Accepted draft" : "## 已接受正文", input.draftMarkdown.trim(),
    "", language === "en" ? "## Output contract" : "## 输出协议",
    "=== SHORT_FICTION_PACKAGE_TITLE ===", input.draftTitle,
    "=== SHORT_FICTION_INTRO ===", language === "en" ? "<synopsis>" : "<简介>",
    "=== SHORT_FICTION_SELLING_POINTS ===", language === "en" ? "<one point per line>" : "<每行一个卖点>",
    "=== SHORT_FICTION_COVER_PROMPT ===", language === "en" ? "<cover prompt>" : "<封面提示词>",
  ].join("\n");
}

function requestedShortFictionChapters(input: ShortFictionDraftPromptInput): number[] {
  const requested = input.chapterNumbers?.filter((chapter) => Number.isInteger(chapter) && chapter >= 1 && chapter <= input.chapterCount);
  return requested && requested.length > 0
    ? [...new Set(requested)].sort((a, b) => a - b)
    : Array.from({ length: input.chapterCount }, (_, index) => index + 1);
}
