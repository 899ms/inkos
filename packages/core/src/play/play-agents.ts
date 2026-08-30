import { z } from "zod";
import { Type, type Static } from "@mariozechner/pi-ai";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import {
  PlayActionIntentSchema,
  PlayMutationSchema,
  type PlayActionIntent,
  type PlayActionIntentInput,
  type PlayMutation,
  type PlayMutationInput,
} from "../models/play.js";

export interface PlayActionInterpreterInput {
  readonly input: string;
  readonly sceneBrief: string;
  readonly language?: "zh" | "en";
}

export interface PlayWorldMutatorInput {
  readonly turn: number;
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly context: string;
  readonly language?: "zh" | "en";
}

export interface PlaySceneRenderInput {
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly context?: string;
  readonly mutationSummary: string;
  readonly stateBrief: string;
  readonly replayContext?: string;
  readonly language?: "zh" | "en";
  // The world's premise — a persistent anchor so the scene stays in the
  // established era/setting/genre and doesn't drift (a modern shop must not grow
  // night-watchmen and oil lamps).
  readonly worldPremise?: string;
}

export interface PlaySceneReconcileInput {
  readonly turn: number;
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly mutation: PlayMutationInput;
  readonly sceneText: string;
  readonly context: string;
  readonly stateBrief: string;
  readonly language?: "zh" | "en";
  readonly worldPremise?: string;
}

const PlaySceneRenderSchema = z.object({
  sceneText: z.string().min(1),
  suggestedActions: z.array(z.string().min(1)),
}).strict();
export type PlaySceneRender = z.infer<typeof PlaySceneRenderSchema>;

const PlayEntityResultSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal("actor"), Type.Literal("location"), Type.Literal("item"),
    Type.Literal("evidence"), Type.Literal("clue"), Type.Literal("claim"),
    Type.Literal("proof_chain"), Type.Literal("organization"), Type.Literal("rule"),
    Type.Literal("scene"), Type.Literal("event"),
  ]),
  label: Type.String(),
  summary: Type.String(),
  status: Type.Optional(Type.String()),
});

const PlayEdgeResultSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  fromId: Type.String(),
  type: Type.String(),
  toId: Type.String(),
  value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  visibility: Type.Optional(Type.Record(Type.String(), Type.String())),
  strength: Type.Optional(Type.Number()),
});

const PlayStateSlotResultSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  ownerEntityId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  kind: Type.Union([
    Type.Literal("resource"), Type.Literal("relation"), Type.Literal("pressure"),
    Type.Literal("clue"), Type.Literal("evidence"), Type.Literal("flag"), Type.Literal("timer"),
  ]),
  label: Type.String(),
  value: Type.Unknown(),
});

const PlayMutationResultSchema = Type.Object({
  summary: Type.String(),
  timeAdvance: Type.Optional(Type.Object({
    elapsed: Type.String(),
    anchor: Type.String(),
    rationale: Type.String(),
    synchronized: Type.Array(Type.String()),
  })),
  entities: Type.Array(PlayEntityResultSchema),
  edges: Type.Array(PlayEdgeResultSchema),
  expiredEdges: Type.Array(Type.Object({
    edgeId: Type.String(),
    reason: Type.String(),
  })),
  stateSlots: Type.Array(PlayStateSlotResultSchema),
  evidenceTransitions: Type.Array(Type.Object({
    entityId: Type.String(),
    from: Type.Optional(Type.Union([
      Type.Literal("unknown"), Type.Literal("hinted"), Type.Literal("seen"),
      Type.Literal("collected"), Type.Literal("verified"), Type.Literal("weaponized"),
      Type.Literal("exposed"), Type.Literal("exhausted"),
    ])),
    to: Type.Union([
      Type.Literal("unknown"), Type.Literal("hinted"), Type.Literal("seen"),
      Type.Literal("collected"), Type.Literal("verified"), Type.Literal("weaponized"),
      Type.Literal("exposed"), Type.Literal("exhausted"),
    ]),
    reason: Type.Optional(Type.String()),
  })),
  blocked: Type.Boolean(),
  blockedReason: Type.String(),
  notes: Type.Array(Type.String()),
});

