import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";

export function buildSettlerSystemPrompt(
  book: BookConfig,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
  language?: "zh" | "en",
): string {
  const resolvedLang = language ?? genreProfile.language;
  const isEnglish = resolvedLang === "en";
  const numericalBlock = genreProfile.numericalSystem
    ? (isEnglish ? "Resource ledger: enabled." : "资源账本：启用。")
    : (isEnglish ? "Resource ledger: disabled; leave UPDATED_LEDGER empty." : "资源账本：关闭；UPDATED_LEDGER 留空。");

  const fullCastBlock = bookRules?.enableFullCastTracking
    ? (isEnglish
        ? `\n## Full cast tracking\nPOST_SETTLEMENT also lists present characters, relationship changes, and absent characters mentioned in the chapter.`
        : `\n## 全员追踪\nPOST_SETTLEMENT 额外列出本章出场角色、关系变化和被提及但未出场的角色。`)
    : "";

  const langPrefix = isEnglish
    ? `【LANGUAGE OVERRIDE】ALL output (state card, hooks, summaries, subplots, emotional arcs, character matrix) MUST be in English. The === TAG === markers remain unchanged.\n\n`
    : "";

  const task = isEnglish
    ? `Project explicit chapter facts into incremental runtime truth using the activated long-writing Skill. Preserve unrelated state and stable IDs. Do not rewrite prose or treat outline plans as completed events.`
    : `按已激活的长篇写作 Skill，把正文明确事实增量投影到运行时 truth。保留无关状态和稳定 ID；不要改写正文，也不要把大纲计划当作已发生事件。`;
  return `${langPrefix}${task}

## Work
- title: ${book.title}
- genre: ${genreProfile.name} (${book.genre})
- platform: ${book.platform}
- ${numericalBlock}${fullCastBlock}

## Output contract
${buildSettlerOutputFormat(genreProfile, resolvedLang)}`;
}

function buildSettlerOutputFormat(gp: GenreProfile, language: "zh" | "en"): string {
  const chapterTypeExample = gp.chapterTypes.length > 0
    ? gp.chapterTypes[0]
    : (language === "en" ? "mainline progression" : "主线推进");

  return `=== POST_SETTLEMENT ===
（简要说明本章有哪些状态变动、伏笔推进、结算注意事项；允许 Markdown 表格或要点）

=== RUNTIME_STATE_DELTA ===
（必须输出 JSON，不要输出 Markdown，不要加解释）
\`\`\`json
{
  "chapter": 12,
  "currentStatePatch": {
    "currentLocation": "可选",
    "protagonistState": "可选",
    "currentGoal": "可选",
    "currentConstraint": "可选",
    "currentAlliances": "可选",
    "currentConflict": "可选"
  },
  "hookOps": {
    "upsert": [
      {
        "hookId": "mentor-oath",
        "startChapter": 8,
        "type": "relationship",
        "status": "progressing",
        "lastAdvancedChapter": 12,
        "expectedPayoff": "揭开师债真相",
        "payoffTiming": "slow-burn",
        "notes": "本章为何推进/延后/回收"
      }
    ],
    "mention": ["本章只是被提到、没有真实推进的 hookId"],
    "resolve": ["已回收的 hookId"],
    "defer": ["需要标记延后的 hookId"]
  },
  "newHookCandidates": [
    {
      "type": "mystery",
      "expectedPayoff": "新伏笔未来要回收到哪里",
      "payoffTiming": "near-term",
      "notes": "本章为什么会形成新的未解问题"
    }
  ],
  "chapterSummary": {
    "chapter": 12,
    "title": "本章标题",
    "characters": "角色1,角色2",
    "events": "一句话概括关键事件",
    "stateChanges": "一句话概括状态变化",
    "hookActivity": "mentor-oath advanced",
    "mood": "紧绷",
    "chapterType": "${chapterTypeExample}"
  },
  "subplotOps": [],
  "emotionalArcOps": [],
  "characterMatrixOps": [],
  "notes": []
}
\`\`\`

规则：
1. 只输出增量，不要重写完整 truth files
2. 所有章节号字段都必须是整数，不能写自然语言
3. hookOps.upsert 里只能写“当前伏笔池里已经存在”的 hookId，不允许发明新的 hookId；语义上承接既有伏笔时必须复用该 id
4. 只有确认当前伏笔池没有同一叙事承诺时，brand-new unresolved thread 才写进 newHookCandidates
5. 如果旧 hook 只是被提到、没有真实状态变化，把它放进 mention，不要更新 lastAdvancedChapter
6. 如果本章推进了旧 hook，lastAdvancedChapter 必须等于当前章号
7. 如果回收或延后 hook，必须放在 resolve / defer 数组里
8. chapterSummary.chapter 必须等于当前章节号`;
}

