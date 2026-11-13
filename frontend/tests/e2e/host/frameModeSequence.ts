import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Locator } from "@playwright/test";

import { sidebarCopy } from "../../../src/i18n/catalog";
import { expect, type Page } from "./fixture";
import {
  hostUrl,
  repositoryRoot,
  supportedHostQueueCounts,
  waitForHostGraphSettled,
} from "./environment";
import {
  ensureM2508CapturedWorkflowAuthority,
  materializeM2508VisiblePromptInCapturedWorkflow,
  type M2508Prompt,
} from "./m25_08Bootstrap";

export const frameSequenceRows = [
  {
    id: "fl2va-fixed-26",
    mode: "fl2va",
    target: 26,
    policy: "fixed_10",
    durations: [10, 10, 6],
    modes: ["i2va", "t2va", "l2va"],
  },
  {
    id: "l2va-reviewed-19",
    mode: "l2va",
    target: 19,
    policy: "auto_storyboard",
    durations: [6, 13],
    modes: ["t2va", "l2va"],
  },
  {
    id: "l2va-fixed-18",
    mode: "l2va",
    target: 18,
    policy: "fixed_10",
    durations: [10, 8],
    modes: ["t2va", "l2va"],
  },
  {
    id: "i2va-cropped-10",
    mode: "i2va",
    target: 10,
    policy: "fixed_5",
    durations: [5, 5],
    modes: ["i2va", "t2va"],
  },
] as const;

export type FrameSequenceRow = (typeof frameSequenceRows)[number];

/** Bind original local copies to the already validated project-relative evidence identity. */
export function frameSequenceMediaRoot(evidenceRelative: string): string {
  if (
    !evidenceRelative ||
    evidenceRelative.startsWith("/") ||
    /^[a-z]:/i.test(evidenceRelative) ||
    evidenceRelative.includes("\\") ||
    evidenceRelative.includes("\0") ||
    evidenceRelative
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error("canonical project-relative evidence path required");
  // IMPORTANT: fixed row directories collide across windows; keep the full frozen identity
  // and exclusive leaf creation so a new run cannot reuse or overwrite an old original.
  const namespace = createHash("sha256")
    .update(evidenceRelative, "utf8")
    .digest("hex");
  return `.tmp/frame-sequence-generated/${namespace}`;
}

export type NativeFramePrompt = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
  }
>;

/** Official startup completion for a clean host page, before creating its owned source. */
export async function waitForNativeFrameStartup(page: Page, budgetMs = 60_000) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000)
    throw new TypeError("invalid native startup budget");
  const current = new URL(page.url());
  if (current.pathname !== "/" || current.search || current.hash)
    throw new TypeError("native startup requires clean base URL");
  const deadline = Date.now() + budgetMs;
  const remaining = () => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new Error("native startup deadline expired");
    return budget;
  };
  // CRITICAL: registration precedes workflow restore, which can remove a source
  // created too early. Wait for official completion; hidden alone is not success.
  await page.waitForFunction(
    () => {
      const runtime = window as unknown as {
        app?: { extensionManager?: unknown };
        comfyAPI?: { app?: { app?: unknown } };
      };
      return (
        runtime.app?.extensionManager &&
        runtime.app === runtime.comfyAPI?.app?.app
      );
    },
    undefined,
    { timeout: remaining() },
  );
  const overlay = page.locator('[data-testid="app-loading-overlay"]');
  await overlay.waitFor({ state: "attached", timeout: remaining() });
  await overlay.waitFor({ state: "hidden", timeout: remaining() });
  await page.evaluate(
    (timeout) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("native startup frame deadline expired")),
          timeout,
        );
        requestAnimationFrame(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    remaining(),
  );
  // A late successful browser result must not admit source creation after expiry.
  remaining();
}

