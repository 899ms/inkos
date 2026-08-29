import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPromptPackPrompt,
  promptOverridePath,
} from "../prompts/index.js";

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-prompt-pack-"));
  roots.push(root);
  return root;
}

async function writePrompt(root: string, promptId: string, content: string): Promise<string> {
  const file = promptOverridePath(root, promptId);
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, content, "utf-8");
  return file;
}

describe("prompt pack loader", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("loads a structurally complete built-in prompt", async () => {
    const loaded = await loadPromptPackPrompt({ promptId: "longform.writer" });

    expect(loaded.source).toBe("builtin");
    expect(loaded.promptId).toBe("longform.writer");
    expect(loaded.content.trim().length).toBeGreaterThan(0);
  });

  it("resolves project, user, then built-in precedence as one flow", async () => {
    const projectRoot = await tempProject();
    const userRoot = await tempProject();
    const userPath = await writePrompt(userRoot, "play.renderer", "USER RENDERER");
    const projectPath = await writePrompt(projectRoot, "play.renderer", "PROJECT RENDERER");

    const project = await loadPromptPackPrompt({
      promptId: "play.renderer",
      projectRoot,
      userRoot,
    });
    await rm(projectPath);
    const user = await loadPromptPackPrompt({
      promptId: "play.renderer",
      projectRoot,
      userRoot,
    });

    expect({ project: [project.source, project.path], user: [user.source, user.path] }).toEqual({
      project: ["project", projectPath],
      user: ["user", userPath],
    });
  });

  it("throws a structured error for unknown prompts", async () => {
    await expect(loadPromptPackPrompt({ promptId: "missing.prompt" }))
      .rejects
      .toMatchObject({
        code: "PROMPT_PACK_PROMPT_NOT_FOUND",
        promptId: "missing.prompt",
      });
  });

});
