import { describe, expect, it } from "vitest";
import type { AppModeApp } from "../src/host/appMode";
import { createNativeCompileDiagnostics } from "./e2e/host/nativeCompileDiagnostics";
import { fixtureBackedAppModeHost } from "./support/hostSeamTestDouble";

const compileHost = <Result>(graphToPrompt: (...args: unknown[]) => Result) => {
  // Observer negatives include malformed compiler returns. Validate the callable seam
  // through the real host fixture while preserving its original function and return type.
  const host = fixtureBackedAppModeHost(
    {
      graphToPrompt: graphToPrompt as NonNullable<AppModeApp["graphToPrompt"]>,
    },
    {},
  ).app;
  expect(host.graphToPrompt).toBe(graphToPrompt);
  return host as unknown as { graphToPrompt: typeof graphToPrompt };
};

const compiled = () => ({
  output: {
    "11": {
      class_type: "LoadImage",
      inputs: { image: "synthetic-private-source" },
      _meta: { title: "synthetic-private-title" },
    },
  },
  workflow: {},
});

describe("scoped native compiler observation", () => {
  it("delegates exactly once with the original this, args and sync result", () => {
    const receiver = {},
      argument = {},
      value = compiled();
    let calls = 0;
    const app = compileHost(function (this: unknown, ...args: unknown[]) {
      calls += 1;
      expect(this).toBe(receiver);
      expect(args).toEqual([argument]);
      return value;
    });
    const before = Object.getOwnPropertyDescriptor(app, "graphToPrompt");
    const trace = createNativeCompileDiagnostics(app);
    expect(app.graphToPrompt.call(receiver, argument)).toBe(value);
    expect(calls).toBe(1);
    const result = trace.finish();
    expect(result.restoration).toBe("restored");
    expect(Object.getOwnPropertyDescriptor(app, "graphToPrompt")).toEqual(
      before,
    );
    expect(result.calls[0]?.shape?.selectedLoadImage).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private/);
  });
  it.each([false, true])(
    "preserves native promise identity and rejection=%s",
    async (reject) => {
      const error = new Error("synthetic-private-error");
      const promise = reject
        ? Promise.reject(error)
        : Promise.resolve(compiled());
      const app = compileHost(() => promise);
      const trace = createNativeCompileDiagnostics(app);
      expect(app.graphToPrompt()).toBe(promise);
      if (reject) await expect(promise).rejects.toBe(error);
      else await promise;
      const result = trace.finish();
      expect(result.calls[0]?.completion).toBe(
        reject ? "rejected" : "fulfilled",
      );
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
    },
  );
  it("throws the exact original object without retaining it", () => {
    const error = { sensitive: "synthetic-private-error" };
    const app = compileHost(() => {
      throw error;
    });
    const trace = createNativeCompileDiagnostics(app);
    let caught: unknown;
    try {
      app.graphToPrompt();
    } catch (value) {
      caught = value;
    }
    expect(caught).toBe(error);
    expect(trace.finish().calls[0]?.completion).toBe("thrown");
  });
  it("restores inherited methods without leaving an own shadow", () => {
    const prototype = { graphToPrompt: () => compiled() };
    const app = fixtureBackedAppModeHost(
      Object.create(prototype) as typeof prototype,
      {},
    ).app;
    const trace = createNativeCompileDiagnostics(app);
    app.graphToPrompt();
    expect(trace.finish().restoration).toBe("restored");
    expect(Object.hasOwn(app, "graphToPrompt")).toBe(false);
    expect(app.graphToPrompt).toBe(prototype.graphToPrompt);
  });
  it("stops observing a retained wrapper after finish", () => {
    let calls = 0;
    const value = compiled();
    const app = compileHost(() => {
      calls += 1;
      return value;
    });
    const trace = createNativeCompileDiagnostics(app);
    const retained = app.graphToPrompt;
    expect(retained()).toBe(value);
    const finished = trace.finish();
    expect(retained()).toBe(value);
    expect(calls).toBe(2);
    expect(trace.snapshot()).toEqual(finished);
  });
  it("does not trigger an own Promise constructor accessor", () => {
    let reads = 0;
    const promise = Promise.resolve(compiled());
    Object.defineProperty(promise, "constructor", {
      get() {
        reads += 1;
        return Promise;
      },
    });
    const app = compileHost(() => promise);
    const trace = createNativeCompileDiagnostics(app);
    expect(app.graphToPrompt()).toBe(promise);
    expect(trace.finish().calls[0]?.completion).toBe("unobserved");
    expect(reads).toBe(0);
  });
  it("does not trigger a custom Promise species accessor", async () => {
    let reads = 0;
    const promise = Promise.resolve(compiled());
    const app = compileHost(() => promise);
    const trace = createNativeCompileDiagnostics(app);
    const descriptor = Object.getOwnPropertyDescriptor(
      Promise,
      Symbol.species,
    )!;
    let result: unknown;
    try {
      Object.defineProperty(Promise, Symbol.species, {
        configurable: true,
        get() {
          reads += 1;
          return Promise;
        },
      });
      result = app.graphToPrompt();
    } finally {
      Object.defineProperty(Promise, Symbol.species, descriptor);
    }
    expect(result).toBe(promise);
    await promise;
    const finished = trace.finish();
    expect(reads).toBe(0);
    expect(finished.calls[0]?.completion).toBe("fulfilled");
  });
  it("preserves a foreign replacement and its descriptor", () => {
    const app = compileHost(() => compiled());
    const trace = createNativeCompileDiagnostics(app);
    const foreign = () => compiled();
    Object.defineProperty(app, "graphToPrompt", {
      value: foreign,
      configurable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(app, "graphToPrompt");
    expect(trace.finish().restoration).toBe("foreign_replaced");
    expect(trace.finish().restoration).toBe("foreign_replaced");
    expect(Object.getOwnPropertyDescriptor(app, "graphToPrompt")).toEqual(
      descriptor,
    );
  });
  it("does not invoke output, selected-node or metadata accessors", () => {
    let reads = 0;
    for (const value of [
      {
        get output() {
          reads += 1;
          return {};
        },
        workflow: {},
      },
      {
        output: {
          get "11"() {
            reads += 1;
            return {};
          },
        },
        workflow: {},
      },
      {
        output: {
          "11": {
            class_type: "LoadImage",
            inputs: {},
            get _meta() {
              reads += 1;
              return {};
            },
          },
        },
        workflow: {},
      },
    ]) {
      const app = compileHost(() => value);
      const trace = createNativeCompileDiagnostics(app);
      expect(app.graphToPrompt()).toBe(value);
      trace.finish();
    }
    expect(reads).toBe(0);
  });
  it("bounds calls and returns independent snapshots", () => {
    const app = compileHost(() => compiled());
    const trace = createNativeCompileDiagnostics(app);
    for (let i = 0; i < 20; i += 1) app.graphToPrompt();
    const first = trace.finish(),
      second = trace.snapshot();
    expect(first.callCount).toBe(5);
    expect(first.overflow).toBe(true);
    expect(first.calls).toHaveLength(4);
    first.calls.length = 0;
    expect(second.calls).toHaveLength(4);
  });
  it("leaves custom thenables unchanged without reading their then accessor", () => {
    let reads = 0;
    const value = {
      get then() {
        reads += 1;
        return () => undefined;
      },
    };
    const app = compileHost(() => value);
    const trace = createNativeCompileDiagnostics(app);
    expect(app.graphToPrompt()).toBe(value);
    expect(trace.finish().calls[0]?.completion).toBe("unobserved");
    expect(reads).toBe(0);
  });
  it("refuses method accessors and immutable slots before invoking anything", () => {
    // Deliberately invalid observer inputs: keep these outside the accepted host factory.
    let reads = 0;
    const accessor = {
      get graphToPrompt() {
        reads += 1;
        return () => compiled();
      },
    };
    expect(() => createNativeCompileDiagnostics(accessor)).toThrow(
      "observation unavailable",
    );
    const fixed = Object.freeze({ graphToPrompt: () => compiled() });
    expect(() => createNativeCompileDiagnostics(fixed)).toThrow(
      "observation unavailable",
    );
    expect(reads).toBe(0);
  });
});
