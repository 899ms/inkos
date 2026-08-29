import { PromptPackManifestSchema, type PromptPackManifest } from "./types.js";

export interface BuiltinPrompt {
  readonly id: string;
  readonly packId: string;
  readonly title: string;
  readonly content: string;
}

const RAW_BUILTIN_PROMPT_PACKS: PromptPackManifest[] = [
  {
    id: "longform",
    title: "Longform Writing",
    description: "Core long-form writing prompts used by chapter production and repair.",
    prompts: ["longform.writer", "longform.reviser", "longform.auditor"],
    source: "builtin",
  },
  {
    id: "play",
    title: "InkOS Play",
    description: "Open-world / branching interaction prompts for world mutation, rendering, reconciliation, and images.",
    prompts: ["play.start", "play.mutator", "play.renderer", "play.reconciler", "play.image"],
    source: "builtin",
  },
  {
    id: "interactive-film",
    title: "Interactive Film Authoring",
    description: "Script, storyboard, story graph, and image-planning prompts for interactive-film projects.",
    prompts: [
      "interactive-film.script",
      "interactive-film.storyboard",
      "interactive-film.story-graph",
      "interactive-film.image-plan",
    ],
    source: "builtin",
  },
];

const RAW_BUILTIN_PROMPTS: BuiltinPrompt[] = [
  {
    id: "longform.writer",
    packId: "longform",
    title: "Longform Writer",
    content: "",
  },
  {
    id: "longform.reviser",
    packId: "longform",
    title: "Longform Reviser",
    content: "",
  },
  {
    id: "longform.auditor",
    packId: "longform",
    title: "Longform Auditor",
    content: "",
  },
  {
    id: "play.start",
    packId: "play",
    title: "Play Start",
    content: "",
  },
  {
    id: "play.mutator",
    packId: "play",
    title: "Play World Mutator",
    content: "",
  },
  {
    id: "play.renderer",
    packId: "play",
    title: "Play Scene Renderer",
    content: "",
  },
  {
    id: "play.reconciler",
    packId: "play",
    title: "Play Scene Reconciler",
    content: "",
  },
  {
    id: "play.image",
    packId: "play",
    title: "Play Image Prompt",
    content: "",
  },
  {
    id: "interactive-film.script",
    packId: "interactive-film",
    title: "Interactive Film Script",
    content: "",
  },
  {
    id: "interactive-film.storyboard",
    packId: "interactive-film",
    title: "Interactive Film Storyboard",
    content: "",
  },
  {
    id: "interactive-film.story-graph",
    packId: "interactive-film",
    title: "Interactive Film Story Graph",
    content: "",
  },
  {
    id: "interactive-film.image-plan",
    packId: "interactive-film",
    title: "Interactive Film Image Plan",
    content: "",
  },
];

export const BUILTIN_PROMPT_PACKS: ReadonlyArray<PromptPackManifest> =
  RAW_BUILTIN_PROMPT_PACKS.map((pack) => PromptPackManifestSchema.parse(pack));

export const BUILTIN_PROMPTS: ReadonlyArray<BuiltinPrompt> = RAW_BUILTIN_PROMPTS;
