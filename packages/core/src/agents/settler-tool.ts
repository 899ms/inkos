import { Type } from "@sinclair/typebox";

const HookRecordToolSchema = Type.Object({
  hookId: Type.String(),
  startChapter: Type.Integer({ minimum: 0 }),
  type: Type.String(),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("progressing"),
    Type.Literal("deferred"),
    Type.Literal("resolved"),
  ]),
  lastAdvancedChapter: Type.Integer({ minimum: 0 }),
  expectedPayoff: Type.String(),
  notes: Type.String(),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  paysOffInArc: Type.Optional(Type.String()),
});

const ChapterSummaryToolSchema = Type.Object({
  title: Type.String(),
  characters: Type.String(),
  events: Type.String(),
  stateChanges: Type.String(),
  hookActivity: Type.String(),
  mood: Type.String(),
  chapterType: Type.String(),
});

const StateFactToolSchema = Type.Object({
  subject: Type.String({ minLength: 1, description: "Stable entity or scope the fact describes." }),
  predicate: Type.String({ minLength: 1, description: "Natural-language relation or state name." }),
  object: Type.String({ minLength: 1, description: "Value explicitly established by the chapter." }),
});

const StateFactSelectorToolSchema = Type.Object({
  subject: Type.String({ minLength: 1 }),
  predicate: Type.String({ minLength: 1 }),
  object: Type.Optional(Type.String({ minLength: 1 })),
});

export const SettlementToolSchema = Type.Object({
  postSettlement: Type.String({ description: "Concise account of the state changes grounded in this chapter." }),
  factOps: Type.Object({
    upsert: Type.Array(StateFactToolSchema, { description: "Facts made current by this chapter." }),
    expire: Type.Array(StateFactSelectorToolSchema, { description: "Previously active facts explicitly ended or superseded by this chapter." }),
  }),
  hookOps: Type.Object({
    upsert: Type.Array(HookRecordToolSchema),
    mention: Type.Array(Type.String()),
    resolve: Type.Array(Type.String()),
    defer: Type.Array(Type.String()),
  }),
  newHookCandidates: Type.Array(Type.Object({
    type: Type.String({ minLength: 1 }),
    expectedPayoff: Type.String({ minLength: 1 }),
    notes: Type.String(),
  })),
  chapterSummary: ChapterSummaryToolSchema,
});
