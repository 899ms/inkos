/**
 * Post-write rule-based validator.
 *
 * Deterministic, zero-LLM-cost checks that run after every chapter generation.
 * Catches violations that prompt-only rules cannot guarantee.
 */

import type { BookRules } from "../models/book-rules.js";
import type { GenreProfile } from "../models/genre-profile.js";

export interface PostWriteViolation {
  readonly rule: string;
  readonly severity: "error" | "warning";
  readonly description: string;
  readonly suggestion: string;
}

export function normalizePostWriteSurface(content: string, _languageOverride?: "zh" | "en"): string {
  return stripPostWriteMetaLines(content).trimEnd();
}

function stripPostWriteMetaLines(content: string): string {
  return content.split(/\r?\n/).filter((line) =>
    !/^\s*\[(?:polisher|writer|reviser|reviewer)-note\]\s*/i.test(line)
    && !/^\s*\[(?:润色|写作|修订|审稿)备注\]\s*/.test(line)
  ).join("\n");
}

interface ParagraphShape {
  readonly paragraphs: ReadonlyArray<string>;
  readonly shortThreshold: number;
  readonly shortParagraphs: ReadonlyArray<string>;
  readonly shortRatio: number;
  readonly averageLength: number;
  readonly maxConsecutiveShort: number;
}

/** Objective surface observations only; semantic review belongs to the review Skill. */
export function validatePostWrite(
  content: string,
  _genreProfile: GenreProfile,
  _bookRules: BookRules | null,
  languageOverride: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  const language = languageOverride === "en" ? "en" : "zh";
  const paragraphs = extractParagraphs(content);
  const maxLength = language === "en" ? 500 : 300;
  const longParagraphs = paragraphs.filter((paragraph) => paragraph.length > maxLength);
  const violations: PostWriteViolation[] = [];
  if (longParagraphs.length >= 2) {
    violations.push(language === "en"
      ? {
          rule: "Paragraph length",
          severity: "warning",
          description: `${longParagraphs.length} paragraphs exceed ${maxLength} characters.`,
          suggestion: "Review paragraph boundaries for the target reading surface.",
        }
      : {
          rule: "段落过长",
          severity: "warning",
          description: `${longParagraphs.length}个段落超过${maxLength}字。`,
          suggestion: "复核段落边界是否适合目标阅读界面。",
        });
  }
  violations.push(...detectParagraphShapeWarnings(content, language));
  return violations;
}

/**
 * Cross-chapter repetition check.
 * Detects phrases from the current chapter that also appeared in recent chapters.
 */
