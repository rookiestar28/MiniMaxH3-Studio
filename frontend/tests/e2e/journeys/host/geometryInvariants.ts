import type { GenerationModeFamily } from "../../../../src/contracts/generationProfileCodec";
import {
  OFFICIAL_ASSET_MANIFEST,
  OFFICIAL_ASSET_POLICY_ID,
  OfficialAssetResolutionError,
  readOfficialAssetInventoryFromNodeDefinitions,
  resolveOfficialAssets,
  type OfficialAssetResolution,
  type OfficialAssetResolutionErrorCode,
} from "../../../../src/host/officialAssetResolution";

export type GeometryAssetReceipt = Pick<
  OfficialAssetResolution,
  "policyId" | "selections" | "changedSlots" | "unresolvedSlots"
> & { errorCode?: OfficialAssetResolutionErrorCode };

export function resolveGeometryAssets(
  template: Record<string, unknown>,
  family: GenerationModeFamily,
  objectInfo: unknown,
): { workflow: Record<string, unknown>; receipt: GeometryAssetReceipt } {
  // /object_info returns node data; the product reads that same data on registered classes.
  const definitions =
    objectInfo !== null &&
    typeof objectInfo === "object" &&
    !Array.isArray(objectInfo)
      ? Object.fromEntries(
          Object.entries(objectInfo).map(([name, nodeData]) => [
            name,
            { nodeData },
          ]),
        )
      : objectInfo;
  try {
    // CRITICAL: resolve before splice, as the product route does. Raw loader defaults absent
    // from the host inventory trigger its missing-model metadata HEADs during graph loading.
    const resolution = resolveOfficialAssets(
      template,
      family,
      readOfficialAssetInventoryFromNodeDefinitions(definitions),
    );
    return {
      workflow: resolution.workflow,
      receipt: {
        policyId: resolution.policyId,
        selections: resolution.selections.map(({ slot, reason }) => ({
          slot,
          reason,
        })),
        changedSlots: resolution.changedSlots,
        unresolvedSlots: resolution.unresolvedSlots,
      },
    };
  } catch (error) {
    if (
      !(error instanceof OfficialAssetResolutionError) ||
      error.code === "invalid_manifest"
    )
      throw error;
    // The route continues on advisory inventory errors. No resolution completed, so keep
    // every required slot unresolved and retain only the code, never inventory or messages.
    return {
      workflow: template,
      receipt: {
        policyId: OFFICIAL_ASSET_POLICY_ID,
        selections: [],
        changedSlots: [],
        unresolvedSlots:
          OFFICIAL_ASSET_MANIFEST.materializationFamilies[family],
        errorCode: error.code,
      },
    };
  }
}

export type GeometryEdge = [number, number, number, number, number, string];

export type GeometryStructure = {
  id: number;
  type: string;
  inputs: { name: string; type: string; widget: boolean; linked: boolean }[];
  outputs: { name: string; type: string; linkCount: number }[];
  widgets: { name: string; value: string | number | boolean | null }[];
};

export function projectGeometryStructure(node: {
  id: number;
  type: string;
  inputs: {
    name: string;
    type: string;
    widget: boolean;
    link?: number | null;
  }[];
  outputs: { name: string; type: string; links?: number[] | null }[];
  widgets: GeometryStructure["widgets"];
}): GeometryStructure {
  return {
    id: node.id,
    type: node.type,
    inputs: node.inputs.map(({ name, type, widget, link }) => ({
      name,
      type,
      widget,
      linked: link != null,
    })),
    outputs: node.outputs.map(({ name, type, links }) => ({
      name,
      type,
      linkCount: links?.length ?? 0,
    })),
    widgets: node.widgets,
  };
}

function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// IMPORTANT: a host may add unlinked widget slots while loading a template. Edge absence,
// not the template's empty input/output array shape, is the invariant under observation.
export function assertNoIncomingEdges(
  node: GeometryStructure,
  edges: GeometryEdge[],
): void {
  requireFact(
    node.inputs.every((input) => !input.linked) &&
      edges.every((edge) => edge[3] !== node.id),
    "geometry node has an incoming edge",
  );
}

export function assertNoOutputEdges(
  node: GeometryStructure,
  edges: GeometryEdge[],
): void {
  requireFact(
    node.outputs.every((output) => output.linkCount === 0) &&
      edges.every((edge) => edge[1] !== node.id),
    "geometry node has an outgoing edge",
  );
}

export function assertNamedWidgetValues(
  node: GeometryStructure,
  expected: Record<string, string | number | boolean | null>,
): void {
  for (const [name, value] of Object.entries(expected)) {
    const widgets = node.widgets.filter((widget) => widget.name === name);
    requireFact(
      widgets.length === 1 && widgets[0].value === value,
      `geometry widget mismatch: ${name}`,
    );
  }
}

