import { describe, expect, it } from "vitest";
import {
  buildHarnessSystemPrompt,
  createBuiltInWorkProfileRegistry,
  createWorkManifest,
} from "../harness/index.js";

describe("harness system prompt", () => {
  it("describes one profile/action boundary instead of mode-specific pipelines", () => {
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    const work = createWorkManifest({
      id: "night-ledger",
      title: "Night Ledger",
      profileId: profile.id,
      language: "en",
    });
    const prompt = buildHarnessSystemPrompt({ profile, work, language: "en" });

    expect(prompt).toContain("InkOS text-creation harness");
    expect(prompt).toContain("Night Ledger (night-ledger");
    expect(prompt).toContain("Only capability actions can cause side effects");
    expect(prompt).toContain("preserve every constraint the user already confirmed");
    expect(prompt).toContain("Present only the effective result");
    expect(prompt).not.toContain("short_fiction_run");
    expect(prompt).not.toContain("agent=\"writer\"");
  });

  it("tells a confirmed turn to invoke the matching action without reconfirming", () => {
    const profile = createBuiltInWorkProfileRegistry().require("short-fiction");
    const prompt = buildHarnessSystemPrompt({
      profile,
      work: null,
      language: "zh",
      confirmedAction: "short_run",
    });

    expect(prompt).toContain("本轮动作已由宿主确认：short_run");
    expect(prompt).toContain("不要再次确认");
    expect(prompt).toContain("完整继承本会话里用户已经明确的全部约束");
  });

  it("inlines forced Skill guidance and exposes other Skills only as selection metadata", () => {
    const profile = createBuiltInWorkProfileRegistry().require("workspace-default");
    const prompt = buildHarnessSystemPrompt({
      profile,
      work: null,
      language: "zh",
      allowIntentSkillSelection: true,
      skills: {
        usedSkills: [{
          id: "forced-craft",
          name: "Forced Craft",
          description: "A required craft method.",
          body: "Preserve the user's ending.",
          source: "project",
        }],
        forcedSkillIds: ["forced-craft"],
        missingSkillIds: [],
        disabledSkillIds: [],
        availableSkills: [
          {
            id: "forced-craft",
            name: "Forced Craft",
            description: "A required craft method.",
            body: "Preserve the user's ending.",
            source: "project",
          },
          {
            id: "optional-review",
            name: "Optional Review",
            description: "Review when needed.",
            body: "",
            source: "builtin",
          },
        ],
        availableSkillIds: ["forced-craft", "optional-review"],
      },
    });

    expect(prompt).toContain("forced-craft (强制)");
    expect(prompt).toContain("Preserve the user's ending.");
    expect(prompt).toContain('"id":"optional-review"');
  });
});