export function detectCrossChapterRepetition(
  currentContent: string,
  recentChaptersContent: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  if (!recentChaptersContent || recentChaptersContent.length < 100) return [];

  const violations: PostWriteViolation[] = [];
  const isEnglish = language === "en";

  if (isEnglish) {
    // Extract 3-word phrases from current chapter
    const words = currentContent.toLowerCase().replace(/[^\w\s']/g, "").split(/\s+/).filter(w => w.length > 2);
    const phraseCounts = new Map<string, number>();
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
    // Check which repeated phrases (2+ in current) also appear in recent chapters
    const recentLower = recentChaptersContent.toLowerCase();
    const crossRepeats: string[] = [];
    for (const [phrase, count] of phraseCounts) {
      if (count >= 2 && recentLower.includes(phrase)) {
        crossRepeats.push(`"${phrase}" (×${count})`);
      }
    }
    if (crossRepeats.length >= 3) {
      violations.push({
        rule: "Cross-chapter repetition",
        severity: "warning",
        description: `${crossRepeats.length} repeated phrases also found in recent chapters: ${crossRepeats.slice(0, 5).join(", ")}`,
        suggestion: "Vary action verbs and descriptive phrases to avoid cross-chapter repetition",
      });
    }
  } else {
    // Chinese: 6-char ngrams
    const chars = currentContent.replace(/[\s\n\r]/g, "");
    const phraseCounts = new Map<string, number>();
    for (let i = 0; i < chars.length - 5; i++) {
      const phrase = chars.slice(i, i + 6);
      if (/^[\u4e00-\u9fff]{6}$/.test(phrase)) {
        phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
      }
    }
    const recentClean = recentChaptersContent.replace(/[\s\n\r]/g, "");
    const crossRepeats: string[] = [];
    for (const [phrase, count] of phraseCounts) {
      if (count >= 2 && recentClean.includes(phrase)) {
        crossRepeats.push(`"${phrase}"(×${count})`);
      }
    }
    if (crossRepeats.length >= 3) {
      violations.push({
        rule: "跨章重复",
        severity: "warning",
        description: `${crossRepeats.length}个重复短语在近期章节中也出现过：${crossRepeats.slice(0, 5).join("、")}`,
        suggestion: "变换动作描写和场景用语，避免跨章节机械重复",
      });
    }
  }

  return violations;
}

export function detectParagraphLengthDrift(
  currentContent: string,
  recentChaptersContent: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  if (!recentChaptersContent || recentChaptersContent.trim().length === 0) return [];

  const current = analyzeParagraphShape(currentContent, language);
  const recent = analyzeParagraphShape(recentChaptersContent, language);

  if (current.paragraphs.length < 4 || recent.paragraphs.length < 4) return [];
  if (recent.averageLength <= 0 || current.averageLength <= 0) return [];

  const shrinkRatio = current.averageLength / recent.averageLength;
  const shortRatioDelta = current.shortRatio - recent.shortRatio;

  if (shrinkRatio >= 0.6 || current.shortRatio < 0.5 || shortRatioDelta < 0.25) {
    return [];
  }

  const dropPercent = Math.round((1 - shrinkRatio) * 100);

  return [
    language === "en"
      ? {
          rule: "Paragraph density drift",
          severity: "warning",
          description: `Average paragraph length dropped from ${Math.round(recent.averageLength)} to ${Math.round(current.averageLength)} characters (${dropPercent}% shorter) compared with recent chapters.`,
          suggestion: "Let action, observation, and reaction share paragraphs more often instead of cutting every beat into a single short line.",
        }
      : {
          rule: "段落密度漂移",
          severity: "warning",
          description: `当前章平均段长从近期章节的${Math.round(recent.averageLength)}字降到${Math.round(current.averageLength)}字，缩短了${dropPercent}%。`,
          suggestion: "不要把每个动作都切成单独短句；适当把动作、观察和反应并入同一段，恢复段落层次。",
        },
  ];
}


function appendParagraphShapeWarnings(
  violations: PostWriteViolation[],
  content: string,
  language: "zh" | "en",
): void {
  const shape = analyzeParagraphShape(content, language);
  if (shape.paragraphs.length < 4) return;

  if (shape.shortParagraphs.length >= 4 && shape.shortRatio >= 0.6) {
    violations.push(
      language === "en"
        ? {
            rule: "Paragraph fragmentation",
            severity: "warning",
            description: `${shape.shortParagraphs.length} of ${shape.paragraphs.length} paragraphs are shorter than ${shape.shortThreshold} characters.`,
            suggestion: "Merge adjacent action, observation, and reaction beats so the chapter does not collapse into one-line paragraphs.",
          }
        : {
            rule: "段落过碎",
            severity: "warning",
            description: `${shape.paragraphs.length}个段落里有${shape.shortParagraphs.length}个不足${shape.shortThreshold}字，段落被切得过碎。`,
            suggestion: "把相邻的动作、观察、反应适当并段，不要每句话都单独起段。",
          },
    );
  }

  if (shape.maxConsecutiveShort >= 3) {
    violations.push(
      language === "en"
        ? {
            rule: "Consecutive short paragraphs",
            severity: "warning",
            description: `${shape.maxConsecutiveShort} short paragraphs appear back to back.`,
            suggestion: "Break the one-beat-per-paragraph rhythm by folding connected beats into fuller paragraphs.",
          }
        : {
            rule: "连续短段",
            severity: "warning",
            description: `连续出现${shape.maxConsecutiveShort}个不足${shape.shortThreshold}字的短段，容易形成短句堆砌。`,
            suggestion: "把连续的碎动作重新编组，至少让一个段落承载完整的动作链或情绪推进。",
          },
    );
  }
}

export function detectParagraphShapeWarnings(
  content: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  const violations: PostWriteViolation[] = [];
  appendParagraphShapeWarnings(violations, content, language);
  return violations;
}

function isDialogueParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return /^[""「『'《]/.test(trimmed) || /^[""]/.test(trimmed) || /^——/.test(trimmed);
}

function analyzeParagraphShape(content: string, language: "zh" | "en"): ParagraphShape {
  const paragraphs = extractParagraphs(content);
  // Exclude dialogue lines from short paragraph counting — dialogue is naturally short
  const narrativeParagraphs = paragraphs.filter((p) => !isDialogueParagraph(p));
  const shortThreshold = language === "en" ? 120 : 35;
  const shortParagraphs = narrativeParagraphs.filter((paragraph) => paragraph.length < shortThreshold);
  const averageLength = paragraphs.length > 0
    ? paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0) / paragraphs.length
    : 0;

  let maxConsecutiveShort = 0;
  let currentConsecutive = 0;
  for (const paragraph of narrativeParagraphs) {
    if (paragraph.length < shortThreshold) {
      currentConsecutive++;
      maxConsecutiveShort = Math.max(maxConsecutiveShort, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }

  return {
    paragraphs,
    shortThreshold,
    shortParagraphs,
    shortRatio: narrativeParagraphs.length > 0 ? shortParagraphs.length / narrativeParagraphs.length : 0,
    averageLength,
    maxConsecutiveShort,
  };
}

function extractParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .filter((paragraph) => paragraph !== "---")
    .filter((paragraph) => !paragraph.startsWith("#"));
}

/**
 * Detect duplicate or near-duplicate chapter titles.
 * Compares the new title against existing chapter titles from index.
 */
export function detectDuplicateTitle(
  newTitle: string,
  existingTitles: ReadonlyArray<string>,
): ReadonlyArray<PostWriteViolation> {
  if (!newTitle.trim()) return [];

  const normalized = newTitle.trim().toLowerCase();
  const violations: PostWriteViolation[] = [];

  for (const existing of existingTitles) {
    const existingNorm = existing.trim().toLowerCase();
    if (!existingNorm) continue;

    // Exact match
    if (normalized === existingNorm) {
      violations.push({
        rule: "duplicate-title",
        severity: "warning",
        description: `章节标题"${newTitle}"与已有章节标题完全相同`,
        suggestion: "更换一个不同的章节标题",
      });
      break;
    }

    // Near-duplicate: one is substring of the other, or only differs by punctuation/numbers
    const stripPunct = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
    if (stripPunct(normalized) === stripPunct(existingNorm)) {
      violations.push({
        rule: "near-duplicate-title",
        severity: "warning",
        description: `章节标题"${newTitle}"与已有标题"${existing}"高度相似`,
        suggestion: "避免使用相似的章节标题",
      });
      break;
    }
  }

  return violations;
}

export function resolveDuplicateTitle(
  newTitle: string,
  existingTitles: ReadonlyArray<string>,
  _language: "zh" | "en" = "zh",
  _options?: { readonly content?: string },
): {
  readonly title: string;
  readonly issues: ReadonlyArray<PostWriteViolation>;
} {
  const title = newTitle.trim();
  return { title, issues: detectDuplicateTitle(title, existingTitles) };
}
