import { Command } from "commander";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listAvailableGenres, readGenreProfile } from "@actalk/inkos-core";
import { findProjectRoot, log, logError } from "../utils.js";
import { resolveCliLanguage, type CliLanguage } from "../localization.js";

export function buildGenreTemplate(
  params: {
    readonly id: string;
    readonly name: string;
  },
  language: CliLanguage = "zh",
): string {
  if (language === "en") {
    return `---
name: ${params.name}
id: ${params.id}
language: en
---
`;
  }

  return `---
name: ${params.name}
id: ${params.id}
language: zh
---
`;
}

export const genreCommand = new Command("genre")
  .description("Manage genre profiles");

genreCommand
  .command("list")
  .description("List all available genre profiles (built-in + project)")
  .action(async () => {
    try {
      const root = findProjectRoot();
      const genres = await listAvailableGenres(root);

      if (genres.length === 0) {
        log("No genre profiles found.");
        return;
      }

      log("Available genres:\n");
      for (const g of genres) {
        const tag = g.source === "project" ? "[project]" : "[builtin]";
        log(`  ${g.id.padEnd(12)} ${g.name.padEnd(8)} ${tag}`);
      }
      log(`\nTotal: ${genres.length} genre(s)`);
    } catch (e) {
      logError(`Failed to list genres: ${e}`);
      process.exit(1);
    }
  });

genreCommand
  .command("show")
  .description("Display a genre profile")
  .argument("<id>", "Genre ID (e.g. xuanhuan, urban, horror)")
  .action(async (id: string) => {
    try {
      const root = findProjectRoot();
      const genres = await listAvailableGenres(root);
      const exactMatch = genres.some(g => g.id === id);
      if (!exactMatch) {
        logError(`Genre "${id}" not found. Available: ${genres.map(g => g.id).join(", ")}`);
        process.exit(1);
      }
      const { profile } = await readGenreProfile(root, id);

      log(`Genre: ${profile.name} (${profile.id})\n`);
      log(`  Language: ${profile.language}`);
    } catch (e) {
      logError(`Failed to show genre: ${e}`);
      process.exit(1);
    }
  });

genreCommand
  .command("create")
  .description("Scaffold a new genre profile in the project genres/ directory")
  .argument("<id>", "Genre ID (e.g. scifi, wuxia, romance)")
  .option("--name <name>", "Genre display name", "")
  .option("--lang <language>", "Template language: zh or en (defaults to INKOS_LOCALE/LANG, then zh)")
  .action(async (id: string, opts) => {
    try {
      const root = findProjectRoot();
      const genresDir = join(root, "genres");
      const filePath = join(genresDir, `${id}.md`);

      // Check if already exists
      try {
        await readFile(filePath, "utf-8");
        logError(`Genre profile already exists: ${filePath}`);
        process.exit(1);
      } catch { /* file doesn't exist, good */ }

      await mkdir(genresDir, { recursive: true });

      const name = opts.name || id;
      const template = buildGenreTemplate(
        {
          id,
          name,
        },
        resolveCliLanguage(opts.lang),
      );

      await writeFile(filePath, template, "utf-8");
      log(`Created genre profile: ${filePath}`);
      log(`Attach professional methodology through Skills, not genre-profile rules.`);
    } catch (e) {
      logError(`Failed to create genre: ${e}`);
      process.exit(1);
    }
  });
