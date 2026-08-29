import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TSchema } from "@sinclair/typebox";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { ActionPayload, RequestedIntent } from "../interaction/action-envelope.js";
import type { PlayMode } from "../interaction/session.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import {
  createContinuationImportTool,
  createDeleteLatestChapterTool,
  createFanficBookTool,
  createGenerateCoverTool,
  createGrepTool,
  createImportChaptersTool,
  createIngestMaterialTool,
  createInteractiveFilmCreationTool,
  createInspectWorkTool,
  createListWorksTool,
  createLsTool,
  createManageBookReferenceTool,
  createPlayEditTool,
  createPlayReviseTool,
  createPlayStartTool,
  createPlayStepTool,
  createProposeActionTool,
  createReadTool,
  createResearchWebTool,
  createResyncChapterStateTool,
  createRetrieveMaterialTool,
  createScriptCreationTool,
  createShortFictionRunTool,
  createSpinoffBookTool,
  createStoryboardCreationTool,
  createSubAgentTool,
  createImitationBookTool,
  type ProposedActionName,
} from "../agent/agent-tools.js";
import {
  createPatchChapterTextTool,
  createRenameEntityTool,
  createReplaceChapterTextTool,
  createWriteTruthFileTool,
} from "./tools/longform-edits.js";
import {
  createTranslationCreateTool,
  createTranslationExportTool,
  createTranslationRunTool,
} from "./tools/translation.js";
import { createReplaceWorkArtifactTool } from "./tools/work-artifacts.js";
import { createFilmAuthoringTools, filmLLMDepsFromClient } from "../agent/film-authoring-tools.js";
import {
  createNarrativeForecastCreateTool,
  createNarrativeForecastGetTool,
  createNarrativeForecastSelectTool,
} from "../agent/forecast-tools.js";
import { mergeActivatedSkillGuidance } from "../skills/index.js";
import {
  ActionResultSchema,
  type ActionArtifactRef,
  type ActionResult,
  type ActionRisk,
  type WorkManifest,
} from "./contracts.js";
import {
  CapabilityRegistry,
  defineCapabilityAction,
  type Capability,
  type CapabilityExecutionContext,
} from "./capability-registry.js";
import { loadWorkManifest } from "./work-store.js";
import { syncWorkSourceArtifacts } from "./source-sync.js";
import { ObservationSchema, type Observation } from "../models/observation.js";

export interface ProductionCapabilityEnvironment {
  readonly pipeline: PipelineRunner;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly proposalAction?: RequestedIntent;
  readonly work: WorkManifest | null;
  readonly language: string;
  readonly actionPayload?: ActionPayload;
  readonly playMode?: PlayMode;
  readonly playWorldExists: boolean;
  readonly sameSessionProposal: boolean;
  readonly allowSystemFileRead: boolean;
  readonly intentSkillTool?: AgentTool<any, any>;
  readonly requestedSkillIds?: () => ReadonlyArray<string>;
  readonly attachmentPaths?: () => ReadonlyArray<string>;
  readonly activeSkills?: () => ReadonlyArray<ActivatedSkillGuidance>;
  readonly workerSkills?: (agent: string) => ReadonlyArray<ActivatedSkillGuidance>;
  readonly profileSkills?: (
    profileId: string,
    includeRecommended?: boolean,
  ) => ReadonlyArray<ActivatedSkillGuidance>;
  readonly interactiveFilmAuthoring?: boolean;
}

const READ_TOOLS = new Set([
  "propose_action",
  "read",
  "list_works",
  "inspect_work",
  "grep",
  "ls",
  "research_web",
  "retrieve_material",
  "get_narrative_forecast",
  "use_skill",
]);

const DESTRUCTIVE_TOOLS = new Set(["delete_latest_chapter"]);

const CONFIRMED_CREATION_TOOLS = new Set([
  "short_fiction_run",
  "script_create",
  "storyboard_create",
  "interactive_film_create",
  "play_start",
  "generate_cover",
  "translation_create",
  "fanfic_create",
  "continuation_import",
  "spinoff_create",
  "imitation_create",
]);

type ProductionAgentTool = AgentTool<any, any>;

