import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { persistChapterArtifacts } from "../pipeline/chapter-persistence.js";
import { validateChapterTruthPersistence } from "../pipeline/chapter-truth-validation.js";
import { StateManager } from "../state/manager.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";

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
      lengthWarnings: [],
      loadChapterIndex: () => state.loadChapterIndex("novel"),
      saveChapter: () => writer.saveChapter(bookDir, output, false, "en"),
      saveTruthFiles: async () => undefined,
      saveChapterIndex: (index) => state.saveChapterIndex("novel", index),
      markBookActiveIfNeeded: async () => undefined,
      snapshotState: async () => undefined,
      syncCurrentStateFactHistory: async () => undefined,
      logSnapshotStage: () => undefined,
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

  it("stops before persistence when derived story state cannot be validated", async () => {
    const root = await tempRoot();
    const bookDir = join(root, "works", "novel", "source");
    await mkdir(join(bookDir, "story"), { recursive: true });
    const output = chapterOutput(2);

    await expect(validateChapterTruthPersistence({
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
      previousTruth: { oldState: "state-v1", oldHooks: "hooks-v1", oldLedger: "" },
      language: "en",
      logWarn: () => undefined,
    })).rejects.toThrow("Chapter state validation unavailable");

    expect(await readdir(join(bookDir, "chapters")).catch(() => [])).toEqual([]);
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
    }).toEqual({ current: acceptedArtifact.revisions[0]?.id, status: "accepted" });
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-longform-harness-"));
    roots.push(root);
    return root;
  }
});

function chapterOutput(chapterNumber: number): WriteChapterOutput {
  return {
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    content: "The witness closes the ledger and leaves the room.",
    wordCount: 9,
    preWriteCheck: "",
    postSettlement: "",
    updatedState: "# Current State\n\nThe witness has left.\n",
    updatedLedger: "",
    updatedHooks: "# Pending Hooks\n",
    chapterSummary: `| ${chapterNumber} | witness leaves |`,
    updatedSubplots: "",
    updatedEmotionalArcs: "",
    updatedCharacterMatrix: "",
    postWriteErrors: [],
    postWriteWarnings: [],
  };
}
