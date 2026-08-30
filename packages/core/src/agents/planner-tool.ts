import { Type } from "@sinclair/typebox";

export const ChapterMemoToolSchema = Type.Object({
  goal: Type.String({ description: "One concrete goal for the chapter." }),
  body: Type.String({ description: "Complete readable Markdown chapter plan." }),
  threadRefs: Type.Array(Type.String({ description: "An existing thread or hook id from the supplied context." })),
});
