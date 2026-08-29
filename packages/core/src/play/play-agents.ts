import { z } from "zod";
import { Type } from "@mariozechner/pi-ai";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import {
  PlayActionIntentSchema,
  PlayMutationSchema,
  type PlayActionIntent,
  type PlayActionIntentInput,
  type PlayMutation,
  type PlayMutationInput,
} from "../models/play.js";
import { appendPromptPackGuidance } from "../prompts/prompt-pack.js";

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
  suggestedActions: z.array(z.string().min(1)).min(0).max(4).default([]),
});
export type PlaySceneRender = z.infer<typeof PlaySceneRenderSchema>;

const PlayEntityResultSchema = Type.Object({
  id: Type.Optional(Type.String()),
  type: Type.Union([
    Type.Literal("actor"), Type.Literal("location"), Type.Literal("item"),
    Type.Literal("evidence"), Type.Literal("clue"), Type.Literal("claim"),
    Type.Literal("proof_chain"), Type.Literal("organization"), Type.Literal("rule"),
    Type.Literal("scene"), Type.Literal("event"),
  ]),
  label: Type.String(),
  summary: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});

const PlayEdgeResultSchema = Type.Object({
  id: Type.Optional(Type.String()),
  fromId: Type.String(),
  type: Type.String(),
  toId: Type.String(),
  value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  visibility: Type.Optional(Type.Record(Type.String(), Type.String())),
  strength: Type.Optional(Type.Number()),
  confidence: Type.Optional(Type.Number()),
});

const PlayStateSlotResultSchema = Type.Object({
  id: Type.Optional(Type.String()),
  ownerEntityId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  kind: Type.Union([
    Type.Literal("resource"), Type.Literal("relation"), Type.Literal("pressure"),
    Type.Literal("clue"), Type.Literal("evidence"), Type.Literal("flag"), Type.Literal("timer"),
  ]),
  label: Type.String(),
  value: Type.Unknown(),
});

const PlayMutationResultSchema = Type.Object({
  summary: Type.Optional(Type.String()),
  timeAdvance: Type.Optional(Type.Object({
    elapsed: Type.String(),
    anchor: Type.Optional(Type.String()),
    rationale: Type.Optional(Type.String()),
    synchronized: Type.Optional(Type.Array(Type.String())),
  })),
  entities: Type.Optional(Type.Array(PlayEntityResultSchema)),
  edges: Type.Optional(Type.Array(PlayEdgeResultSchema)),
  expiredEdges: Type.Optional(Type.Array(Type.Object({
    edgeId: Type.String(),
    reason: Type.Optional(Type.String()),
  }))),
  stateSlots: Type.Optional(Type.Array(PlayStateSlotResultSchema)),
  evidenceTransitions: Type.Optional(Type.Array(Type.Object({
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
  }))),
  blocked: Type.Optional(Type.Boolean()),
  blockedReason: Type.Optional(Type.String()),
  notes: Type.Optional(Type.Array(Type.String())),
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

const PLAY_SCENE_RENDER_TOOL = {
  name: "submit_play_scene",
  label: "Submit play scene",
  description: "Submit the rendered scene and up to four immediate player actions grounded in the applied world state.",
  parameters: Type.Object({
    sceneText: Type.String({ minLength: 1 }),
    suggestedActions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 4 }),
  }),
} as const;

// A play turn runs three internal LLM calls (interpret → mutate → render). The
// transport-level retry in the provider does NOT cover HTTP 502/503/429 or
// "temporarily unavailable", so a single flaky upstream response would break the
// whole turn. Retry those here; each agent then applies its own safe failure policy.
function isRetryableLlmError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /50[0-9]|429|temporarily unavailable|timeout|timed out|socket|terminated|econn|network|fetch failed|bad gateway|service unavailable|rate limit/.test(msg);
}

