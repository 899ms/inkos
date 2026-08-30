import { Type } from "@sinclair/typebox";

export const FanficCanonToolSchema = Type.Object({
  worldRules: Type.String(),
  characterProfiles: Type.String(),
  keyEvents: Type.String(),
  powerSystem: Type.String(),
  writingStyle: Type.String(),
});
