import { join } from "node:path";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  loadTranslationChapter,
  loadTranslationGlossary,
  loadTranslationManifest,
  mergeGlossaryTerms,
  saveTranslationProgress,
  saveTranslationManifest,
} from "./run-store.js";
import type {
  RunTranslationProjectResult,
  TranslationChapterFile,
  TranslationModelPort,
  TranslationProjectManifest,
  TranslationSegment,
} from "./types.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";

export async function runTranslationProject(
  projectRoot: string,
  projectId: string,
  options: {
    readonly model: TranslationModelPort;
    readonly batchSize?: number;
  },
): Promise<RunTranslationProjectResult> {
  try {
    let manifest = await loadTranslationManifest(projectRoot, projectId);
    let glossary = [...await loadTranslationGlossary(projectRoot, projectId)];
    const reportLines = [`# Translation Review`, ""];
    let translatedSegments = 0;
    let reviewedChapters = 0;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 8, 32));

  for (const chapterInfo of manifest.chapters) {
    const source = await loadTranslationChapter(projectRoot, chapterInfo.sourcePath);
    const translated = await loadTranslationChapter(projectRoot, chapterInfo.translatedPath).catch(() => ({
      ...source,
      segments: [],
    } satisfies TranslationChapterFile));
    const translatedByIndex = new Map(translated.segments.map((segment) => [segment.index, segment]));
    let translatedTitle = translated.title;
    const pending = source.segments.filter((segment) => !translatedByIndex.get(segment.index)?.target?.trim());

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const result = await options.model.translateSegments({
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
        chapterTitle: source.title,
        segments: batch,
        glossary,
      });
      if (result.chapterTitle?.trim()) translatedTitle = result.chapterTitle.trim();
      for (const item of result.segments) {
        const original = source.segments.find((segment) => segment.index === item.index);
        if (!original) continue;
        translatedByIndex.set(item.index, {
          ...original,
          target: item.target,
          ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
        });
        translatedSegments++;
      }
      if (result.glossary?.length) {
        glossary = [...mergeGlossaryTerms([...glossary, ...result.glossary])];
      }
      await saveTranslationProgress(projectRoot, projectId, chapterInfo.translatedPath, {
        ...source,
        title: translatedTitle,
        segments: orderedTranslatedSegments(source.segments, translatedByIndex),
      }, glossary);
    }

    const completedChapter = await loadTranslationChapter(projectRoot, chapterInfo.translatedPath);
    let reviewSummary: string | undefined;
    let reviewIssues: ReadonlyArray<string> | undefined;
    if (options.model.reviewChapter && completedChapter.segments.some((segment) => segment.target?.trim())) {
      const review = await options.model.reviewChapter({
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
        chapterTitle: completedChapter.title,
        segments: completedChapter.segments,
        glossary,
      });
      reviewedChapters++;
      reviewSummary = review.summary;
      reviewIssues = review.issues;
      reportLines.push(`## ${completedChapter.title}`, "", `- summary: ${review.summary}`, "");
      for (const issue of review.issues) {
        reportLines.push(`- issue: ${issue}`);
      }
      reportLines.push("");
    }
    manifest = updateChapterProgress(
      manifest,
      chapterInfo.number,
      completedChapter.segments.filter((segment) => segment.target?.trim()).length,
      completedChapter.title,
      reviewSummary,
      reviewIssues,
    );
    await saveTranslationManifest(projectRoot, manifest);
  }

    const reportPath = `works/${projectId}/source/review-report.md`;
    await commitAtomicFileSet({
      rootDir: projectRoot,
      writes: [{
        relativePath: reportPath,
        content: `${reportLines.join("\n").trimEnd()}\n`,
      }],
    });
    await syncWorkSourceArtifacts({ projectRoot, workId: projectId, accept: true });
    return {
      projectId,
      translatedSegments,
      reviewedChapters,
      reportPath,
    };
  } catch (error) {
    await syncWorkSourceArtifacts({ projectRoot, workId: projectId, accept: false }).catch(() => undefined);
    throw error;
  }
}

function orderedTranslatedSegments(
  sourceSegments: ReadonlyArray<TranslationSegment>,
  translatedByIndex: ReadonlyMap<number, TranslationSegment>,
): ReadonlyArray<TranslationSegment> {
  return sourceSegments.map((segment) => translatedByIndex.get(segment.index) ?? segment);
}

function updateChapterProgress(
  manifest: TranslationProjectManifest,
  chapterNumber: number,
  translatedSegments: number,
  translatedTitle: string,
  reviewSummary?: string,
  reviewIssues?: ReadonlyArray<string>,
): TranslationProjectManifest {
  return {
    ...manifest,
    updatedAt: new Date().toISOString(),
    chapters: manifest.chapters.map((chapter) =>
      chapter.number === chapterNumber
        ? { ...chapter, title: translatedTitle, translatedSegments, reviewSummary, reviewIssues }
        : chapter,
    ),
  };
}