export interface ConfirmedCapabilityBinding {
  readonly capabilityId: string;
  readonly actionId: string;
  readonly profileId: string;
}

const CONFIRMED_CAPABILITY_BINDINGS: Readonly<Partial<Record<RequestedIntent, ConfirmedCapabilityBinding>>> = {
  create_book: { capabilityId: "longform", actionId: "sub_agent", profileId: "longform-novel" },
  write_next: { capabilityId: "longform", actionId: "sub_agent", profileId: "longform-novel" },
  short_run: { capabilityId: "short-fiction", actionId: "short_fiction_run", profileId: "short-fiction" },
  play_start: { capabilityId: "interactive-world", actionId: "play_start", profileId: "interactive-world" },
  play_step: { capabilityId: "interactive-world", actionId: "play_step", profileId: "interactive-world" },
  generate_cover: { capabilityId: "visual", actionId: "generate_cover", profileId: "visual-asset" },
  fanfic_init: { capabilityId: "adaptation", actionId: "fanfic_create", profileId: "workspace-default" },
  continuation_import: { capabilityId: "adaptation", actionId: "continuation_import", profileId: "workspace-default" },
  spinoff_create: { capabilityId: "adaptation", actionId: "spinoff_create", profileId: "workspace-default" },
  style_imitation: { capabilityId: "adaptation", actionId: "imitation_create", profileId: "workspace-default" },
  script_create: { capabilityId: "script", actionId: "script_create", profileId: "script" },
  storyboard_create: { capabilityId: "storyboard", actionId: "storyboard_create", profileId: "storyboard" },
  interactive_film_create: { capabilityId: "interactive-film", actionId: "interactive_film_create", profileId: "interactive-film" },
  translation_create: { capabilityId: "translation", actionId: "translation_create", profileId: "translation" },
  draft_structure: { capabilityId: "interactive-film", actionId: "draft_structure", profileId: "interactive-film" },
  connect_choice: { capabilityId: "interactive-film", actionId: "connect_choice", profileId: "interactive-film" },
  remove_node: { capabilityId: "interactive-film", actionId: "remove_node", profileId: "interactive-film" },
};

export function confirmedCapabilityBinding(intent: RequestedIntent): ConfirmedCapabilityBinding | undefined {
  return CONFIRMED_CAPABILITY_BINDINGS[intent];
}

export function createSingleToolCapabilityRegistry(input: {
  readonly binding: ConfirmedCapabilityBinding;
  readonly tool: AgentTool<any, any>;
}): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerToolCapability(
    registry,
    input.binding.capabilityId,
    input.binding.capabilityId,
    [input.tool],
    { forceConfirmation: [input.tool.name] },
  );
  return registry;
}

