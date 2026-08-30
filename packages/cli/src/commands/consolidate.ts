import { Command } from "commander";
import { ConsolidatorAgent } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const consolidateCommand = new Command("consolidate")
  .description("Build a derived volume-summary artifact without changing chapter history")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);

      const pipelineConfig = buildPipelineConfig(config, root);
      const consolidator = new ConsolidatorAgent({
        client: pipelineConfig.client,
        model: pipelineConfig.model,
        projectRoot: root,
      });

      const { StateManager } = await import("@actalk/inkos-core");
      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);

      if (!opts.json) log(`Building volume summaries for "${bookId}"...`);

      const result = await consolidator.consolidate(bookDir);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(result.volumeSummaries
          ? "Volume summaries saved to story/volume_summaries.md; source summaries were preserved."
          : "No source summaries or volume map were available.");
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Volume-summary generation failed: ${e}`);
      }
      process.exit(1);
    }
  });
