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

const MODE_LABELS: Record<FanficMode, string> = {
  canon: "原作向（严格遵守原作设定）",
  au: "AU/平行世界（世界规则可改，角色保留）",
  ooc: "OOC（角色性格可偏离原作）",
  cp: "CP（以配对关系为核心）",
};

export class FanficCanonImporter extends BaseAgent {
  get name(): string {
    return "fanfic-canon-importer";
  }

  async importFromText(
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<FanficCanonOutput> {
    const source = await this.prepareSourceText(sourceText, sourceName);

    const modeLabel = MODE_LABELS[fanficMode];

    const systemPrompt = `按已激活的导入 Skill 从用户素材编译同人正典。模式：${modeLabel}。只记录素材支持的事实；缺失信息标为“素材未提及”。${source.compiled ? "输入是带片段编号的语义资料包，引用其中证据。" : ""}

通过结果工具分别提交世界规则、角色档案、关键事件、力量体系和写作风格。各字段使用可直接写入正典文档的 Markdown。`;

    const { result } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `以下是原作《${sourceName}》的素材：\n\n${source.text}` },
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

    const meta = [
      "---",
      "meta:",
      `  sourceFile: "${sourceName}"`,
      `  fanficMode: "${fanficMode}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");

    const fullDocument = [
      `# 同人正典（《${sourceName}》）`,
      "",
      "## 世界规则",
      worldRules || "（素材中未提取到明确世界规则）",
      "",
      "## 角色档案",
      characterProfiles || "（素材中未提取到角色信息）",
      "",
      "## 关键事件时间线",
      keyEvents || "（素材中未提取到关键事件）",
      "",
      "## 力量体系",
      powerSystem || "（原作无明确力量体系）",
      "",
      "## 原作写作风格",
      writingStyle || "（素材不足以提取风格特征）",
      "",
      meta,
    ].join("\n");

    return { worldRules, characterProfiles, keyEvents, powerSystem, writingStyle, fullDocument };
  }

  private async prepareSourceText(sourceText: string, sourceName: string): Promise<{ readonly text: string; readonly compiled: boolean }> {
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
            content: [
              "你是同人正典资料编译器。任务是把一个原作片段压成后续抽取可用的 Markdown 资料包。",
              "不要续写、不要创作、不要补不存在的信息。只保留片段里实际出现的世界规则、人物、关系、关键事件、能力体系、口头禅、说话风格和原文证据。",
              "如果片段没有某类信息，直接省略该类。保留片段编号，方便后续追溯。",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `原作：《${sourceName}》`,
              `片段：${index + 1}/${chunks.length}`,
              "",
              chunks[index],
            ].join("\n"),
          },
        ],
        { temperature: 0.2 },
      );
      const content = response.content.trim();
      if (content) {
        notes.push([`## 片段 ${index + 1}/${chunks.length}`, content].join("\n\n"));
      }
    }

    return {
      compiled: true,
      text: [
        `# 《${sourceName}》语义资料包`,
        "",
        "以下内容由 InkOS 逐段读取完整原作素材后压缩生成，用于后续正典抽取。它不是原文截断。",
        "",
        ...notes,
      ].join("\n"),
    };
  }
}
