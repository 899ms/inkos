// Bilingual prompt builders for the narrative forecast agent, organized the
// same way as prompts/short-fiction.ts: each builder switches on language.

export type ForecastLanguage = "zh" | "en";

export interface ForecastPromptInput {
  readonly contextMarkdown: string;
  readonly divergence: string;
  readonly branchCount: number;
  readonly horizon: number;
  readonly baseChapter: number;
}

export function buildForecastSystemPrompt(language: ForecastLanguage): string {
  return language === "en"
    ? "Project mutually isolated, non-canonical futures with the activated long-writing Skill. Preserve canon, list conflicts under risks, and return exactly one JSON object."
    : "按已激活的长篇写作 Skill 推演相互隔离的非正史候选未来。保留正典，冲突写入 risks，只返回一个 JSON 对象。";
}

export function buildForecastUserPrompt(input: ForecastPromptInput, language: ForecastLanguage): string {
  const firstChapter = input.baseChapter + 1;
  if (language === "en") {
    return [
      input.contextMarkdown,
      "",
      "## Divergence point",
      "",
      input.divergence,
      "",
      "## Output requirements",
      "",
      `Produce exactly ${input.branchCount} candidate branches. Each branch covers roughly ${input.horizon} future chapters starting at chapter ${firstChapter}.`,
      "Return JSON with exactly this shape (field names must match):",
      forecastJsonShape(firstChapter, "en"),
    ].join("\n");
  }
  return [
    input.contextMarkdown,
    "",
    "## 分歧点",
    "",
    input.divergence,
    "",
    "## 输出要求",
    "",
    `生成恰好 ${input.branchCount} 个候选分支。每个分支覆盖从第 ${firstChapter} 章开始、约 ${input.horizon} 章的未来走向。`,
    "输出 JSON，结构如下（字段名必须完全一致）：",
    forecastJsonShape(firstChapter, "zh"),
  ].join("\n");
}

export function buildForecastRepairPrompt(validationError: string, language: ForecastLanguage): string {
  if (language === "en") {
    return [
      `Your previous output failed validation: ${validationError}`,
      "Re-output the complete JSON object only, fixing the problem above. No explanations, no code fences.",
    ].join("\n");
  }
  return [
    `你上一次的输出未通过校验：${validationError}`,
    "请修正上述问题后重新输出完整 JSON 对象，只输出 JSON，不要解释，不要代码围栏。",
  ].join("\n");
}

function forecastJsonShape(firstChapter: number, language: ForecastLanguage): string {
  if (language === "en") {
    return [
      "{",
      '  "branches": [',
      "    {",
      '      "title": "short branch title",',
      '      "premise": "the assumption this branch makes about the divergence point",',
      `      "beats": [{ "chapter": integer chapter number starting at ${firstChapter}, "summary": "what happens in that chapter" }],`,
      '      "characterDecisions": [{ "character": "name", "decision": "the key decision this character makes" }],',
      '      "projectedChanges": {',
      '        "characters": ["projected character state changes"],',
      '        "relationships": ["projected relationship changes"],',
      '        "world": ["projected world/faction changes"],',
      '        "hooks": ["which hooks advance, fire, or break"]',
      "      },",
      '      "risks": [{ "kind": "continuity|causality|character", "description": "consistency risk" }],',
      '      "uncertainties": ["open uncertainties"],',
      '      "intentAlignment": { "score": integer 0-100, "rationale": "how well this matches the author intent and current focus" }',
      "    }",
      "  ]",
      "}",
    ].join("\n");
  }
  return [
    "{",
    '  "branches": [',
    "    {",
    '      "title": "分支短标题",',
    '      "premise": "该分支对分歧点做出的前提与假设",',
    `      "beats": [{ "chapter": 从 ${firstChapter} 开始的整数章号, "summary": "该章发生什么" }],`,
    '      "characterDecisions": [{ "character": "人物名", "decision": "该人物做出的关键决策" }],',
    '      "projectedChanges": {',
    '        "characters": ["人物状态预计变化"],',
    '        "relationships": ["关系预计变化"],',
    '        "world": ["世界/势力预计变化"],',
    '        "hooks": ["哪些伏笔被推进、引爆或破坏"]',
    "      },",
    '      "risks": [{ "kind": "continuity|causality|character", "description": "一致性风险" }],',
    '      "uncertainties": ["不确定因素"],',
    '      "intentAlignment": { "score": 0到100的整数, "rationale": "与作者意图和当前聚焦的匹配说明" }',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}
