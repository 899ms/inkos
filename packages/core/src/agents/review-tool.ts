import { Type } from "@sinclair/typebox";

export const ChapterReviewToolSchema = Type.Object({
  issues: Type.Array(Type.Object({
    code: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("hard"), Type.Literal("soft")]),
    summary: Type.String({ minLength: 1 }),
    evidence: Type.Array(Type.String({ minLength: 1 })),
  })),
  summary: Type.String(),
});
