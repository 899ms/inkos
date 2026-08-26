import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  ActionResultSchema,
  ArtifactManifestSchema,
  CapabilityRegistry,
  createCapabilityPiTools,
  defineCapabilityAction,
  CreativeEpisodeStore,
  WorkProfileRegistry,
  WorkProfileSchema,
  createWorkManifest,
  loadWorkManifest,
  promoteArtifactRevision,
  saveWorkManifest,
  stageArtifactRevision,
  workManifestPath,
  type Capability,
} from "../harness/index.js";

describe("v2 harness contracts", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rejects an artifact whose accepted revision pointer is unknown", () => {
    expect(() => ArtifactManifestSchema.parse({
      id: "chapter-1",
      kind: "chapter",
      currentRevisionId: "missing",
      revisions: [],
      metadata: {},
    })).toThrow(/currentRevisionId/);
  });

  it("persists a work manifest atomically under works/<id>/work.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-work-"));
    roots.push(root);
    const manifest = createWorkManifest({
      id: "night-train",
      title: "夜班列车",
      profileId: "longform-novel",
      language: "zh",
      now: "2026-08-26T00:00:00.000Z",
    });

    await saveWorkManifest(root, manifest);

    expect(await loadWorkManifest(root, "night-train")).toEqual(manifest);
    expect(JSON.parse(await readFile(workManifestPath(root, "night-train"), "utf-8"))).toEqual(manifest);
  });

  it("supports safe Unicode work ids without allowing path traversal", () => {
    expect(createWorkManifest({
      id: "夜班列车",
      title: "夜班列车",
      profileId: "longform-novel",
      language: "zh",
    }).id).toBe("夜班列车");
    expect(() => createWorkManifest({
      id: "../夜班列车",
      title: "Unsafe",
      profileId: "longform-novel",
      language: "zh",
    })).toThrow(/Resource ID/);
  });

  it("binds open profiles to registered capabilities without session-kind branching", async () => {
    const registry = new CapabilityRegistry();
    const capability: Capability = {
      id: "longform",
      title: "Long-form writing",
      description: "Plan and write long works.",
      actions: [defineCapabilityAction({
        id: "draft",
        title: "Draft",
        description: "Draft an artifact revision.",
        risk: "recoverable-write",
        parameters: Type.Object({ instruction: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        async execute(_context, input) {
          const { instruction } = input;
          return ActionResultSchema.parse({
            status: "success",
            summary: `Drafted: ${instruction}`,
            nextActions: ["review"],
            artifacts: [],
            observations: [],
          });
        },
      })],
    };
    registry.register(capability);
    const profile = WorkProfileSchema.parse({
      version: 2,
      id: "longform-novel",
      title: "Long-form novel",
      capabilityIds: ["longform"],
    });
    const work = createWorkManifest({
      id: "demo",
      title: "Demo",
      profileId: profile.id,
      language: "en",
    });

    expect(registry.forProfile(profile).map((item) => item.id)).toEqual(["longform"]);
    await expect(registry.invoke("longform", "draft", {
      projectRoot: "/tmp/demo",
      episodeId: "episode-1",
      work,
      profile,
    }, { instruction: "chapter one" })).resolves.toMatchObject({
      status: "success",
      summary: "Drafted: chapter one",
      nextActions: ["review"],
    });
  });

  it("rejects duplicate capability and action ids", () => {
    const registry = new CapabilityRegistry();
    const action = {
      id: "read",
      title: "Read",
      description: "Read.",
      risk: "read" as const,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return ActionResultSchema.parse({ status: "success", summary: "ok" });
      },
    };
    registry.register({ id: "workspace", title: "Workspace", description: "", actions: [action] });
    expect(() => registry.register({ id: "workspace", title: "Workspace", description: "", actions: [action] }))
      .toThrow(/already registered/);
    expect(() => new CapabilityRegistry().register({
      id: "broken",
      title: "Broken",
      description: "",
      actions: [action, action],
    })).toThrow(/Duplicate action/);
  });

  it("keeps append-only episode events in strict sequence", () => {
    const store = new CreativeEpisodeStore(":memory:");
    try {
      store.create({
        version: 2,
        id: "episode-1",
        workId: "demo",
        profileId: "longform-novel",
        status: "running",
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: null,
      });
      store.append({
        episodeId: "episode-1",
        workId: "demo",
        type: "action-started",
        capabilityId: "longform",
        actionId: "draft",
        payload: { instruction: "chapter one" },
      }, "2026-08-26T00:00:01.000Z");
      store.append({
        episodeId: "episode-1",
        workId: "demo",
        type: "action-completed",
        capabilityId: "longform",
        actionId: "draft",
        payload: { status: "success" },
      }, "2026-08-26T00:00:02.000Z");

      expect(store.listEvents("episode-1").map((event) => [event.seq, event.type])).toEqual([
        [0, "action-started"],
        [1, "action-completed"],
      ]);
      expect(store.finish("episode-1", "completed", "2026-08-26T00:00:03.000Z").status).toBe("completed");
      expect(() => store.finish("episode-1", "failed")).toThrow(/already terminal/);
    } finally {
      store.close();
    }
  });

  it("stores candidate revisions separately and promotes them explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-revision-"));
    roots.push(root);
    const work = createWorkManifest({
      id: "revision-demo",
      title: "Revision Demo",
      profileId: "longform-novel",
      language: "en",
      now: "2026-08-26T00:00:00.000Z",
    });
    await saveWorkManifest(root, work);

    const staged = await stageArtifactRevision({
      projectRoot: root,
      manifest: work,
      artifactId: "chapter-1",
      artifactKind: "chapter",
      revisionId: "revision-1",
      content: "# Chapter One\n\nDraft.",
      contentType: "text/markdown",
      fileName: "chapter.md",
      episodeId: "episode-1",
      createdAt: "2026-08-26T00:00:01.000Z",
    });

    expect(staged.revision.status).toBe("candidate");
    expect(staged.manifest.artifacts[0]?.currentRevisionId).toBeNull();
    await expect(access(join(root, "works", "revision-demo", staged.revision.path))).resolves.toBeUndefined();

    const promoted = await promoteArtifactRevision({
      projectRoot: root,
      manifest: staged.manifest,
      artifactId: "chapter-1",
      revisionId: "revision-1",
      updatedAt: "2026-08-26T00:00:02.000Z",
    });
    expect(promoted.artifacts[0]?.currentRevisionId).toBe("revision-1");
    expect(promoted.artifacts[0]?.revisions[0]?.status).toBe("accepted");
  });

  it("registers open work profiles without a central type enum", () => {
    const profiles = new WorkProfileRegistry();
    profiles.register(WorkProfileSchema.parse({
      version: 2,
      id: "custom-radio-drama",
      title: "Radio drama",
      capabilityIds: ["adaptation", "single-pass"],
    }));
    expect(profiles.require("custom-radio-drama").capabilityIds).toEqual(["adaptation", "single-pass"]);
    expect(() => profiles.register(profiles.require("custom-radio-drama"))).toThrow(/already registered/);
  });

  it("adapts registered capability actions directly into Pi tools", async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "workspace",
      title: "Workspace",
      description: "Workspace actions.",
      actions: [defineCapabilityAction({
        id: "inspect",
        title: "Inspect",
        description: "Inspect the active work.",
        risk: "read",
        parameters: Type.Object({ topic: Type.String() }, { additionalProperties: false }),
        async execute(_context, input) {
          return ActionResultSchema.parse({
            status: "success",
            summary: `Inspected ${input.topic}`,
            artifacts: [],
            observations: [],
            nextActions: [],
            data: { kind: "inspection", topic: input.topic },
          });
        },
      })],
    });
    const profile = WorkProfileSchema.parse({
      version: 2,
      id: "workspace-default",
      title: "Workspace",
      capabilityIds: ["workspace"],
    });
    const tools = createCapabilityPiTools({
      registry,
      profile,
      executeAction: (capabilityId, actionId, parameters, signal) => registry.invoke(
        capabilityId,
        actionId,
        {
          projectRoot: "/tmp/demo",
          episodeId: "episode-1",
          work: null,
          profile,
          signal,
        },
        parameters,
      ),
    });

    expect(tools.map((tool) => tool.name)).toEqual(["workspace__inspect"]);
    await expect(tools[0]!.execute("call-1", { topic: "outline" }))
      .resolves.toMatchObject({
        content: [{ type: "text", text: "Inspected outline" }],
        details: { kind: "inspection", topic: "outline" },
      });
  });
});