export function assertDrivesDimensions(
  selector: GeometryStructure,
  anchor: number,
  targets: { name: string; slot: number }[],
  edges: GeometryEdge[],
): void {
  const outgoing = edges.filter((edge) => edge[1] === selector.id);
  requireFact(
    targets.length === 2 && outgoing.length === 2,
    "selector must drive only the two dimensions",
  );
  for (const name of ["width", "height"]) {
    const outputSlots = selector.outputs
      .map((output, slot) => ({ ...output, slot }))
      .filter((output) => output.name === name);
    const target = targets.filter((input) => input.name === name);
    requireFact(
      outputSlots.length === 1 && target.length === 1,
      "dimension port identity missing or ambiguous",
    );
    const output = outputSlots[0];
    const links = outgoing.filter((edge) => edge[2] === output.slot);
    requireFact(
      output.linkCount === 1 &&
        links.length === 1 &&
        links[0][3] === anchor &&
        links[0][4] === target[0].slot,
      `selector does not drive anchor ${name}`,
    );
  }
  requireFact(
    selector.outputs.every(
      (output) =>
        ["width", "height"].includes(output.name) || output.linkCount === 0,
    ),
    "selector has a linked non-dimension output",
  );
}

// IMPORTANT: attach once before checking facts. Preserve completed modes on a projection
// failure, and let the original build error remain primary rather than a missing attachment.
export async function collectGeometry<T>(
  builders: (() => Promise<T>)[],
  attach: (value: { projections: T[]; incomplete: boolean }) => Promise<void>,
): Promise<T[]> {
  const projections: T[] = [];
  try {
    for (const build of builders) projections.push(await build());
  } catch (error) {
    try {
      await attach({ projections, incomplete: true });
    } finally {
      throw error;
    }
  }
  await attach({ projections, incomplete: false });
  return projections;
}

export type DeniedNetworkEvent = {
  kind: "http" | "websocket" | "download";
  method?: string;
  originClass: "same" | "foreign";
  pathClass: "prompt" | "queue" | "download" | "provider" | "other";
  phase: "startup" | "interaction";
};

export function createDeniedNetworkRecorder(allowedOrigin: string) {
  const origin = new URL(allowedOrigin).origin;
  const events: DeniedNetworkEvent[] = [];
  let phase: DeniedNetworkEvent["phase"] = "startup";
  return {
    beginInteractionPhase(): void {
      phase = "interaction";
    },
    record(
      kind: DeniedNetworkEvent["kind"],
      address: string,
      method?: string,
    ): void {
      let originClass: DeniedNetworkEvent["originClass"] = "foreign";
      let pathClass: DeniedNetworkEvent["pathClass"] = "other";
      try {
        const url = new URL(address);
        if (url.protocol === "ws:") url.protocol = "http:";
        if (url.protocol === "wss:") url.protocol = "https:";
        originClass = url.origin === origin ? "same" : "foreign";
        const segment = url.pathname
          .match(/\/(prompt|queue|downloads?|providers?)(?:\/|$)/i)?.[1]
          .toLowerCase();
        if (segment === "prompt" || segment === "queue") pathClass = segment;
        if (segment === "download" || segment === "downloads")
          pathClass = "download";
        if (segment === "provider" || segment === "providers")
          pathClass = "provider";
      } catch {
        // A malformed address remains foreign/other; never retain it or bypass the denial.
      }
      const verb = method?.toUpperCase();
      events.push({
        kind,
        ...(kind === "http"
          ? {
              method:
                verb &&
                [
                  "GET",
                  "HEAD",
                  "POST",
                  "PUT",
                  "PATCH",
                  "DELETE",
                  "OPTIONS",
                  "CONNECT",
                  "TRACE",
                ].includes(verb)
                  ? verb
                  : "OTHER",
            }
          : {}),
        originClass,
        pathClass,
        phase,
      });
    },
    snapshot() {
      // CRITICAL: retain only closed categories, never URL-bearing data. Startup denials
      // remain visible host context; the maintained settled phase defines the zero-attempt gate.
      const counts = new Map<string, DeniedNetworkEvent & { count: number }>();
      for (const event of events) {
        const key = JSON.stringify(event);
        const current = counts.get(key);
        if (current) current.count += 1;
        else counts.set(key, { ...event, count: 1 });
      }
      return {
        events: events.map((event) => ({ ...event })),
        counts: [...counts.values()],
        total: events.length,
        startupCount: events.filter((event) => event.phase === "startup")
          .length,
        interactionCount: events.filter(
          (event) => event.phase === "interaction",
        ).length,
      };
    },
  };
}
