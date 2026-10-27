import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const expected = [
  "components/H3Sidebar.tsx",
  "components/ImageCropDialog.tsx",
  "components/nle/NleOverlay.tsx",
];
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );
}
function inspect(source: string) {
  // Inventory the literal class seams used by product roots, including JSX and DOM construction.
  const classes = [
    ...source.matchAll(/\bclassName\s*=\s*["']([^"']*)["']/g),
    ...source.matchAll(
      /\.setAttribute\(\s*["']class["']\s*,\s*["']([^"']*)["']/g,
    ),
    ...source.matchAll(/\.classList\.add\(\s*["']([^"']*)["']/g),
  ];
  const roots = classes.filter((match) =>
    match[1]!.split(/\s+/).includes("h3c"),
  ).length;
  const controllers = [
    ...source.matchAll(
      /\b(?:return|const\s+\w+\s*=)\s+createHostThemeController\(/g,
    ),
  ].length;
  return { roots, controllers };
}

it("every product .h3c creation site owns its theme controller, including portals", () => {
  const inventory = files(sourceRoot).map((path) => ({
    path: relative(sourceRoot, path).replaceAll("\\", "/"),
    ...inspect(readFileSync(path, "utf8")),
  }));
  expect(
    inventory
      .filter((row) => row.roots > 0)
      .map((row) => row.path)
      .sort(),
  ).toEqual(expected);
  expect(
    inventory
      .filter((row) => row.controllers > 0)
      .map((row) => row.path)
      .sort(),
  ).toEqual(expected);
  for (const row of inventory)
    expect(row.controllers, row.path).toBe(row.roots);
});

it("finds an unwired fourth root and handles real product LF/CRLF equivalently", () => {
  expect(inspect('const fourth = <div className="h3c" />;')).toEqual({
    roots: 1,
    controllers: 0,
  });
  for (const path of expected) {
    const lf = readFileSync(join(sourceRoot, path), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    expect(inspect(lf.replaceAll("\n", "\r\n"))).toEqual(inspect(lf));
  }
});
