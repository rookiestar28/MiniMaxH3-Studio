import type { AppModeCompiledPrompt } from "../../src/host/appModeContract";

export function withCompiledPackIdentity<T extends AppModeCompiledPrompt>(
  compiled: T,
): T {
  Object.values(compiled.output).forEach((value, index) => {
    const node = value as Record<string, unknown>;
    node._meta =
      index % 2 === 0
        ? { title: "Node", cnr_id: "pack", ver: "1" }
        : { title: "Node", aux_id: "owner/pack", ver: "1" };
  });
  return compiled;
}

export function hasSameCompiledMetadata(
  actual: AppModeCompiledPrompt,
  expected: AppModeCompiledPrompt,
): boolean {
  return Object.entries(expected.output).every(
    ([id, value]) =>
      JSON.stringify(
        (actual.output[id] as Record<string, unknown> | undefined)?._meta,
      ) === JSON.stringify((value as Record<string, unknown>)._meta),
  );
}
