import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChapterSummariesStateSchema,
  HooksStateSchema,
} from "../models/runtime-state.js";
import { MemoryDB, type StoredHook, type StoredSummary } from "../state/memory-db.js";
import { bootstrapStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import {
  parseChapterSummariesMarkdown,
  parsePendingHooksMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
} from "./story-markdown.js";
import {
  LocalSearchIndex,
  type SearchDocument,
  type SearchHit,
} from "../retrieval/local-search.js";
export {
  parseChapterSummariesMarkdown,
  parsePendingHooksMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
} from "./story-markdown.js";

export interface MemorySelection {
  readonly summaries: ReadonlyArray<StoredSummary>;
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly lookupHooks: ReadonlyArray<StoredHook>;
  readonly volumeSummaries: ReadonlyArray<VolumeSummarySelection>;
  readonly dbPath: string;
  readonly retrievalTrace: MemoryRetrievalTrace;
}

export interface MemoryRetrievalTrace {
  readonly engine: "sqlite-fts5-bm25";
  readonly query: string;
  readonly candidates: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly source: string;
    readonly score: number;
  }>;
  readonly semanticSelectedIds?: ReadonlyArray<string>;
}

export interface MemorySemanticSelectionRequest {
  readonly chapterNumber: number;
  readonly query: string;
  readonly candidates: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly source: string;
    readonly title: string;
    readonly excerpt: string;
  }>;
}

export type MemorySemanticSelector = (
  request: MemorySemanticSelectionRequest,
) => Promise<ReadonlyArray<string>>;

export interface VolumeSummarySelection {
  readonly heading: string;
  readonly content: string;
  readonly anchor: string;
}

export async function retrieveMemorySelection(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly goal: string;
  readonly semanticSelector?: MemorySemanticSelector;
}): Promise<MemorySelection> {
  const storyDir = join(params.bookDir, "story");
  const stateDir = join(storyDir, "state");
  const fallbackChapter = Math.max(0, params.chapterNumber - 1);

  await bootstrapStructuredStateFromMarkdown({
    bookDir: params.bookDir,
    fallbackChapter,
  }).catch(() => undefined);

  const [
    hooksMarkdown,
    volumeSummariesMarkdown,
    structuredHooks,
    structuredSummaries,
  ] = await Promise.all([
    readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    readFile(join(storyDir, "volume_summaries.md"), "utf-8").catch(() => ""),
    readStructuredState(join(stateDir, "hooks.json"), HooksStateSchema),
    readStructuredState(join(stateDir, "chapter_summaries.json"), ChapterSummariesStateSchema),
  ]);
  const retrievalQuery = params.goal;
  const parsedVolumeSummaries = parseVolumeSummariesMarkdown(volumeSummariesMarkdown);
  // Structured hook state is authoritative; SQLite remains a rebuildable
  // retrieval projection.
  const hooks = structuredHooks?.hooks ?? parsePendingHooksMarkdown(hooksMarkdown);
  // Every unresolved hook remains searchable canon. The semantic selector
  // decides relevance for the current task; status does not imply urgency.
  const searchableHooks = hooks.filter((hook) => hook.status !== "resolved");

  const summaries = structuredSummaries?.rows ?? parseChapterSummariesMarkdown(
    await readFile(join(storyDir, "chapter_summaries.md"), "utf-8").catch(() => ""),
  );
  const memoryDb = new MemoryDB(params.bookDir);
  try {
    memoryDb.replaceSummaries(summaries);

    // Markdown/structured hook state is authoritative. SQLite is a rebuildable
    // search projection and is never allowed to resurrect removed hook rows.
    const dbPath = join(storyDir, "memory.db");
    const searchIndex = new LocalSearchIndex(dbPath);
    try {
      searchIndex.replaceScope(
        STORY_MEMORY_SCOPE,
        buildMemorySearchDocuments({
          summaries,
          hooks: searchableHooks,
          volumeSummaries: parsedVolumeSummaries,
        }),
      );
      const hits = searchIndex.search(retrievalQuery, {
        scope: STORY_MEMORY_SCOPE,
        limit: 32,
      });
      const semanticSelectedIds = await selectSemanticCandidateIds({
        selector: params.semanticSelector,
        chapterNumber: params.chapterNumber,
        query: retrievalQuery,
        hits,
      });
      const selectedIds = new Set(semanticSelectedIds ?? hits.map((hit) => hit.id));

      return {
        summaries: selectSummariesById(summaries, params.chapterNumber, selectedIds),
        hooks: searchableHooks.filter((hook) => selectedIds.has(hookDocumentId(hook.hookId))),
        lookupHooks: searchableHooks,
        volumeSummaries: parsedVolumeSummaries.filter((_, index) => selectedIds.has(volumeSummaryDocumentId(index))),
        dbPath,
        retrievalTrace: {
          engine: "sqlite-fts5-bm25",
          query: retrievalQuery,
          candidates: hits.map(({ id, kind, source, score }) => ({ id, kind, source, score })),
          ...(semanticSelectedIds ? { semanticSelectedIds } : {}),
        },
      };
    } finally {
      searchIndex.close();
    }
  } finally {
    memoryDb.close();
  }
}

