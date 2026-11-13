import {
  AppModeError,
  createAppModeController,
  type AppModeInputs,
} from "../src/host/appMode";
import {
  ManagedSequenceClientError,
  decodeManagedSequenceMutationResult,
} from "../src/host/managedSequenceClient";
import {
  canonicalStringFingerprint,
  sha256Text,
} from "../src/contracts/canonicalFingerprint";
import { createProductionManagedChildResolver } from "../src/host/productionManagedChildResolver";
import type { OwnedGraphReference } from "../src/host/ownedGraphIdentity";
import {
  ManagedSerialSequenceRunnerError,
  type ManagedSerialSequenceStartIntent,
} from "../src/host/managedSequenceRunnerContract";
import { loadAvailableProfile } from "../tests/support/generationProfileFixture";
import { fixtureBackedAppModeHost } from "../tests/support/hostSeamTestDouble";
import {
  acceptedQueueResponse,
  syntheticPromptUuid,
} from "../tests/support/queuePromptTestDouble";
import { preparedSequenceMediaFixture } from "../tests/support/preparedSequenceMediaFixture";
import { compileSequenceWorkflow } from "../tests/support/sequenceCompileFixture";
import { nativeCanvasSequenceTemplateFixture } from "../tests/support/nativeCanvasSequenceTemplateFixture";
import type { Json } from "../tests/support/templateFixture";
import { createManagedSequenceHarnessEngine } from "./managedSequence";

const search = new URLSearchParams(location.search);
const selected = search.get("task");
if (selected !== "i2va" && selected !== "l2va" && selected !== "fl2va")
  throw new Error("explicit frame mode required");
const mode = selected;
const cropped = search.get("crop") === "true";
const fp = (digit: string) => `sha256:${digit.repeat(64)}`;
const profile = { name: "h3_base", version: "1.0" };
const retained = preparedSequenceMediaFixture(mode, mode, cropped).prepared
  .bindings!;
const activeWorkflow = {};
let visible: Json = {
  nodes: [
    {
      id: 1,
      type: "H3ContextRequest",
      mode: 0,
      widgets_values: ["synthetic"],
      inputs: [],
      outputs: [],
    },
    { id: 2, type: "MiniMaxH3ImageToVideo", mode: 0, inputs: [], outputs: [] },
  ],
  links: [],
  groups: [],
  config: {},
  extra: {},
  version: 0.4,
};
let owned: OwnedGraphReference = {
  nodeIds: ["1", "2"],
  linkIds: [],
  anchorNodeId: "2",
  authoredWidgetNodeIds: ["1"],
};
let queues = 0,
  writes = 0,
  observations = 0,
  reads = 0,
  starts = 0;
let changed = false,
  lastFailure: string | null = null;
type BridgeStage = "parent" | "resolver" | "controller" | "runner" | "bridge";
let stage: BridgeStage = "bridge";
let failureStage: BridgeStage | null = null;
let failureName: string | null = null;
function recordFailure(error: unknown) {
  lastFailure =
    error instanceof AppModeError ||
    error instanceof ManagedSequenceClientError ||
    error instanceof ManagedSerialSequenceRunnerError
      ? error.code
      : "unexpected";
  const name = error instanceof Error ? error.name : "other";
  failureName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "other";
  failureStage = stage;
}
let currentTask: AppModeInputs["task_mode"] = mode;
const observedReceiptHandles: string[] = [];
const childModes: string[] = [];
const bindCounts: number[] = [];
const queuedGuideIndices: number[][] = [];
const host = fixtureBackedAppModeHost(
  {
    extensionManager: {
      workflow: { activeWorkflow, openWorkflows: [activeWorkflow] },
    },
    loadApiJson: async () => undefined,
    loadGraphData: async (value: unknown) => {
      visible = structuredClone(value) as Json;
      writes += 1;
    },
    graphToPrompt: async (value?: unknown) =>
      compileSequenceWorkflow((value ?? visible) as Json, false),
    graph: { serialize: () => visible },
  },
  {
    queuePrompt: async () => {
      queues += 1;
      queuedGuideIndices.push(
        (visible.nodes as Json[])
          .filter((node) => node.type === "MiniMaxH3AddGuide")
          .map((node) => Number((node.widgets_values as unknown[])[0])),
      );
      return acceptedQueueResponse(200 + queues);
    },
  },
);