const WORLD_MUTATION_TOOL = {
  name: "submit_world_mutation",
  label: "Submit world mutation",
  description: "Submit the complete world-state transition caused by this action. Host-owned event metadata is intentionally omitted.",
  parameters: PlayMutationResultSchema,
} as const;

const GRAPH_RECONCILIATION_TOOL = {
  name: "submit_graph_reconciliation",
  label: "Submit graph reconciliation",
  description: "Submit only graph facts present in the rendered scene but missing from the applied mutation. Submit empty arrays when nothing is missing.",
  parameters: PlayMutationResultSchema,
} as const;

const PLAY_ACTION_TOOL = {
  name: "submit_play_action",
  label: "Submit play action",
  description: "Submit the interpreted player action without changing world state.",
  parameters: Type.Object({
    actionKind: Type.Union([
      Type.Literal("look"), Type.Literal("say"), Type.Literal("move"),
      Type.Literal("do"), Type.Literal("wait"),
    ]),
    targetEntityLabel: Type.Optional(Type.String()),
    targetLocationLabel: Type.Optional(Type.String()),
    intent: Type.String(),
    manner: Type.Optional(Type.String()),
    risk: Type.Optional(Type.String()),
    ambiguity: Type.Optional(Type.String()),
    secondaryActions: Type.Optional(Type.Array(Type.String())),
  }),
} as const;

export class PlayActionInterpreterAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-action-interpreter";
  }

  async interpret(input: PlayActionInterpreterInput): Promise<PlayActionIntent> {
    const { result } = await this.submitStructured([
      { role: "system", content: buildActionInterpreterSystemPrompt(input.language ?? "zh") },
      { role: "user", content: buildActionInterpreterUserPrompt(input, input.language ?? "zh") },
    ], PLAY_ACTION_TOOL, { temperature: 0.15, maxTokens: 1024 });
    return PlayActionIntentSchema.parse(result);
  }
}

export class PlayWorldMutatorAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-world-mutator";
  }

  async proposeMutation(input: PlayWorldMutatorInput): Promise<PlayMutation> {
    const language = input.language ?? "zh";
    const actionKind = PlayActionIntentSchema.parse(input.action).actionKind;
    const systemPrompt = buildWorldMutatorSystemPrompt(language);
    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildWorldMutatorUserPrompt(input, language) },
    ];

    const { result: raw } = await this.submitStructured(
      messages,
      WORLD_MUTATION_TOOL,
      { temperature: 0.25, maxTokens: 4096 },
    );
    const mutation = mutationFromStructuredResult(raw, input.turn, actionKind);
    if (!hasMutationResult(mutation)) {
      throw new Error("Play world mutation was empty; the turn was not committed.");
    }
    return mutation;
  }
}

function mutationFromStructuredResult(
  raw: Static<typeof PlayMutationResultSchema>,
  turn: number,
  actionKind: PlayActionIntent["actionKind"],
): PlayMutation {
  const eventId = `evt-${turn}`;
  const entities = raw.entities.map((entity) => ({
        ...(entity as Record<string, unknown>),
        createdEventId: eventId,
        updatedEventId: eventId,
      }));
  const edges = raw.edges.map((edge) => ({
        ...(edge as Record<string, unknown>),
        validFromEventId: eventId,
        validUntilEventId: null,
        sourceEventId: eventId,
      }));
  const stateSlots = raw.stateSlots.map((slot) => ({
        ...(slot as Record<string, unknown>),
        updatedEventId: eventId,
      }));

  return PlayMutationSchema.parse({
    eventId,
    turn,
    actionKind,
    summary: raw.summary,
    timeAdvance: raw.timeAdvance,
    entities: { upsert: entities },
    edges: {
      upsert: edges,
      expire: raw.expiredEdges.map((edge) => ({
        ...(edge as Record<string, unknown>),
        validUntilEventId: eventId,
      })),
    },
    stateSlots: { upsert: stateSlots },
    evidence: { transitions: raw.evidenceTransitions },
    blocked: raw.blocked,
    blockedReason: raw.blockedReason,
    notes: raw.notes,
  });
}