const STORY_MEMORY_SCOPE = "story-memory";

async function selectSemanticCandidateIds(params: {
  readonly selector?: MemorySemanticSelector;
  readonly chapterNumber: number;
  readonly query: string;
  readonly hits: ReadonlyArray<SearchHit>;
}): Promise<ReadonlyArray<string> | undefined> {
  if (!params.selector || params.hits.length <= 1) return undefined;
  try {
    const allowed = new Set(params.hits.map((hit) => hit.id));
    const selected = await params.selector({
      chapterNumber: params.chapterNumber,
      query: params.query,
      candidates: params.hits.map((hit) => ({
        id: hit.id,
        kind: hit.kind,
        source: hit.source,
        title: hit.title,
        excerpt: hit.body,
      })),
    });
    return [...new Set(selected)].filter((id) => allowed.has(id));
  } catch {
    // Retrieval remains available if the semantic selector is temporarily
    // unavailable; BM25 and deterministic story-state priorities still apply.
    return undefined;
  }
}

async function readStructuredState<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function buildMemorySearchDocuments(input: {
  readonly summaries: ReadonlyArray<StoredSummary>;
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly volumeSummaries: ReadonlyArray<VolumeSummarySelection>;
}): SearchDocument[] {
  return [
    ...input.summaries.map((summary) => ({
      id: summaryDocumentId(summary.chapter),
      scope: STORY_MEMORY_SCOPE,
      kind: "chapter-summary",
      source: `story/chapter_summaries.md#${summary.chapter}`,
      title: summary.title || `Chapter ${summary.chapter}`,
      body: [
        summary.characters,
        summary.events,
        summary.stateChanges,
        summary.hookActivity,
        summary.mood,
        summary.chapterType,
      ].filter(Boolean).join("\n"),
      metadata: { chapter: summary.chapter },
    })),
    ...input.hooks.map((hook) => ({
      id: hookDocumentId(hook.hookId),
      scope: STORY_MEMORY_SCOPE,
      kind: "hook",
      source: `story/pending_hooks.md#${hook.hookId}`,
      title: [hook.hookId, hook.type].filter(Boolean).join(" "),
      body: [hook.status, hook.expectedPayoff, hook.notes].filter(Boolean).join("\n"),
      metadata: { hookId: hook.hookId },
    })),
    ...input.volumeSummaries.map((summary, index) => ({
      id: volumeSummaryDocumentId(index),
      scope: STORY_MEMORY_SCOPE,
      kind: "volume-summary",
      source: `story/volume_summaries.md#${summary.anchor}`,
      title: summary.heading,
      body: summary.content,
      metadata: { index },
    })),
  ];
}

function summaryDocumentId(chapter: number): string {
  return `summary:${chapter}`;
}

function hookDocumentId(hookId: string): string {
  return `hook:${hookId}`;
}

function volumeSummaryDocumentId(index: number): string {
  return `volume-summary:${index}`;
}

function parseVolumeSummariesMarkdown(markdown: string): VolumeSummarySelection[] {
  if (!markdown.trim()) return [];

  const sections = markdown
    .split(/^##\s+/m)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections.map((section) => {
    const [headingLine, ...bodyLines] = section.split("\n");
    const heading = headingLine?.trim() ?? "";
    const content = bodyLines.join("\n").trim();

    return {
      heading,
      content,
      anchor: slugifyAnchor(heading),
    };
  }).filter((section) => section.heading.length > 0 && section.content.length > 0);
}

function selectSummariesById(
  summaries: ReadonlyArray<StoredSummary>,
  chapterNumber: number,
  selectedIds: ReadonlySet<string>,
): StoredSummary[] {
  return summaries
    .filter((summary) => summary.chapter < chapterNumber)
    .filter((summary) => summary.chapter === chapterNumber - 1 || selectedIds.has(summaryDocumentId(summary.chapter)))
    .sort((left, right) => left.chapter - right.chapter);
}

function slugifyAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "volume-summary";
}
