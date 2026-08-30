import { Type } from "@sinclair/typebox";
import { ObservationToolSchema } from "./review-tool.js";

export const StateValidationToolSchema = Type.Object({
  reconciliationRequired: Type.Boolean({
    description: "True only when recalculating the derived truth projection can resolve the mismatch. False for contradictions in prose or between authority sources.",
  }),
  observations: Type.Array(ObservationToolSchema),
});
