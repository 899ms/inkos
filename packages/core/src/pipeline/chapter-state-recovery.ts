import type { AuditIssue } from "../agents/continuity.js";
import type {
  ValidationResult,
  ValidationWarning,
} from "../agents/state-validator.js";
import type { StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { WriterAgent } from "../agents/writer.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthLanguage } from "../utils/length-metrics.js";

export interface SettlementRetryParams {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly baselineChapter?: number;
  readonly allowNewHooks?: boolean;
  readonly title: string;
  readonly content: string;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly oldState: string;
  readonly oldHooks: string;
  readonly originalValidation: ValidationResult;
  readonly language: LengthLanguage;
  readonly logWarn?: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}

export type SettlementRetryResult =
  | {
    readonly kind: "reconciled";
    readonly output: WriteChapterOutput;
    readonly validation: ValidationResult;
  }
  | {
    readonly kind: "unresolved";
    readonly output: WriteChapterOutput;
    readonly validation: ValidationResult;
    readonly issues: ReadonlyArray<AuditIssue>;
  };

export async function reconcileChapterStateAfterReview(
  params: SettlementRetryParams,
): Promise<SettlementRetryResult> {
  params.logWarn?.({
    zh: `状态投影需要对账，正在仅重算第${params.chapterNumber}章结算层`,
    en: `State projection needs reconciliation; recalculating settlement for chapter ${params.chapterNumber}`,
  });

  const retryOutput = await params.writer.settleChapterState({
    book: params.book,
    bookDir: params.bookDir,
    chapterNumber: params.chapterNumber,
    title: params.title,
    content: params.content,
    allowReapply: true,
    baselineChapter: params.baselineChapter,
    allowNewHooks: params.allowNewHooks,
    chapterIntent: params.reducedControlInput?.chapterIntent,
    contextPackage: params.reducedControlInput?.contextPackage,
    ruleStack: params.reducedControlInput?.ruleStack,
    validationFeedback: buildStateReconciliationFeedback(
      params.originalValidation.warnings,
      params.language,
    ),
  });

  let retryValidation: ValidationResult;
  try {
    retryValidation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.oldState,
      retryOutput.updatedState,
      params.oldHooks,
      retryOutput.updatedHooks,
      params.language,
    );
  } catch (error) {
    const validation: ValidationResult = {
      consistent: false,
      reconciliationRequired: true,
      warnings: [{
        category: "state-validation-unavailable",
        description: `State reconciliation could not be verified: ${String(error)}`,
      }],
    };
    return {
      kind: "unresolved",
      output: retryOutput,
      validation,
      issues: buildStateReconciliationIssues(validation.warnings, params.language),
    };
  }

  if (retryValidation.warnings.length > 0) {
    params.logWarn?.({
      zh: `状态校验重试后，第${params.chapterNumber}章仍有 ${retryValidation.warnings.length} 条警告`,
      en: `State validation retry still reports ${retryValidation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of retryValidation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (retryValidation.consistent && !retryValidation.reconciliationRequired) {
    return {
      kind: "reconciled",
      output: retryOutput,
      validation: retryValidation,
    };
  }

  return {
    kind: "unresolved",
    output: retryOutput,
    validation: retryValidation,
    issues: buildStateReconciliationIssues(retryValidation.warnings, params.language),
  };
}

export function buildStateReconciliationFeedback(
  warnings: ReadonlyArray<ValidationWarning>,
  language: LengthLanguage,
): string {
  if (warnings.length === 0) {
    return language === "en"
      ? "The previous settlement contradicted the chapter text. Reconcile truth files strictly to the body."
      : "上一次状态结算与正文矛盾。请严格以正文为准修正 truth files。";
  }

  if (language === "en") {
    return [
      "The previous settlement needs reconciliation. Align these differences with the chapter body:",
      ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
    ].join("\n");
  }

  return [
    "上一次状态结算需要对账。请对照正文修正以下差异：",
    ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
  ].join("\n");
}

export function buildStateReconciliationIssues(
  warnings: ReadonlyArray<ValidationWarning>,
  language: LengthLanguage,
): ReadonlyArray<AuditIssue> {
  if (warnings.length > 0) {
    return warnings.map((warning) => ({
      severity: "warning" as const,
      category: "state-validation",
      description: warning.description,
      suggestion: language === "en"
        ? "Review or explicitly reconcile state before relying on this projection."
        : "依赖这份状态投影前，请复核或显式执行状态对账。",
    }));
  }

  return [{
    severity: "warning",
    category: "state-validation",
    description: language === "en"
      ? "State reconciliation remains unresolved after recalculation."
      : "状态结算重算后仍有未解决差异。",
    suggestion: language === "en"
      ? "Review or explicitly reconcile state before relying on this projection."
      : "依赖这份状态投影前，请复核或显式执行状态对账。",
  }];
}