async function chatWithRetry<T>(call: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryableLlmError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export class PlayActionInterpreterAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-action-interpreter";
  }

  async interpret(input: PlayActionInterpreterInput): Promise<PlayActionIntent> {
    // Never throw: a transient upstream error (after retries) or unparseable output
    // degrades to a generic action (the player's raw text as a "do"), not a crash.
    let raw: unknown = {};
    try {
      const response = await chatWithRetry(() => this.chat([
        { role: "system", content: buildActionInterpreterSystemPrompt(input.language ?? "zh") },
        { role: "user", content: buildActionInterpreterUserPrompt(input, input.language ?? "zh") },
      ], { temperature: 0.15, maxTokens: 1024 }));
      raw = parseJson(response.content);
    } catch { /* transient/malformed → degrade below */ }
    const parsed = PlayActionIntentSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : PlayActionIntentSchema.parse({ actionKind: "do", intent: input.input });
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
    const systemPrompt = await appendPromptPackGuidance(
      buildWorldMutatorSystemPrompt(language),
      { promptId: "play.mutator", projectRoot: this.ctx.projectRoot },
    );
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildWorldMutatorUserPrompt(input, language) },
    ];

    // Empty output cannot count as a completed turn: otherwise prose advances
    // while the canonical graph stays frozen. Give the model one repair turn,
    // then expose a blocked no-op instead of silently splitting state and prose.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await chatWithRetry(() => this.submitStructured(
          messages,
          WORLD_MUTATION_TOOL,
          { temperature: 0.25, maxTokens: 4096 },
        ));
        const mutation = mutationFromStructuredResult(raw, input.turn, actionKind);
        logDroppedMutationItems(raw, mutation, input.turn);
        if (hasMutationResult(mutation)) return mutation;
      } catch {
        // One operation-level retry below. Transport retries remain in the Pi harness.
      }
      if (attempt === 0) {
        messages.push({
          role: "user",
          content: language === "en"
            ? "No usable world result was submitted. Call submit_world_mutation with a summary and the concrete state, entity, relationship, or time changes. If the action cannot proceed, submit blocked=true with blockedReason."
            : "刚才没有提交可用的世界结算。调用 submit_world_mutation，写明 summary 和具体的状态、实体、关系或时间变化；动作不能执行时提交 blocked=true 与 blockedReason。",
        });
      }
    }

    return withHostMutationIdentity(PlayMutationSchema.parse({
      blocked: true,
      blockedReason: language === "en"
        ? "The model did not return a usable world-state transition. This turn did not advance."
        : "模型没有返回可用的世界状态变更，本回合未推进。",
    }), input.turn, actionKind);
  }
}

function mutationFromStructuredResult(
  raw: Record<string, unknown>,
  turn: number,
  actionKind: PlayActionIntent["actionKind"],
): PlayMutation {
  return withHostMutationIdentity(PlayMutationSchema.parse({
    summary: raw.summary,
    timeAdvance: raw.timeAdvance,
    entities: { upsert: raw.entities },
    edges: {
      upsert: raw.edges,
      expire: Array.isArray(raw.expiredEdges)
        ? raw.expiredEdges.map((edge) => ({
            ...(edge as Record<string, unknown>),
            validUntilEventId: `evt-${turn}`,
          }))
        : [],
    },
    stateSlots: { upsert: raw.stateSlots },
    evidence: { transitions: raw.evidenceTransitions },
    blocked: raw.blocked,
    blockedReason: raw.blockedReason,
    notes: raw.notes,
  }), turn, actionKind);
}

function withHostMutationIdentity(
  mutation: PlayMutation,
  turn: number,
  actionKind: PlayActionIntent["actionKind"],
): PlayMutation {
  return PlayMutationSchema.parse({
    ...mutation,
    eventId: `evt-${turn}`,
    turn,
    actionKind,
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

function rawUpsertCount(field: unknown): number {
  if (Array.isArray(field)) return field.length;
  if (field && typeof field === "object" && Array.isArray((field as { upsert?: unknown }).upsert)) {
    return (field as { upsert: unknown[] }).upsert.length;
  }
  return 0;
}

function logDroppedMutationItems(raw: unknown, mutation: PlayMutation, turn: number): void {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  const rawE = rawUpsertCount(r.entities);
  const rawEd = rawUpsertCount(r.edges);
  const rawS = rawUpsertCount(r.stateSlots);
  const keptE = mutation.entities.upsert.length;
  const keptEd = mutation.edges.upsert.length;
  const keptS = mutation.stateSlots.upsert.length;
  if (rawE > keptE || rawEd > keptEd || rawS > keptS) {
    // eslint-disable-next-line no-console -- intentional degradation observability
    console.warn(
      `[play-mutator] turn ${turn}: dropped malformed items — entities ${rawE}->${keptE}, edges ${rawEd}->${keptEd}, slots ${rawS}->${keptS}`,
    );
  }
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
    const systemPrompt = await appendPromptPackGuidance(
      buildSceneRendererSystemPrompt(input.mode ?? "open", language),
      { promptId: "play.renderer", projectRoot: this.ctx.projectRoot },
    );
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildSceneRendererUserPrompt(input, language) },
    ];
    const raw = await chatWithRetry(() => this.submitStructured(
      messages,
      PLAY_SCENE_RENDER_TOOL,
      { temperature: 0.45, maxTokens: 4096 },
    ));
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
    const eventId = `evt-${input.turn}`;
    const actionKind = PlayActionIntentSchema.parse(input.action).actionKind;
    const empty = emptyReconciliation(input.turn, actionKind);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildSceneReconcilerSystemPrompt(language) },
      { role: "user", content: buildSceneReconcilerUserPrompt(input, language) },
    ];
    try {
      const raw = await chatWithRetry(() => this.submitStructured(
        messages,
        GRAPH_RECONCILIATION_TOOL,
        { temperature: 0.1, maxTokens: 2048 },
      ));
      return mutationFromStructuredResult(raw, input.turn, actionKind);
    } catch {
      return empty;
    }
  }
}

