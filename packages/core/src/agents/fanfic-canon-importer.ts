import { BaseAgent } from "./base.js";
import type { FanficMode } from "../models/book.js";

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

const SOURCE_CHUNK_CHARS = 50_000;

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

按顺序返回：
=== SECTION: world_rules ===
<地理、社会、组织、物理或能力规则>
=== SECTION: character_profiles ===
| 角色 | 身份 | 性格底色 | 语癖/口头禅 | 说话风格 | 行为模式 | 关键关系 | 信息边界 |
=== SECTION: key_events ===
| 序号 | 事件 | 涉及角色 | 对派生创作的约束 |
=== SECTION: power_system ===
<等级、规则和限制；不适用时明确说明>
=== SECTION: writing_style ===
<叙事视角、句段节奏、场景与对话习惯、情绪表达及可追溯原文证据>`;

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `以下是原作《${sourceName}》的素材：\n\n${source.text}` },
      ],
      { temperature: 0.3 },
    );

    const content = response.content;
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== SECTION: ${tag} ===\\s*([\\s\\S]*?)(?==== SECTION:|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const worldRules = extract("world_rules");
    const characterProfiles = extract("character_profiles");
    const keyEvents = extract("key_events");
    const powerSystem = extract("power_system");
    const writingStyle = extract("writing_style");

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
    if (sourceText.length <= SOURCE_CHUNK_CHARS) {
      return { text: sourceText, compiled: false };
    }

    const chunks = splitIntoChunks(sourceText, SOURCE_CHUNK_CHARS);
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

function splitIntoChunks(text: string, chunkChars: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    chunks.push(text.slice(offset, offset + chunkChars));
  }
  return chunks;
}
