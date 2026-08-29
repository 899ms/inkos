import { z } from "zod";

export const ObservationSchema = z.object({
  code: z.string().min(1),
  kind: z.enum(["hard", "soft"]),
  status: z.enum(["pass", "warning", "fail"]),
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
}): Observation {
  const inRange = input.actual >= input.min && input.actual <= input.max;
  return ObservationSchema.parse({
    code: input.code,
    kind: "soft",
    status: inRange ? "pass" : "warning",
    summary: `${input.actual} ${input.unit}; target ${input.target}, range ${input.min}-${input.max}`,
    evidence: input.evidence ? [input.evidence] : [],
  });
}
