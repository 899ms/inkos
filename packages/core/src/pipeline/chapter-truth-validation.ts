import type { StateValidationAuthorityContext, ValidationResult, StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { Logger } from "../utils/logger.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import { retrySettlementAfterValidationFailure } from "./chapter-state-recovery.js";

export async function validateChapterTruthPersistence(params: {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly persistenceOutput: WriteChapterOutput;
  readonly previousTruth: {
    readonly oldState: string;
    readonly oldHooks: string;
    readonly oldLedger: string;
  };
  readonly authorityContext?: StateValidationAuthorityContext;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly language: LengthLanguage;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}): Promise<{
  readonly validation: ValidationResult;
  readonly persistenceOutput: WriteChapterOutput;
}> {
  let validation: ValidationResult;
  let persistenceOutput = params.persistenceOutput;

  try {
    validation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
      params.authorityContext,
    );
  } catch (error) {
    params.logger?.warn(`State validation error for chapter ${params.chapterNumber}: ${String(error)}`);
    throw new Error(`Chapter state validation unavailable: ${String(error)}`);
  }

  if (validation.warnings.length > 0) {
    params.logWarn({
      zh: `状态校验：第${params.chapterNumber}章发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of validation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (!validation.passed || validation.repairRequired) {
    const recovery = await retrySettlementAfterValidationFailure({
      writer: params.writer,
      validator: params.validator,
      book: params.book,
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      reducedControlInput: params.reducedControlInput,
      oldState: params.previousTruth.oldState,
      oldHooks: params.previousTruth.oldHooks,
      originalValidation: validation,
      language: params.language,
      logWarn: params.logWarn,
      logger: params.logger,
    });

    if (recovery.kind === "recovered") {
      persistenceOutput = recovery.output;
      validation = recovery.validation;
    } else {
      throw new Error(recovery.issues.map((issue) => issue.description).join("; "));
    }
  }

  return {
    validation,
    persistenceOutput,
  };
}
