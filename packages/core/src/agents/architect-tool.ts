import { Type } from "@sinclair/typebox";

export const FoundationOutlineToolSchema = Type.Object({
  storyFrame: Type.String({ description: "Readable story foundation Markdown." }),
  volumeMap: Type.String({ description: "Readable volume and chapter-direction Markdown." }),
});

export const BookRulesDataToolSchema = Type.Object({
  protagonist: Type.Optional(Type.Object({
    name: Type.String(),
    personalityLock: Type.Optional(Type.Array(Type.String())),
    behavioralConstraints: Type.Optional(Type.Array(Type.String())),
  })),
  genreLock: Type.Optional(Type.Object({
    primary: Type.String(),
    forbidden: Type.Optional(Type.Array(Type.String())),
  })),
  narrativePerson: Type.Optional(Type.Union([Type.Literal("first"), Type.Literal("third")])),
  numericalSystemOverrides: Type.Optional(Type.Object({
    hardCap: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    resourceTypes: Type.Optional(Type.Array(Type.String())),
  })),
  eraConstraints: Type.Optional(Type.Object({
    enabled: Type.Boolean(),
    period: Type.Optional(Type.String()),
    region: Type.Optional(Type.String()),
  })),
  prohibitions: Type.Optional(Type.Array(Type.String())),
  enableFullCastTracking: Type.Optional(Type.Boolean()),
  fanficMode: Type.Optional(Type.Union([
    Type.Literal("canon"),
    Type.Literal("au"),
    Type.Literal("ooc"),
    Type.Literal("cp"),
  ])),
  allowedDeviations: Type.Optional(Type.Array(Type.String())),
});

export const FoundationDetailsToolSchema = Type.Object({
  roles: Type.Array(Type.Object({
    tier: Type.Union([Type.Literal("major"), Type.Literal("minor")]),
    name: Type.String(),
    content: Type.String({ description: "Readable role-card Markdown." }),
  })),
  bookRules: Type.String({ description: "Readable book-rules Markdown." }),
  bookRulesData: BookRulesDataToolSchema,
  pendingHooks: Type.Array(Type.Object({
    hookId: Type.String(),
    type: Type.String(),
    expectedPayoff: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  })),
});
