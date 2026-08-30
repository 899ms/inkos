import { z } from "zod";
import yaml from "js-yaml";

export const GenreProfileSchema = z.object({
  name: z.string(),
  id: z.string(),
  language: z.enum(["zh", "en"]).default("zh"),
});

export type GenreProfile = z.infer<typeof GenreProfileSchema>;

export interface ParsedGenreProfile {
  readonly profile: GenreProfile;
}

export function parseGenreProfile(raw: string): ParsedGenreProfile {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error("Genre profile missing YAML frontmatter (--- ... ---)");
  }

  const frontmatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
  const profile = GenreProfileSchema.parse(frontmatter);
  return { profile };
}
