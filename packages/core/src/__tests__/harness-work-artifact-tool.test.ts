import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInitialWorkManifestWrite,
  createReplaceWorkArtifactTool,
  executeExplicitCapabilityTool,
  loadWorkManifest,
} from "../harness/index.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

describe("replace Work artifact capability", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("atomically replaces only an accepted text artifact and records a new revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-work-artifact-"));
    roots.push(root);
    const initial = createInitialWorkManifestWrite({
      workId: "script-work",
      title: "Script Work",
      profileId: "script",
      language: "en",
      writes: [{ relativePath: "works/script-work/source/script.md", content: "# Draft\n" }],
    });
    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "works/script-work/source/script.md", content: "# Draft\n" },
        initial.write,
      ],
    });
    const before = await loadWorkManifest(root, "script-work");
    const artifact = before.artifacts[0]!;

    const result = await executeExplicitCapabilityTool({
      projectRoot: root,
      binding: { capabilityId: "workspace", actionId: "replace_work_artifact", profileId: "script" },
      tool: createReplaceWorkArtifactTool(root, "script-work"),
      workId: "script-work",
      parameters: {
        path: "source/script.md",
        content: "# Revised\n",
        expectedRevisionId: artifact.currentRevisionId,
      },
    });

    expect(result).toMatchObject({ status: "success", data: { kind: "work_artifact_replaced" } });
    await expect(readFile(join(root, "works", "script-work", "source", "script.md"), "utf-8"))
      .resolves.toBe("# Revised\n");
    const after = await loadWorkManifest(root, "script-work");
    expect(after.artifacts[0]?.revisions).toHaveLength(2);

    await expect(createReplaceWorkArtifactTool(root, "script-work").execute("stale", {
      path: "source/script.md",
      content: "# Lost update\n",
      expectedRevisionId: artifact.currentRevisionId!,
    })).rejects.toThrow("Work artifact changed");
  });
});