function hasMutationResult(mutation: PlayMutation): boolean {
  return mutation.blocked
    || Boolean(mutation.summary.trim())
    || Boolean(mutation.timeAdvance)
    || mutation.entities.upsert.length > 0
    || mutation.edges.upsert.length > 0
    || mutation.edges.expire.length > 0
    || mutation.stateSlots.upsert.length > 0
    || mutation.evidence.transitions.length > 0
    || mutation.notes.length > 0;
}

export class PlaySceneRendererAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-scene-renderer";
  }

  async render(input: PlaySceneRenderInput & { readonly mode?: "open" | "guided" }): Promise<PlaySceneRender> {
    const language = input.language ?? "zh";
    const mode = input.mode ?? "open";
    const systemPrompt = buildSceneRendererSystemPrompt(mode, language);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildSceneRendererUserPrompt(input, language) },
    ];
    const { result: raw } = await this.submitStructured(
      messages,
      {
        name: "submit_play_scene",
        label: "Submit play scene",
        description: mode === "guided"
          ? "Submit the rendered scene and grounded optional player choices."
          : "Submit the rendered open-world scene with an empty suggestedActions array.",
        parameters: Type.Object({
          sceneText: Type.String({ minLength: 1 }),
          suggestedActions: mode === "open"
            ? Type.Array(Type.String({ minLength: 1 }), { maxItems: 0 })
            : Type.Array(Type.String({ minLength: 1 })),
        }),
      },
      { temperature: 0.45, maxTokens: 4096 },
    );
    return PlaySceneRenderSchema.parse(raw);
  }
}

export class PlaySceneReconcilerAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-scene-reconciler";
  }

  async reconcile(input: PlaySceneReconcileInput): Promise<PlayMutationInput> {
    const language = input.language ?? "zh";
    const actionKind = PlayActionIntentSchema.parse(input.action).actionKind;
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildSceneReconcilerSystemPrompt(language) },
      { role: "user", content: buildSceneReconcilerUserPrompt(input, language) },
    ];
    const { result: raw } = await this.submitStructured(
      messages,
      GRAPH_RECONCILIATION_TOOL,
      { temperature: 0.1, maxTokens: 2048 },
    );
    return mutationFromStructuredResult(raw, input.turn, actionKind);
  }
}

function buildSceneReconcilerSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You reconcile an interactive-fiction scene with the world graph.",
      "Compare the rendered prose against the already applied changes and current state summary.",
      "If the prose introduced a concrete named object, clue, evidence, location, organization, or person that is not represented in the applied changes/current state, submit ONLY those missing graph facts.",
      "Do not rewrite prose. Do not invent facts that are not in the rendered scene. If nothing is missing, submit empty arrays.",
      "For tangible things the player now physically holds, add a holding edge from actor_player with value.role=\"holding\"; if the target is evidence/clue/claim/proof_chain rather than an item, also set value.physical=true. Observed phenomena or learned facts are not holdings.",
      "Call submit_graph_reconciliation once. The host supplies eventId, turn, and actionKind.",
    ].join("\n");
  }
  return [
    "你负责把互动小说正文和世界图谱对齐。",
    "对照已经应用的本回合变化、当前状态摘要和最终正文。",
    "如果正文里出现了具体且具名的新物件、线索、证据、地点、组织或人物，但它还没有体现在已应用变化/当前状态里，只提交这些缺失图谱事实。",
    "不要改正文，不要发明正文没有的事实。没有缺失就提交空数组。",
    "玩家获得或拿在手里的实物，需要补一条 actor_player 指向该实体、value.role=\"holding\" 的 edge；如果目标是 evidence/clue/claim/proof_chain 而不是 item，还要设置 value.physical=true。观察到的现象或知道的信息不是持有物。",
    "调用一次 submit_graph_reconciliation；eventId、turn、actionKind 由宿主补入。",
  ].join("\n");
}

