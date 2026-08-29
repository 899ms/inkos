export function buildCharacterVoiceProfiles(fanficCanon: string): string {
  // Extract character table from fanfic_canon.md
  const tableMatch = fanficCanon.match(
    /## 角色档案[\s\S]*?\n(\|[^\n]+\|\n\|[-|\s]+\|\n(?:\|[^\n]+\|\n)*)/,
  );
  if (!tableMatch) return "";

  const rows = tableMatch[1]!
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.startsWith("|--") && !line.startsWith("| 角色"))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((cells) => cells.length >= 5);

  if (rows.length === 0) return "";

  const profiles = rows.map((cells) => {
    const [name, , , catchphrases, speakingStyle, behavior] = cells;
    const parts: string[] = [`### ${name}`];
    if (catchphrases && catchphrases !== "（素材未提及）") {
      parts.push(`- 口头禅/语癖：${catchphrases}`);
    }
    if (speakingStyle && speakingStyle !== "（素材未提及）") {
      parts.push(`- 说话风格：${speakingStyle}`);
    }
    if (behavior && behavior !== "（素材未提及）") {
      parts.push(`- 典型行为：${behavior}`);
    }
    return parts.join("\n");
  });

  return `
## 角色语音参照（同人写作专用）

以下角色的对话和行为必须参照原作特征。写对话时，先想"这个角色在原作里会怎么说"。

${profiles.join("\n\n")}`;
}