export function buildSettlerUserPrompt(params: {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly currentState: string;
  readonly ledger: string;
  readonly hooks: string;
  readonly chapterSummaries: string;
  readonly subplotBoard: string;
  readonly emotionalArcs: string;
  readonly characterMatrix: string;
  readonly volumeOutline: string;
  readonly observations?: string;
  readonly selectedEvidenceBlock?: string;
  readonly governedControlBlock?: string;
  readonly validationFeedback?: string;
  readonly language?: "zh" | "en";
}): string {
  const isEnglish = params.language === "en";
  const heading = (en: string, zh: string) => isEnglish ? en : zh;
  const ledgerBlock = params.ledger
    ? `\n## ${heading("Current resource ledger", "当前资源账本")}\n${params.ledger}\n`
    : "";

  const summariesBlock = params.chapterSummaries !== "(文件尚未创建)"
    ? `\n## ${heading("Existing chapter summaries", "已有章节摘要")}\n${params.chapterSummaries}\n`
    : "";

  const subplotBlock = params.subplotBoard !== "(文件尚未创建)"
    ? `\n## ${heading("Current subplots", "当前支线进度板")}\n${params.subplotBoard}\n`
    : "";

  const emotionalBlock = params.emotionalArcs !== "(文件尚未创建)"
    ? `\n## ${heading("Current emotional arcs", "当前情感弧线")}\n${params.emotionalArcs}\n`
    : "";

  const matrixBlock = params.characterMatrix !== "(文件尚未创建)"
    ? `\n## ${heading("Current character matrix", "当前角色交互矩阵")}\n${params.characterMatrix}\n`
    : "";

  const observationsBlock = params.observations
    ? `\n## ${heading("Observer facts", "观察日志")}\n${params.observations}\n`
    : "";
  const selectedEvidenceBlock = params.selectedEvidenceBlock
    ? `\n## ${heading("Selected long-range evidence", "已选长程证据")}\n${params.selectedEvidenceBlock}\n`
    : "";
  const controlBlock = params.governedControlBlock ?? "";
  const outlineBlock = controlBlock.length === 0
    ? `\n## ${heading("Volume map", "卷纲")}\n${params.volumeOutline}\n`
    : "";
  const validationFeedbackBlock = params.validationFeedback
    ? `\n## ${heading("Reconciliation observations", "状态对账观察")}\n${params.validationFeedback}\n`
    : "";

  return `${isEnglish ? `Project Chapter ${params.chapterNumber} "${params.title}" into runtime truth.` : `把第${params.chapterNumber}章「${params.title}」投影到运行时 truth。`}
${observationsBlock}
${validationFeedbackBlock}
## ${heading("Chapter body", "本章正文")}

${params.content}
${controlBlock}

## ${heading("Current state", "当前状态卡")}
${params.currentState}
${ledgerBlock}
## ${heading("Current hook pool", "当前伏笔池")}
${params.hooks}
${selectedEvidenceBlock}${summariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}
${outlineBlock}

${isEnglish ? "Return the settlement in the exact === TAG === contract." : "按 === TAG === 协议返回结算结果。"}`;
}