function buildSceneReconcilerUserPrompt(input: PlaySceneReconcileInput, language: "zh" | "en"): string {
  const actionKind = PlayActionIntentSchema.parse(input.action).actionKind;
  const eventId = `evt-${input.turn}`;
  if (language === "en") {
    return [
      `eventId: ${eventId}`,
      `turn: ${input.turn}`,
      `actionKind: ${actionKind}`,
      "",
      ...(input.worldPremise ? ["World setting:", input.worldPremise, ""] : []),
      "Player input:",
      input.input,
      "",
      "Current context before this turn:",
      input.context,
      "",
      "Applied mutation:",
      JSON.stringify(PlayMutationSchema.parse(input.mutation), null, 2),
      "",
      "Current state summary:",
      input.stateBrief,
      "",
      "Rendered scene:",
      input.sceneText,
    ].join("\n");
  }
  return [
    `eventId: ${eventId}`,
    `turn: ${input.turn}`,
    `actionKind: ${actionKind}`,
    "",
    ...(input.worldPremise ? ["世界设定：", input.worldPremise, ""] : []),
    "玩家输入：",
    input.input,
    "",
    "本回合前的当前上下文：",
    input.context,
    "",
    "已应用 mutation：",
    JSON.stringify(PlayMutationSchema.parse(input.mutation), null, 2),
    "",
    "当前状态摘要：",
    input.stateBrief,
    "",
    "最终正文：",
    input.sceneText,
  ].join("\n");
}

function buildActionInterpreterSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You are an interactive-fiction action interpreter.",
      "Your job is to normalize one line of the player's natural language into one of five action kinds: look / say / move / do / wait.",
      "Do not add drama for the player, do not advance the plot, do not write scene prose.",
      "look = observe/examine/recall a clue; say = speak/probe/confront; move = move to a location; do = perform an action/use an item/investigate; wait = wait/stall/watch.",
      "Submit the normalized action through the result tool.",
    ].join("\n");
  }
  return [
    "你是互动小说动作理解器。",
    "你的任务是把玩家一句自然语言，归一成五类动作之一：look / say / move / do / wait。",
    "不要替玩家加戏，不要直接推进剧情，不要写场景正文。",
    "look=观察/检查/回忆线索；say=说话/试探/质问；move=移动到地点；do=执行动作/使用物品/调查；wait=等待/拖延/旁观。",
    "通过结果工具提交归一后的动作。",
  ].join("\n");
}

function buildActionInterpreterUserPrompt(input: PlayActionInterpreterInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Current scene:",
      input.sceneBrief,
      "",
      "Player input:",
      input.input,
      "",
      "Output fields: actionKind, targetEntityLabel?, targetLocationLabel?, intent, manner, risk, ambiguity, secondaryActions.",
    ].join("\n");
  }
  return [
    "当前场景：",
    input.sceneBrief,
    "",
    "玩家输入：",
    input.input,
    "",
    "输出字段：actionKind, targetEntityLabel?, targetLocationLabel?, intent, manner, risk, ambiguity, secondaryActions。",
  ].join("\n");
}

function buildWorldMutatorSystemPrompt(language: "zh" | "en"): string {
  const contract = language === "en"
    ? [
        "Draft this turn's state changes from the player's literal action and authoritative context using the activated play-world Skill. Do not write scene prose or commit state.",
        "Create only facts made real by this turn. Reuse exact roster ids. The player id is always actor_player; only its label, summary, and status vary.",
        "Represent tangible discovered or held things as item/evidence/clue entities. A physical holding is an actor_player edge with value.role=holding; set value.physical=true for physical evidence or clues. Mere knowledge is observed, not held.",
        "Record meaningful relationships as edges with value.role=relation. stateSlots are optional and appear only when the world contract authorizes that kind of tracking.",
        "For non-opening turns, timeAdvance records the natural elapsed duration, resulting anchor, rationale, and synchronized off-screen changes. It is not a fixed tick.",
        "If the action cannot proceed, set blocked=true with blockedReason.",
        "Call submit_world_mutation once with summary, timeAdvance, entities, edges, stateSlots, evidenceTransitions, blocked, blockedReason, and notes. The host owns eventId, turn, and actionKind.",
      ]
    : [
        "按已激活的开放世界 Skill，根据玩家原话与权威上下文起草本回合状态变化。不要写场景正文，也不要替宿主落库。",
        "只创建本回合真正落地的事实，并复用名册精确 id。玩家 id 永远是 actor_player，只可改变 label、summary、status。",
        "玩家发现或持有的实物必须建成 item/evidence/clue 实体。实际持有使用 actor_player 指向实体且 value.role=holding；物理证据或线索再设 value.physical=true。只知道某事属于 observed，不是 holding。",
        "有意义的关系写成 value.role=relation 的 edge。只有世界契约允许时才使用 stateSlots。",
        "非开场回合的 timeAdvance 记录动作自然经过时长、结束时间锚、理由和同期世界变化，不是固定 tick。",
        "动作无法执行时设置 blocked=true 和 blockedReason。",
        "调用一次 submit_world_mutation，提交 summary、timeAdvance、entities、edges、stateSlots、evidenceTransitions、blocked、blockedReason、notes；eventId、turn、actionKind 由宿主补入。",
      ];
  return contract.join("\n");
}

