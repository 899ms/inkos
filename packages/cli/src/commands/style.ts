import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError, runWithCliProfileSkills } from "../utils.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const styleCommand = new Command("style")
  .description("Compile a reference text into an operational style guide");

styleCommand
  .command("import")
  .description("Generate and import a Skill-based style guide into a book")
  .argument("<file>", "Reference text file")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--name <name>", "Source name")
  .option("--json", "Output JSON")
  .action(async (file: string, bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const text = await readFile(resolve(file), "utf-8");
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      await runWithCliProfileSkills(
        pipeline,
        root,
        "longform-novel",
        () => pipeline.generateStyleGuide(bookId, text, opts.name ?? file),
        { extraSkillIds: ["inkos-long-story-analysis", "inkos-imitation-writing"] },
      );
      const result = { bookId, file, styleGuide: "story/style_guide.md" };
      log(opts.json ? JSON.stringify(result, null, 2) : `Style guide imported to "${bookId}" from "${file}"`);
    } catch (error) {
      if (opts.json) log(JSON.stringify({ error: String(error) }));
      else logError(`Import failed: ${error}`);
      process.exit(1);
    }
  });
