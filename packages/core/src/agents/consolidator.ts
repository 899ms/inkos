import { BaseAgent } from "./base.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readVolumeMap } from "../utils/outline-paths.js";
import { VolumeSummariesToolSchema } from "./consolidator-tool.js";

export interface ConsolidationResult {
  readonly volumeSummaries: string;
  readonly sourcePreserved: true;
}

/** Build a derived semantic summary without deleting or rewriting source history. */
export class ConsolidatorAgent extends BaseAgent {
  get name(): string {
    return "consolidator";
  }

  async consolidate(bookDir: string): Promise<ConsolidationResult> {
    const storyDir = join(bookDir, "story");
    const summariesPath = join(storyDir, "chapter_summaries.md");
    const volumeSummariesPath = join(storyDir, "volume_summaries.md");
    const [chapterSummaries, volumeMap] = await Promise.all([
      readFile(summariesPath, "utf-8").catch(() => ""),
      readVolumeMap(bookDir, ""),
    ]);
    if (!chapterSummaries.trim() || !volumeMap.trim()) {
      return { volumeSummaries: "", sourcePreserved: true };
    }

    const { result } = await this.submitStructured(
      [
        {
          role: "system",
          content: "按已激活的长篇写作 Skill，把现有章节摘要编译成可追溯的卷级 Markdown 摘要。只总结输入支持的内容，保留人物、地点、事件、因果和未解线索。不得改写或删减源文件。",
        },
        {
          role: "user",
          content: `## 卷纲\n${volumeMap}\n\n## 完整章节摘要\n${chapterSummaries}`,
        },
      ],
      {
        name: "submit_volume_summaries",
        label: "Submit volume summaries",
        description: "Submit a derived Markdown volume-summary artifact.",
        parameters: VolumeSummariesToolSchema,
      },
      { temperature: 0.3 },
    );
    const volumeSummaries = result.volumeSummaries.trim();
    await writeFile(volumeSummariesPath, `${volumeSummaries}\n`, "utf-8");
    return { volumeSummaries, sourcePreserved: true };
  }
}
