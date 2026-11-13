import { stdout } from "node:process";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalStringFingerprint,
  sha256Text,
} from "../src/contracts/canonicalFingerprint";
import {
  PRODUCTION_CANONICAL_LOWERING_SCHEMA,
  graphFingerprint,
} from "../src/host/appMode";
import {
  MANAGED_SEQUENCE_ROUTE,
  ManagedSequenceClientError,
  type EligibleSegmentExecution,
} from "../src/host/managedSequenceClient";
import {
  observeOwnedGraph,
  type OwnedGraphReference,
} from "../src/host/ownedGraphIdentity";
import {
  MANAGED_PREPARED_CONTEXT_ACTION_SCHEMA,
  MANAGED_PREPARED_CONTEXT_SCHEMA,
  createProductionManagedChildResolver,
  decodeProductionManagedPreparedContext,
} from "../src/host/productionManagedChildResolver";
import { fixtureBackedAppModeHost } from "./support/hostSeamTestDouble";

const fp = (digit: string) => `sha256:${digit.repeat(64)}`;
const prompt = "A blue sphere turns slowly.";
const profile = (name: "h3_base" | "h3_full_reference") => ({
  name,
  version: "1.0",
});
const profileFingerprint = (name: "h3_base" | "h3_full_reference") =>
  sha256Text(JSON.stringify(profile(name)));
const contextWorkspaceHandle = `ws_${"c".repeat(40)}`;
const workflowAuthority = {};
const ownedReference = Object.freeze({
  nodeIds: Object.freeze(["1", "2"]),
  linkIds: Object.freeze(["10"]),
  anchorNodeId: "2",
  authoredWidgetNodeIds: Object.freeze(["1"]),
});

function graph(intent = "previous prompt") {
  return {
    last_node_id: 2,
    last_link_id: 10,
    nodes: [
      {
        id: 1,
        type: "H3ContextRequest",
        mode: 0,
        widgets_values: [intent],
        inputs: [],
        outputs: [{ name: "request", type: "H3_CONTEXT_REQUEST" }],
      },
      {
        id: 2,
        type: "MiniMaxH3ImageToVideo",
        mode: 0,
        inputs: [{ name: "prompt", type: "STRING", link: 10 }],
        outputs: [],
      },
    ],
    links: [[10, 1, 0, 2, 0, "STRING"]],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };
}

function graphWithForeignNoise() {
  const value = graph();
  return {
    ...value,
    nodes: [
      ...value.nodes.map((node, index) => ({
        ...node,
        pos: [100 + index * 40, 200 + index * 20],
        size: [320, 180],
      })),
      {
        id: 99,
        type: "ForeignHostNode",
        mode: 0,
        widgets_values: ["foreign presentation"],
        inputs: [],
        outputs: [],
        pos: [900, 700],
        size: [120, 80],
      },
    ],
    config: { foreign_layout_revision: 7 },
    extra: { host_metadata: { zoom: 1.25, selected: [99] } },
  };
}

function execution(): EligibleSegmentExecution {
  return Object.freeze({
    parentSequenceId: "managed.sequence.1",
    parentAuthorizationFingerprint: fp("1"),
    segmentId: "segment.1",
    slotRevision: 4,
    attemptEpoch: 1,
    materializationReceiptFingerprint: fp("2"),
    predecessorTerminalFingerprint: null,
    requestId: "prepare.segment.1",
    jobCount: 1,
    fingerprint: fp("3"),
  });
}

type ReferenceWire = {
  asset_id: string;
  kind: "image" | "video" | "audio";
  role: string;
  connection_order: number;
  metadata: null;
  paired_video_id: string | null;
};

function reference(
  assetId: string,
  kind: ReferenceWire["kind"],
  role: string,
  order: number,
  pairedVideoId: string | null = null,
): ReferenceWire {
  return {
    asset_id: assetId,
    kind,
    role,
    connection_order: order,
    metadata: null,
    paired_video_id: pairedVideoId,
  };
}

