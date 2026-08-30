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
    ? "Create the complete short-story plan using the activated short-writing Skill and only the supplied material. Submit it through the outline tool."
    : "按已激活的短篇写作 Skill 和用户材料生成完整短篇方案，通过方案工具提交。";
}

export function buildShortFictionOutlineUserPrompt(input: ShortFictionOutlinePromptInput, language: ShortFictionLanguage = "zh"): string {
  const reference = input.reference?.text?.trim();
  return [
    language === "en" ? "## Creative Direction" : "## 创作方向",
    input.direction,
    "",
    language === "en" ? "## Target" : "## 目标",
    language === "en"
      ? `${input.chapterCount} chapters; about ${input.charsPerChapter} words per chapter.`
      : `${input.chapterCount} 章；每章约 ${input.charsPerChapter} 字。`,
    ...(reference ? ["", language === "en" ? "## Reference" : "## 参考材料", reference] : []),
  ].join("\n");
}
export function buildShortFictionWriterSystemPrompt(language: ShortFictionLanguage = "zh"): string {
  return language === "en"
    ? "Write exactly the requested chapter batch using the activated short-writing Skill and the full plan. Submit complete chapters through the draft tool."
    : "按已激活的短篇写作 Skill 和完整方案写本批指定章节，通过初稿工具提交完整章节。";
}

export function buildShortFictionWriterUserPrompt(input: ShortFictionDraftPromptInput, language: ShortFictionLanguage = "zh"): string {
  const chapters = requestedShortFictionChapters(input);
  const previous = input.previousDraftMarkdown?.trim();
  return [
    language === "en" ? "## Task" : "## 任务",
    language === "en"
      ? `Write only chapters ${chapters.join(", ")} of ${input.chapterCount}; about ${input.charsPerChapter} words each.`
      : `只写第 ${chapters.join("、")} 章；全篇 ${input.chapterCount} 章，每章约 ${input.charsPerChapter} 字。`,
    "",
    language === "en" ? "## Direction" : "## 创作方向",
    input.direction,
    "",
    language === "en" ? "## Plan" : "## 故事方案",
    input.outlineMarkdown,
    ...(previous ? ["", language === "en" ? "## Persisted previous chapters" : "## 已落盘前文章节", previous] : []),
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
    "", language === "en" ? "## Current plan" : "## 当前方案", input.outlineMarkdown,
    "", language === "en" ? "## Draft under review" : "## 待审正文", input.draftMarkdown,
  ].join("\n");
}

export function buildShortFictionPackageSystemPrompt(language: ShortFictionLanguage = "zh"): string {
  return language === "en"
    ? "Package the persisted draft using the activated short-writing Skill. Preserve its actual title and plot, then submit through the package tool."
    : "按已激活的短篇写作 Skill 包装已落盘正文，保留实际标题与剧情，通过包装工具提交。";
}

export function buildShortFictionPackageUserPrompt(input: ShortFictionPackagePromptInput, language: ShortFictionLanguage = "zh"): string {
  return [
    language === "en" ? "## Direction" : "## 创作方向", input.direction,
    "", language === "en" ? "## Plan" : "## 故事方案", input.outlineMarkdown.trim(),
    "", language === "en" ? "## Persisted draft" : "## 已落盘正文", input.draftMarkdown.trim(),
    "", language === "en" ? "## Existing title" : "## 当前标题", input.draftTitle,
  ].join("\n");
}
function requestedShortFictionChapters(input: ShortFictionDraftPromptInput): number[] {
  const requested = input.chapterNumbers?.filter((chapter) => Number.isInteger(chapter) && chapter >= 1 && chapter <= input.chapterCount);
  return requested && requested.length > 0
    ? [...new Set(requested)].sort((a, b) => a - b)
    : Array.from({ length: input.chapterCount }, (_, index) => index + 1);
}
