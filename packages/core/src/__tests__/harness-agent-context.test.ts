import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProtectedContextOverflowError,
  createBuiltInWorkProfileRegistry,
  createHarnessContextTransform,
  createWorkManifest,
  saveWorkManifest,
  workDirectory,
} from "../harness/index.js";

describe("harness agent context", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("injects only current Work identity and task-critical files without excerpting text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-harness-context-"));
    roots.push(root);
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    const work = createWorkManifest({
      id: "harbor",
      title: "Harbor",
      profileId: profile.id,
      language: "en",
    });
    await saveWorkManifest(root, work);
    const storyDir = join(workDirectory(root, work.id), "source", "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "author_intent.md"), "# Intent\n\nKeep the witness alive through volume two.");
    await writeFile(join(storyDir, "current_focus.md"), "# Focus\n\nInterrogate the forged ledger.");
    const transform = createHarnessContextTransform({
      projectRoot: root,
      work,
      profile,
      budgetTokens: 8_000,
    });

    const messages = await transform([{ role: "user", content: "What matters now?", timestamp: 1 }] as never);
    const rendered = JSON.stringify(messages);
    expect(rendered).toContain("works/harbor/work.json");
    expect(rendered).toContain("Keep the witness alive through volume two.");
    expect(rendered).toContain("Interrogate the forged ledger.");
    expect(rendered).not.toContain("truncated");
    expect(rendered).not.toContain("未全文注入");
  });

  it("fails loudly when protected context alone exceeds its budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-harness-context-overflow-"));
    roots.push(root);
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    const work = createWorkManifest({
      id: "overflow",
      title: "Overflow",
      profileId: profile.id,
      language: "zh",
    });
    await saveWorkManifest(root, work);
    const storyDir = join(workDirectory(root, work.id), "source", "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "author_intent.md"), "不可删除的约束。".repeat(1_000));
    const transform = createHarnessContextTransform({
      projectRoot: root,
      work,
      profile,
      budgetTokens: 100,
    });

    await expect(transform([{ role: "user", content: "继续", timestamp: 1 }] as never))
      .rejects.toBeInstanceOf(ProtectedContextOverflowError);
  });
});
