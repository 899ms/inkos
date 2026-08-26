import { z } from "zod";

export const HARNESS_VERSION = 2 as const;

export const HarnessIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "ID must be filesystem-safe");

const UNSAFE_RESOURCE_ID_RE = /[\u0000-\u001f\u007f/\\:*?"'`{}<>|]/u;

export const WorkResourceIdSchema = z.string()
  .min(1)
  .max(120)
  .refine((value) => value.trim() === value, "Resource ID must not have surrounding whitespace")
  .refine((value) => value !== "." && value !== ".." && !value.includes(".."), "Resource ID cannot traverse directories")
  .refine((value) => !UNSAFE_RESOURCE_ID_RE.test(value), "Resource ID contains unsafe path characters");

export const RelativeArtifactPathSchema = z.string()
  .min(1)
  .refine((value) => (
    !value.startsWith("/")
    && !value.startsWith("\\")
    && !/^[a-z]:[\\/]/i.test(value)
    && !value.split(/[\\/]+/).includes("..")
  ), "Artifact paths must stay inside the work directory");

export const WorkLineageSchema = z.object({
  relation: HarnessIdSchema,
  sourceWorkId: WorkResourceIdSchema,
  sourceArtifactId: WorkResourceIdSchema.optional(),
}).strict();
export type WorkLineage = z.infer<typeof WorkLineageSchema>;

export const ArtifactRevisionStatusSchema = z.enum(["candidate", "accepted", "rejected"]);
export type ArtifactRevisionStatus = z.infer<typeof ArtifactRevisionStatusSchema>;

export const ArtifactRevisionSchema = z.object({
  id: HarnessIdSchema,
  parentRevisionId: HarnessIdSchema.nullable().default(null),
  path: RelativeArtifactPathSchema,
  contentType: z.string().min(1),
  status: ArtifactRevisionStatusSchema,
  checksum: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  episodeId: HarnessIdSchema.optional(),
  createdAt: z.string().min(1),
}).strict();
export type ArtifactRevision = z.infer<typeof ArtifactRevisionSchema>;

export const ArtifactManifestSchema = z.object({
  id: WorkResourceIdSchema,
  kind: HarnessIdSchema,
  currentRevisionId: HarnessIdSchema.nullable().default(null),
  revisions: z.array(ArtifactRevisionSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((artifact, context) => {
  const revisionIds = new Set(artifact.revisions.map((revision) => revision.id));
  if (artifact.currentRevisionId !== null && !revisionIds.has(artifact.currentRevisionId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currentRevisionId"],
      message: "currentRevisionId must reference a known revision",
    });
  }
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export const WorkManifestSchema = z.object({
  version: z.literal(HARNESS_VERSION),
  id: WorkResourceIdSchema,
  title: z.string().min(1),
  profileId: HarnessIdSchema,
  language: z.string().min(1),
  status: z.enum(["draft", "active", "archived"]).default("active"),
  lineage: z.array(WorkLineageSchema).default([]),
  artifacts: z.array(ArtifactManifestSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type WorkManifest = z.infer<typeof WorkManifestSchema>;

export const ConfirmationPolicySchema = z.object({
  inferredMutation: z.enum(["execute", "confirm"]).default("confirm"),
  explicitRecoverableMutation: z.enum(["execute", "confirm"]).default("execute"),
  destructiveMutation: z.literal("confirm").default("confirm"),
}).strict();
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;

export const WorkProfileSchema = z.object({
  version: z.literal(HARNESS_VERSION),
  id: HarnessIdSchema,
  title: z.string().min(1),
  description: z.string().default(""),
  capabilityIds: z.array(HarnessIdSchema).min(1),
  requiredSkillIds: z.array(HarnessIdSchema).default([]),
  recommendedSkillIds: z.array(HarnessIdSchema).default([]),
  contextRecipes: z.record(HarnessIdSchema, HarnessIdSchema).default({}),
  artifactKinds: z.array(HarnessIdSchema).default([]),
  hardGates: z.array(HarnessIdSchema).default([]),
  softCriteria: z.array(HarnessIdSchema).default([]),
  confirmation: ConfirmationPolicySchema.default({
    inferredMutation: "confirm",
    explicitRecoverableMutation: "execute",
    destructiveMutation: "confirm",
  }),
}).strict();
export type WorkProfile = z.infer<typeof WorkProfileSchema>;

export const ActionRiskSchema = z.enum(["read", "recoverable-write", "destructive-write"]);
export type ActionRisk = z.infer<typeof ActionRiskSchema>;

export const ActionArtifactRefSchema = z.object({
  workId: WorkResourceIdSchema,
  artifactId: WorkResourceIdSchema,
  revisionId: HarnessIdSchema.optional(),
  path: RelativeArtifactPathSchema.optional(),
}).strict();
export type ActionArtifactRef = z.infer<typeof ActionArtifactRefSchema>;

export const ActionObservationSchema = z.object({
  code: HarnessIdSchema,
  kind: z.enum(["hard", "soft"]),
  status: z.enum(["pass", "warning", "fail"]),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
}).strict();
export type ActionObservation = z.infer<typeof ActionObservationSchema>;

export const ActionResultSchema = z.object({
  status: z.enum(["success", "warning", "error"]),
  summary: z.string().min(1),
  nextActions: z.array(HarnessIdSchema).default([]),
  artifacts: z.array(ActionArtifactRefSchema).default([]),
  observations: z.array(ActionObservationSchema).default([]),
  retry: z.object({
    allowed: z.boolean(),
    reason: z.string().optional(),
  }).strict().optional(),
  data: z.unknown().optional(),
}).strict();
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const EpisodeStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
export type EpisodeStatus = z.infer<typeof EpisodeStatusSchema>;

export const CreativeEpisodeSchema = z.object({
  version: z.literal(HARNESS_VERSION),
  id: HarnessIdSchema,
  workId: HarnessIdSchema.nullable().default(null),
  profileId: HarnessIdSchema.nullable().default(null),
  status: EpisodeStatusSchema,
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).nullable().default(null),
}).strict();
export type CreativeEpisode = z.infer<typeof CreativeEpisodeSchema>;

export const CreativeEpisodeEventSchema = z.object({
  version: z.literal(HARNESS_VERSION),
  episodeId: HarnessIdSchema,
  seq: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  type: HarnessIdSchema,
  workId: HarnessIdSchema.nullable().default(null),
  capabilityId: HarnessIdSchema.optional(),
  actionId: HarnessIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CreativeEpisodeEvent = z.infer<typeof CreativeEpisodeEventSchema>;
