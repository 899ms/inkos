import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import type { WorkProfile } from "../harness/contracts.js";
import type { AgentSkill, SkillResolutionResult } from "./types.js";

export function applyRequiredProfileSkills(
  resolution: SkillResolutionResult,
  profile: WorkProfile,
): SkillResolutionResult {
  const required = resolveProfileSkillActivations(resolution.availableSkills, profile);
  const used = new Map<string, AgentSkill>();
  for (const activation of required) used.set(activation.skill.id, activation.skill);
  for (const skill of resolution.usedSkills) used.set(skill.id, skill);
  return {
    ...resolution,
    usedSkills: [...used.values()],
    forcedSkillIds: [...new Set([...profile.requiredSkillIds, ...resolution.forcedSkillIds])],
  };
}

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