async function loadTemplate(name: string) {
  const template = nativeCanvasSequenceTemplateFixture(name);
  const nodes = template.nodes as Json[],
    links = template.links as unknown[][];
  const anchor = nodes.find((node) => node.id === 3)!;
  (anchor.inputs as Json[]).find((port) => port.name === "clip")!.link = 24;
  nodes.find((node) => node.id === 25)!.widgets_values = [
    "synthetic.safetensors",
  ];
  nodes.push({
    id: 27,
    type: "CLIPLoader",
    inputs: [],
    outputs: [{ name: "CLIP", type: "CLIP", links: [24] }],
    widgets_values: ["synthetic.safetensors", "minimax_h3"],
  });
  (nodes.find((node) => node.id === 4)!.inputs as Json[]).push({
    name: "vae",
    type: "VAE",
    link: 25,
  });
  (
    (nodes.find((node) => node.id === 25)!.outputs as Json[])[0]!
      .links as number[]
  ).push(25);
  links.push([24, 27, 0, 3, 0, "CLIP"], [25, 25, 0, 4, 1, "VAE"]);
  template.last_node_id = Math.max(Number(template.last_node_id), 27);
  template.last_link_id = Math.max(Number(template.last_link_id), 25);
  return template;
}
const controller = createAppModeController(host.app, host.api, {
  loadProfile: loadAvailableProfile,
  loadTemplate,
  readNodeDefinitions: () =>
    cropped
      ? {
          ImageCropV2: {
            nodeData: {
              name: "ImageCropV2",
              input: {
                required: { image: ["IMAGE"], crop_region: ["BOUNDING_BOX"] },
              },
              output: ["IMAGE"],
            },
          },
        }
      : undefined,
  nodeDefinitionReadinessReached: () => cropped,
});
const resolver = createProductionManagedChildResolver({
  app: host.app,
  currentOwnedGraphReference: () => owned,
  fetchApi: async (_route, options) => {
    reads += 1;
    const request = JSON.parse(String(options?.body)) as {
      payload: Record<string, unknown>;
    };
    const payload = request.payload;
    const index = payload.segment_id === "segment.1" ? 0 : 1;
    const task =
      mode === "i2va"
        ? index === 0
          ? "i2va"
          : "t2va"
        : mode === "l2va"
          ? index === 1
            ? "l2va"
            : "t2va"
          : index === 0
            ? "i2va"
            : "l2va";
    const roles =
      task === "i2va" ? ["first_frame"] : task === "l2va" ? ["last_frame"] : [];
    const entries = retained.entries.filter(
      (row) => roles.includes(row.role) || mode === "i2va",
    );
    const canonicalPrompt = "A blue sphere turns slowly.";
    return new Response(
      JSON.stringify({
        schema: "h3.context.managed_prepared_context.v2",
        parent_sequence_id: payload.parent_sequence_id,
        parent_revision: payload.expected_revision,
        authorization_fingerprint: payload.authorization_fingerprint,
        segment_id: payload.segment_id,
        eligible_execution_fingerprint: payload.eligible_execution_fingerprint,
        materialization_receipt_fingerprint:
          payload.materialization_receipt_fingerprint,
        context_workspace_handle: payload.context_workspace_handle,
        context_report_id: `report.${index + 1}`,
        context_report_revision: 1,
        context_report_fingerprint: fp("4"),
        canonical_prompt: canonicalPrompt,
        canonical_prompt_fingerprint:
          canonicalStringFingerprint(canonicalPrompt),
        task_mode: task,
        duration_milliseconds: 6000,
        frame_count: 158,
        profile,
        profile_fingerprint: sha256Text(JSON.stringify(profile)),
        ordered_references: roles.map((role, i) => ({
          asset_id: `${role}_1`,
          kind: "image",
          role,
          connection_order: i + 1,
          metadata: null,
          paired_video_id: null,
        })),
        reference_registry_fingerprint: fp("5"),
        native_binding_fingerprint: fp("6"),
        sequence_task_mode: mode,
        geometry_donor_asset_id: mode === "i2va" ? "first_frame_1" : null,
        media_bindings: entries.length
          ? { schema: retained.schema, entries }
          : null,
        canonical_lowering: {
          schema:
            task === "t2va"
              ? "h3.context.production_canonical_lowering.v1"
              : "h3.context.production_canonical_lowering.v2",
          base_report_fingerprint: fp("7"),
          base_report_revision: 0,
          override_revision: 1,
          reason: "Materialize approved Production segment prompt",
          ...(task === "t2va" ? {} : { task_mode: task, binding_roles: roles }),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
});
const engine = createManagedSequenceHarnessEngine({
  workflowAuthority: activeWorkflow,
  resolveChild: async (...args) => {
    stage = "resolver";
    return resolver(...args);
  },
  startChild: async (inputs, options) => {
    starts += 1;
    currentTask = inputs.task_mode;
    childModes.push(inputs.task_mode);
    stage = "controller";
    const prepare = options!.prepareManaged!;
    try {
      return await controller.start(inputs, {
        ...options,
        observeSourceIdentity: async (request) => {
          observations += 1;
          const entry = retained.entries.find(
            (row) => row.locator === request.locator,
          )!;
          const handle = "ig_" + String(observations).padStart(40, "0");
          observedReceiptHandles.push(handle);
          return {
            ...entry.source_identity,
            receipt_handle: handle,
            source_fingerprint: changed
              ? fp("f")
              : entry.source_identity.source_fingerprint,
          };
        },
        prepareManaged: async (preflight) => {
          bindCounts.push(observations);
          stage = "parent";
          const authority = await prepare(preflight);
          stage = "controller";
          return {
            ...authority,
            bindCanvasIdentity(identity) {
              owned = identity.ownedReference;
              authority.bindCanvasIdentity?.(identity);
            },
          };
        },
      });
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  },
});
// IMPORTANT: the shared authority engine emits T2VA V1 by default. A frame fixture must
// publish its actual global V2 mode; relabelling the Start intent alone is correctly refused.
const sendParent = engine.parentClient.send;
let checkedParentRoundTrip = false;
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}
Object.assign(engine.parentClient, {
  send: async (...args: Parameters<typeof sendParent>) => {
    stage = "parent";
    const result = await sendParent(...args);
    const failure =
      args[1] === "fail_prepared_child" ? args[2].failure_code : null;
    if (
      failure !== null &&
      failure !== undefined &&
      failure !== "sequence_media_changed" &&
      failure !== "sequence_media_unavailable"
    )
      throw new Error("invalid synthetic frame failure");
    stage = "runner";
    const intended = Object.freeze({
      ...result,
      schema: "h3.context.managed_sequence_result.v2" as const,
      sequenceTaskMode: mode,
      failureCode: failure ?? null,
    });
    const execution = result.execution;
    const child = result.childAuthority;
    const decoded = decodeManagedSequenceMutationResult(
      {
        schema: intended.schema,
        parent_sequence_id: result.parentSequenceId,
        authorization_fingerprint: result.authorizationFingerprint,
        read_authority_fingerprint: result.readAuthorityFingerprint,
        state: result.state,
        revision: result.revision,
        execution:
          execution === null
            ? null
            : {
                schema: "h3.context.eligible_segment_execution.v1",
                parent_sequence_id: execution.parentSequenceId,
                parent_authorization_fingerprint:
                  execution.parentAuthorizationFingerprint,
                segment_id: execution.segmentId,
                slot_revision: execution.slotRevision,
                attempt_epoch: execution.attemptEpoch,
                materialization_receipt_fingerprint:
                  execution.materializationReceiptFingerprint,
                predecessor_terminal_fingerprint:
                  execution.predecessorTerminalFingerprint,
                request_id: execution.requestId,
                job_count: execution.jobCount,
              },
        execution_fingerprint: execution?.fingerprint ?? null,
        child_authority:
          child === null
            ? null
            : {
                schema: child.schema,
                run_handle: child.runHandle,
                state_fingerprint: child.stateFingerprint,
                job_id: child.jobId,
                transaction_id: child.transactionId,
              },
        context_workspace_handle: result.contextWorkspaceHandle,
        parent_expires_at_epoch_ms: result.parentExpiresAtEpochMs,
        replayed: result.replayed,
        sequence_task_mode: intended.sequenceTaskMode,
        failure_code: intended.failureCode,
      },
      mode,
    );
    if (!checkedParentRoundTrip) {
      if (
        JSON.stringify(ordered(decoded)) !== JSON.stringify(ordered(intended))
      )
        throw new Error("synthetic parent round trip mismatch");
      checkedParentRoundTrip = true;
    }
    return decoded;
  },
});
const intent: ManagedSerialSequenceStartIntent = {
  ...engine.startIntent,
  sequenceTaskMode: mode,
  mediaBindings: retained,
};
const status = document.querySelector("#status")!;
function settled(operation: Promise<unknown>) {
  return operation.then(
    () => {
      status.textContent = engine.runner().snapshot().parentState ?? "idle";
    },
    (error) => {
      if (lastFailure === null) recordFailure(error);
      status.textContent = "failed";
    },
  );
}
document.querySelector("#generate")!.addEventListener("click", () => {
  stage = "runner";
  void settled(engine.runner().start(intent));
});
document.querySelector("#terminal")!.addEventListener("click", () => {
  stage = "runner";
  void settled(engine.sendTerminalPair(syntheticPromptUuid(200 + queues)));
});
document.querySelector("#change")!.addEventListener("click", () => {
  changed = true;
});
export function snapshot() {
  return {
    queues,
    writes,
    observations,
    reads,
    starts,
    lastFailure,
    failureStage,
    failureName,
    childModes: [...childModes],
    bindCounts: [...bindCounts],
    uniqueReceiptCount: new Set(observedReceiptHandles).size,
    queuedGuideIndices: structuredClone(queuedGuideIndices),
    actions: engine.snapshot().actions,
    runner: engine.runner().snapshot(),
  };
}
declare global {
  interface Window {
    h3FrameSequence: { snapshot: typeof snapshot };
  }
}
window.h3FrameSequence = { snapshot };
