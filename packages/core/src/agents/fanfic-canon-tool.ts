import { Type } from "@sinclair/typebox";

export const FanficCanonToolSchema = Type.Object({
  worldRules: Type.String({ minLength: 1 }),
  characterProfiles: Type.String({ minLength: 1 }),
  keyEvents: Type.String({ minLength: 1 }),
  powerSystem: Type.String({ minLength: 1 }),
  writingStyle: Type.String({ minLength: 1 }),
});
