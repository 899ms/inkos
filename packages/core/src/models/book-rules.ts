import { z } from "zod";

const ProtagonistSchema = z.object({
  name: z.string(),
  personalityLock: z.array(z.string()).default([]),
  behavioralConstraints: z.array(z.string()).default([]),
}).optional();

const GenreLockSchema = z.object({
  primary: z.string(),
  forbidden: z.array(z.string()).default([]),
}).optional();

const NumericalOverridesSchema = z.object({
  hardCap: z.union([z.number(), z.string()]).optional(),
  resourceTypes: z.array(z.string()).default([]),
}).optional();

const EraConstraintsSchema = z.object({
  enabled: z.boolean().default(false),
  period: z.string().optional(),
  region: z.string().optional(),
}).optional();

export const BookRulesSchema = z.object({
  version: z.string().default("1.0"),
  protagonist: ProtagonistSchema,
  genreLock: GenreLockSchema,
  // Narrative person, set ONLY when the user explicitly asked for one. Lenient:
  // a stray/placeholder value degrades to undefined rather than breaking the
  // whole book_rules parse (fail-open).
  narrativePerson: z.enum(["first", "third"]).optional().catch(undefined),
  numericalSystemOverrides: NumericalOverridesSchema,
  eraConstraints: EraConstraintsSchema,
  prohibitions: z.array(z.string()).default([]),
  enableFullCastTracking: z.boolean().default(false),
  fanficMode: z.enum(["canon", "au", "ooc", "cp"]).optional(),
  allowedDeviations: z.array(z.string()).default([]),
});

export type BookRules = z.infer<typeof BookRulesSchema>;

export interface ParsedBookRules {
  readonly rules: BookRules;
  readonly body: string;
}
