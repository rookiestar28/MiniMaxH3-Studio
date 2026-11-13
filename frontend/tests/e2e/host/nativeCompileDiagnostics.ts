type CompileHost = {
  graphToPrompt?: (...args: unknown[]) => unknown;
};

/** Self-contained so the exact observer can run in a browser without a product hook. */
export function createNativeCompileDiagnostics(app: CompileHost) {
  const own = Object.getOwnPropertyDescriptor(app, "graphToPrompt");
  let owner: object | null = app;
  let descriptor = own;
  for (
    let depth = 0;
    descriptor === undefined && owner !== null && depth < 16;
    depth += 1
  ) {
    owner = Object.getPrototypeOf(owner) as object | null;
    if (owner !== null)
      descriptor = Object.getOwnPropertyDescriptor(owner, "graphToPrompt");
  }
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    (own !== undefined && own.configurable !== true && own.writable !== true) ||
    (own === undefined && !Object.isExtensible(app))
  )
    throw new Error("native compile observation unavailable");
  const original = descriptor.value as (...args: unknown[]) => unknown;
  type Shape = {
    inspection: "closed" | "unavailable";
    topLevelKeysClosed: boolean;
    outputOwnData: boolean;
    workflowOwnData: boolean;
    outputRecord: boolean;
    outputNodeCount: number;
    selectedOwnData: boolean;
    selectedLoadImage: boolean;
    selectedKeysClosed: boolean;
    selectedInputsRecord: boolean;
    selectedMetadataClosed: boolean;
  };
  type Call = {
    arguments: number;
    completion:
      | "pending"
      | "returned"
      | "fulfilled"
      | "rejected"
      | "thrown"
      | "unobserved";
    shape?: Shape;
  };
  const calls: Call[] = [];
  let callCount = 0;
  let overflow = false;
  let disposed = false;
  let restoration: "pending" | "restored" | "foreign_replaced" | "unavailable" =
    "pending";
  const record = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  };
  const data = (value: object, key: string) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field !== undefined && "value" in field
      ? { value: field.value as unknown }
      : undefined;
  };
  const describe = (value: unknown): Shape => {
    const shape: Shape = {
      inspection: "unavailable",
      topLevelKeysClosed: false,
      outputOwnData: false,
      workflowOwnData: false,
      outputRecord: false,
      outputNodeCount: 0,
      selectedOwnData: false,
      selectedLoadImage: false,
      selectedKeysClosed: false,
      selectedInputsRecord: false,
      selectedMetadataClosed: false,
    };
    try {
      if (!record(value)) return shape;
      shape.topLevelKeysClosed = Object.keys(value).every(
        (key) => key === "output" || key === "workflow",
      );
      const output = data(value, "output");
      shape.outputOwnData = output !== undefined;
      shape.workflowOwnData = data(value, "workflow") !== undefined;
      shape.outputRecord = record(output?.value);
      if (shape.outputRecord) {
        const nodes = output!.value as Record<string, unknown>;
        shape.outputNodeCount = Math.min(Object.keys(nodes).length, 10_001);
        const selected = data(nodes, "11");
        shape.selectedOwnData = selected !== undefined;
        if (record(selected?.value)) {
          const node = selected.value;
          shape.selectedLoadImage =
            data(node, "class_type")?.value === "LoadImage";
          shape.selectedKeysClosed = Object.keys(node).every((key) =>
            ["class_type", "inputs", "_meta"].includes(key),
          );
          shape.selectedInputsRecord = record(data(node, "inputs")?.value);
          const metaDescriptor = Object.getOwnPropertyDescriptor(node, "_meta");
          const meta = data(node, "_meta");
          shape.selectedMetadataClosed =
            metaDescriptor === undefined ||
            (meta !== undefined && meta.value === undefined);
          if (record(meta?.value)) {
            const metadata = meta.value;
            shape.selectedMetadataClosed = Object.keys(metadata).every(
              (key) => {
                if (!["title", "cnr_id", "aux_id", "ver"].includes(key))
                  return false;
                const field = data(metadata, key);
                return (
                  field !== undefined &&
                  (field.value === undefined ||
                    (typeof field.value === "string" &&
                      (key === "title" || field.value.length <= 256)))
                );
              },
            );
          }
        }
      }
      shape.inspection = "closed";
    } catch {
      // CRITICAL: observation cannot substitute an exception for the original compiler result.
    }
    return shape;
  };
  function observed(this: unknown, ...args: unknown[]): unknown {
    if (disposed) return Reflect.apply(original, this, args);
    callCount = Math.min(callCount + 1, 5);
    const call: Call | undefined =
      calls.length < 4
        ? { arguments: Math.min(args.length, 2), completion: "pending" }
        : undefined;
    if (call !== undefined) calls.push(call);
    else overflow = true;
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      if (call !== undefined && !disposed) call.completion = "thrown";
      throw error;
    }
    // Keep observation itself bounded even if a caller retains this wrapper.
    if (call === undefined) return result;
    try {
      if (Object.getPrototypeOf(result) === Promise.prototype) {
        if (
          Object.getOwnPropertyDescriptor(result, "then") !== undefined ||
          Object.getOwnPropertyDescriptor(result, "constructor") !==
            undefined ||
          Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")
            ?.value !== Promise
        ) {
          call.completion = "unobserved";
          return result;
        }
        // CRITICAL: await this checked native promise; .then invokes a species getter.
        // Return the original promise; the observer still adds reaction microtasks and
        // changes rejection bookkeeping, so it cannot claim unchanged scheduling.
        void (async () => {
          try {
            const value: unknown = await result;
            if (!disposed) {
              call.completion = "fulfilled";
              call.shape = describe(value);
            }
          } catch {
            if (!disposed) call.completion = "rejected";
          }
        })();
      } else if (
        record(result) &&
        Object.getOwnPropertyDescriptor(result, "then") !== undefined
      ) {
        if (call !== undefined && !disposed) call.completion = "unobserved";
      } else if (call !== undefined && !disposed) {
        call.completion = "returned";
        call.shape = describe(result);
      }
    } catch {
      if (call !== undefined && !disposed) call.completion = "unobserved";
    }
    return result;
  }
  Object.defineProperty(
    app,
    "graphToPrompt",
    own === undefined
      ? {
          value: observed,
          configurable: true,
          writable: true,
          enumerable: false,
        }
      : { ...own, value: observed },
  );
  const snapshot = () => ({
    schema: "h3.context.native_compile_trace.v1" as const,
    callCount,
    overflow,
    restoration,
    calls: calls.map((call) => ({
      ...call,
      ...(call.shape === undefined ? {} : { shape: { ...call.shape } }),
    })),
  });
  return {
    snapshot,
    finish: () => {
      if (!disposed) {
        disposed = true;
        try {
          const current = Object.getOwnPropertyDescriptor(app, "graphToPrompt");
          // CRITICAL: a foreign replacement is no longer ours; never overwrite its callback.
          if (current?.value !== observed) restoration = "foreign_replaced";
          else {
            if (own === undefined) delete app.graphToPrompt;
            else Object.defineProperty(app, "graphToPrompt", own);
            restoration = "restored";
          }
        } catch {
          restoration = "unavailable";
        }
      }
      return snapshot();
    },
  };
}
