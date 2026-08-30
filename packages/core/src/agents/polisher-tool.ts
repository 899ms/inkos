import { Type } from "@sinclair/typebox";

export const PolishedChapterToolSchema = Type.Object({
  polishedContent: Type.String({ description: "Complete polished chapter prose." }),
});
