import {
  PlayEventSchema,
  PlayMutationSchema,
  type PlayEdgeInput,
  type PlayEntity,
  type PlayEntityInput,
  type PlayEvent,
  type PlayEventInput,
  type PlayEvidenceStatus,
  type PlayMutationInput,
  type PlayStateSlot,
  type PlayStateSlotInput,
} from "../models/play.js";
import type { PlayGraphSnapshot } from "./play-db.js";

export interface PlayReducerDB {
  readonly snapshot?: () => PlayGraphSnapshot;
  readonly replaceWithSnapshot?: (snapshot: PlayGraphSnapshot) => void;
  readonly transaction?: <T>(fn: () => T) => T;
  readonly getEntity: (id: string) => PlayEntity | null;
  readonly upsertEntity: (entity: PlayEntityInput) => void;
  readonly upsertEdge: (edge: PlayEdgeInput) => void;
  readonly expireEdge: (edgeId: string, validUntilEventId: string) => void;
  readonly upsertStateSlot: (slot: PlayStateSlotInput) => void;
  readonly getStateSlotsForEntity: (entityId: string) => PlayStateSlot[];
  readonly recordEvent: (event: PlayEventInput) => void;
}

export interface ApplyPlayMutationInput {
  readonly db: PlayReducerDB;
  readonly mutation: PlayMutationInput;
  readonly rawInput: string;
  readonly createdAt?: string;
}

export interface ApplyPlayMutationResult {
  readonly event: PlayEvent;
  readonly blocked: boolean;
}

const EVIDENCE_ORDER: readonly PlayEvidenceStatus[] = [
  "unknown",
  "hinted",
  "seen",
  "collected",
  "verified",
  "weaponized",
  "exposed",
  "exhausted",
];

export function applyPlayMutation(input: ApplyPlayMutationInput): ApplyPlayMutationResult {
  const mutation = PlayMutationSchema.parse(input.mutation);
  const event = PlayEventSchema.parse({
    id: mutation.eventId,
    turn: mutation.turn,
    actionKind: mutation.actionKind,
    rawInput: input.rawInput,
    outcomeSummary: mutation.summary || mutation.blockedReason,
    timeAdvance: mutation.timeAdvance,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });

  validateMutation(input.db, mutation);

  const apply = () => {
    input.db.recordEvent(event);

    if (!mutation.blocked) {
      applyGraphChanges(input.db, mutation);
    }

    return { event, blocked: mutation.blocked };
  };

  return input.db.transaction ? input.db.transaction(apply) : apply();
}

export interface SeedPlayGraphInput {
  readonly db: PlayReducerDB;
  readonly mutation: PlayMutationInput;
}

export function seedPlayGraph(input: SeedPlayGraphInput): void {
  const mutation = PlayMutationSchema.parse(input.mutation);
  validateMutation(input.db, mutation);
  const apply = () => {
    if (!mutation.blocked) applyGraphChanges(input.db, mutation);
  };
  if (input.db.transaction) input.db.transaction(apply);
  else apply();
}

function validateMutation(db: PlayReducerDB, mutation: ReturnType<typeof PlayMutationSchema.parse>): void {
  const upsertedEntityIds = new Set(mutation.entities.upsert.map((entity) => entity.id));
  const entityExists = (entityId: string): boolean => upsertedEntityIds.has(entityId) || db.getEntity(entityId) !== null;
  const findEntity = (entityId: string): PlayEntity | PlayEntityInput | null =>
    mutation.entities.upsert.find((entity) => entity.id === entityId) ?? db.getEntity(entityId);

  for (const edge of mutation.edges.upsert) {
    if (!entityExists(edge.fromId) || !entityExists(edge.toId)) {
      throw new Error(`Play mutation edge ${edge.id} references a missing endpoint: ${edge.fromId} -> ${edge.toId}`);
    }
    if (isRecord(edge.value) && edge.value.role === "holding" && !isPhysicalHoldingTarget(findEntity(edge.toId), edge.value)) {
      throw new Error(`Play mutation edge ${edge.id} marks a non-physical target as held: ${edge.toId}`);
    }
  }

  for (const slot of mutation.stateSlots.upsert) {
    if (slot.ownerEntityId && !entityExists(slot.ownerEntityId)) {
      throw new Error(`Play mutation references missing entity in state slot ${slot.id}: ${slot.ownerEntityId}`);
    }
  }

  for (const transition of mutation.evidence.transitions) {
    const entity = findEntity(transition.entityId);
    if (!entity || (entity.type !== "evidence" && entity.type !== "clue")) {
      throw new Error(`Play evidence transition references a non-evidence entity: ${transition.entityId}`);
    }
    const current = currentEvidenceStatus(db, transition.entityId);
    if (transition.from && transition.from !== current) {
      throw new Error(`Play evidence transition expected ${transition.entityId}=${transition.from}, found ${current}`);
    }
    if (evidenceRank(transition.to) < evidenceRank(current)) {
      throw new Error(`Play evidence transition goes backwards for ${transition.entityId}: ${current} -> ${transition.to}`);
    }
  }
}

function applyGraphChanges(db: PlayReducerDB, mutation: ReturnType<typeof PlayMutationSchema.parse>): void {
  for (const entity of mutation.entities.upsert) {
    db.upsertEntity(entity);
  }
  for (const edge of mutation.edges.expire) {
    db.expireEdge(edge.edgeId, edge.validUntilEventId);
  }
  for (const edge of mutation.edges.upsert) {
    db.upsertEdge(edge);
  }
  for (const slot of mutation.stateSlots.upsert) {
    db.upsertStateSlot(slot);
  }
  for (const transition of mutation.evidence.transitions) {
    db.upsertStateSlot({
      id: evidenceStatusSlotId(transition.entityId),
      ownerEntityId: transition.entityId,
      kind: "evidence",
      label: "证据状态",
      value: {
        previous: currentEvidenceStatus(db, transition.entityId),
        status: transition.to,
        reason: transition.reason,
      },
      updatedEventId: mutation.eventId,
    });
  }
}

function isPhysicalHoldingTarget(target: PlayEntity | PlayEntityInput | null, value: Record<string, unknown>): boolean {
  if (!target) return false;
  if (target.type === "item") return true;
  if (value.physical === true || value.portable === true) {
    return target.type === "evidence" || target.type === "clue" || target.type === "claim" || target.type === "proof_chain";
  }
  return false;
}

function currentEvidenceStatus(db: PlayReducerDB, entityId: string): PlayEvidenceStatus {
  const slot = db.getStateSlotsForEntity(entityId)
    .find((candidate) => candidate.id === evidenceStatusSlotId(entityId) || candidate.kind === "evidence");
  if (!slot || !isRecord(slot.value)) return "unknown";
  const status = slot.value.status;
  return typeof status === "string" && (EVIDENCE_ORDER as readonly string[]).includes(status)
    ? status as PlayEvidenceStatus
    : "unknown";
}

function evidenceStatusSlotId(entityId: string): string {
  return `evidence:${entityId}:status`;
}

function evidenceRank(status: PlayEvidenceStatus): number {
  return EVIDENCE_ORDER.indexOf(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
