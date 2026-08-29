import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";
import { ObservationSchema } from "./observation.js";

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  wordCount: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  observations: z.array(ObservationSchema).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  provenance: z.enum(["generated", "imported", "edited"]).default("generated"),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
