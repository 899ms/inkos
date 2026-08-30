import { Type } from "@sinclair/typebox";

export const ChapterReviewToolSchema = Type.Object({
  issues: Type.Array(Type.Object({
    severity: Type.Union([
      Type.Literal("critical"),
      Type.Literal("warning"),
      Type.Literal("info"),
    ]),
    repairScope: Type.Optional(Type.Union([
      Type.Literal("local"),
      Type.Literal("structural"),
      Type.Literal("unknown"),
    ])),
    category: Type.String(),
    description: Type.String(),
    suggestion: Type.String(),
  })),
  summary: Type.String(),
});
