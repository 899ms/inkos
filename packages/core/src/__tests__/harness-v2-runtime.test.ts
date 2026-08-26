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
    episodes.close();
  });

  it("allows explicit recoverable writes but always confirms destructive writes", async () => {
    const profiles = createBuiltInWorkProfileRegistry();
    const profile = profiles.require("longform-novel");
    expect(profile.confirmation).toEqual({
      inferredMutation: "confirm",
      explicitRecoverableMutation: "execute",
      destructiveMutation: "confirm",
    });
  });
});

