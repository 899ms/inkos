import { Type } from "@sinclair/typebox";

export const StoryboardAssetsToolSchema = Type.Object({
  imagePrompts: Type.Array(Type.String({ description: "One generation-ready image prompt for a storyboard shot." })),
});

export const InteractiveFilmPackageToolSchema = Type.Object({
  storyTree: Type.String(),
  flags: Type.String(),
  script: Type.String(),
  storyboard: Type.String(),
  imagePrompts: Type.Array(Type.String()),
});
