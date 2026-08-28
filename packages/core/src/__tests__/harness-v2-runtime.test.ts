import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  ActionConfirmationRequiredError,
  ActionResultSchema,
  CapabilityRegistry,
  CreativeEpisodeStore,
  CreativeHarnessRuntime,
  createBuiltInWorkProfileRegistry,
  createWorkManifest,
  defineCapabilityAction,
} from "../harness/index.js";

describe("v2 creative harness runtime", () => {
  it("applies risk confirmation structurally and records the full action lifecycle", async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register({
      id: "longform",
      title: "Long-form",
      description: "",
      actions: [
        defineCapabilityAction({
          id: "inspect",
          title: "Inspect",
          description: "Inspect the work.",
          risk: "read",
          parameters: Type.Object({}),
          async execute() {
            return ActionResultSchema.parse({ status: "success", summary: "inspected" });
          },
        }),
        defineCapabilityAction({
          id: "draft",
          title: "Draft",
          description: "Draft a revision.",
          risk: "recoverable-write",
          requiresConfirmation: true,
          parameters: Type.Object({ instruction: Type.String() }),
          async execute(_context, input) {
            return ActionResultSchema.parse({
              status: "success",
              summary: `drafted ${input.instruction}`,
            });
          },
        }),
      ],
    });
    const episodes = new CreativeEpisodeStore(":memory:");
    const profiles = createBuiltInWorkProfileRegistry();
    const runtime = new CreativeHarnessRuntime("/tmp/demo", capabilities, profiles, episodes);
    const work = createWorkManifest({
      id: "夜班列车",
      title: "夜班列车",
      profileId: "longform-novel",
      language: "zh",
    });
    const handle = runtime.startEpisode({
      episodeId: "episode-1",
      profileId: "longform-novel",
      work,
      startedAt: "2026-08-26T00:00:00.000Z",
    });

    await expect(runtime.executeAction({
      handle,
      capabilityId: "longform",
      actionId: "inspect",
      parameters: {},
      source: "agent",
    })).resolves.toMatchObject({ status: "success" });
    await expect(runtime.executeAction({
      handle,
      capabilityId: "longform",
      actionId: "draft",
      parameters: { instruction: "chapter one" },
      source: "agent",
    })).rejects.toBeInstanceOf(ActionConfirmationRequiredError);
    await expect(runtime.executeAction({
      handle,
      capabilityId: "longform",
      actionId: "draft",
      parameters: { instruction: "chapter one" },
      source: "agent",
      confirmed: true,
    })).resolves.toMatchObject({ status: "success", summary: "drafted chapter one" });
    runtime.finishEpisode(handle, "completed", "2026-08-26T00:01:00.000Z");

    expect(episodes.listEvents("episode-1").map((event) => event.type)).toEqual([
      "episode-started",
      "action-started",
      "action-completed",
      "action-confirmation-required",
      "action-started",
      "action-completed",
      "episode-completed",
    ]);
    expect(episodes.requireEpisode("episode-1").status).toBe("completed");
    expect(episodes.listEpisodes({ workId: work.id })).toEqual([
      expect.objectContaining({ id: "episode-1", status: "completed", workId: work.id }),
    ]);
    expect(episodes.listEpisodes({ status: "failed" })).toEqual([]);
    episodes.close();
  });

  it("allows explicit recoverable writes but always confirms destructive writes", async () => {
    const profiles = createBuiltInWorkProfileRegistry();
    const profile = profiles.require("longform-novel");
    expect(profile.confirmation).toEqual({
      inferredMutation: "execute",
      explicitRecoverableMutation: "execute",
      destructiveMutation: "confirm",
    });
  });

  it("binds a creation Episode to the single Work produced by its artifacts", async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register({
      id: "longform",
      title: "Long-form",
      description: "",
      actions: [defineCapabilityAction({
        id: "create",
        title: "Create",
        description: "Create a Work.",
        risk: "recoverable-write",
        parameters: Type.Object({}),
        async execute() {
          return ActionResultSchema.parse({
            status: "success",
            summary: "created",
            artifacts: [{ workId: "created-work", artifactId: "foundation" }],
          });
        },
      })],
    });
    const episodes = new CreativeEpisodeStore(":memory:");
    const runtime = new CreativeHarnessRuntime(
      "/tmp/create",
      capabilities,
      createBuiltInWorkProfileRegistry(),
      episodes,
    );
    const handle = runtime.startEpisode({
      episodeId: "episode-create",
      profileId: "longform-novel",
      startedAt: "2026-08-26T00:00:00.000Z",
    });

    await runtime.executeAction({
      handle,
      capabilityId: "longform",
      actionId: "create",
      parameters: {},
      source: "explicit",
    });
    runtime.finishEpisode(handle, "completed", "2026-08-26T00:01:00.000Z");

    expect(episodes.requireEpisode("episode-create")).toMatchObject({
      workId: "created-work",
      status: "completed",
    });
    expect(episodes.listEvents("episode-create").map((event) => [event.type, event.workId])).toEqual([
      ["episode-started", null],
      ["action-started", null],
      ["episode-work-bound", "created-work"],
      ["action-completed", "created-work"],
      ["episode-completed", "created-work"],
    ]);
    episodes.close();
  });

  it("serializes mutating actions for the same Work while preserving their order", async () => {
    const capabilities = new CapabilityRegistry();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    capabilities.register({
      id: "longform",
      title: "Long-form",
      description: "",
      actions: [defineCapabilityAction({
        id: "mutate",
        title: "Mutate",
        description: "Mutate the work.",
        risk: "recoverable-write",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_context, input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(`start:${input.id}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(`end:${input.id}`);
          active -= 1;
          return ActionResultSchema.parse({ status: "success", summary: input.id });
        },
      })],
    });
    const episodes = new CreativeEpisodeStore(":memory:");
    const profiles = createBuiltInWorkProfileRegistry();
    const runtime = new CreativeHarnessRuntime("/tmp/serialized", capabilities, profiles, episodes);
    const work = createWorkManifest({
      id: "serialized-work",
      title: "Serialized Work",
      profileId: "longform-novel",
      language: "en",
    });
    const first = runtime.startEpisode({ episodeId: "episode-serial-1", profileId: "longform-novel", work });
    const second = runtime.startEpisode({ episodeId: "episode-serial-2", profileId: "longform-novel", work });

    await Promise.all([
      runtime.executeAction({ handle: first, capabilityId: "longform", actionId: "mutate", parameters: { id: "first" }, source: "agent" }),
      runtime.executeAction({ handle: second, capabilityId: "longform", actionId: "mutate", parameters: { id: "second" }, source: "agent" }),
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    episodes.close();
  });
});
