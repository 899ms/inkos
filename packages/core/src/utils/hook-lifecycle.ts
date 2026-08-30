import type { HookStatus } from "../models/runtime-state.js";

const HOOK_STATUSES = new Set<HookStatus>(["open", "progressing", "deferred", "resolved"]);

export function resolveHookStatusAlias(status: string | undefined | null): HookStatus | undefined {
  const normalized = status?.trim().toLowerCase() as HookStatus | undefined;
  return normalized && HOOK_STATUSES.has(normalized) ? normalized : undefined;
}

export function normalizeStoredHookStatus(status: string): HookStatus {
  return resolveHookStatusAlias(status) ?? "open";
}