function preparedContext(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const selectedProfile = profile("h3_base");
  return {
    schema: MANAGED_PREPARED_CONTEXT_SCHEMA,
    parent_sequence_id: execution().parentSequenceId,
    parent_revision: execution().slotRevision,
    authorization_fingerprint: execution().parentAuthorizationFingerprint,
    segment_id: execution().segmentId,
    eligible_execution_fingerprint: execution().fingerprint,
    materialization_receipt_fingerprint:
      execution().materializationReceiptFingerprint,
    context_workspace_handle: contextWorkspaceHandle,
    context_report_id: "report.segment.1",
    context_report_revision: 1,
    context_report_fingerprint: fp("4"),
    canonical_prompt: prompt,
    canonical_prompt_fingerprint: canonicalStringFingerprint(prompt),
    task_mode: "t2va",
    duration_milliseconds: 8_000,
    frame_count: 192,
    profile: selectedProfile,
    profile_fingerprint: profileFingerprint("h3_base"),
    ordered_references: [],
    reference_registry_fingerprint: fp("5"),
    native_binding_fingerprint: fp("6"),
    canonical_lowering: {
      schema: PRODUCTION_CANONICAL_LOWERING_SCHEMA,
      base_report_fingerprint: fp("7"),
      base_report_revision: 0,
      override_revision: 1,
      reason: "Materialize approved Production segment prompt",
    },
    ...overrides,
  };
}

function framePreparedContext() {
  const refs = ["first_frame", "last_frame"].map((role, index) => ({
    asset_id: `${role}_1`,
    role,
    kind: "image",
    connection_order: index + 1,
    metadata: null,
    paired_video_id: null,
  }));
  return preparedContext({
    schema: "h3.context.managed_prepared_context.v2",
    task_mode: "fl2va",
    sequence_task_mode: "fl2va",
    geometry_donor_asset_id: null,
    ordered_references: refs,
    canonical_lowering: null,
    media_bindings: {
      schema: "h3.context.sequence_media_binding_set.v1",
      entries: refs.map((ref) => ({
        asset_id: ref.asset_id,
        role: ref.role,
        kind: "image",
        loader_class: "LoadImage",
        loader_node_id: ref.role,
        locator: `synthetic/${ref.role}.png`,
        source_identity: {
          schema: "h3.context.input_geometry.receipt.v2",
          receipt_handle: "ig_" + "r".repeat(40),
          source_fingerprint: fp("a"),
        },
        registry_endpoint: {
          node_id: "registry",
          input_name: ref.role,
          source_node_id: ref.role,
          source_slot: 0,
        },
        transform: null,
      })),
    },
  });
}

