import type {
  ChapterTrace,
  ContextPackage,
  RuleStack,
} from "../models/input-governance.js";
import { estimateTextTokens } from "../llm/provider.js";
import {
  ChapterTraceSchema,
  RuleStackSchema,
} from "../models/input-governance.js";
import type { PlanChapterOutput } from "../agents/planner.js";

/**
 * Compose the per-chapter rule stack used by writer / continuity / reviser
 * prompts. Source names follow the Phase 5 layout (story_frame, volume_map,
 * roles/) and activeOverrides are derived from the planner's intent so the
 * "Governed Control Stack" block surfaces the actual gating in effect for
 * the current chapter — it used to be a static stub that ignored both
 * `plan` and `chapterNumber`.
 *
 * Phase hotfix 6 (Option A): make this honestly dynamic instead of deleting
 * it, because writer.ts (~L820/L900), continuity.ts (~L590), and
 * reviser.ts (~L600) all render ruleStack.sections / activeOverrides into
 * the model prompt. Removing the function would require a much larger
 * prompt refactor; making it real fixes the lie at the source.
 */
export function buildGovernedRuleStack(): RuleStack {
  return RuleStackSchema.parse({
    layers: [
      { id: "L1", name: "hard_facts", precedence: 100, scope: "global" },
      { id: "L2", name: "author_intent", precedence: 80, scope: "book" },
      { id: "L3", name: "planning", precedence: 60, scope: "arc" },
      { id: "L4", name: "current_task", precedence: 70, scope: "local" },
    ],
    sections: {
      // Phase 5 authoritative source names (was: story_bible, volume_outline).
      hard: ["story_frame", "current_state", "book_rules", "roles"],
      soft: ["author_intent", "current_focus", "volume_map"],
    },
    overrideEdges: [
      { from: "L4", to: "L3", allowed: true, scope: "current_chapter" },
      { from: "L4", to: "L2", allowed: false, scope: "current_chapter" },
      { from: "L4", to: "L1", allowed: false, scope: "current_chapter" },
    ],
    activeOverrides: [],
  });
}

export function buildGovernedTrace(params: {
  readonly chapterNumber: number;
  readonly plan: PlanChapterOutput;
  readonly contextPackage: ContextPackage;
  readonly composerInputs: ReadonlyArray<string>;
  readonly notes?: ReadonlyArray<string>;
  readonly promptPacks?: ReadonlyArray<string>;
  readonly compression?: ChapterTrace["compression"];
  readonly retrieval?: ChapterTrace["retrieval"];
}): ChapterTrace {
  const protectedEntries = params.contextPackage.selectedContext.filter((entry) =>
    isProtectedContextSource(entry),
  );
  const compressibleEntries = params.contextPackage.selectedContext.filter((entry) =>
    !isProtectedContextSource(entry),
  );
  const protectedTokens = sumContextTokens(protectedEntries);
  const compressibleTokens = sumContextTokens(compressibleEntries);

  return ChapterTraceSchema.parse({
    chapter: params.chapterNumber,
    plannerInputs: params.plan.plannerInputs,
    composerInputs: params.composerInputs,
    selectedSources: params.contextPackage.selectedContext.map((entry) => entry.source),
    promptPacks: params.promptPacks ?? [],
    contextTiers: {
      protectedSources: protectedEntries.map((entry) => entry.source),
      compressibleSources: compressibleEntries.map((entry) => entry.source),
    },
    tokenBudget: {
      protectedTokens,
      compressibleTokens,
      totalSelectedTokens: protectedTokens + compressibleTokens,
    },
    ...(params.compression ? { compression: params.compression } : {}),
    ...(params.retrieval ? { retrieval: params.retrieval } : {}),
    notes: params.notes ?? [],
  });
}

export function isProtectedContextSource(input: string | ContextPackage["selectedContext"][number]): boolean {
  if (typeof input !== "string" && input.protection) return input.protection === "protected";
  const source = typeof input === "string" ? input : input.source;
  return source === "runtime/chapter_memo"
    || source === "story/current_focus.md"
    || source === "story/author_intent.md"
    || source === "story/outline/story_frame.md"
    || source.startsWith("story/outline/story_frame.md#")
    || source === "story/story_bible.md"
    || source === "story/outline/volume_map.md"
    || source.startsWith("story/outline/volume_map.md#")
    || source === "story/volume_outline.md"
    || source === "story/parent_canon.md"
    || source === "story/fanfic_canon.md"
    || source.startsWith("story/current_state.md")
    || source.startsWith("story/pending_hooks.md#")
    || source.startsWith("runtime/referenced_hook#");
}

function sumContextTokens(entries: ReadonlyArray<ContextPackage["selectedContext"][number]>): number {
  return entries.reduce((total, entry) => total + estimateContextSourceTokens(entry), 0);
}

function estimateContextSourceTokens(entry: ContextPackage["selectedContext"][number]): number {
  return estimateTextTokens([entry.source, entry.reason, entry.excerpt].filter(Boolean).join("\n"));
}