export function createProductionCapabilityRegistry(
  environment: ProductionCapabilityEnvironment,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const lang = environment.language === "en" ? "en" : "zh";
  const proposalTool = createProposeActionTool(lang, {
    sameSession: environment.sameSessionProposal,
    proposalAction: environment.work
      ? undefined
      : proposedActionName(environment.proposalAction) ?? proposalActionForProfile(environment.profileId),
    requestedSkillIds: environment.requestedSkillIds,
    attachmentPaths: environment.attachmentPaths,
  });
  const workspaceTools: ProductionAgentTool[] = [
    proposalTool,
    createReadTool(environment.projectRoot, {
      scope: "project",
      allowSystemPaths: environment.allowSystemFileRead,
    }),
    createListWorksTool(environment.projectRoot),
    createInspectWorkTool(environment.projectRoot),
    createResearchWebTool(environment.projectRoot),
    createIngestMaterialTool(environment.projectRoot),
    createRetrieveMaterialTool(environment.projectRoot),
  ];
  if (environment.work && ["short-fiction", "script", "storyboard", "translation", "visual-asset"].includes(environment.work.profileId)) {
    workspaceTools.push(createReplaceWorkArtifactTool(environment.projectRoot, environment.work.id));
  }
  if (environment.intentSkillTool) workspaceTools.push(environment.intentSkillTool);
  registerToolCapability(registry, "workspace", "Creative workspace", workspaceTools);

  const longformTools: ProductionAgentTool[] = environment.work
    ? [
        createSubAgentTool(environment.pipeline, environment.work.id, environment.projectRoot, {
          actionPayload: environment.actionPayload,
          language: lang,
          activeSkills: environment.activeSkills,
          workerSkills: environment.workerSkills,
        }),
        createWriteTruthFileTool(environment.projectRoot, environment.work.id),
        createRenameEntityTool(environment.projectRoot, environment.work.id),
        createPatchChapterTextTool(environment.projectRoot, environment.work.id),
        createReplaceChapterTextTool(environment.projectRoot, environment.work.id),
        createResyncChapterStateTool(environment.pipeline, environment.work.id, {
          language: lang,
          defaultSkills: environment.profileSkills?.("longform-novel"),
          activeSkills: environment.activeSkills,
        }),
        createDeleteLatestChapterTool(environment.projectRoot, environment.work.id),
        createManageBookReferenceTool(environment.projectRoot, environment.work.id),
        createImportChaptersTool(environment.pipeline, environment.work.id, environment.projectRoot),
        createNarrativeForecastCreateTool(environment.pipeline, environment.work.id, environment.projectRoot),
        createNarrativeForecastGetTool(environment.work.id, environment.projectRoot),
        createNarrativeForecastSelectTool(environment.work.id, environment.projectRoot),
        createGrepTool(environment.projectRoot),
        createLsTool(environment.projectRoot),
      ]
    : [createSubAgentTool(environment.pipeline, null, environment.projectRoot, {
        actionPayload: environment.actionPayload,
        architectCreateOnly: true,
        language: lang,
        activeSkills: environment.activeSkills,
        workerSkills: environment.workerSkills,
      })];
  registerToolCapability(registry, "longform", "Long-form creation", longformTools, {
    forceConfirmation: environment.work ? [] : ["sub_agent"],
  });

  registerToolCapability(registry, "short-fiction", "Short fiction", [
    createShortFictionRunTool(environment.pipeline, environment.projectRoot, {
      actionPayload: environment.actionPayload,
      language: lang,
      defaultSkills: environment.profileSkills?.("short-fiction"),
      activeSkills: environment.activeSkills,
    }),
  ]);
  registerToolCapability(registry, "script", "Script creation", [
    createScriptCreationTool(environment.pipeline, environment.projectRoot, {
      actionPayload: environment.actionPayload,
      language: lang,
      defaultSkills: environment.profileSkills?.("script"),
      activeSkills: environment.activeSkills,
    }),
  ]);
  registerToolCapability(registry, "storyboard", "Storyboard creation", [
    createStoryboardCreationTool(environment.pipeline, environment.projectRoot, {
      actionPayload: environment.actionPayload,
      language: lang,
      defaultSkills: environment.profileSkills?.("storyboard"),
      activeSkills: environment.activeSkills,
    }),
  ]);

  const interactiveFilmTools = environment.interactiveFilmAuthoring && environment.work
    ? createFilmAuthoringTools({
        projectRoot: environment.projectRoot,
        projectId: environment.work.id,
        llm: filmLLMDepsFromClient(
          environment.pipeline.createAgentContext("film-authoring", environment.work.id).client,
          environment.pipeline.createAgentContext("film-authoring", environment.work.id).model,
          {
            activatedSkills: () => mergeActivatedSkillGuidance(
              environment.profileSkills?.("interactive-film") ?? [],
              environment.activeSkills?.() ?? [],
            ),
          },
        ),
        proposeActionTool: proposalTool,
        language: lang,
      })
    : [createInteractiveFilmCreationTool(environment.pipeline, environment.projectRoot, {
        actionPayload: environment.actionPayload,
        language: lang,
        defaultSkills: environment.profileSkills?.("interactive-film"),
        activeSkills: environment.activeSkills,
      })];
  registerToolCapability(registry, "interactive-film", "Interactive film", interactiveFilmTools);

  const interactiveWorldId = environment.work?.profileId === "interactive-world"
    ? environment.work.id
    : environment.sessionId;
  const interactiveWorldTools = environment.playWorldExists
    ? [
        createPlayEditTool(environment.projectRoot, interactiveWorldId, lang),
        createPlayReviseTool(environment.pipeline, environment.projectRoot, interactiveWorldId, {
          language: lang,
          defaultSkills: environment.profileSkills?.("interactive-world"),
          activeSkills: environment.activeSkills,
        }),
        createPlayStepTool(environment.pipeline, environment.projectRoot, interactiveWorldId, {
          language: lang,
          defaultSkills: environment.profileSkills?.("interactive-world"),
          activeSkills: environment.activeSkills,
        }),
      ]
    : [createPlayStartTool(
        environment.pipeline,
        environment.projectRoot,
        interactiveWorldId,
        environment.playMode,
        {
          actionPayload: environment.actionPayload,
          defaultSkills: environment.profileSkills?.("interactive-world"),
          activeSkills: environment.activeSkills,
        },
      )];
  registerToolCapability(registry, "interactive-world", "Interactive world", interactiveWorldTools);

  const translationTools = environment.work?.profileId === "translation"
    ? [
        createTranslationRunTool(environment.pipeline, environment.projectRoot, environment.work.id, {
          defaultSkills: environment.profileSkills?.("translation"),
          activeSkills: environment.activeSkills,
        }),
        createTranslationExportTool(environment.projectRoot, environment.work.id),
      ]
    : [createTranslationCreateTool(environment.projectRoot, { actionPayload: environment.actionPayload })];
  registerToolCapability(registry, "translation", "Translation", translationTools);
  registerToolCapability(registry, "adaptation", "Adaptation", [
    createFanficBookTool(environment.pipeline, environment.projectRoot, {
      defaultSkills: environment.profileSkills?.("longform-novel"),
      activeSkills: environment.activeSkills,
    }),
    createContinuationImportTool(environment.pipeline, environment.work?.id ?? null, environment.projectRoot, {
      defaultSkills: environment.profileSkills?.("longform-novel"),
      activeSkills: environment.activeSkills,
    }),
    createSpinoffBookTool(environment.pipeline, environment.projectRoot, {
      defaultSkills: environment.profileSkills?.("longform-novel"),
      activeSkills: environment.activeSkills,
    }),
    createImitationBookTool(environment.pipeline, environment.projectRoot, {
      defaultSkills: environment.profileSkills?.("longform-novel"),
      activeSkills: environment.activeSkills,
    }),
  ]);
  registerToolCapability(registry, "visual", "Visual assets", [
    createGenerateCoverTool(environment.projectRoot, { actionPayload: environment.actionPayload }),
  ]);
  return registry;
}

