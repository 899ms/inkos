import { z } from "zod";

export const ObservationSchema = z.object({
  code: z.string().min(1),
  kind: z.enum(["hard", "soft"]),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
}).strict();

export type Observation = z.infer<typeof ObservationSchema>;

export function createRangeObservation(input: {
  readonly code: string;
  readonly actual: number;
  readonly target: number;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly evidence?: string;
}): Observation | null {
  if (input.actual >= input.min && input.actual <= input.max) return null;
  return ObservationSchema.parse({
    code: input.code,
    kind: "soft",
    summary: `${input.actual} ${input.unit}; target ${input.target}, range ${input.min}-${input.max}`,
    evidence: input.evidence ? [input.evidence] : [],
  });
}
