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
  expectedPayoff: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  paysOffInArc: Type.Optional(Type.String()),
});

const ChapterSummaryToolSchema = Type.Object({
  title: Type.String(),
  characters: Type.Optional(Type.String()),
  events: Type.Optional(Type.String()),
  stateChanges: Type.Optional(Type.String()),
  hookActivity: Type.Optional(Type.String()),
  mood: Type.Optional(Type.String()),
  chapterType: Type.Optional(Type.String()),
});

const LooseOpToolSchema = Type.Record(Type.String(), Type.Unknown());

export const SettlementToolSchema = Type.Object({
  postSettlement: Type.String({ description: "Concise account of the state changes grounded in this chapter." }),
  currentStatePatch: Type.Optional(Type.Object({
    currentLocation: Type.Optional(Type.String()),
    protagonistState: Type.Optional(Type.String()),
    currentGoal: Type.Optional(Type.String()),
    currentConstraint: Type.Optional(Type.String()),
    currentAlliances: Type.Optional(Type.String()),
    currentConflict: Type.Optional(Type.String()),
  })),
  hookOps: Type.Optional(Type.Object({
    upsert: Type.Optional(Type.Array(HookRecordToolSchema)),
    mention: Type.Optional(Type.Array(Type.String())),
    resolve: Type.Optional(Type.Array(Type.String())),
    defer: Type.Optional(Type.Array(Type.String())),
  })),
  newHookCandidates: Type.Optional(Type.Array(Type.Object({
    type: Type.String(),
    expectedPayoff: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  }))),
  chapterSummary: Type.Optional(ChapterSummaryToolSchema),
  subplotOps: Type.Optional(Type.Array(LooseOpToolSchema)),
  emotionalArcOps: Type.Optional(Type.Array(LooseOpToolSchema)),
  characterMatrixOps: Type.Optional(Type.Array(LooseOpToolSchema)),
  notes: Type.Optional(Type.Array(Type.String())),
});