function proposedActionName(value: RequestedIntent | undefined): ProposedActionName | undefined {
  if (value === "create_book"
    || value === "short_run"
    || value === "play_start"
    || value === "generate_cover"
    || value === "fanfic_init"
    || value === "continuation_import"
    || value === "spinoff_create"
    || value === "style_imitation"
    || value === "script_create"
    || value === "storyboard_create"
    || value === "interactive_film_create"
    || value === "translation_create"
    || value === "draft_structure"
    || value === "connect_choice"
    || value === "remove_node") {
    return value;
  }
  return undefined;
}

function proposalActionForProfile(profileId: string): ProposedActionName | undefined {
  if (profileId === "longform-novel") return "create_book";
  if (profileId === "short-fiction") return "short_run";
  if (profileId === "interactive-world") return "play_start";
  if (profileId === "script") return "script_create";
  if (profileId === "storyboard") return "storyboard_create";
  if (profileId === "interactive-film") return "interactive_film_create";
  if (profileId === "translation") return "translation_create";
  if (profileId === "visual-asset") return "generate_cover";
  return undefined;
}

function registerToolCapability(
  registry: CapabilityRegistry,
  id: string,
  title: string,
  tools: ReadonlyArray<ProductionAgentTool>,
  options: { readonly forceConfirmation?: ReadonlyArray<string> } = {},
): void {
  const forced = new Set(options.forceConfirmation ?? []);
  const capability: Capability = {
    id,
    title,
    description: title,
    actions: tools.map((tool) => toolBackedAction(tool, forced.has(tool.name))),
  };
  registry.register(capability);
}

