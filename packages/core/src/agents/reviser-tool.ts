import { Type } from "@sinclair/typebox";

export const ChapterRewriteToolSchema = Type.Object({
  revisedContent: Type.String({ minLength: 1, description: "Complete revised chapter prose." }),
});

export const ChapterSpotFixToolSchema = Type.Object({
  patches: Type.Array(Type.Object({
    targetText: Type.String({ minLength: 1, description: "Exact, uniquely matching text copied from the original chapter." }),
    replacementText: Type.String({ description: "Replacement text for this local patch." }),
  })),
});
