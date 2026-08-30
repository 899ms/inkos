import { z } from "zod";

export const ObservationSchema = z.object({
  code: z.string().min(1),
  kind: z.enum(["hard", "soft"]),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
}).strict();

export type Observation = z.infer<typeof ObservationSchema>;
