import { Type } from "@sinclair/typebox";

export const ShortOutlineToolSchema = Type.Object({
  storyTitle: Type.String({ minLength: 1 }),
  planMarkdown: Type.String({ minLength: 1 }),
});

export const ShortDraftBatchToolSchema = Type.Object({
  storyTitle: Type.String({ minLength: 1 }),
  openingHook: Type.Optional(Type.String()),
  chapters: Type.Array(Type.Object({
    number: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, description: "Chapter title only; do not include a chapter number or heading prefix." }),
    content: Type.String({ minLength: 1 }),
  })),
});

export const ShortPackageToolSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  intro: Type.String({ minLength: 1 }),
  sellingPoints: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  coverPrompt: Type.String({ minLength: 1 }),
});