describe("private prepared V2 binding contract", () => {
  it("measures the fully populated private V2 maximum Unicode envelope", () => {
    const value = framePreparedContext();
    const prompt = "🌟".repeat(4096);
    const entries = ["first_frame", "last_frame"].map((role, index) => {
      const asset = `asset${index}`.padEnd(128, "n"),
        loader = `loader${index}`.padEnd(128, "n"),
        crop = `crop${index}`.padEnd(128, "n");
      return {
        asset_id: asset,
        role,
        kind: "image",
        loader_class: "LoadImage",
        loader_node_id: loader,
        locator: "🌟".repeat(512),
        source_identity: {
          schema: "h3.context.input_geometry.receipt.v2",
          receipt_handle: "ig_" + "r".repeat(96),
          source_fingerprint: fp("a"),
        },
        registry_endpoint: {
          node_id: "registry".padEnd(128, "n"),
          input_name: role,
          source_node_id: crop,
          source_slot: 0,
        },
        transform: {
          node_id: crop,
          class_type: "ImageCropV2",
          region: { x: 16352, y: 16352, width: 32, height: 32 },
        },
      };
    });
    Object.assign(value, {
      parent_sequence_id: "p".repeat(128),
      segment_id: "s".repeat(128),
      context_report_id: "r".repeat(128),
      context_workspace_handle: "ws_" + "w".repeat(96),
      canonical_prompt: prompt,
      canonical_prompt_fingerprint: canonicalStringFingerprint(prompt),
      ordered_references: entries.map((row, index) =>
        reference(row.asset_id, "image", row.role, index + 1),
      ),
      media_bindings: {
        schema: "h3.context.sequence_media_binding_set.v1",
        entries,
      },
      canonical_lowering: {
        ...(preparedContext().canonical_lowering as object),
        schema: "h3.context.production_canonical_lowering.v2",
        task_mode: "fl2va",
        binding_roles: ["first_frame", "last_frame"],
      },
    });
    const size = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(decodeProductionManagedPreparedContext(value).canonical_prompt).toBe(
      prompt,
    );
    expect(entries.every((row) => size(row) <= 4096)).toBe(true);
    expect(size(value)).toBeLessThanOrEqual(32768);
    expect([...prompt]).toHaveLength(4096);
    expect(size(prompt) - 2).toBe(16384);
    stdout.write(
      JSON.stringify({
        maximum_entry_bytes: entries.map(size),
        maximum_frame_prepared_bytes: size(value),
      }) + "\n",
    );
  });
  it("joins a V2 lowering to the child's exact mode and ordered roles", () => {
    const value = framePreparedContext();
    value.canonical_lowering = {
      ...(preparedContext().canonical_lowering as object),
      schema: "h3.context.production_canonical_lowering.v2",
      task_mode: "fl2va",
      binding_roles: ["first_frame", "last_frame"],
    };
    expect(
      decodeProductionManagedPreparedContext(value).canonical_lowering,
    ).toMatchObject({
      schema: "h3.context.production_canonical_lowering.v2",
      taskMode: "fl2va",
      bindingRoles: ["first_frame", "last_frame"],
    });
    expect(() =>
      decodeProductionManagedPreparedContext({
        ...value,
        canonical_lowering: {
          ...(value.canonical_lowering as object),
          task_mode: "i2va",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProductionManagedPreparedContext({
        ...value,
        canonical_lowering: {
          ...(value.canonical_lowering as object),
          binding_roles: ["last_frame", "first_frame"],
        },
      }),
    ).toThrow();
  });
  it("decodes exact frame bindings and global geometry ownership", () => {
    const value = framePreparedContext();
    expect(decodeProductionManagedPreparedContext(value)).toMatchObject(value);
  });
  it.each([
    "extra",
    "missing",
    "foreign_asset",
    "wrong_role",
    "wrong_mode",
    "donor",
  ])("rejects %s", (change) => {
    const value = framePreparedContext();
    if (change === "extra") value.foreign = true;
    if (change === "missing") value.media_bindings = null;
    if (change === "foreign_asset") value.ordered_references = [];
    if (change === "wrong_role")
      value.ordered_references = [
        {
          asset_id: "first_frame_1",
          role: "reference",
          kind: "image",
          connection_order: 1,
          metadata: null,
          paired_video_id: null,
        },
      ];
    if (change === "wrong_mode") value.sequence_task_mode = "ref2va";
    if (change === "donor") value.geometry_donor_asset_id = "first_frame_1";
    expect(() => decodeProductionManagedPreparedContext(value)).toThrow();
  });
});

function environment(responseValue = preparedContext()) {
  let visible: unknown = graph();
  const loadGraphData = vi.fn();
  const fetchApi = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => structuredClone(responseValue),
  }));
  const bound = fixtureBackedAppModeHost(
    {
      graph: { serialize: vi.fn(() => structuredClone(visible)) },
      extensionManager: {
        workflow: {
          activeWorkflow: workflowAuthority,
          openWorkflows: [workflowAuthority],
        },
      },
      loadGraphData,
    },
    {},
  );
  const currentOwnedGraphReference = vi.fn(() => ownedReference);
  return {
    app: bound.app,
    fetchApi,
    loadGraphData,
    currentOwnedGraphReference,
    resolver: createProductionManagedChildResolver({
      app: bound.app,
      fetchApi,
      currentOwnedGraphReference,
    }),
    setVisible(next: unknown) {
      visible = next;
    },
  };
}

function reservedFrameContext(
  task: "t2va" | "i2va" | "l2va" | "fl2va",
  global: "i2va" | "l2va" | "fl2va",
  text: string,
) {
  const value = framePreparedContext();
  const roles =
    task === "fl2va"
      ? ["first_frame", "last_frame"]
      : task === "i2va"
        ? ["first_frame"]
        : task === "l2va"
          ? ["last_frame"]
          : [];
  const needed = new Set([
    ...roles,
    ...(global === "i2va" ? ["first_frame"] : []),
  ]);
  const entries = (
    value.media_bindings as { entries: Array<Record<string, unknown>> }
  ).entries.filter((row) => needed.has(String(row.role)));
  // Invalid-surrogate rows deliberately carry a syntactic fingerprint so the decoder owns refusal.
  const textFingerprint = /[\uD800-\uDFFF]/u.test(text)
    ? fp("4")
    : canonicalStringFingerprint(text);
  return {
    ...value,
    task_mode: task,
    sequence_task_mode: global,
    canonical_prompt: text,
    canonical_prompt_fingerprint: textFingerprint,
    geometry_donor_asset_id: global === "i2va" ? "first_frame_1" : null,
    ordered_references: roles.map((role, index) =>
      reference(`${role}_1`, "image", role, index + 1),
    ),
    media_bindings: entries.length
      ? { schema: "h3.context.sequence_media_binding_set.v1", entries }
      : null,
    canonical_lowering: {
      ...(preparedContext().canonical_lowering as object),
      ...(task === "t2va"
        ? {}
        : {
            schema: "h3.context.production_canonical_lowering.v2",
            task_mode: task,
            binding_roles: roles,
          }),
    },
  };
}

