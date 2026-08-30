import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { persistChapterArtifacts } from "../pipeline/chapter-persistence.js";
import { reviewChapterDraft } from "../pipeline/chapter-review.js";
import { validateChapterTruthPersistence } from "../pipeline/chapter-truth-validation.js";
import { StateManager } from "../state/manager.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";

describe("long-form harness mini-flow", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("persists an authorized chapter with review observations instead of a quality status", async () => {
    const root = await tempRoot();
    const bookDir = join(root, "works", "novel", "source");
    await mkdir(join(bookDir, "story"), { recursive: true });
    const state = new StateManager(root);
    const output = chapterOutput(1);
    const writer = new WriterAgent({ client: {} as never, model: "test", projectRoot: root });

    await persistChapterArtifacts({
      chapterNumber: 1,
      chapterTitle: output.title,
      auditResult: {
        summary: "One continuity observation.",
        issues: [{
          severity: "critical",
          category: "canon-consistency",
          description: "A supporting detail conflicts with the current canon.",
          suggestion: "Review the detail before the next revision.",
        }],
      },
      finalWordCount: output.wordCount,
      loadChapterIndex: () => state.loadChapterIndex("novel"),
      saveChapter: (index) => writer.saveChapter(bookDir, output, "en", index),
      markBookActiveIfNeeded: async () => undefined,
    });

    const [chapter] = await state.loadChapterIndex("novel");
    const persisted = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as Array<Record<string, unknown>>;
    expect({
      observation: chapter?.observations[0]?.code,
      provenance: chapter?.provenance,
      hasLegacyStatus: "status" in (persisted[0] ?? {}),
      chapterFiles: (await readdir(join(bookDir, "chapters"))).filter((file) => file.endsWith(".md")).length,
    }).toEqual({
      observation: "canon-consistency-1",
      provenance: "generated",
      hasLegacyStatus: false,
      chapterFiles: 1,
    });
  });

  it("keeps the chapter persistable when state review is unavailable", async () => {
    const root = await tempRoot();
    const bookDir = join(root, "works", "novel", "source");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await createInitialRuntimeState({ bookDir, language: "en" });
    const output = chapterOutput(2);

    const result = await validateChapterTruthPersistence({
      writer: { settleChapterState: async () => output },
      validator: { validate: async () => { throw new Error("validator unavailable"); } },
      book: {
        id: "novel",
        title: "Novel",
        genre: "general",
        platform: "other",
        status: "active",
        targetChapters: 10,
        chapterWordCount: 1000,
        language: "en",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      bookDir,
      chapterNumber: 2,
      title: output.title,
      content: output.content,
      persistenceOutput: output,
      previousTruth: { oldState: "state-v1", oldHooks: "hooks-v1" },
      reducedControlInput: {
        chapterIntent: "Review chapter 2 state.",
        contextPackage: { chapter: 2, selectedContext: [] },
      },
      language: "en",
      logWarn: () => undefined,
    });

    expect({
      content: result.persistenceOutput.content,
      category: result.validation.warnings[0]?.category,
      needsReconciliation: result.validation.reconciliationRequired,
      stateApplied: result.persistenceOutput.runtimeStateApplied,
    }).toEqual({
      content: output.content,
      category: "state-validation-unavailable",
      needsReconciliation: true,
      stateApplied: false,
    });
  });

  it("keeps the chapter persistable when review observation is unavailable", async () => {
    const output = chapterOutput(3);
    const result = await reviewChapterDraft({
      book: { genre: "other" },
      bookDir: "/tmp/unused",
      chapterNumber: 3,
      output,
      controlInput: { contextPackage: { chapter: 3, selectedContext: [] } },
      lengthSpec: buildLengthSpec(9, "en"),
      initialUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      auditor: { auditChapter: async () => { throw new Error("review stream idle"); } },
      assertNotEmpty: () => undefined,
      addUsage: (left) => left,
    });
    expect({
      content: result.content,
      observation: result.review.issues[0]?.category,
      unavailable: result.review.unavailable,
    }).toEqual({
      content: output.content,
      observation: "review-unavailable",
      unavailable: true,
    });
  });

  it("keeps failed output as a candidate until an authorized action accepts it", async () => {
    const root = await tempRoot();
    const work = createWorkManifest({ id: "novel", title: "Novel", profileId: "longform-novel", language: "en" });
    await saveWorkManifest(root, work);
    const sourceDir = join(root, "works", "novel", "source");
    await mkdir(join(sourceDir, "chapters"), { recursive: true });
    await writeFile(join(sourceDir, "chapters", "0001_opening.md"), "# Chapter 1\n\nDraft one.\n");

    await syncWorkSourceArtifacts({ projectRoot: root, workId: "novel", episodeId: "episode-failed", accept: false });
    const candidate = await loadWorkManifest(root, "novel");
    const artifact = candidate.artifacts[0]!;
    expect({ current: artifact.currentRevisionId, statuses: artifact.revisions.map((revision) => revision.status) }).toEqual({
      current: null,
      statuses: ["candidate"],
    });

    await syncWorkSourceArtifacts({ projectRoot: root, workId: "novel", episodeId: "episode-success", accept: true });
    const accepted = await loadWorkManifest(root, "novel");
    const acceptedArtifact = accepted.artifacts.find((item) => item.id === artifact.id)!;
    expect({
      current: acceptedArtifact.currentRevisionId,
      status: acceptedArtifact.revisions.find((revision) => revision.id === acceptedArtifact.currentRevisionId)?.status,
    }).toEqual({ current: acceptedArtifact.revisions[0]?.id, status: "current" });
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-longform-harness-"));
    roots.push(root);
    return root;
  }
});

function chapterOutput(chapterNumber: number): WriteChapterOutput {
  const chapterSummary = {
    chapter: chapterNumber,
    title: `Chapter ${chapterNumber}`,
    characters: "witness",
    events: "The witness leaves.",
    stateChanges: "The witness is outside.",
    hookActivity: "",
    mood: "tense",
    chapterType: "investigation",
  };
  return {
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    content: "The witness closes the ledger and leaves the room.",
    wordCount: 9,
    postSettlement: "",
    runtimeStateDelta: {
      chapter: chapterNumber,
      factOps: {
        upsert: [{ subject: "witness", predicate: "location", object: "outside" }],
        expire: [],
      },
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      newHookCandidates: [],
      chapterSummary,
    },
    runtimeStateSnapshot: {
      manifest: {
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: chapterNumber,
        projectionVersion: 1,
      },
      currentState: {
        chapter: chapterNumber,
        facts: [{
          subject: "witness",
          predicate: "location",
          object: "outside",
          validFromChapter: chapterNumber,
          validUntilChapter: null,
          sourceChapter: chapterNumber,
        }],
      },
      hooks: { hooks: [] },
      chapterSummaries: { rows: [chapterSummary] },
    },
    updatedState: "# Current State\n\nThe witness has left.\n",
    updatedHooks: "# Pending Hooks\n",
    updatedChapterSummaries: `| ${chapterNumber} | witness leaves |`,
    runtimeStateApplied: true,
  };
}
