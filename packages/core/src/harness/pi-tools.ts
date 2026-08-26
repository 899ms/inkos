import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import {
  type ActionResult,
  type WorkProfile,
} from "./contracts.js";
import {
  CapabilityRegistry,
  type CapabilityAction,
  type CapabilityExecutionContext,
} from "./capability-registry.js";

export interface CapabilityAuthorizationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface CreateCapabilityPiToolsOptions {
  readonly registry: CapabilityRegistry;
  readonly profile: WorkProfile;
  readonly createContext: (
    capabilityId: string,
    actionId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ) => CapabilityExecutionContext | Promise<CapabilityExecutionContext>;
  readonly authorize?: (
    capabilityId: string,
    action: CapabilityAction,
  ) => CapabilityAuthorizationResult | Promise<CapabilityAuthorizationResult>;
  readonly onResult?: (
    capabilityId: string,
    actionId: string,
    result: ActionResult,
  ) => void | Promise<void>;
}

export function createCapabilityPiTools(
  options: CreateCapabilityPiToolsOptions,
): ReadonlyArray<AgentTool<TSchema, ActionResult>> {
  return options.registry.forProfile(options.profile).flatMap((capability) => (
    capability.actions.map((action): AgentTool<TSchema, ActionResult> => ({
      name: capabilityToolName(capability.id, action.id),
      label: action.title,
      description: action.description,
      parameters: action.parameters,
      async execute(toolCallId, params, signal): Promise<AgentToolResult<ActionResult>> {
        if (signal?.aborted) throw signal.reason;
        const authorization = await options.authorize?.(capability.id, action);
        if (authorization && !authorization.allowed) {
          throw new Error(authorization.reason ?? `Action blocked: ${capability.id}.${action.id}`);
        }
        const context = await options.createContext(capability.id, action.id, toolCallId, signal);
        const result = await options.registry.invoke(capability.id, action.id, context, params);
        await options.onResult?.(capability.id, action.id, result);
        if (result.status === "error") {
          throw new CapabilityActionError(capability.id, action.id, result);
        }
        return {
          content: [{ type: "text", text: renderActionResultForAgent(result) }],
          details: result,
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

function renderActionResultForAgent(result: ActionResult): string {
  const lines = [result.summary];
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

