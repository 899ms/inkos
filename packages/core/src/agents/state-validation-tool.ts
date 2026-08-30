import { Type } from "@sinclair/typebox";
import { ObservationToolSchema } from "./review-tool.js";

export const StateValidationToolSchema = Type.Object({
  reconciliationRequired: Type.Boolean(),
  observations: Type.Array(ObservationToolSchema),
});
