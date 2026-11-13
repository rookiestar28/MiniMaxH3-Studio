// Resolve import syntax with the checkout's locked direct TypeScript dependency.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(readFileSync(0, "utf8"));
const require = createRequire(resolve(input.typescriptRoot, "frontend/package.json"));
const version = JSON.parse(readFileSync(require.resolve("typescript/package.json"), "utf8")).version;
const modern = Number(version.split(".")[0]) >= 7;
const ts = await import(pathToFileURL(require.resolve(modern ? "typescript/unstable/ast" : "typescript")).href);
const K = ts.SyntaxKind;
const modules = {};
const browserSkipGuards = {};
let playwrightMatches = null;
const aliases = { vitest: {}, playwright: {}, production: {} };
const externals = [];
const runnerConfigs = {
  "frontend/vitest.config.ts": "vitest",
  "frontend/vite.e2e.config.ts": "playwright",
  "frontend/vite.config.ts": "production",
};

function literal(node) {
  return node && (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral)
    ? node.text : undefined;
}

function aliasTarget(node) {
  const direct = literal(node);
  if (direct !== undefined) return direct;
  if (node?.kind !== K.CallExpression || node.expression.text !== "fileURLToPath") return undefined;
  const url = node.arguments?.[0];
  return url?.kind === K.NewExpression && url.expression.text === "URL" ? literal(url.arguments?.[0]) : undefined;
}

function inspect(source, name) {
  const imports = new Set();
  const declarations = new Map();
  const skipVariables = new Set();
  function children(node, visit) {
    if (modern) node.forEachChild(visit);
    else ts.forEachChild(node, visit);
  }
  function declarationsWalk(node) {
    if (node.kind === K.FunctionDeclaration && node.name && node.body) {
      declarations.set(node.name.text, [node.body]);
    }
    if (node.kind === K.VariableDeclaration && node.name.kind === K.Identifier && node.initializer) {
      const values = declarations.get(node.name.text) ?? [];
      values.push(node.initializer);
      declarations.set(node.name.text, values);
    }
    children(node, declarationsWalk);
  }
  function environment(node, seen = new Set()) {
    if (!node) return;
    if ((node.kind === K.PropertyAccessExpression || node.kind === K.ElementAccessExpression) &&
      node.expression.kind === K.PropertyAccessExpression && node.expression.name.text === "env" &&
      node.expression.expression.kind === K.Identifier && node.expression.expression.text === "process") {
      let variable = node.kind === K.PropertyAccessExpression ? node.name.text : literal(node.argumentExpression);
      if (variable === undefined && node.argumentExpression?.kind === K.Identifier) {
        const values = declarations.get(node.argumentExpression.text) ?? [];
        if (values.length === 1) variable = literal(values[0]);
      }
      // Retain unresolved guards as a sentinel: parity must fail if this spec enters the runner.
      // Non-default host specs are parsed too, but cannot grant authority or block ordinary groups.
      variable ??= "<nonliteral-environment>";
      skipVariables.add(variable);
    }
    if (node.kind === K.Identifier && !seen.has(node.text)) {
      const next = new Set(seen).add(node.text);
      for (const value of declarations.get(node.text) ?? []) environment(value, next);
    }
    children(node, (child) => environment(child, seen));
  }
  if (name.startsWith("frontend/tests/e2e/") && name.endsWith(".spec.ts")) declarationsWalk(source);
  function property(object, key) {
    if (object?.kind !== K.ObjectLiteralExpression) return undefined;
    return object.properties.find((node) => node.kind === K.PropertyAssignment && node.name.text === key)?.initializer;
  }
  function walk(node) {
    if (node.kind === K.CallExpression && node.expression.kind === K.PropertyAccessExpression &&
      node.expression.name.text === "skip" && node.expression.expression.kind === K.Identifier &&
      node.expression.expression.text === "test") {
      environment(node.arguments[0]);
      // A true skip nested in an opt-in if is still guarded by that environment condition.
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.kind === K.IfStatement) environment(parent.expression);
      }
    }
    if (node.kind === K.ImportDeclaration || node.kind === K.ExportDeclaration) {
      const target = literal(node.moduleSpecifier);
      if (target !== undefined) imports.add(target);
    } else if (node.kind === K.CallExpression &&
      (node.expression.kind === K.ImportKeyword ||
        (node.expression.kind === K.Identifier && node.expression.text === "require"))) {
      const target = literal(node.arguments?.[0]);
      if (target !== undefined) imports.add(target);
    } else if (node.kind === K.ImportType) {
      const target = literal(node.argument?.literal);
      if (target !== undefined) imports.add(target);
    } else if (node.kind === K.PropertyAssignment) {
      if (name === "frontend/playwright.config.ts" && node.name.text === "testMatch" &&
        node.initializer.kind === K.ArrayLiteralExpression) {
        playwrightMatches = node.initializer.elements.map(literal);
        if (playwrightMatches.some((value) => value === undefined)) throw new Error("nonliteral testMatch");
      }
      if (runnerConfigs[name] && node.name.text === "resolve") {
        const entries = property(node.initializer, "alias");
        if (entries) {
          if (entries.kind !== K.ObjectLiteralExpression) throw new Error("nonliteral resolve.alias");
          for (const entry of entries.properties) {
            const target = aliasTarget(entry.initializer);
            if (entry.kind !== K.PropertyAssignment || target === undefined) throw new Error("nonliteral alias target");
            aliases[runnerConfigs[name]][entry.name.text] = target;
          }
        }
      }
      if (name === "frontend/vite.config.ts" && node.name.text === "rolldownOptions") {
        const entries = property(node.initializer, "external");
        if (entries) {
          if (entries.kind !== K.ArrayLiteralExpression) throw new Error("nonliteral external list");
          const values = entries.elements.map(literal);
          if (values.some((value) => value === undefined)) throw new Error("nonliteral external entry");
          externals.push(...values);
        }
      }
    }
    if (modern) node.forEachChild(walk);
    else ts.forEachChild(node, walk);
  }
  walk(source);
  modules[name] = [...imports].sort();
  if (name.startsWith("frontend/tests/e2e/") && name.endsWith(".spec.ts")) {
    browserSkipGuards[name] = [...skipVariables].sort();
  }
}

// CRITICAL: parse complete syntax. A standalone lexer loses template/regex context; CSS in
// the shipped template can stall its token position and exhaust memory before selection.
if (modern) {
  const { API } = await import(pathToFileURL(require.resolve("typescript/unstable/sync")).href);
  const api = new API({ cwd: input.root });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openFiles: input.paths.map((name) => resolve(input.root, name)) });
    for (const name of input.paths) {
      const absolute = resolve(input.root, name);
      const source = snapshot.getDefaultProjectForFile(absolute).program.getSourceFile(absolute);
      if (!source) throw new Error(`source unavailable: ${name}`);
      inspect(source, name);
    }
  } finally {
    snapshot?.dispose();
    api.close();
  }
} else {
  for (const name of input.paths) {
    inspect(ts.createSourceFile(name, readFileSync(resolve(input.root, name), "utf8"), ts.ScriptTarget.Latest, true), name);
  }
}
process.stdout.write(JSON.stringify({ modules, playwrightMatches, aliases, externals, browserSkipGuards, parser: `typescript-${version}-ast` }));
