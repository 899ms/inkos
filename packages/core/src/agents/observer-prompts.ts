import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";

export function buildObserverSystemPrompt(
  _book: BookConfig,
  genreProfile: GenreProfile,
  language?: "zh" | "en",
): string {
  const isEnglish = (language ?? genreProfile.language) === "en";
  const sections = isEnglish
    ? ["CHARACTERS", "LOCATIONS", "RESOURCES", "RELATIONSHIPS", "EMOTIONS", "INFORMATION", "PLOT_THREADS", "TIME", "PHYSICAL_STATE"]
    : ["角色行为", "位置变化", "资源变化", "关系变化", "情绪变化", "信息流动", "剧情线索", "时间", "身体状态"];
  const shape = sections.map((section) => `[${section}]\n- <explicit observation or none>`).join("\n\n");
  return isEnglish
    ? `Extract explicit chapter facts using the activated long-writing Skill. Do not predict, infer future events, or rewrite prose. Return exactly one === OBSERVATIONS === block with these sections:\n\n=== OBSERVATIONS ===\n\n${shape}`
    : `按已激活的长篇写作 Skill 提取正文明确事实。不要预测、补全未来事件或改写正文。只返回一个 === OBSERVATIONS === 区块，并包含以下小节：\n\n=== OBSERVATIONS ===\n\n${shape}`;
}

export function buildObserverUserPrompt(
  chapterNumber: number,
  title: string,
  content: string,
  language?: "zh" | "en",
): string {
  return language === "en"
    ? `Extract explicit facts from Chapter ${chapterNumber} "${title}":\n\n${content}`
    : `提取第${chapterNumber}章「${title}」中的明确事实：\n\n${content}`;
}
