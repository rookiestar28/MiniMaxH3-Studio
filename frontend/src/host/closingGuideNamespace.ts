import { isRecord, type Json } from "./templateGraphTopology";

type Kind = "node" | "link" | "group" | "reroute";
const kinds: Kind[] = ["node", "link", "group", "reroute"];
const counterKeys = {
  node: "lastNodeId",
  link: "lastLinkId",
  group: "lastGroupId",
  reroute: "lastRerouteId",
} as const;

/** Private graph IDs must survive the host's cross-definition normalization. */
export function closingGuideNamespace(workflow: Json, refuse: () => never) {
  const rows = (value: unknown): Json[] =>
    value === undefined
      ? []
      : Array.isArray(value) && value.every(isRecord)
        ? value
        : refuse();
  const id = (value: unknown): number => {
    const numeric = typeof value === "string" ? Number(value) : value;
    if (
      typeof numeric !== "number" ||
      !Number.isSafeInteger(numeric) ||
      numeric < 0 ||
      (typeof value === "string" && String(numeric) !== value)
    )
      return refuse();
    return numeric;
  };
  const links = (graph: Json): (Json | unknown[])[] => {
    if (!Array.isArray(graph.links)) return refuse();
    const normal = graph.links.map((link: unknown) => {
      if (Array.isArray(link) && link.length >= 6) return link;
      return isRecord(link) ? link : refuse();
    });
    return [...normal, ...rows(graph.floatingLinks)];
  };
  const entries = (graph: Json, kind: Kind) =>
    kind === "link"
      ? links(graph)
      : rows(graph[kind === "node" ? "nodes" : `${kind}s`]);
  const entryId = (entry: Json | unknown[]) =>
    id(Array.isArray(entry) ? entry[0] : entry.id);
  const definitions =
    workflow.definitions === undefined
      ? []
      : isRecord(workflow.definitions)
        ? rows(workflow.definitions.subgraphs)
        : refuse();
  const maximum: Record<Kind, number> = {
    node: 0,
    link: 0,
    group: 0,
    reroute: 0,
  };
  for (const graph of [workflow, ...definitions]) {
    for (const kind of kinds) {
      const seen = new Set<number>();
      for (const entry of entries(graph, kind)) {
        const value = entryId(entry);
        if (seen.has(value)) return refuse();
        seen.add(value);
        maximum[kind] = Math.max(maximum[kind], value);
      }
      const state = graph.state;
      if (state !== undefined && !isRecord(state)) return refuse();
      for (const value of [
        graph[`last_${kind}_id`],
        isRecord(state) ? state[counterKeys[kind]] : undefined,
      ]) {
        if (value !== undefined)
          maximum[kind] = Math.max(maximum[kind], id(value));
      }
    }
  }
  const next = (kind: Kind) => {
    const value = maximum[kind] + 1;
    if (!Number.isSafeInteger(value)) return refuse();
    maximum[kind] = value;
    return value;
  };
  const remapDefinition = (graph: Json, instance: Json): void => {
    const maps = Object.fromEntries(
      kinds.map((kind) => [
        kind,
        new Map(
          entries(graph, kind).map((entry) => [entryId(entry), next(kind)]),
        ),
      ]),
    ) as Record<Kind, Map<number, number>>;
    const mapped = (kind: Kind, value: unknown) =>
      maps[kind].get(id(value)) ?? refuse();
    const mappedNode = (value: unknown) =>
      value === -10 || value === -20 ? value : mapped("node", value);
    const list = (owner: Json, key: string, kind: Kind) => {
      const values = owner[key];
      if (values === undefined || values === null) return;
      if (!Array.isArray(values)) return refuse();
      owner[key] = values.map((value: unknown) => mapped(kind, value));
    };
    for (const node of rows(graph.nodes)) {
      node.id = mapped("node", node.id);
      for (const port of rows(node.inputs)) {
        if (port.link !== undefined && port.link !== null)
          port.link = mapped("link", port.link);
      }
      for (const port of rows(node.outputs)) list(port, "links", "link");
    }
    for (const link of links(graph)) {
      if (Array.isArray(link)) {
        link[0] = mapped("link", link[0]);
        link[1] = mappedNode(link[1]);
        link[3] = mappedNode(link[3]);
      } else {
        link.id = mapped("link", link.id);
        link.origin_id = mappedNode(link.origin_id);
        link.target_id = mappedNode(link.target_id);
        if (link.parentId !== undefined && link.parentId !== null)
          link.parentId = mapped("reroute", link.parentId);
      }
    }
    for (const port of [...rows(graph.inputs), ...rows(graph.outputs)])
      list(port, "linkIds", "link");
    for (const widget of rows(graph.widgets))
      widget.id = mapped("node", widget.id);
    for (const group of rows(graph.groups))
      group.id = mapped("group", group.id);
    for (const reroute of rows(graph.reroutes)) {
      reroute.id = mapped("reroute", reroute.id);
      if (reroute.parentId !== undefined && reroute.parentId !== null)
        reroute.parentId = mapped("reroute", reroute.parentId);
      list(reroute, "linkIds", "link");
    }
    const properties = instance.properties;
    if (properties !== undefined && !isRecord(properties)) return refuse();
    if (isRecord(properties)) {
      if (properties.proxyWidgets !== undefined) {
        if (!Array.isArray(properties.proxyWidgets)) return refuse();
        for (const proxy of properties.proxyWidgets) {
          if (!Array.isArray(proxy) || proxy.length < 2) return refuse();
          proxy[0] = String(mapped("node", proxy[0]));
        }
      }
      for (const preview of rows(properties.previewExposures))
        preview.sourceNodeId = String(mapped("node", preview.sourceNodeId));
    }
    const extra = graph.extra;
    if (extra !== undefined && !isRecord(extra)) return refuse();
    if (isRecord(extra)) {
      for (const extension of rows(extra.linkExtensions))
        extension.id = mapped("link", extension.id);
      if (extra.linkPresentation !== undefined) {
        if (!isRecord(extra.linkPresentation)) return refuse();
        extra.linkPresentation = Object.fromEntries(
          Object.entries(extra.linkPresentation).map(([key, value]) => [
            String(mapped("link", key)),
            value,
          ]),
        );
      }
    }
    const state = { ...(isRecord(graph.state) ? graph.state : {}) };
    for (const kind of kinds) state[counterKeys[kind]] = maximum[kind];
    graph.state = state;
  };
  return { next, remapDefinition };
}