describe("reserved private frame resolver", () => {
  it.each([
    ["i2va", "i2va"],
    ["t2va", "i2va"],
    ["l2va", "l2va"],
    ["fl2va", "fl2va"],
    ["t2va", "fl2va"],
  ] as const)(
    "resolves 4096 astral code points and exact private media for %s of %s",
    async (task, global) => {
      const value = reservedFrameContext(task, global, "🌟".repeat(4096));
      const subject = environment(value);
      const plan = await subject.resolver(
        execution(),
        contextWorkspaceHandle,
        0,
      );
      expect(plan.inputs.user_intent).toBe(value.canonical_prompt);
      expect(plan.inputs.task_mode).toBe(task);
      expect(plan.inputs.first_frame_source).toBe(
        task === "i2va" || task === "fl2va" ? "first_frame" : undefined,
      );
      expect(plan.inputs.last_frame_source).toBe(
        task === "l2va" || task === "fl2va" ? "last_frame" : undefined,
      );
      expect(plan.preparedSequenceMedia).toMatchObject({
        sequenceTaskMode: global,
        bindings: value.media_bindings,
        geometryDonorAssetId: value.geometry_donor_asset_id,
      });
      expect(plan.options).not.toHaveProperty("preparedSequenceMedia");
      expect(subject.loadGraphData).not.toHaveBeenCalled();
    },
  );

  it.each([
    "🌟".repeat(4097),
    "synthetic\ud800prompt",
    "synthetic\udc00prompt",
  ])(
    "refuses invalid private Unicode before a child plan or canvas write %#",
    async (text) => {
      const subject = environment(reservedFrameContext("i2va", "i2va", text));
      await expect(
        subject.resolver(execution(), contextWorkspaceHandle, 0),
      ).rejects.toMatchObject({
        code:
          text.length > 8192
            ? "unsupported_prepared_context"
            : "invalid_response",
      });
      expect(subject.loadGraphData).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary T2VA's existing UTF-16 refusal", async () => {
    const text = "🌟".repeat(4096);
    const subject = environment(
      preparedContext({
        canonical_prompt: text,
        canonical_prompt_fingerprint: canonicalStringFingerprint(text),
      }),
    );
    await expect(
      subject.resolver(execution(), contextWorkspaceHandle, 0),
    ).rejects.toMatchObject({
      code: "unsupported_prepared_context",
      status: 422,
    });
  });
});

function deferredEnvironment() {
  let release!: (value: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let visible: unknown = graph();
  let referenceAuthority: OwnedGraphReference = ownedReference;
  const workflowStore = {
    activeWorkflow: workflowAuthority as object,
    openWorkflows: [workflowAuthority] as object[],
  };
  const loadGraphData = vi.fn();
  const fetchApi = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => response,
  }));
  const bound = fixtureBackedAppModeHost(
    {
      graph: { serialize: () => structuredClone(visible) },
      extensionManager: { workflow: workflowStore },
      loadGraphData,
    },
    {},
  );
  const resolver = createProductionManagedChildResolver({
    app: bound.app,
    fetchApi,
    currentOwnedGraphReference: () => referenceAuthority,
  });
  return {
    app: bound.app,
    loadGraphData,
    resolver,
    release,
    setVisible(value: unknown) {
      visible = value;
    },
    setReference(value: OwnedGraphReference) {
      referenceAuthority = value;
    },
    workflowStore,
  };
}

