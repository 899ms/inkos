import { describe, expect, it } from "vitest";
import { createBuiltInWorkProfileRegistry } from "../harness/index.js";
import {
  mergeActivatedSkillGuidance,
  resolveProfileSkillActivations,
} from "../skills/activations.js";
import type { AgentSkill } from "../skills/types.js";

function skill(id: string, source: AgentSkill["source"] = "builtin"): AgentSkill {
  return { id, name: id, description: `${id} description`, body: `${id} method`, source };
}

describe("profile Skill activations", () => {
  it("derives professional defaults from each Work Profile", () => {
    const profiles = createBuiltInWorkProfileRegistry();
    const available = [
      skill("inkos-long-writing"),
      skill("inkos-story-review"),
      skill("inkos-short-writing"),
      skill("inkos-play-world"),
    ];

    expect(resolveProfileSkillActivations(available, profiles.require("longform-novel"))
      .map((item) => item.skill.id)).toEqual(["inkos-long-writing"]);
    expect(resolveProfileSkillActivations(
      available,
      profiles.require("longform-novel"),
      { includeRecommended: true },
    ).map((item) => item.skill.id)).toEqual(["inkos-long-writing", "inkos-story-review"]);
    expect(resolveProfileSkillActivations(available, profiles.require("short-fiction"))
      .map((item) => item.skill.id)).toEqual(["inkos-short-writing"]);
    expect(resolveProfileSkillActivations(available, profiles.require("interactive-world"))
      .map((item) => item.skill.id)).toEqual(["inkos-play-world"]);
  });

  it("uses the latest project replacement and merges explicit Skills without duplicates", () => {
    const profiles = createBuiltInWorkProfileRegistry();
    const replacement = skill("inkos-play-world", "project");
    const defaults = resolveProfileSkillActivations(
      [skill("inkos-play-world"), replacement],
      profiles.require("interactive-world"),
    );
    const explicit = [{ skill: skill("detective-evidence", "project"), resources: [] }];

    expect(mergeActivatedSkillGuidance(defaults, explicit)).toEqual([
      { skill: replacement, resources: [] },
      explicit[0],
    ]);
  });
});
