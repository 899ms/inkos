import { Type } from "@sinclair/typebox";

export const ObservationToolSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  evidence: Type.Array(Type.String({ minLength: 1 })),
});

export const ChapterReviewToolSchema = Type.Object({
  observations: Type.Array(ObservationToolSchema),
  summary: Type.String(),
});
