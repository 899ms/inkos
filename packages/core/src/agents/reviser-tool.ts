import { Type } from "@sinclair/typebox";

export const ChapterRewriteToolSchema = Type.Object({
  fixedIssues: Type.Array(Type.String()),
  revisedContent: Type.String({ description: "Complete revised chapter prose." }),
});

export const ChapterSpotFixToolSchema = Type.Object({
  fixedIssues: Type.Array(Type.String()),
  patches: Type.Array(Type.Object({
    targetText: Type.String({ description: "Exact, uniquely matching text copied from the original chapter." }),
    replacementText: Type.String({ description: "Replacement text for this local patch." }),
  })),
});
