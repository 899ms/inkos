import { BaseAgent } from "./base.js";
import type { FanficMode } from "../models/book.js";
import { FanficCanonToolSchema } from "./fanfic-canon-tool.js";
import { estimateTextTokens } from "../llm/provider.js";
import { semanticInputBudget, splitTextByEstimatedTokens } from "../llm/semantic-input.js";

export interface FanficCanonOutput {
  readonly worldRules: string;
  readonly characterProfiles: string;
  readonly keyEvents: string;
  readonly powerSystem: string;
  readonly writingStyle: string;
  readonly fullDocument: string;
}

export class FanficCanonImporter extends BaseAgent {
  get name(): string {
    return "fanfic-canon-importer";
  }

  async importFromText(
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
    language: "zh" | "en" = "zh",
  ): Promise<FanficCanonOutput> {
    const source = await this.prepareSourceText(sourceText, sourceName, language);
    const systemPrompt = language === "en"
      ? `Compile source-grounded fan-fiction canon with the activated import and fan-fiction Skills. Mode: ${fanficMode}. Submit all canonical sections through the result tool.${source.compiled ? " The input is a traceable semantic source package." : ""}`
      : `按已激活的导入与同人 Skills 编译有来源依据的同人正典。模式：${fanficMode}。通过结果工具提交全部正典小节。${source.compiled ? "输入是可追溯的语义资料包。" : ""}`;

    const { result } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: language === "en"
          ? `Source material for "${sourceName}":\n\n${source.text}`
          : `原作《${sourceName}》素材：\n\n${source.text}` },
      ],
      {
        name: "submit_fanfic_canon",
        label: "Submit fanfic canon",
        description: "Submit the source-grounded canon sections for host persistence.",
        parameters: FanficCanonToolSchema,
      },
      { temperature: 0.3 },
    );

    const worldRules = result.worldRules.trim();
    const characterProfiles = result.characterProfiles.trim();
    const keyEvents = result.keyEvents.trim();
    const powerSystem = result.powerSystem.trim();
    const writingStyle = result.writingStyle.trim();
    if ([worldRules, characterProfiles, keyEvents, powerSystem, writingStyle].some((section) => !section)) {
      throw new Error("Fanfic canon compiler returned an empty required section.");
    }

    const headings = language === "en"
      ? ["Fan-fiction Canon", "World Rules", "Character Profiles", "Key Event Timeline", "Power System", "Source Style", "Source", "Material", "Mode"]
      : ["同人正典", "世界规则", "角色档案", "关键事件时间线", "力量体系", "原作写作风格", "来源", "素材", "同人模式"];
    const fullDocument = [
      `# ${headings[0]}（${sourceName}）`,
      "",
      `## ${headings[1]}`,
      worldRules,
      "",
      `## ${headings[2]}`,
      characterProfiles,
      "",
      `## ${headings[3]}`,
      keyEvents,
      "",
      `## ${headings[4]}`,
      powerSystem,
      "",
      `## ${headings[5]}`,
      writingStyle,
      "",
      `## ${headings[6]}`,
      `- ${headings[7]}: ${sourceName}`,
      `- ${headings[8]}: ${fanficMode}`,
    ].join("\n");

    return { worldRules, characterProfiles, keyEvents, powerSystem, writingStyle, fullDocument };
  }

  private async prepareSourceText(
    sourceText: string,
    sourceName: string,
    language: "zh" | "en",
  ): Promise<{ readonly text: string; readonly compiled: boolean }> {
    const budget = semanticInputBudget(this.ctx.client, { reservedOutputTokens: 16_384 });
    if (budget === undefined || estimateTextTokens(sourceText) <= budget) {
      return { text: sourceText, compiled: false };
    }

    const chunks = splitTextByEstimatedTokens(sourceText, budget);
    const notes: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const response = await this.chat(
        [
          {
            role: "system",
            content: language === "en"
              ? "Compile the complete source chunk into a traceable Markdown evidence package with the activated import Skill."
              : "按已激活的导入 Skill，把完整原作片段编译为可追溯 Markdown 资料包。",
          },
          {
            role: "user",
            content: [
              language === "en" ? `Source: ${sourceName}` : `原作：${sourceName}`,
              language === "en" ? `Chunk: ${index + 1}/${chunks.length}` : `片段：${index + 1}/${chunks.length}`,
              "",
              chunks[index],
            ].join("\n"),
          },
        ],
        { temperature: 0.2 },
      );
      const content = response.content.trim();
      if (!content) throw new Error(`Fanfic source compiler returned empty output for chunk ${index + 1}/${chunks.length}.`);
      notes.push([`## 片段 ${index + 1}/${chunks.length}`, content].join("\n\n"));
    }

    return {
      compiled: true,
      text: [
        language === "en" ? `# ${sourceName} semantic source package` : `# 《${sourceName}》语义资料包`,
        "",
        language === "en"
          ? "Compiled from every source chunk for traceable canon extraction."
          : "逐段读取完整原作素材后编译，用于可追溯正典抽取。",
        "",
        ...notes,
      ].join("\n"),
    };
  }
}
