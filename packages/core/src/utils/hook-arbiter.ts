import {
  RuntimeStateDeltaSchema,
  type HookRecord,
  type NewHookCandidate,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";
import { normalizeHookId } from "./story-markdown.js";

export interface HookArbiterDecision {
  readonly action: "created" | "rejected";
  readonly reason: string;
  readonly hookId?: string;
  readonly candidate: NewHookCandidate;
}

interface PendingHookCandidate extends NewHookCandidate {
  readonly preferredHookId?: string;
}

export function arbitrateRuntimeStateDeltaHooks(params: {
  readonly hooks: ReadonlyArray<HookRecord>;
  readonly delta: RuntimeStateDelta;
  readonly allowNewHooks?: boolean;
}): {
  readonly resolvedDelta: RuntimeStateDelta;
  readonly decisions: ReadonlyArray<HookArbiterDecision>;
} {
  const delta = RuntimeStateDeltaSchema.parse(params.delta);
  const workingHooks = params.hooks.map((hook) => ({ ...hook }));
  const knownHookIds = new Set(workingHooks.map((hook) => hook.hookId));
  const upsertsById = new Map<string, HookRecord>();
  const mentions = new Set(delta.hookOps.mention);
  const resolves = uniqueStrings(delta.hookOps.resolve);
  const defers = uniqueStrings(delta.hookOps.defer);
  const fallbackCandidates: PendingHookCandidate[] = [];
  const decisions: HookArbiterDecision[] = [];

  for (const hook of delta.hookOps.upsert) {
    if (knownHookIds.has(hook.hookId)) {
      const normalized = { ...hook };
      upsertsById.set(normalized.hookId, normalized);
      replaceWorkingHook(workingHooks, normalized);
      continue;
    }

    fallbackCandidates.push({
      type: hook.type,
      expectedPayoff: hook.expectedPayoff,
      notes: hook.notes,
      preferredHookId: hook.hookId,
    });
  }

  for (const candidate of [...fallbackCandidates, ...delta.newHookCandidates]) {
    if (params.allowNewHooks === false) {
      decisions.push({
        action: "rejected",
        reason: "new_hooks_disabled",
        candidate,
      });
      continue;
    }

    const created = createCanonicalHook({
      candidate,
      chapter: delta.chapter,
      existingIds: new Set([
        ...workingHooks.map((hook) => hook.hookId),
        ...upsertsById.keys(),
      ]),
    });
    upsertsById.set(created.hookId, created);
    workingHooks.push(created);
    decisions.push({
      action: "created",
    reason: "admit",
      hookId: created.hookId,
      candidate,
    });
  }

  const resolvedDelta = RuntimeStateDeltaSchema.parse({
    ...delta,
    hookOps: {
      upsert: [...upsertsById.values()].sort(sortHooks),
      mention: [...mentions]
        .filter((hookId) => !upsertsById.has(hookId))
        .filter((hookId) => !resolves.includes(hookId))
        .filter((hookId) => !defers.includes(hookId))
        .sort(),
      resolve: resolves,
      defer: defers,
    },
    newHookCandidates: [],
  });

  return {
    resolvedDelta,
    decisions,
  };
}

function createCanonicalHook(params: {
  readonly candidate: PendingHookCandidate;
  readonly chapter: number;
  readonly existingIds: ReadonlySet<string>;
}): HookRecord {
  return {
    hookId: buildCanonicalHookId(params.candidate, params.existingIds),
    startChapter: params.chapter,
    type: params.candidate.type.trim(),
    status: "open",
    lastAdvancedChapter: params.chapter,
    expectedPayoff: params.candidate.expectedPayoff.trim(),
    notes: params.candidate.notes.trim(),
  };
}

function buildCanonicalHookId(
  candidate: PendingHookCandidate,
  existingIds: ReadonlySet<string>,
): string {
  const preferred = normalizeHookId(candidate.preferredHookId);
  if (preferred && !existingIds.has(preferred)) {
    return preferred;
  }

  const base = "hook";
  let next = base;
  let suffix = 2;

  while (existingIds.has(next)) {
    next = `${base}-${suffix}`;
    suffix += 1;
  }

  return next;
}

function replaceWorkingHook(workingHooks: HookRecord[], hook: HookRecord): void {
  const index = workingHooks.findIndex((candidate) => candidate.hookId === hook.hookId);
  if (index >= 0) {
    workingHooks[index] = hook;
    return;
  }

  workingHooks.push(hook);
}

function sortHooks(left: HookRecord, right: HookRecord): number {
  return left.startChapter - right.startChapter
    || left.lastAdvancedChapter - right.lastAdvancedChapter
    || left.hookId.localeCompare(right.hookId);
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
