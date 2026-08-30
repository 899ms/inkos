import { Type } from "@sinclair/typebox";

export const ShortOutlineToolSchema = Type.Object({
  storyTitle: Type.String(),
  planMarkdown: Type.String(),
});

export const ShortDraftBatchToolSchema = Type.Object({
  storyTitle: Type.Optional(Type.String()),
  openingHook: Type.Optional(Type.String()),
  chapters: Type.Array(Type.Object({
    number: Type.Integer({ minimum: 1 }),
    title: Type.String(),
    content: Type.String(),
  })),
});

export const ShortPackageToolSchema = Type.Object({
  title: Type.String(),
  intro: Type.String(),
  sellingPoints: Type.Array(Type.String()),
  coverPrompt: Type.String(),
});
