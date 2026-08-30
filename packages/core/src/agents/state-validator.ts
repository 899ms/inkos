import { BaseAgent } from "./base.js";
import { StateValidationToolSchema } from "./state-validation-tool.js";

export interface ValidationWarning {
  readonly category: string;
  readonly description: string;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly consistent: boolean;
  readonly reconciliationRequired: boolean;
}

export interface StateValidationAuthorityContext {
  readonly storyFrame?: string;
  readonly bookRules?: string;
  readonly chapterSummaries?: string;
}

/**
 * Validates Settler output by comparing old and new truth files via LLM.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * The model submits a typed reconciliation decision; prose has no authority.
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
    authorityContext?: StateValidationAuthorityContext,
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");

    // Skip validation if nothing changed
    if (!stateDiff && !hooksDiff) {
      return { warnings: [], consistent: true, reconciliationRequired: false };
    }

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `Validate the incremental truth projection against the chapter and authority context. ${langInstruction}
Request reconciliation when an explicit chapter fact is missing, a projected change lacks textual support, a temporal/state contradiction exists, or a hook transition conflicts with the chapter. The chapter itself remains unchanged. Submit the decision and evidence through the validation tool.`;

    const authorityBlock = this.buildAuthorityContextBlock(authorityContext);

    const userPrompt = `Chapter ${chapterNumber} validation:

${authorityBlock}

## State Card Changes
${stateDiff || "(no changes)"}

## Hooks Pool Changes
${hooksDiff || "(no changes)"}

## Chapter Text (for reference)
${chapterContent}`;

    try {
      const { result } = await this.submitStructured(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        {
          name: "submit_state_validation",
          label: language === "en" ? "Submit state validation" : "提交状态对账",
          description: "Submit whether state reconciliation is required and the concrete evidence.",
          parameters: StateValidationToolSchema,
        },
        { temperature: 0.1 },
      );
      return {
        warnings: result.warnings,
        consistent: !result.reconciliationRequired,
        reconciliationRequired: result.reconciliationRequired,
      };
    } catch (error) {
      this.log?.warn(`State reconciliation review unavailable: ${error}`);
      throw error;
    }
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private buildAuthorityContextBlock(authorityContext?: StateValidationAuthorityContext): string {
    if (!authorityContext) return "## Authority / Cross-Truth Context\n(no authority context provided)";

    const storyFrame = (authorityContext.storyFrame ?? "").trim();
    const bookRules = (authorityContext.bookRules ?? "").trim();
    const chapterSummaries = (authorityContext.chapterSummaries ?? "").trim();

    return [
      "## Authority / Cross-Truth Context",
      "Authority priority: current chapter text > runtime truth files/current summaries > story_frame/book_rules.",
      "",
      "### story_frame",
      storyFrame || "(empty)",
      "",
      "### book_rules excerpt",
      bookRules || "(empty)",
      "",
      "### chapter_summaries",
      chapterSummaries || "(empty)",
    ].join("\n");
  }

}
