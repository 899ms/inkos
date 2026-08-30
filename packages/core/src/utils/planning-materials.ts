import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readStoryFrame,
  readVolumeMap,
  readCurrentStateWithFallback,
} from "./outline-paths.js";

export interface PlanningSeedMaterials {
  readonly storyDir: string;
  readonly authorIntent: string;
  readonly currentFocus: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly currentState: string;
  readonly chapterSummariesRaw: string;
  readonly brief: string;
  readonly previousEndingExcerpt?: string;
}

async function readFileOrDefault(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "(文件尚未创建)";
  }
}

async function readBriefFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function readPreviousEndingExcerpt(
  bookDir: string,
  chapterNumber: number,
): Promise<string | undefined> {
  const previousChapter = chapterNumber - 1;
  if (previousChapter < 1) {
    return undefined;
  }

  const chaptersDir = join(bookDir, "chapters");
  const padded = String(previousChapter).padStart(4, "0");
  try {
    const files = await readdir(chaptersDir);
    const match = files.find((file) => file.startsWith(padded) && file.endsWith(".md"));
    if (!match) {
      return undefined;
    }
    const markdown = await readFile(join(chaptersDir, match), "utf-8");
    const body = markdown
      .split("\n")
      .slice(1)
      .join("\n")
      .trim();
    if (!body) {
      return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

export async function loadPlanningSeedMaterials(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
}): Promise<PlanningSeedMaterials> {
  const storyDir = join(params.bookDir, "story");
  const sourcePaths = {
    authorIntent: join(storyDir, "author_intent.md"),
    currentFocus: join(storyDir, "current_focus.md"),
    chapterSummaries: join(storyDir, "chapter_summaries.md"),
    currentState: join(storyDir, "current_state.md"),
    brief: join(storyDir, "brief.md"),
  } as const;

  // Phase 5: prefer the new prose outline files (outline/story_frame.md +
  // outline/volume_map.md). Fall back to the legacy files transparently.
  const placeholder = "(文件尚未创建)";

  const [
    authorIntent,
    currentFocus,
    storyBible,
    volumeOutline,
    chapterSummariesRaw,
    currentState,
    previousEndingExcerpt,
    brief,
  ] = await Promise.all([
    readFileOrDefault(sourcePaths.authorIntent),
    readFileOrDefault(sourcePaths.currentFocus),
    readStoryFrame(params.bookDir, placeholder),
    readVolumeMap(params.bookDir, placeholder),
    readFileOrDefault(sourcePaths.chapterSummaries),
    // Phase 5 consolidation: derive initial state from roles + pending_hooks
    // seed rows when current_state.md is still just the architect's placeholder.
    readCurrentStateWithFallback(params.bookDir, placeholder),
    readPreviousEndingExcerpt(params.bookDir, params.chapterNumber),
    readBriefFile(sourcePaths.brief),
  ]);

  return {
    storyDir,
    authorIntent,
    currentFocus,
    storyBible,
    volumeOutline,
    currentState,
    chapterSummariesRaw,
    brief,
    previousEndingExcerpt,
  };
}
