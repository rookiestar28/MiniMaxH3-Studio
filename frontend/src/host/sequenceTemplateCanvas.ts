import { readQueueMetadataCompatibleGraph } from "./graphSerialization";
import {
  i2vaDimensionSelector,
  isRecord,
  linkList,
  nodeList,
  resolveAnchor,
  TemplateSpliceError,
  type Json,
} from "./templateGraphTopology";

const keys = ["aspect_ratio", "megapixels", "multiple"] as const;
type SelectorTuple = readonly [string, number, number];

function refuse(): never {
  throw new TemplateSpliceError(
    "invalid_sequence_geometry",
    "invalid_sequence_geometry",
  );
}

function selector(workflow: Json): Json {
  const { node: anchor } = resolveAnchor(workflow, "image_to_video");
  const nodes = nodeList(workflow);
  const links = linkList(workflow);
  const origin = (name: string): readonly [Json, number] => {
    if (!Array.isArray(anchor.inputs) || !anchor.inputs.every(isRecord))
      return refuse();
    const ports = anchor.inputs;
    const matches = ports.filter((port) => port.name === name);
    const input = matches[0];
    if (matches.length !== 1 || !Number.isSafeInteger(input?.link))
      return refuse();
    const edges = links.filter(
      (edge) => Array.isArray(edge) && edge[0] === input!.link,
    );
    const edge = edges[0];
    if (
      !Array.isArray(edge) ||
      edges.length !== 1 ||
      edge[3] !== anchor.id ||
      edge[4] !== ports.indexOf(input!)
    )
      return refuse();
    const sources = nodes.filter((node) => node.id === edge[1]);
    const source = sources[0];
    const slot = edge[2];
    if (
      sources.length !== 1 ||
      source === undefined ||
      !Number.isSafeInteger(slot) ||
      Number(slot) < 0 ||
      !Array.isArray(source.outputs)
    )
      return refuse();
    const output: unknown = source.outputs[Number(slot)];
    if (
      !isRecord(output) ||
      !Array.isArray(output.links) ||
      !output.links.includes(input!.link)
    )
      return refuse();
    return [source, Number(slot)];
  };
  return i2vaDimensionSelector(origin("width"), origin("height")) ?? refuse();
}

function tuple(node: Json): SelectorTuple {
  if (
    !Array.isArray(node.inputs) ||
    node.inputs.some((input) => !isRecord(input) || input.link != null)
  )
    return refuse();
  const values = node.widgets_values;
  if (!Array.isArray(values) || values.length !== 3) return refuse();
  const [aspect, megapixels, multiple] = values;
  if (
    typeof aspect !== "string" ||
    aspect.trim() !== aspect ||
    aspect.length === 0 ||
    aspect.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(aspect) ||
    typeof megapixels !== "number" ||
    !Number.isFinite(megapixels) ||
    megapixels <= 0 ||
    typeof multiple !== "number" ||
    !Number.isSafeInteger(multiple) ||
    multiple <= 0
  )
    return refuse();
  if (Object.hasOwn(node, "widgets_values_named")) {
    const named = node.widgets_values_named;
    if (
      !isRecord(named) ||
      keys.some((key, index) => named[key] !== values[index])
    )
      return refuse();
  }
  return [aspect, megapixels, multiple];
}

/** Read only the native dimension seam; keep the child's model, media and sink graph. */
export function inheritSequenceTemplateCanvas(
  child: Json,
  authority: Json,
): Json {
  const source = readQueueMetadataCompatibleGraph(authority).graph;
  const target = structuredClone(readQueueMetadataCompatibleGraph(child).graph);
  const values = tuple(selector(source));
  const destination = selector(target);
  tuple(destination);
  destination.widgets_values = [...values];
  if (Object.hasOwn(destination, "widgets_values_named")) {
    destination.widgets_values_named = {
      ...(destination.widgets_values_named as Json),
      ...Object.fromEntries(keys.map((key, index) => [key, values[index]])),
    };
  }
  return target;
}