/** Closed UI diagnostics only; never retain visible messages or graph/prompt payloads. */
export async function nativeFrameCanvasState(shell: Locator): Promise<string> {
  return shell.locator("[data-shell-status]").evaluateAll((elements) => {
    if (elements.length !== 1) return "unavailable";
    const element = elements[0]!;
    const status = element.getAttribute("data-shell-status");
    const reason = element.getAttribute("data-shell-reason");
    if (status === "error") return "error:closed";
    if (
      status === "interactive" &&
      [
        "canvas_ready",
        "native_preference",
        "dirty_graph",
        "ambiguous_graph",
        "malformed_graph",
        "incompatible_graph",
        "unavailable",
      ].includes(reason ?? "")
    )
      return `interactive:${reason}`;
    return "pending";
  });
}

/** Prepare this owned source-only baseline canvas, without admitting any native prompt. */
export async function prepareNativeFrameCanvas(
  shell: Locator,
  admissionCount: () => number | Promise<number>,
  now: () => number = Date.now,
) {
  const deadline = now() + 120_000;
  const remaining = () => {
    const budget = deadline - now();
    // IMPORTANT: a one-millisecond grace can admit Replace or accept readiness after expiry.
    if (budget <= 0)
      throw new Error("native baseline preparation deadline expired");
    return budget;
  };
  const settle = () =>
    expect
      .poll(() => nativeFrameCanvasState(shell), { timeout: remaining() })
      .toMatch(/^(interactive:|error:)/);
  expect(await admissionCount()).toBe(0);
  await shell
    .locator('[data-h3-focus-key="app-submit"]')
    .click({ timeout: remaining() });
  let submitPresses = 1;
  await settle();
  expect(await admissionCount()).toBe(0);
  if ((await nativeFrameCanvasState(shell)) === "interactive:dirty_graph") {
    // IMPORTANT: only the explicit Replace action prepares a dirty source canvas. Submitting
    // again after a compatible rescan (native_preference) can queue before baseline parity proof.
    const replace = shell.getByRole("button", {
      name: sidebarCopy("en").replaceAppMode,
      exact: true,
    });
    expect(await replace.count()).toBe(1);
    await replace.click({ timeout: remaining() });
    submitPresses += 1;
    await settle();
    expect(await admissionCount()).toBe(0);
  }
  const terminalState = await nativeFrameCanvasState(shell);
  expect(terminalState).toMatch(
    /^interactive:(canvas_ready|native_preference)$/,
  );
  expect(await admissionCount()).toBe(0);
  remaining();
  return { submitPresses, terminalState };
}

