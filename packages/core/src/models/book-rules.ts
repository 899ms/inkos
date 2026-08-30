import { z } from "zod";

const ProtagonistSchema = z.object({
  name: z.string(),
  personalityLock: z.array(z.string()),
  behavioralConstraints: z.array(z.string()),
}).strict().optional();

const GenreLockSchema = z.object({
  primary: z.string(),
  forbidden: z.array(z.string()),
}).strict().optional();

const NumericalOverridesSchema = z.object({
  hardCap: z.union([z.number(), z.string()]).optional(),
  resourceTypes: z.array(z.string()),
}).strict().optional();

const EraConstraintsSchema = z.object({
  enabled: z.boolean(),
  period: z.string().optional(),
  region: z.string().optional(),
}).strict().optional();

export const BookRulesSchema = z.object({
  version: z.literal("2"),
  protagonist: ProtagonistSchema,
  genreLock: GenreLockSchema,
  narrativePerson: z.enum(["first", "third"]).optional(),
  numericalSystemOverrides: NumericalOverridesSchema,
  eraConstraints: EraConstraintsSchema,
  prohibitions: z.array(z.string()),
  enableFullCastTracking: z.boolean(),
  fanficMode: z.enum(["canon", "au", "ooc", "cp"]).optional(),
  allowedDeviations: z.array(z.string()),
}).strict();

export type BookRules = z.infer<typeof BookRulesSchema>;

export interface ParsedBookRules {
  readonly rules: BookRules;
  readonly body: string;
}