function toolBackedAction(
  tool: ProductionAgentTool,
  forceConfirmation: boolean,
) {
  const risk = toolRisk(tool.name);
  return defineCapabilityAction({
    id: tool.name,
    title: tool.label || tool.name,
    description: tool.description || tool.name,
    risk,
    requiresConfirmation: forceConfirmation || CONFIRMED_CREATION_TOOLS.has(tool.name),
    parameters: tool.parameters ?? Type.Any(),
    async execute(context: CapabilityExecutionContext, input: unknown): Promise<ActionResult> {
      const before = await loadKnownWork(context.projectRoot, context.work?.id);
      const result = await tool.execute(context.episodeId, input, context.signal, context.onUpdate);
      return normalizeToolResult(context, result, before, risk !== "read");
    },
  });
}

function toolRisk(toolName: string): ActionRisk {
  if (READ_TOOLS.has(toolName)) return "read";
  if (DESTRUCTIVE_TOOLS.has(toolName)) return "destructive-write";
  return "recoverable-write";
}

async function normalizeToolResult(
  context: CapabilityExecutionContext,
  result: AgentToolResult<unknown>,
  before: WorkManifest | null,
  syncArtifacts: boolean,
): Promise<ActionResult> {
  const content = result.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  const details = result.details;
  const isError = (result as { isError?: boolean }).isError === true;
  const workIds = new Set<string>();
  if (syncArtifacts && context.work) workIds.add(context.work.id);
  collectWorkIds(details, workIds);
  const artifacts: ActionArtifactRef[] = [];
  for (const workId of workIds) {
    if (await loadKnownWork(context.projectRoot, workId)) {
      await syncWorkSourceArtifacts({
        projectRoot: context.projectRoot,
        workId,
        episodeId: context.episodeId,
        accept: !isError,
      });
    }
    const after = await loadKnownWork(context.projectRoot, workId);
    if (!after) continue;
    const previous = before?.id === workId ? before : null;
    const priorRevisions = new Map(previous?.artifacts.map((artifact) => [artifact.id, artifact.currentRevisionId]) ?? []);
    for (const artifact of after.artifacts) {
      if (priorRevisions.get(artifact.id) === artifact.currentRevisionId) continue;
      const revision = artifact.revisions.find((candidate) => candidate.id === artifact.currentRevisionId);
      const previousRevision = previous?.artifacts
        .find((candidate) => candidate.id === artifact.id)
        ?.revisions.find((candidate) => candidate.id === priorRevisions.get(artifact.id));
      artifacts.push({
        workId,
        artifactId: artifact.id,
        ...(artifact.currentRevisionId ? { revisionId: artifact.currentRevisionId } : {}),
        ...(revision?.path || previousRevision?.path ? { path: revision?.path ?? previousRevision!.path } : {}),
      });
    }
  }
  const observations = extractObservations(details);
  const status = isError
    ? "error"
    : observations.some((observation) => observation.status !== "pass") ? "warning" : "success";
  const summary = content.split("\n").map((line) => line.trim()).find(Boolean)
    ?? (status === "error" ? "Action failed." : "Action completed.");
  return ActionResultSchema.parse({
    status,
    summary,
    ...(content ? { content } : {}),
    nextActions: [],
    artifacts,
    observations,
    ...(details === undefined ? {} : { data: details }),
    ...(status === "error" ? { retry: { allowed: true } } : {}),
  });
}

function extractObservations(details: unknown): Observation[] {
  if (!details || typeof details !== "object") return [];
  const raw = (details as Record<string, unknown>).observations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    const parsed = ObservationSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.description !== "string") return [];
    return [ObservationSchema.parse({
      code: typeof record.category === "string" && record.category ? record.category : `review-${index + 1}`,
      kind: "soft",
      status: "warning",
      summary: record.description,
      evidence: typeof record.suggestion === "string" && record.suggestion ? [record.suggestion] : [],
    })];
  });
}

function collectWorkIds(value: unknown, target: Set<string>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["workId", "bookId", "storyId", "projectId", "worldId"]) {
    if (typeof record[key] === "string" && record[key]) target.add(record[key]);
  }
  if (record.data && record.data !== value) collectWorkIds(record.data, target);
}

async function loadKnownWork(projectRoot: string, workId: string | undefined): Promise<WorkManifest | null> {
  if (!workId) return null;
  try {
    return await loadWorkManifest(projectRoot, workId);
  } catch {
    return null;
  }
}