describe("Production managed child resolver", () => {
  it("enforces the dedicated prepared byte budget for CJK payloads", () => {
    const cjk = "\u754c".repeat(4_096);
    const admitted = preparedContext({
      canonical_prompt: cjk,
      canonical_prompt_fingerprint: canonicalStringFingerprint(cjk),
    });
    expect(
      decodeProductionManagedPreparedContext(admitted).canonical_prompt,
    ).toBe(cjk);
    const oversized = "\u754c".repeat(16_384);
    const refused = preparedContext({
      canonical_prompt: oversized,
      canonical_prompt_fingerprint: canonicalStringFingerprint(oversized),
    });
    expect(() => decodeProductionManagedPreparedContext(refused)).toThrow();
  });
  it("admits exactly the derived prepared byte cap and refuses one extra byte", () => {
    const make = (extra: number) => {
      const value = preparedContext({
        canonical_prompt: "x",
        canonical_prompt_fingerprint: canonicalStringFingerprint("x"),
      });
      const overhead =
        new TextEncoder().encode(JSON.stringify(value)).byteLength - 1;
      const text = "x".repeat(32 * 1_024 + extra - overhead);
      value.canonical_prompt = text;
      value.canonical_prompt_fingerprint = canonicalStringFingerprint(text);
      expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBe(
        32 * 1_024 + extra,
      );
      return value;
    };
    expect(
      decodeProductionManagedPreparedContext(make(0)).canonical_prompt,
    ).toBeTruthy();
    expect(() => decodeProductionManagedPreparedContext(make(1))).toThrow();
  });
  it("keeps parent identity across legitimate child writes while refreshing owned currentness", async () => {
    const wire = preparedContext();
    const subject = environment(wire);
    const first = await subject.resolver(
      execution(),
      contextWorkspaceHandle,
      0,
    );
    const nextGraph = { ...graph(prompt), extra: { foreign_revision: 2 } };
    subject.setVisible(nextGraph);
    const next = {
      ...execution(),
      segmentId: "segment.2",
      slotRevision: 8,
      fingerprint: fp("4"),
    };
    Object.assign(wire, {
      segment_id: next.segmentId,
      parent_revision: next.slotRevision,
      eligible_execution_fingerprint: next.fingerprint,
    });
    const second = await subject.resolver(next, contextWorkspaceHandle, 1);
    expect(second.activeWorkflowFingerprint).toBe(
      first.activeWorkflowFingerprint,
    );
    expect(second.previousOwnedProjectionFingerprint).toBe(
      observeOwnedGraph(nextGraph, ownedReference).fingerprint,
    );
    expect(second.previousOwnedProjectionFingerprint).not.toBe(
      first.previousOwnedProjectionFingerprint,
    );
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it("binds the first dirty child after reused predecessors without requiring index zero", async () => {
    const subject = environment();
    const result = await subject.resolver(
      execution(),
      contextWorkspaceHandle,
      1,
    );
    expect(result.workflowAuthority).toBe(workflowAuthority);
    expect(result.activeWorkflowFingerprint).toBe(graphFingerprint(graph()));
    expect(subject.fetchApi).toHaveBeenCalledOnce();
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it("refuses identical-content workflow replacement between children", async () => {
    const subject = deferredEnvironment();
    subject.release(preparedContext());
    await subject.resolver(execution(), contextWorkspaceHandle, 0);
    const replacement = {};
    subject.workflowStore.activeWorkflow = replacement;
    subject.workflowStore.openWorkflows = [replacement];
    await expect(
      subject.resolver(execution(), contextWorkspaceHandle, 1),
    ).rejects.toMatchObject({ code: "workflow_identity_changed" });
  });

  it("binds a new parent at its first child without carrying the old graph label", async () => {
    const wire = preparedContext();
    const subject = environment(wire);
    const first = await subject.resolver(
      execution(),
      contextWorkspaceHandle,
      0,
    );
    const nextGraph = graph(prompt);
    subject.setVisible(nextGraph);
    const next = { ...execution(), parentSequenceId: "managed.sequence.2" };
    Object.assign(wire, { parent_sequence_id: next.parentSequenceId });
    const second = await subject.resolver(next, contextWorkspaceHandle, 0);
    expect(second.activeWorkflowFingerprint).toBe(graphFingerprint(nextGraph));
    expect(second.activeWorkflowFingerprint).not.toBe(
      first.activeWorkflowFingerprint,
    );
  });

  it("reads one exact prepared authority and captures the real workflow and owned projection", async () => {
    const subject = environment();
    const result = await subject.resolver(
      execution(),
      contextWorkspaceHandle,
      0,
    );

    expect(result.inputs).toEqual({
      task_mode: "t2va",
      user_intent: prompt,
      duration_milliseconds: 8_000,
      frame_count: 192,
    });
    expect(result.options).toEqual({
      replaceExisting: true,
      artifactScope: `managed.${execution().fingerprint.slice(-32)}`,
    });
    expect(result.canonicalLowering).toEqual({
      schema: PRODUCTION_CANONICAL_LOWERING_SCHEMA,
      canonicalPrompt: prompt,
      baseReportFingerprint: fp("7"),
      baseReportRevision: 0,
      overrideRevision: 1,
      reason: "Materialize approved Production segment prompt",
    });
    expect(result.workflowAuthority).toBe(workflowAuthority);
    expect(result.activeWorkflowFingerprint).toBe(graphFingerprint(graph()));
    expect(result.previousOwnedProjectionFingerprint).toBe(
      observeOwnedGraph(graph(), ownedReference).fingerprint,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(subject.fetchApi).toHaveBeenCalledOnce();
    const [path, init] = subject.fetchApi.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(MANAGED_SEQUENCE_ROUTE);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      schema: MANAGED_PREPARED_CONTEXT_ACTION_SCHEMA,
      request_id: `read.prepared.${execution().fingerprint.slice(-40)}`,
      action: "read_prepared_child_context",
      payload: {
        parent_sequence_id: execution().parentSequenceId,
        expected_revision: execution().slotRevision,
        authorization_fingerprint: execution().parentAuthorizationFingerprint,
        segment_id: execution().segmentId,
        eligible_execution_fingerprint: execution().fingerprint,
        materialization_receipt_fingerprint:
          execution().materializationReceiptFingerprint,
        context_workspace_handle: contextWorkspaceHandle,
      },
    });
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "i2va" as const,
      refs: [reference("image_1", "image", "first_frame", 1)],
    },
    {
      mode: "l2va" as const,
      refs: [reference("last_image_1", "image", "last_frame", 1)],
    },
    {
      mode: "fl2va" as const,
      refs: [
        reference("image_1", "image", "first_frame", 1),
        reference("last_image_1", "image", "last_frame", 2),
      ],
    },
  ])(
    "preserves exact $mode semantic references but refuses an unresolved host binding",
    async ({ mode, refs }) => {
      const wire = preparedContext({
        task_mode: mode,
        ordered_references: refs,
      });
      const decoded = decodeProductionManagedPreparedContext(wire);
      expect(decoded.task_mode).toBe(mode);
      expect(decoded.ordered_references).toEqual(refs);
      const subject = environment(wire);
      await expect(
        subject.resolver(execution(), contextWorkspaceHandle, 0),
      ).rejects.toMatchObject({
        code: "unsupported_prepared_context",
        status: 422,
      });
      expect(subject.loadGraphData).not.toHaveBeenCalled();
    },
  );

  it("preserves ordered Ref2VA media but does not reinterpret semantic asset IDs as host node IDs", async () => {
    const references = [
      reference("image_1", "image", "reference", 1),
      reference("video_1_audio", "audio", "audio_source", 2, "video_1"),
      reference("video_1", "video", "reference", 3),
      reference("audio_1", "audio", "audio_source", 4),
    ];
    const wire = preparedContext({
      task_mode: "ref2va",
      profile: profile("h3_full_reference"),
      profile_fingerprint: profileFingerprint("h3_full_reference"),
      ordered_references: references,
    });
    expect(
      decodeProductionManagedPreparedContext(wire).ordered_references,
    ).toEqual(references);
    const subject = environment(wire);
    await expect(
      subject.resolver(execution(), contextWorkspaceHandle, 0),
    ).rejects.toMatchObject({
      code: "unsupported_prepared_context",
      status: 422,
    });
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it.each([
    ["parent_sequence_id", "managed.foreign"],
    ["parent_revision", 5],
    ["authorization_fingerprint", fp("a")],
    ["segment_id", "segment.foreign"],
    ["eligible_execution_fingerprint", fp("b")],
    ["materialization_receipt_fingerprint", fp("c")],
    ["context_workspace_handle", `ws_${"d".repeat(40)}`],
  ])("rejects a cross-authority %s response join", async (field, value) => {
    const subject = environment(preparedContext({ [field]: value }));
    await expect(
      subject.resolver(execution(), contextWorkspaceHandle, 0),
    ).rejects.toMatchObject({
      code: "cross_prepared_context_authority",
      status: 500,
    });
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, content drift, profile drift and invalid reference authority", () => {
    const invalid = [
      preparedContext({ injected_report: {} }),
      preparedContext({ canonical_prompt_fingerprint: fp("f") }),
      preparedContext({
        profile: profile("h3_full_reference"),
        profile_fingerprint: profileFingerprint("h3_base"),
      }),
      preparedContext({
        ordered_references: [
          reference("audio_pair_1", "audio", "audio_source", 1, "video_1"),
          reference("image_1", "image", "reference", 2),
          reference("video_1", "video", "reference", 3),
        ],
      }),
      preparedContext({
        ordered_references: [reference("11", "image", "first_frame", 2)],
      }),
      preparedContext({
        ordered_references: [
          reference("31", "video", "reference", 1),
          reference("11", "image", "reference", 2),
        ],
      }),
      preparedContext({
        canonical_lowering: {
          schema: PRODUCTION_CANONICAL_LOWERING_SCHEMA,
          base_report_fingerprint: fp("7"),
          base_report_revision: 0,
          override_revision: 1,
          reason: "Materialize approved Production segment prompt",
          injected: true,
        },
      }),
      preparedContext({
        canonical_lowering: {
          schema: PRODUCTION_CANONICAL_LOWERING_SCHEMA,
          base_report_fingerprint: fp("7"),
          base_report_revision: 0,
          override_revision: 1,
          reason: "trust a different prompt",
        },
      }),
    ];
    for (const wire of invalid)
      expect(() => decodeProductionManagedPreparedContext(wire)).toThrow(
        ManagedSequenceClientError,
      );
  });

  it.each([
    preparedContext({
      task_mode: "t2va",
      ordered_references: [reference("image_1", "image", "first_frame", 1)],
    }),
    preparedContext({
      task_mode: "ref2va",
      profile: profile("h3_full_reference"),
      profile_fingerprint: profileFingerprint("h3_full_reference"),
      ordered_references: [
        reference("image_1", "image", "subject_reference", 1),
      ],
    }),
    preparedContext({
      task_mode: "ref2va",
      profile: profile("h3_full_reference"),
      profile_fingerprint: profileFingerprint("h3_full_reference"),
      ordered_references: [
        reference("image_1", "image", "reference", 1),
        reference("image_2", "image", "reference", 2),
      ],
    }),
    preparedContext({
      task_mode: "fl2va",
      ordered_references: [
        reference("last_image_1", "image", "last_frame", 1),
        reference("image_1", "image", "first_frame", 2),
      ],
    }),
    preparedContext({ canonical_lowering: null }),
    preparedContext({
      canonical_lowering: {
        schema: PRODUCTION_CANONICAL_LOWERING_SCHEMA,
        base_report_fingerprint: fp("7"),
        base_report_revision: 1,
        override_revision: 1,
        reason: "Materialize approved Production segment prompt",
      },
    }),
    (() => {
      const oversizedPrompt = "x".repeat(4_097);
      return preparedContext({
        canonical_prompt: oversizedPrompt,
        canonical_prompt_fingerprint:
          canonicalStringFingerprint(oversizedPrompt),
      });
    })(),
  ])(
    "refuses a valid backend context App Mode cannot represent without semantic loss",
    async (wire) => {
      const subject = environment(wire);
      await expect(
        subject.resolver(execution(), contextWorkspaceHandle, 0),
      ).rejects.toMatchObject({
        code: "unsupported_prepared_context",
        status: 422,
      });
    },
  );

  it("rejects when an owned authored node changes during the prepared context read", async () => {
    let release!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let visible = graph();
    const loadGraphData = vi.fn();
    const fetchApi = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => response,
    }));
    const bound = fixtureBackedAppModeHost(
      {
        graph: { serialize: () => structuredClone(visible) },
        extensionManager: {
          workflow: {
            activeWorkflow: workflowAuthority,
            openWorkflows: [workflowAuthority],
          },
        },
        loadGraphData,
      },
      {},
    );
    const resolver = createProductionManagedChildResolver({
      app: bound.app,
      fetchApi,
      currentOwnedGraphReference: () => ownedReference,
    });
    const pending = resolver(execution(), contextWorkspaceHandle, 0);
    visible = graph("foreign edit");
    release(preparedContext());

    await expect(pending).rejects.toMatchObject({
      code: "workflow_identity_changed",
      status: 409,
    });
    expect(loadGraphData).not.toHaveBeenCalled();
  });

  it("accepts foreign nodes, host metadata and layout changes while owned projection stays current", async () => {
    const subject = deferredEnvironment();
    const pending = subject.resolver(execution(), contextWorkspaceHandle, 0);
    const latest = graphWithForeignNoise();
    subject.setVisible(latest);
    subject.release(preparedContext());

    const result = await pending;
    expect(result.activeWorkflowFingerprint).toBe(graphFingerprint(latest));
    expect(result.activeWorkflowFingerprint).not.toBe(
      graphFingerprint(graph()),
    );
    expect(result.previousOwnedProjectionFingerprint).toBe(
      observeOwnedGraph(graph(), ownedReference).fingerprint,
    );
    expect(observeOwnedGraph(latest, ownedReference).fingerprint).toBe(
      result.previousOwnedProjectionFingerprint,
    );
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it("rejects an anchor prompt-binding change during the prepared context read", async () => {
    const subject = deferredEnvironment();
    const pending = subject.resolver(execution(), contextWorkspaceHandle, 0);
    const value = graph();
    subject.setVisible({
      ...value,
      nodes: value.nodes.map((node) =>
        node.id === 2
          ? {
              ...node,
              inputs: [{ name: "prompt", type: "STRING", link: null }],
            }
          : node,
      ),
    });
    subject.release(preparedContext());

    await expect(pending).rejects.toMatchObject({
      code: "workflow_identity_changed",
      status: 409,
    });
    expect(subject.loadGraphData).not.toHaveBeenCalled();
  });

  it.each(["active workflow", "open tab count"])(
    "rejects a changed %s during the prepared context read",
    async (change) => {
      const subject = deferredEnvironment();
      const pending = subject.resolver(execution(), contextWorkspaceHandle, 0);
      if (change === "active workflow") {
        const replacement = {};
        subject.workflowStore.activeWorkflow = replacement;
        subject.workflowStore.openWorkflows = [replacement];
      } else {
        subject.workflowStore.openWorkflows.push({});
      }
      subject.release(preparedContext());

      await expect(pending).rejects.toMatchObject({
        code: "workflow_identity_changed",
        status: 409,
      });
      expect(subject.loadGraphData).not.toHaveBeenCalled();
    },
  );

  it("rejects when the owned graph reference changes while the prepared context read is pending", async () => {
    let release!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let referenceAuthority = ownedReference;
    const loadGraphData = vi.fn();
    const fetchApi = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => response,
    }));
    const bound = fixtureBackedAppModeHost(
      {
        graph: { serialize: () => graph() },
        extensionManager: {
          workflow: {
            activeWorkflow: workflowAuthority,
            openWorkflows: [workflowAuthority],
          },
        },
        loadGraphData,
      },
      {},
    );
    const resolver = createProductionManagedChildResolver({
      app: bound.app,
      fetchApi,
      currentOwnedGraphReference: () => referenceAuthority,
    });
    const pending = resolver(execution(), contextWorkspaceHandle, 0);
    referenceAuthority = Object.freeze({
      ...ownedReference,
      nodeIds: Object.freeze(["1"]),
    });
    release(preparedContext());

    await expect(pending).rejects.toMatchObject({
      code: "workflow_identity_changed",
      status: 409,
    });
    expect(loadGraphData).not.toHaveBeenCalled();
  });

  it("closes malformed canonical text and decoder inputs as typed response errors", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      preparedContext({ canonical_prompt: "unsafe\ud800text" }),
    ]) {
      expect(() => decodeProductionManagedPreparedContext(value)).toThrow(
        ManagedSequenceClientError,
      );
    }
  });

  it("accepts an exact positive Decimal metadata value without binary64 underflow", () => {
    const value = preparedContext({
      task_mode: "ref2va",
      profile: profile("h3_full_reference"),
      profile_fingerprint: profileFingerprint("h3_full_reference"),
      ordered_references: [
        {
          ...reference("11", "image", "reference", 1),
          metadata: {
            duration_seconds: `0.${"0".repeat(400)}1`,
            width: null,
            height: null,
            frame_count: null,
            sample_rate: null,
            channels: null,
          },
        },
      ],
    });
    expect(
      decodeProductionManagedPreparedContext(value).ordered_references,
    ).toHaveLength(1);
  });

  it("does not parse a refusal body, mutate the canvas, or consult a queue seam", async () => {
    const json = vi.fn();
    const loadGraphData = vi.fn();
    const queuePrompt = vi.fn();
    const fetchApi = vi.fn(async () => ({
      ok: false,
      status: 409,
      json,
    }));
    const bound = fixtureBackedAppModeHost(
      {
        graph: { serialize: () => graph() },
        extensionManager: {
          workflow: {
            activeWorkflow: workflowAuthority,
            openWorkflows: [workflowAuthority],
          },
        },
        loadGraphData,
      },
      { queuePrompt },
    );
    const resolver = createProductionManagedChildResolver({
      app: bound.app,
      fetchApi,
      currentOwnedGraphReference: () => ownedReference,
    });

    await expect(
      resolver(execution(), contextWorkspaceHandle, 0),
    ).rejects.toMatchObject({
      code: "prepared_context_rejected",
      status: 409,
    });
    expect(json).not.toHaveBeenCalled();
    expect(loadGraphData).not.toHaveBeenCalled();
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