function emptyReconciliation(turn: number, actionKind: PlayActionIntent["actionKind"]): PlayMutationInput {
  return {
    eventId: `evt-${turn}`,
    turn,
    actionKind,
    summary: "",
    entities: { upsert: [] },
    edges: { upsert: [], expire: [] },
    stateSlots: { upsert: [] },
    evidence: { transitions: [] },
    blocked: false,
    blockedReason: "",
    notes: [],
  };
}

function buildSceneReconcilerSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You reconcile an interactive-fiction scene with the world graph.",
      "Compare the rendered prose against the already applied changes and current state summary.",
      "If the prose introduced a concrete named object, clue, evidence, location, organization, or person that is not represented in the applied changes/current state, submit ONLY those missing graph facts.",
      "Do not rewrite prose. Do not invent facts that are not in the rendered scene. If nothing is missing, submit empty arrays.",
      "Use the same eventId/turn/actionKind. For tangible things the player now physically holds, add a holding edge from actor_player with value.role=\"holding\"; if the target is evidence/clue/claim/proof_chain rather than an item, also set value.physical=true. Observed phenomena or learned facts are not holdings.",
      "Call submit_graph_reconciliation once. The host supplies eventId, turn, and actionKind.",
    ].join("\n");
  }
  return [
    "你负责把互动小说正文和世界图谱对齐。",
    "对照已经应用的本回合变化、当前状态摘要和最终正文。",
    "如果正文里出现了具体且具名的新物件、线索、证据、地点、组织或人物，但它还没有体现在已应用变化/当前状态里，只提交这些缺失图谱事实。",
    "不要改正文，不要发明正文没有的事实。没有缺失就提交空数组。",
    "沿用同一个 eventId/turn/actionKind。玩家获得或拿在手里的实物，需要补一条 actor_player 指向该实体、value.role=\"holding\" 的 edge；如果目标是 evidence/clue/claim/proof_chain 而不是 item，还要设置 value.physical=true。观察到的现象或知道的信息不是持有物。",
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
      "Output strict JSON, no explanation.",
    ].join("\n");
  }
  return [
    "你是互动小说动作理解器。",
    "你的任务是把玩家一句自然语言，归一成五类动作之一：look / say / move / do / wait。",
    "不要替玩家加戏，不要直接推进剧情，不要写场景正文。",
    "look=观察/检查/回忆线索；say=说话/试探/质问；move=移动到地点；do=执行动作/使用物品/调查；wait=等待/拖延/旁观。",
    "输出严格 JSON，不要解释。",
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
      "Requirement: use eventId evt-" + input.turn + "; every new or referenced entity id must be stable, readable, and short.",
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
    "要求：eventId 使用 evt-" + input.turn + "；所有新增或引用的实体 id 要稳定、可读、短小。",
  ].join("\n");
}

export function buildSceneRendererSystemPrompt(mode: "open" | "guided" = "open", language: "zh" | "en" = "zh"): string {
  const actionsRule = language === "en"
    ? mode === "guided"
      ? "suggestedActions contains 0-3 optional springboards only at a genuine decision point."
      : "suggestedActions contains 0-3 optional hints and may be empty."
    : mode === "guided"
      ? "suggestedActions 只在真实抉择点提供 0-3 个可选跳板。"
      : "suggestedActions 可提供 0-3 个可选提示，也可以为空。";
  const contract = language === "en"
    ? [
        "Render the playable scene with the activated play-world Skill from the already-applied state.",
        "Carry out every completed part of the player's action before its aftermath. Preserve pre-action canon unless Applied changes update it.",
        "Named people, places, objects, clues, and organizations may appear only when present in Applied changes or the current state. Treat supplied elapsed time and anchor as canonical.",
        "sceneText is narrative prose only; choices belong only in suggestedActions.",
        actionsRule,
        "Return strict JSON: sceneText, suggestedActions.",
      ]
    : [
        "按已激活的开放世界 Skill，根据已经应用的状态渲染可玩场景。",
        "先写出玩家动作中已经完成的各部分，再写余波。除非已应用变化明确更新，否则保留动作前正典。",
        "具名人物、地点、物件、线索和组织只能来自已应用变化或当前状态；输入的 elapsed 与 anchor 是权威时间。",
        "sceneText 只写叙事正文，选择只能放在 suggestedActions。",
        actionsRule,
        "返回严格 JSON：sceneText, suggestedActions。",
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

function parseJson(raw: string): unknown {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Play agent did not return JSON.");
  }
}
