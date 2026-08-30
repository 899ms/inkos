import { Type } from "@sinclair/typebox";

export const FoundationOutlineToolSchema = Type.Object({
  storyFrame: Type.String({ minLength: 1, description: "Readable story foundation Markdown." }),
  volumeMap: Type.String({ minLength: 1, description: "Readable volume and chapter-direction Markdown." }),
});

export const BookRulesDataToolSchema = Type.Object({
  protagonist: Type.Optional(Type.Object({
    name: Type.String(),
    personalityLock: Type.Array(Type.String()),
    behavioralConstraints: Type.Array(Type.String()),
  })),
  genreLock: Type.Optional(Type.Object({
    primary: Type.String(),
    forbidden: Type.Array(Type.String()),
  })),
  narrativePerson: Type.Optional(Type.String({ description: "Narrative person in the user's own terms." })),
  prohibitions: Type.Array(Type.String()),
  enableFullCastTracking: Type.Boolean(),
  fanficMode: Type.Optional(Type.String()),
  allowedDeviations: Type.Array(Type.String()),
});

export const FoundationDetailsToolSchema = Type.Object({
  roles: Type.Array(Type.Object({
    tier: Type.Union([Type.Literal("major"), Type.Literal("minor")]),
    name: Type.String({ minLength: 1 }),
    content: Type.String({ minLength: 1, description: "Readable role-card Markdown." }),
  }), { minItems: 1 }),
  bookRules: Type.String({ minLength: 1, description: "Readable book-rules Markdown." }),
  bookRulesData: BookRulesDataToolSchema,
  pendingHooks: Type.Array(Type.Object({
    hookId: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    expectedPayoff: Type.String({ minLength: 1 }),
    notes: Type.String(),
  })),
});