function buildWorldMutatorUserPrompt(input: PlayWorldMutatorInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      `turn: ${input.turn}`,
      "Player's words:",
      input.input,
      "",
      "Action interpretation:",
      JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
      "",
      "Current context:",
      input.context,
      "",
      "Every new or referenced entity, edge, and state-slot id must be stable, readable, and short.",
    ].join("\n");
  }
  return [
    `turn: ${input.turn}`,
    "玩家原话：",
    input.input,
    "",
    "动作理解：",
    JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
    "",
    "当前上下文：",
    input.context,
    "",
    "所有新增或引用的实体、关系和状态槽 id 都要稳定、可读、短小。",
  ].join("\n");
}

export function buildSceneRendererSystemPrompt(mode: "open" | "guided" = "open", language: "zh" | "en" = "zh"): string {
  const actionsRule = language === "en"
    ? mode === "guided"
      ? "suggestedActions contains sparse optional springboards only at a genuine decision point."
      : "suggestedActions must be empty; open worlds use free player input."
    : mode === "guided"
      ? "suggestedActions 只在真实抉择点提供少量可选跳板。"
      : "suggestedActions 必须为空；开放世界只接收玩家自由输入。";
  const contract = language === "en"
    ? [
        "Render the playable scene with the activated play-world Skill from the already-applied state.",
        "Named people, places, objects, clues, and organizations may appear only when present in Applied changes or the current state. Treat supplied elapsed time and anchor as canonical.",
        "sceneText is narrative prose only; choices belong only in suggestedActions.",
        actionsRule,
        "Submit sceneText and suggestedActions through the result tool.",
      ]
    : [
        "按已激活的开放世界 Skill，根据已经应用的状态渲染可玩场景。",
        "具名人物、地点、物件、线索和组织只能来自已应用变化或当前状态；输入的 elapsed 与 anchor 是权威时间。",
        "sceneText 只写叙事正文，选择只能放在 suggestedActions。",
        actionsRule,
        "通过结果工具提交 sceneText 与 suggestedActions。",
      ];
  return contract.join("\n");
}

function buildSceneRendererUserPrompt(input: PlaySceneRenderInput, language: "zh" | "en"): string {
  const premise = input.worldPremise?.trim();
  const context = input.context?.trim();
  if (language === "en") {
    return [
      ...(premise ? ["World setting (always obey):", premise, ""] : []),
      ...(context ? ["Authoritative context before this action:", context, ""] : []),
      "Player's words:",
      input.input,
      "",
      "Action:",
      JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
      "",
      "Applied changes this turn:",
      input.mutationSummary,
      "",
      "Current state summary:",
      input.stateBrief,
      input.replayContext ? ["", "Replay constraints:", input.replayContext].join("\n") : "",
    ].join("\n");
  }
  return [
    ...(premise ? ["世界设定（始终遵守）：", premise, ""] : []),
    ...(context ? ["本回合前的权威上下文：", context, ""] : []),
    "玩家原话：",
    input.input,
    "",
    "动作：",
    JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
    "",
    "已应用的本回合变化：",
    input.mutationSummary,
    "",
    "当前状态摘要：",
    input.stateBrief,
    input.replayContext ? ["", "重写约束：", input.replayContext].join("\n") : "",
  ].join("\n");
}
