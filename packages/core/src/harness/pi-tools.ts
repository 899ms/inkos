import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import {
  type ActionResult,
  type WorkProfile,
} from "./contracts.js";
import {
  CapabilityRegistry,
  type CapabilityAction,
} from "./capability-registry.js";

export interface CreateCapabilityPiToolsOptions {
  readonly registry: CapabilityRegistry;
  readonly profile: WorkProfile;
  readonly executeAction: (
    capabilityId: string,
    actionId: string,
    parameters: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: unknown) => void,
  ) => Promise<ActionResult>;
  readonly includeAction?: (capabilityId: string, action: CapabilityAction) => boolean;
  readonly onResult?: (
    capabilityId: string,
    actionId: string,
    result: ActionResult,
  ) => void | Promise<void>;
}

export function createCapabilityPiTools(
  options: CreateCapabilityPiToolsOptions,
): ReadonlyArray<AgentTool<TSchema, unknown>> {
  return options.registry.forProfile(options.profile).flatMap((capability) => (
    capability.actions
      .filter((action) => options.includeAction?.(capability.id, action) ?? true)
      .map((action): AgentTool<TSchema, unknown> => ({
      name: capabilityToolName(capability.id, action.id),
      label: action.title,
      description: action.description,
      parameters: action.parameters,
      async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<unknown>> {
        if (signal?.aborted) throw signal.reason;
        const result = await options.executeAction(
          capability.id,
          action.id,
          params,
          signal,
          onUpdate ? (partialResult) => onUpdate(partialResult as AgentToolResult<ActionResult>) : undefined,
        );
        await options.onResult?.(capability.id, action.id, result);
        if (result.status === "error") {
          throw new CapabilityActionError(capability.id, action.id, result);
        }
        return {
          content: [{ type: "text", text: renderActionResultForAgent(result) }],
          // Studio renders domain-owned result cards (proposed_action, play
          // scene, chapter revision, etc.). The harness ActionResult remains
          // authoritative in the Episode ledger; Pi events expose its domain
          // payload when one exists.
          details: result.data ?? result,
        };
      },
      }))
  ));
}

export class CapabilityActionError extends Error {
  constructor(
    readonly capabilityId: string,
    readonly actionId: string,
    readonly result: ActionResult,
  ) {
    super(result.summary);
    this.name = "CapabilityActionError";
  }
}

export function capabilityToolName(capabilityId: string, actionId: string): string {
  return `${capabilityId}__${actionId}`;
}

export function capabilityActionId(toolName: string): string {
  const separator = toolName.indexOf("__");
  return separator >= 0 ? toolName.slice(separator + 2) : toolName;
}

function renderActionResultForAgent(result: ActionResult): string {
  const lines = [result.summary];
  if (result.content && result.content !== result.summary) lines.push(result.content);
  if (result.artifacts.length > 0) {
    lines.push("Artifacts:", ...result.artifacts.map((artifact) => (
      `- ${artifact.workId}/${artifact.artifactId}${artifact.revisionId ? `@${artifact.revisionId}` : ""}`
    )));
  }
  if (result.observations.length > 0) {
    lines.push("Observations:", ...result.observations.map((observation) => (
      `- [${observation.kind}/${observation.status}] ${observation.code}: ${observation.summary}`
    )));
  }
  if (result.nextActions.length > 0) {
    lines.push(`Next actions: ${result.nextActions.join(", ")}`);
  }
  return lines.join("\n");
}
