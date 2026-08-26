import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { commitAtomicFileSet } from "../../utils/atomic-file-set.js";
import { loadWorkManifest } from "../work-store.js";

const ReplaceWorkArtifactParams = Type.Object({
  path: Type.String({ description: "Exact current source/ artifact path shown by the Work inspector or read context." }),
  content: Type.String({ description: "Complete replacement text." }),
  expectedRevisionId: Type.Optional(Type.String({ description: "Optional optimistic-lock revision id from the Work manifest." })),
});

export function createReplaceWorkArtifactTool(
  projectRoot: string,
  workId: string,
): AgentTool<typeof ReplaceWorkArtifactParams> {
  return {
    name: "replace_work_artifact",
    label: "Replace Work Artifact",
    description:
      "Replace one registered text artifact in the current Work. The path must already be the accepted source/ revision; " +
      "this cannot create arbitrary files or edit binary artifacts.",
    parameters: ReplaceWorkArtifactParams,
    async execute(_toolCallId, params: Static<typeof ReplaceWorkArtifactParams>) {
      const work = await loadWorkManifest(projectRoot, workId);
      const artifact = work.artifacts.find((candidate) => candidate.revisions.some((revision) => (
        revision.id === candidate.currentRevisionId && revision.path === params.path
      )));
      const current = artifact?.revisions.find((revision) => revision.id === artifact.currentRevisionId);
      if (!artifact || !current) throw new Error(`Current Work artifact not found: ${params.path}`);
      if (!current.path.startsWith("source/")) throw new Error(`Work artifact is not editable source: ${current.path}`);
      if (!(current.contentType.startsWith("text/") || current.contentType === "application/json")) {
        throw new Error(`Work artifact is not text: ${current.path}`);
      }
      if (params.expectedRevisionId && params.expectedRevisionId !== current.id) {
        throw new Error(`Work artifact changed: expected ${params.expectedRevisionId}, current ${current.id}`);
      }
      await commitAtomicFileSet({
        rootDir: projectRoot,
        writes: [{ relativePath: `works/${workId}/${current.path}`, content: params.content }],
      });
      return {
        content: [{ type: "text", text: `Replaced ${current.path} in "${work.title}".` }],
        details: {
          kind: "work_artifact_replaced",
          workId,
          artifactId: artifact.id,
          previousRevisionId: current.id,
          path: current.path,
        },
      };
    },
  };
}