/** Content-free parity plus the synthetic authored intent, retained only in worker memory. */
export function nativeFrameSelection(prompt: NativeFramePrompt) {
  type Value =
    null | boolean | number | string | Value[] | { [key: string]: Value };
  const refuse = (): never => {
    throw new Error("invalid native parity graph");
  };
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
  if (!record(prompt) || Object.keys(prompt).length > 2048) return refuse();
  const entries = Object.entries(prompt);
  if (
    entries.some(
      ([, node]) =>
        !record(node) ||
        typeof node.class_type !== "string" ||
        !record(node.inputs) ||
        Object.keys(node.inputs).length > 128,
    )
  )
    return refuse();
  const nodes = entries.map(([, node]) => node);
  const anchors = nodes.filter(
    (node) => node.class_type === "MiniMaxH3ImageToVideo",
  );
  const requests = nodes.filter(
    (node) => node.class_type === "comfyui_h3_context.H3Context.Request",
  );
  if (
    anchors.length !== 1 ||
    requests.length !== 1 ||
    typeof requests[0]!.inputs.user_intent !== "string"
  )
    throw new Error("one real native anchor and Context intent are required");
  let visited = 0;
  let stringBytes = 0;
  const enter = (depth: number) => {
    if (depth > 64 || ++visited > 8192) refuse();
  };
  const text = (value: string) => {
    stringBytes += Buffer.byteLength(value, "utf8");
    return stringBytes <= 1024 * 1024 ? value : refuse();
  };
  const literal = (value: unknown, depth: number): Value => {
    enter(depth);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : refuse();
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) {
      if (value.length > 8192 || Object.keys(value).length !== value.length)
        return refuse();
      return value.map((item) => literal(item, depth + 1));
    }
    if (!record(value) || Object.keys(value).length > 128) return refuse();
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [text(key), literal(value[key], depth + 1)]),
    );
  };
  const visiting = new Set<string>();
  const nodeValue = (id: string, depth: number): Value => {
    enter(depth);
    if (!Object.hasOwn(prompt, id) || visiting.has(id)) return refuse();
    const node = prompt[id]!;
    if (Object.keys(node.inputs).length > 128) return refuse();
    visiting.add(id);
    try {
      return {
        class_type: literal(node.class_type, depth + 1),
        inputs: Object.fromEntries(
          Object.keys(node.inputs)
            .sort()
            .map((key) => [text(key), inputValue(node.inputs[key], depth + 1)]),
        ),
      };
    } finally {
      visiting.delete(id);
    }
  };
  const inputValue = (value: unknown, depth: number): Value => {
    enter(depth);
    if (!Array.isArray(value))
      return { kind: "literal", value: literal(value, depth + 1) };
    if (
      value.length !== 2 ||
      !(
        typeof value[0] === "string" ||
        (Number.isSafeInteger(value[0]) && value[0] >= 0)
      ) ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0
    )
      return refuse();
    // CRITICAL: compiled IDs are graph-local. Compare every upstream input and
    // output slot; copying IDs rejects remapped graphs and misses upstream size drift.
    // Wrapped literal arrays stay literal: only direct API input arrays are links.
    return {
      kind: "connection",
      node: nodeValue(String(value[0]), depth + 1),
      outputSlot: value[1],
    };
  };
  const ordered = (values: Value[]): Value[] =>
    values.sort((left, right) => {
      const a = JSON.stringify(left),
        b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return {
    intent: text(requests[0]!.inputs.user_intent),
    models: ordered(
      entries
        .filter(([, node]) =>
          [
            "UNETLoader",
            "CLIPLoader",
            "VAELoader",
            "LoraLoaderModelOnly",
          ].includes(node.class_type),
        )
        .map(([id]) => nodeValue(id, 0)),
    ),
    seeds: ordered(
      nodes.flatMap((node) =>
        Object.entries(node.inputs)
          .filter(([key]) => key === "seed" || key === "noise_seed")
          .map(([key, value]): Value => [
            text(node.class_type),
            text(key),
            inputValue(value, 0),
          ]),
      ),
    ),
    width: inputValue(anchors[0]!.inputs.width, 0),
    height: inputValue(anchors[0]!.inputs.height, 0),
  };
}

/** Only closed booleans cross the evidence boundary; selection values stay in memory. */
export function nativeFrameParityFields(
  expected: ReturnType<typeof nativeFrameSelection>,
  actual: ReturnType<typeof nativeFrameSelection>,
) {
  return Object.fromEntries(
    (["intent", "models", "seeds", "width", "height"] as const).map((key) => [
      key,
      JSON.stringify(expected[key]) === JSON.stringify(actual[key]),
    ]),
  );
}

/** Read only the exact real native history output; never alter shared history or output files. */
export async function copyNativeFrameOutput(
  page: Page,
  promptId: string,
  directory: string,
  basename: string,
  expectedFingerprint?: string,
) {
  if (!hostUrl) throw new Error("supplied host is required");
  const historyResponse = await page.request.get(
    new URL(`/history/${encodeURIComponent(promptId)}`, hostUrl).href,
  );
  expect(historyResponse.status()).toBe(200);
  const history = (await historyResponse.json())[promptId];
  expect(history.status.status_str).toBe("success");
  const outputs: Array<{ filename: string; subfolder: string; type: string }> =
    [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.filename === "string" &&
      entry.filename.endsWith(".mp4") &&
      entry.type === "output" &&
      typeof entry.subfolder === "string"
    )
      outputs.push(entry as (typeof outputs)[number]);
    Object.values(entry).forEach(visit);
  };
  visit(history.outputs);
  const unique = [
    ...new Map(outputs.map((entry) => [JSON.stringify(entry), entry])).values(),
  ];
  expect(unique).toHaveLength(1);
  const url = new URL("/view", hostUrl);
  for (const key of ["filename", "subfolder", "type"] as const)
    url.searchParams.set(key, unique[0]![key]);
  const response = await page.request.get(url.href);
  expect(response.status()).toBe(200);
  const contentLength = Number(response.headers()["content-length"]);
  expect(Number.isSafeInteger(contentLength)).toBe(true);
  expect(contentLength).toBeGreaterThan(0);
  expect(contentLength).toBeLessThanOrEqual(64 * 1024 * 1024);
  const bytes = await response.body();
  expect(bytes.length).toBe(contentLength);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (expectedFingerprint !== undefined)
    expect(`sha256:${digest}`).toBe(expectedFingerprint);
  await writeFile(resolve(directory, basename), bytes, { flag: "wx" });
  return { sha256: digest, bytes: bytes.length };
}

