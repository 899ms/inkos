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
    if (oldState === newState && oldHooks === newHooks) {
      return { warnings: [], consistent: true, reconciliationRequired: false };
    }

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `Validate the derived truth projection against the current chapter and supplied authority using the activated long-writing Skill. ${langInstruction}
Do not rewrite the chapter or silently resolve contradictory sources. Submit whether reconciliation is required and the concrete evidence through the validation tool.`;

    const authorityBlock = this.buildAuthorityContextBlock(authorityContext);

    const userPrompt = `Chapter ${chapterNumber} validation:

${authorityBlock}

## Previous State Card
${oldState}

## Proposed State Card
${newState}

## Previous Hooks
${oldHooks}

## Proposed Hooks
${newHooks}

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

  private buildAuthorityContextBlock(authorityContext?: StateValidationAuthorityContext): string {
    if (!authorityContext) return "## Authority / Cross-Truth Context\n(no authority context provided)";

    const storyFrame = (authorityContext.storyFrame ?? "").trim();
    const bookRules = (authorityContext.bookRules ?? "").trim();
    const chapterSummaries = (authorityContext.chapterSummaries ?? "").trim();

    return [
      "## Authority / Cross-Truth Context",
      "Contradictory authority must be reported for reconciliation rather than silently reordered.",
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
