import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import type { WorkProfile } from "../harness/contracts.js";
import type { AgentSkill } from "./types.js";

export function resolveProfileSkillActivations(
  availableSkills: ReadonlyArray<AgentSkill>,
  profile: WorkProfile,
  options: { readonly includeRecommended?: boolean } = {},
): ActivatedSkillGuidance[] {
  const byId = new Map(availableSkills.map((skill) => [skill.id, skill]));
  const missingRequired = profile.requiredSkillIds.filter((id) => !byId.has(id));
  if (missingRequired.length > 0) {
    throw new Error(
      `Profile "${profile.id}" requires unavailable skill(s): ${missingRequired.join(", ")}`,
    );
  }
  const ids = options.includeRecommended
    ? [...profile.requiredSkillIds, ...profile.recommendedSkillIds]
    : profile.requiredSkillIds;
  return [...new Set(ids)].flatMap((id) => {
    const skill = byId.get(id);
    return skill ? [{ skill, resources: [] }] : [];
  });
}

export function mergeActivatedSkillGuidance(
  ...groups: ReadonlyArray<ReadonlyArray<ActivatedSkillGuidance>>
): ActivatedSkillGuidance[] {
  const merged = new Map<string, ActivatedSkillGuidance>();
  for (const group of groups) {
    for (const activation of group) merged.set(activation.skill.id, activation);
  }
  return [...merged.values()];
}

export function activatedSkillIds(
  activations: ReadonlyArray<ActivatedSkillGuidance>,
): string[] {
  return activations.map((activation) => activation.skill.id);
}