/** Execute only the real Context source chain; native generation remains a separate UI action. */
export async function bootstrapFrameContext(page: Page, row: FrameSequenceRow) {
  const first = process.env.H3_CONTEXT_FRAME_FIRST_INPUT;
  const last = process.env.H3_CONTEXT_FRAME_LAST_INPUT;
  const cropped = process.env.H3_CONTEXT_FRAME_CROP_INPUT;
  if (!first || !last || !cropped || !hostUrl)
    throw new Error(
      "explicit scoped frame fixtures and supplied host are required",
    );
  const fixture = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "workflows/m15_03_product_shell_base.json"),
      "utf8",
    ),
  );
  const prompt: Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  > = structuredClone(fixture.prompt);
  delete prompt["7"];
  prompt["1"]!.inputs = {
    task_mode: row.mode,
    duration_seconds: 5,
    user_intent:
      "A synthetic colored geometric sculpture rotates slowly against a plain background.",
  };
  prompt["2"]!.inputs.reference_registry = ["9", 0];
  prompt["9"] = {
    class_type: "comfyui_h3_context.H3Context.ReferenceRegistry",
    inputs: {},
  };
  if (row.mode !== "l2va") {
    prompt["10"] = {
      class_type: "LoadImage",
      inputs: { image: row.mode === "i2va" ? cropped : first },
    };
    prompt["9"].inputs.first_frame = ["10", 0];
    if (row.mode === "i2va") {
      prompt["12"] = {
        class_type: "ImageCropV2",
        inputs: {
          image: ["10", 0],
          crop_region: { x: 160, y: 96, width: 608, height: 352 },
        },
      };
      prompt["9"].inputs.first_frame = ["12", 0];
    }
  }
  if (row.mode !== "i2va") {
    prompt["11"] = { class_type: "LoadImage", inputs: { image: last } };
    prompt["9"].inputs.last_frame = ["11", 0];
  }
  const contextOnly = new Set(
    [
      "Request",
      "Plan",
      "Compiler",
      "Validator",
      "NativeH3Adapter",
      "ProductShell",
      "Preview",
      "ReferenceRegistry",
    ].map((name) => `comfyui_h3_context.H3Context.${name}`),
  );
  for (const node of Object.values(prompt))
    if (
      !contextOnly.has(node.class_type) &&
      !["LoadImage", "ImageCropV2"].includes(node.class_type)
    )
      throw new Error(
        "model-free Context bootstrap contains an execution node",
      );
  await page.evaluate(materializeM2508VisiblePromptInCapturedWorkflow, {
    ...prompt,
    "7": fixture.prompt["7"],
  } satisfies M2508Prompt);
  await page.evaluate(ensureM2508CapturedWorkflowAuthority);
  await waitForHostGraphSettled(page);
  const promptId = await page.evaluate(async (prompt) => {
    const runtime = window as unknown as {
      comfyAPI: { api: { api: { clientId: string } } };
    };
    const response = await fetch("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        client_id: runtime.comfyAPI.api.api.clientId,
      }),
    });
    if (response.status !== 200)
      throw new Error(`Context bootstrap refused: ${response.status}`);
    return String((await response.json()).prompt_id);
  }, prompt);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          new URL(`/history/${encodeURIComponent(promptId)}`, hostUrl).href,
        );
        expect(response.status()).toBe(200);
        return (
          (await response.json())[promptId]?.outputs?.["6"]
            ?.sidebar_workspace?.[0] !== undefined
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect
    .poll(() => supportedHostQueueCounts(page))
    .toEqual({ running: 0, pending: 0 });
  await waitForHostGraphSettled(page);
  return promptId;
}

