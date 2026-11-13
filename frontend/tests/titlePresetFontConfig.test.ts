// @vitest-environment node

import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { expect, it } from "vitest";
import vitestConfig from "../vitest.config";
import e2eConfig from "../vite.e2e.config";

it("adds only the two exact packaged faces while preserving strict and deny defaults", async () => {
  const fonts = ["Regular", "Bold"].map((weight) =>
    fileURLToPath(
      new URL(
        `../../comfyui_h3_context/fonts/NotoSans-${weight}.ttf`,
        import.meta.url,
      ),
    ).replaceAll("\\", "/"),
  );
  for (const [config, root] of [
    [vitestConfig, fileURLToPath(new URL("..", import.meta.url))],
    [e2eConfig, fileURLToPath(new URL("../e2e", import.meta.url))],
  ] as const) {
    const defaults = await resolveConfig({ configFile: false, root }, "serve");
    // Vite appends pnpm's store to the input allow array; resolve a copy so the authored
    // two-file allowance remains available for the separate exact-cardinality assertion.
    const actual = await resolveConfig(
      { configFile: false, root, server: structuredClone(config.server) },
      "serve",
    );
    expect(actual.server.fs.strict).toBe(true);
    expect(actual.server.fs.deny).toEqual(defaults.server.fs.deny);
    expect(new Set(actual.server.fs.allow)).toEqual(
      new Set([...defaults.server.fs.allow, ...fonts]),
    );
    expect(config.server?.fs?.allow).toHaveLength(3);
  }
});
