import { Type } from "@sinclair/typebox";

export const StateValidationToolSchema = Type.Object({
  reconciliationRequired: Type.Boolean(),
  warnings: Type.Array(Type.Object({
    category: Type.String(),
    description: Type.String(),
  })),
});