/** All plan authority comes from the same controls and reviewed typed rows available to users. */
export async function planFrameSequence(page: Page, row: FrameSequenceRow) {
  const section = page.locator("[data-h3-nle-planning-status]");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const control = (name: string) =>
    section.locator(`[data-h3-nle-control="planning.${name}"]`);
  await control("target_seconds").fill(String(row.target));
  await control("policy").selectOption(row.policy);
  await expect(control("target_seconds")).toHaveValue(String(row.target));
  await expect(control("policy")).toHaveValue(row.policy);
  const [prepareRequest] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(
          "/h3-context/v1/production/planning/action",
        ) &&
        request.postDataJSON()?.action === "prepare_context",
      { timeout: 60_000 },
    ),
    control("prepare_context").click(),
  ]);
  const preparePayload = prepareRequest.postDataJSON()?.payload;
  expect(preparePayload?.target_seconds).toBe(row.target);
  expect(preparePayload?.policy).toBe(row.policy);
  await expect(section).toHaveAttribute(
    "data-h3-nle-planning-status",
    "prepared",
    { timeout: 60_000 },
  );
  await control("review_storyboard").click();
  let start = 0;
  for (const [index, seconds] of row.durations.entries()) {
    await control("add_row").click();
    const shot = section.locator(".h3-nle-storyboard > li").nth(index);
    await shot
      .locator('input[type="text"]')
      .fill("The synthetic sculpture rotates steadily.");
    await shot
      .locator('input[type="number"]')
      .nth(0)
      .fill(String(start * 1000));
    start += seconds;
    await shot
      .locator('input[type="number"]')
      .nth(1)
      .fill(String(start * 1000));
    await shot.locator('input[type="checkbox"]').check();
  }
  await control("admit_reviewed").click();
  await expect(control("propose")).toBeEnabled({ timeout: 30_000 });
  await control("propose").click();
  await expect(control("approve_import")).toBeEnabled({ timeout: 30_000 });
  // IMPORTANT: proposal code sentences also contain li; count only actual segments.
  await expect(
    section.locator('[data-h3-nle-region="proposal"] [data-h3-nle-segment]'),
  ).toHaveCount(row.durations.length);
  await expect(
    section.locator('[data-h3-nle-status="proposal-blockers"]'),
  ).toHaveCount(0);
  const holds = section.locator('[data-h3-nle-status="proposal-holds"]');
  await expect(holds).toHaveCount(1);
  // IMPORTANT (B-M2522-START-01): exact-plan qualification resolves only this hold at Start.
  await expect(holds).toHaveAttribute(
    "data-codes",
    "managed_execution_qualification_pending",
  );
  await control("approve_import").click();
  await expect(section).toHaveAttribute(
    "data-h3-nle-planning-status",
    "imported",
    { timeout: 30_000 },
  );
}
