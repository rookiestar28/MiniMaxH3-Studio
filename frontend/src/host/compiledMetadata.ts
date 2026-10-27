// IMPORTANT: admit host title plus the documented zNodePackMetadata members.
// Title-only admission breaks Start on frontend 1.56.1+; preserve admitted values.
// Keep title undefined or an unbounded string; bounding it like pack members breaks
// Start for long user titles. Unknown members and invalid values stay refused.
const COMPILED_META_KEYS = new Set(["title", "cnr_id", "aux_id", "ver"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isSafeCompiledMetadata(value: unknown): boolean {
  const meta = record(value);
  return (
    meta !== undefined &&
    Object.entries(meta).every(
      ([key, entry]) =>
        COMPILED_META_KEYS.has(key) &&
        (key === "title"
          ? entry === undefined || typeof entry === "string"
          : typeof entry === "string" && entry.length <= 256),
    )
  );
}

function hasUnrecognizedCompiledMetadata(compiled: unknown): boolean {
  const output = record(record(compiled)?.output);
  return (
    output !== undefined &&
    Object.values(output).some((value) => {
      const node = record(value);
      return node?._meta !== undefined && !isSafeCompiledMetadata(node._meta);
    })
  );
}

export function compiledPromptAdmissionFailure(
  compiled: unknown,
  adopting: boolean,
): Readonly<{
  code: "compile_failed" | "incompatible_graph";
  message: string;
}> {
  if (hasUnrecognizedCompiledMetadata(compiled))
    return {
      code: "compile_failed",
      message: "an unrecognized compiled _meta member",
    };
  return {
    code: adopting ? "incompatible_graph" : "compile_failed",
    message: adopting
      ? "the current graph is not a complete H3 flow with one Product Shell and native generation anchor"
      : "host compilation returned an unqualified H3 prompt envelope",
  };
}
