import { Type } from "@sinclair/typebox";
import { StoryGraphContentToolSchema } from "../interactive-film/tool-schemas.js";

export const StoryboardPackageToolSchema = Type.Object({
  storyboard: Type.String({ minLength: 1 }),
  imagePrompts: Type.Array(
    Type.String({ minLength: 1, description: "One generation-ready image prompt for a storyboard shot." }),
    { minItems: 1 },
  ),
});

export const InteractiveFilmPackageToolSchema = Type.Object({
  storyTree: Type.String(),
  flags: Type.String(),
  script: Type.String(),
  storyboard: Type.String(),
  imagePrompts: Type.Array(Type.String()),
  storyGraph: StoryGraphContentToolSchema,
});
