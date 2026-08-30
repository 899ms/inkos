import type { ContextPackage } from "../models/input-governance.js";
import {
  parsePendingHooksMarkdown,
  renderHookSnapshot,
} from "./memory-retrieval.js";

export function buildGovernedHookWorkingSet(params: {
  readonly hooksMarkdown: string;
  readonly contextPackage: ContextPackage;
  readonly language: "zh" | "en";
}): string {
  const { hooksMarkdown } = params;
  if (!hooksMarkdown || hooksMarkdown === "(文件不存在)" || hooksMarkdown === "(文件尚未创建)") {
    return hooksMarkdown;
  }

  const hooks = parsePendingHooksMarkdown(hooksMarkdown);
  if (hooks.length === 0) return hooksMarkdown;

  const selectedIds = new Set(
    params.contextPackage.selectedContext
      .filter((entry) => entry.source.startsWith("story/pending_hooks.md#"))
      .map((entry) => entry.source.slice("story/pending_hooks.md#".length))
      .filter(Boolean),
  );
  if (selectedIds.size === 0) return hooksMarkdown;

  const workingSet = hooks.filter((hook) => selectedIds.has(hook.hookId));
  return workingSet.length > 0
    ? renderHookSnapshot(workingSet, params.language)
    : hooksMarkdown;
}
