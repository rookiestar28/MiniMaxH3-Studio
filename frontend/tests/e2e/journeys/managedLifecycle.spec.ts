import { expect, test, type Page, type TestInfo } from "../fixtures/h3Page";

import { syntheticPromptUuid } from "../../support/queuePromptTestDouble";
import { createQualifiedBasePrompt } from "../../support/qualifiedBasePrompt";
import { syntheticTemplate } from "../../support/templateFixture";
import { sidebarCopy } from "../../../src/i18n/catalog";
import { createManagedJournal } from "../../../src/state/managedJournal";
import {
  nativeFrameSelection,
  nativeFrameParityFields,
  prepareNativeFrameCanvas,
  waitForNativeFrameStartup,
  type NativeFramePrompt,
} from "../host/frameModeSequence";
import { createNativeCompileDiagnostics } from "../host/nativeCompileDiagnostics";

const managedPromptId = syntheticPromptUuid(201);
const secondManagedPromptId = syntheticPromptUuid(202);

function nativeParityPrompt(renamed = false): NativeFramePrompt {
  const prompt: NativeFramePrompt = {
    request: {
      class_type: "comfyui_h3_context.H3Context.Request",
      inputs: { user_intent: "A synthetic blue cube turns slowly." },
    },
    unet: {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "synthetic-model.safetensors",
        weight_dtype: "default",
      },
    },
    lora: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["unet", 0],
        lora_name: "synthetic-lora.safetensors",
        strength_model: 1,
      },
    },
    clip: {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "synthetic-clip.safetensors",
        type: "synthetic",
        device: "default",
      },
    },
    vae: {
      class_type: "VAELoader",
      inputs: { vae_name: "synthetic-vae.safetensors" },
    },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: 17 } },
    size: {
      class_type: "SyntheticDimensions",
      inputs: { width: 640, height: 640, literal: { __value__: ["unet", 0] } },
    },
    anchor: {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: { width: ["size", 0], height: ["size", 1] },
    },
  };
  if (!renamed) return prompt;
  return Object.fromEntries(
    Object.entries(prompt)
      .reverse()
      .map(([id, node]) => [
        `renamed-${id}`,
        {
          class_type: node.class_type,
          inputs: Object.fromEntries(
            Object.entries(node.inputs)
              .reverse()
              .map(([key, value]) => [
                key,
                Array.isArray(value)
                  ? [`renamed-${value[0]}`, value[1]]
                  : value,
              ]),
          ),
        },
      ]),
  );
}

test("native parity preserves equivalent compiled selections across graph identifiers and input order", () => {
  expect(nativeFrameSelection(nativeParityPrompt(true))).toEqual(
    nativeFrameSelection(nativeParityPrompt()),
  );
});

test("native parity retains genuine model seed intent geometry and output-slot differences", () => {
  const original = nativeFrameSelection(nativeParityPrompt());
  for (const [id, key, value] of [
    ["unet", "unet_name", "different-model.safetensors"],
    ["unet", "weight_dtype", "fp8"],
    ["lora", "strength_model", 0.5],
    ["lora", "model", ["unet", 1]],
    ["clip", "device", "cpu"],
    ["noise", "noise_seed", 18],
    ["request", "user_intent", "A synthetic green sphere moves."],
    ["size", "width", 864],
    ["size", "height", 480],
    ["anchor", "width", ["size", 1]],
  ] as const) {
    const changed = nativeParityPrompt();
    changed[id]!.inputs[key] = value;
    expect(nativeFrameSelection(changed)).not.toEqual(original);
  }
  const duplicate = nativeParityPrompt();
  duplicate.secondLora = structuredClone(duplicate.lora!);
  duplicate.secondLora.inputs.strength_model = 0.25;
  const reversed = Object.fromEntries(Object.entries(duplicate).reverse());
  expect(JSON.stringify(nativeFrameSelection(reversed))).toBe(
    JSON.stringify(nativeFrameSelection(duplicate)),
  );
  expect(nativeFrameSelection(duplicate)).not.toEqual(original);
  const reordered = nativeParityPrompt(true);
  expect(JSON.stringify(nativeFrameSelection(reordered))).toBe(
    JSON.stringify(original),
  );
  const numeric = nativeParityPrompt();
  numeric["17"] = numeric.size!;
  delete numeric.size;
  numeric.anchor!.inputs.width = [17, 0];
  numeric.anchor!.inputs.height = [17, 1];
  expect(nativeFrameSelection(numeric)).toEqual(original);
  const literal = nativeParityPrompt();
  literal.anchor!.inputs.width = structuredClone(original.width);
  expect(nativeFrameSelection(literal)).not.toEqual(original);
});

test("native parity refuses malformed dangling cyclic and exhausted dependencies", () => {
  for (const link of [
    ["absent", 0],
    ["size", -1],
    ["size", 0.5],
    ["size"],
    [true, 0],
  ]) {
    const changed = nativeParityPrompt();
    changed.anchor!.inputs.width = link;
    expect(() => nativeFrameSelection(changed)).toThrow(
      "invalid native parity graph",
    );
  }
  const cyclic = nativeParityPrompt();
  cyclic.unet!.inputs.loop = ["lora", 0];
  expect(() => nativeFrameSelection(cyclic)).toThrow(
    "invalid native parity graph",
  );
  const deep = nativeParityPrompt();
  for (let i = 0; i < 70; i += 1)
    deep[`chain${i}`] = {
      class_type: "SyntheticPass",
      inputs: { value: [`chain${i + 1}`, 0] },
    };
  deep.chain70 = { class_type: "SyntheticPass", inputs: { value: 640 } };
  deep.anchor!.inputs.width = ["chain0", 0];
  expect(() => nativeFrameSelection(deep)).toThrow(
    "invalid native parity graph",
  );
  const huge = nativeParityPrompt();
  huge.unet!.inputs.unet_name = "a".repeat(1024 * 1024 + 1);
  expect(() => nativeFrameSelection(huge)).toThrow(
    "invalid native parity graph",
  );
  const hugeSeedClass = nativeParityPrompt();
  hugeSeedClass.noise!.class_type = "s".repeat(1024 * 1024 + 1);
  expect(() => nativeFrameSelection(hugeSeedClass)).toThrow(
    "invalid native parity graph",
  );
  const aggregateSeedClasses = nativeParityPrompt();
  for (let i = 0; i < 65; i += 1)
    aggregateSeedClasses[`extraNoise${i}`] = {
      class_type: "s".repeat(16 * 1024),
      inputs: { noise_seed: 17 },
    };
  expect(() => nativeFrameSelection(aggregateSeedClasses)).toThrow(
    "invalid native parity graph",
  );
  const literalCycle: Record<string, unknown> = {};
  literalCycle.self = literalCycle;
  const cyclicValue = nativeParityPrompt();
  cyclicValue.unet!.inputs.literal = literalCycle;
  expect(() => nativeFrameSelection(cyclicValue)).toThrow(
    "invalid native parity graph",
  );
});

test("native parity evidence exposes only the exact five equality booleans", () => {
  const expected = nativeFrameSelection(nativeParityPrompt());
  const same = nativeFrameParityFields(
    expected,
    nativeFrameSelection(nativeParityPrompt(true)),
  );
  expect(same).toEqual({
    intent: true,
    models: true,
    seeds: true,
    width: true,
    height: true,
  });
  const changed = nativeParityPrompt();
  changed.noise!.inputs.noise_seed = 18;
  expect(
    nativeFrameParityFields(expected, nativeFrameSelection(changed)),
  ).toEqual({
    intent: true,
    models: true,
    seeds: false,
    width: true,
    height: true,
  });
  expect(Object.keys(same)).toEqual([
    "intent",
    "models",
    "seeds",
    "width",
    "height",
  ]);
  expect(Object.values(same).every((value) => typeof value === "boolean")).toBe(
    true,
  );
});

type HarnessSnapshot = Readonly<{
  queueCount: number;
  queueNodeTypes: readonly (readonly string[])[];
  queueFrameCounts: readonly number[];
  durationResolutionRequests: readonly number[];
  coordinatorExpectedFrames: readonly number[];
  coordinatorActions: readonly string[];
  productionActions: readonly string[];
  authoringActions: readonly string[];
  importCount: number;
  lifecycleEvents: readonly string[];
  managedRequestIds: readonly string[];
  requestLedgerIds: readonly string[];
  replayCollisionCount: number;
  queuePromptWrapperMode: "none" | "mutate_in_place" | "forward_copy";
  projectWorkspaceHandle: string | null;
  projectSegmentCount: number;
}>;

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  return page.evaluate(() => {
    const harness = (
      window as unknown as {
        h3ManagedEntryHarness?: { snapshot(): HarnessSnapshot };
      }
    ).h3ManagedEntryHarness;
    if (harness === undefined)
      throw new Error("managed entry harness is absent");
    return harness.snapshot();
  });
}

async function dispatch(
  page: Page,
  action:
    | "dispatchBootstrap"
    | "dispatchTerminal"
    | "dispatchInterruption"
    | "dispatchArtifact"
    | "dropHostSocket"
    | "restoreHostSocket"
    | "destroySidebar"
    | "renderSidebar",
): Promise<void> {
  await page.evaluate((requestedAction) => {
    const harness = (
      window as unknown as {
        h3ManagedEntryHarness?: Record<string, () => void>;
      }
    ).h3ManagedEntryHarness;
    if (harness === undefined)
      throw new Error("managed entry harness is absent");
    harness[requestedAction]!();
  }, action);
}

test("a reused custom mount releases H3 before a delayed destroy", async ({
  page,
}) => {
  await page.goto("/?mode=managed-entry");
  const container = page.locator("#managed-entry-sidebar");
  await expect(
    container.locator('[data-shell-status="interactive"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      container.evaluate((node) => ({
        container: (node as HTMLElement).style.minWidth,
        content: (node.parentElement as HTMLElement | null)?.style.minWidth,
        panel: (node.parentElement?.parentElement as HTMLElement | null)?.style
          .minWidth,
      })),
    )
    .toEqual({ container: "704px", content: "704px", panel: "704px" });

  await container.evaluate((node) => {
    const replacement = document.createElement("section");
    replacement.dataset.foreignExtension = "";
    replacement.textContent = "foreign sidebar";
    node.replaceChildren(replacement);
  });
  const replacement = container.locator(":scope > [data-foreign-extension]");
  await expect(replacement).toHaveText("foreign sidebar");
  await expect
    .poll(() =>
      container.evaluate((node) => ({
        container: (node as HTMLElement).style.cssText,
        content: (node.parentElement as HTMLElement | null)?.style.cssText,
        markerCount: node.querySelectorAll("[data-h3-context-mount]").length,
        panel: (node.parentElement?.parentElement as HTMLElement | null)?.style
          .cssText,
        styleCount: document.querySelectorAll("style[data-h3-context]").length,
      })),
    )
    .toEqual({
      container: "",
      content: "",
      markerCount: 0,
      panel: "",
      styleCount: 0,
    });

  await dispatch(page, "destroySidebar");
  await expect(replacement).toHaveText("foreign sidebar");

  await dispatch(page, "renderSidebar");
  await expect(
    container.locator('[data-shell-status="interactive"]'),
  ).toBeVisible();
  await expect(replacement).toHaveCount(0);
  await dispatch(page, "destroySidebar");
  await expect(container).toBeEmpty();
});

async function runManagedLifecycle(page: Page): Promise<HarnessSnapshot> {
  const intent = page.getByRole("textbox", { name: "Intent" });
  const duration = page.getByRole("spinbutton", {
    name: "Clip duration (seconds)",
  });
  const start = page.getByRole("button", {
    name: "Apply and queue current H3 graph",
  });
  await expect(intent).toBeVisible();
  await intent.fill("A synthetic eight-second managed H3 browser journey.");
  await duration.fill("8");
  await expect(page.getByText("Delivers 8 s (192 frames).")).toBeVisible();
  await expect(start).toBeEnabled();
  await start.click();

  await expect.poll(async () => (await snapshot(page)).queueCount).toBe(1);
  await expect(
    page.locator('[data-app-mode-phase="generating"]'),
  ).toBeVisible();
  const prepared = await snapshot(page);
  expect(prepared.coordinatorActions).toEqual([]);
  expect(prepared.productionActions).not.toContain(
    "create_workspace_from_context",
  );
  expect(prepared.queueNodeTypes[0]).toContain("MiniMaxH3ImageToVideo");
  expect(prepared.queueNodeTypes[0]).not.toContain("MiniMaxH3ReferenceToVideo");
  expect(prepared.queueNodeTypes[0]).toContain("SaveVideo");

  await dispatch(page, "dispatchBootstrap");
  await expect(
    page.locator('[data-app-mode-phase="generating"]'),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const current = await snapshot(page);
      return {
        queues: current.queueCount,
        actions: current.coordinatorActions,
      };
    })
    .toEqual({
      queues: 1,
      actions: ["prepare_managed_run", "submit_managed_run"],
    });
  const generating = await snapshot(page);
  expect(generating.queueNodeTypes[0]).toContain("MiniMaxH3ImageToVideo");
  expect(generating.queueNodeTypes[0]).toContain("SaveVideo");
  expect(
    generating.lifecycleEvents.filter(
      (event) => event !== "production:read_accumulated_project",
    ),
  ).toEqual([
    `queue:${managedPromptId}`,
    "coordinator:prepare_managed_run",
    "coordinator:submit_managed_run",
  ]);

  await dispatch(page, "dispatchTerminal");
  await expect(
    page.locator('[data-app-mode-phase="verifying_output"]'),
  ).toBeVisible();
  await expect(page.locator('[data-shell-status="projected"]')).toHaveCount(0);
  await expect
    .poll(async () => (await snapshot(page)).coordinatorActions)
    .toEqual([
      "prepare_managed_run",
      "submit_managed_run",
      "close_managed_run",
    ]);

  await dispatch(page, "dropHostSocket");
  await expect(
    page.locator('[data-shell-status="host_unavailable"]'),
  ).toBeVisible();
  await dispatch(page, "restoreHostSocket");
  await expect(
    page.locator('[data-app-mode-phase="verifying_output"]'),
  ).toBeVisible();
  await expect
    .poll(async () => (await snapshot(page)).coordinatorActions)
    .toEqual([
      "prepare_managed_run",
      "submit_managed_run",
      "close_managed_run",
      "read_managed_run",
    ]);

  await dispatch(page, "dispatchArtifact");
  await expect(page.locator('[data-shell-status="projected"]')).toBeVisible();
  await page.getByRole("button", { name: "Production" }).click();
  await expect(
    page.getByText("1 of 1 segments", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sequence authority is unavailable")).toHaveCount(
    0,
  );
  await expect
    .poll(async () => (await snapshot(page)).coordinatorActions)
    .toEqual([
      "prepare_managed_run",
      "submit_managed_run",
      "close_managed_run",
      "read_managed_run",
      "close_managed_run",
    ]);
  const completed = await snapshot(page);
  expect(completed.managedRequestIds).toHaveLength(5);
  expect(new Set(completed.managedRequestIds).size).toBe(5);
  expect(completed.replayCollisionCount).toBe(0);
  return completed;
}

async function runAccumulatingMember(
  page: Page,
  intentValue: string,
  expectedQueueCount: number,
  expectedOrdinal: number,
  expectedStartLabel = "Start H3 App Mode",
): Promise<HarnessSnapshot> {
  const intent = page.getByRole("textbox", { name: "Intent" });
  await expect(intent).toBeVisible();
  const coordinatorActionCount = (await snapshot(page)).coordinatorActions
    .length;
  await intent.fill(intentValue);
  await page
    .getByRole("spinbutton", { name: "Clip duration (seconds)" })
    .fill("8");
  await expect(page.getByText("Delivers 8 s (192 frames).")).toBeVisible();

  const start = page.locator('[data-h3-focus-key="app-submit"]');
  await expect(start).toHaveText(expectedStartLabel);
  await expect(start).toBeEnabled();
  await start.click();
  if (expectedStartLabel === "Start H3 App Mode") {
    await expect(
      page.locator('[data-shell-reason="canvas_ready"]'),
    ).toBeVisible();
    expect((await snapshot(page)).queueCount).toBe(expectedQueueCount - 1);
    await expect(start).toHaveText("Apply and queue current H3 graph");
    await start.click();
  }
  await expect
    .poll(async () => (await snapshot(page)).queueCount)
    .toBe(expectedQueueCount);
  await expect(
    page.locator('[data-app-mode-phase="generating"]'),
  ).toBeVisible();

  await dispatch(page, "dispatchBootstrap");
  await expect
    .poll(async () => (await snapshot(page)).coordinatorActions.length)
    .toBe(coordinatorActionCount + 2);
  await dispatch(page, "dispatchTerminal");
  await expect(
    page.locator('[data-app-mode-phase="verifying_output"]'),
  ).toBeVisible();
  await dispatch(page, "dispatchArtifact");
  await expect(page.locator('[data-shell-status="projected"]')).toBeVisible();

  await page.getByRole("button", { name: "Production" }).click();
  await expect(
    page.getByText(`${expectedOrdinal} of ${expectedOrdinal} segments`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(`Added segment ${expectedOrdinal}`, { exact: true }),
  ).toBeVisible();
  const current = await snapshot(page);
  expect(current.projectSegmentCount).toBe(expectedOrdinal);
  return current;
}

test("successive Starts and a reload append to one stable Production project", async ({
  page,
}) => {
  await page.goto(
    "/?mode=managed-entry&queueWrapper=mutate_in_place&initialGraph=empty",
  );
  const first = await runAccumulatingMember(
    page,
    "A synthetic eight-second managed H3 browser journey.",
    1,
    1,
  );
  expect(first.productionActions[0]).toBe("admit_generation_destination_v2");
  expect(first.projectWorkspaceHandle).not.toBeNull();
  expect(first.lifecycleEvents.slice(0, 5)).toEqual([
    "production:admit_generation_destination_v2",
    `queue:${managedPromptId}`,
    "coordinator:prepare_managed_run",
    "production:read_accumulated_project",
    "coordinator:submit_managed_run",
  ]);

  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("button", { name: "Edit App Mode setup" }).click();
  await expect(
    page.locator('[data-shell-status="editing_setup"]'),
  ).toBeVisible();
  const second = await runAccumulatingMember(
    page,
    "A synthetic eight-second managed H3 browser journey.",
    2,
    2,
    "Apply and queue current H3 graph",
  );
  expect(second.projectWorkspaceHandle).toBe(first.projectWorkspaceHandle);
  expect(
    second.productionActions.filter(
      (action) => action === "admit_generation_destination_v2",
    ),
  ).toHaveLength(2);
  const secondAdmissionIndex = second.lifecycleEvents.lastIndexOf(
    "production:admit_generation_destination_v2",
  );
  expect(
    second.lifecycleEvents.slice(
      secondAdmissionIndex,
      secondAdmissionIndex + 5,
    ),
  ).toEqual([
    "production:admit_generation_destination_v2",
    `queue:${secondManagedPromptId}`,
    "coordinator:prepare_managed_run",
    "production:read_accumulated_project",
    "coordinator:submit_managed_run",
  ]);

  await page.reload();
  await expect(page.locator('[data-shell-status="interactive"]')).toBeVisible();
  const adopted = await snapshot(page);
  expect(adopted.projectWorkspaceHandle).toBe(first.projectWorkspaceHandle);
  expect(adopted.projectSegmentCount).toBe(2);
  const third = await runAccumulatingMember(
    page,
    "A synthetic eight-second managed H3 browser journey.",
    1,
    3,
  );
  expect(third.projectWorkspaceHandle).toBe(first.projectWorkspaceHandle);
  expect(third.projectSegmentCount).toBe(3);
});

test("an interrupted first attempt stays empty and the next ordinary Start commits once", async ({
  page,
}) => {
  await page.goto(
    "/?mode=managed-entry&queueWrapper=mutate_in_place&initialGraph=empty",
  );
  await page
    .getByRole("textbox", { name: "Intent" })
    .fill("A synthetic eight-second managed H3 browser journey.");
  await page
    .getByRole("spinbutton", { name: "Clip duration (seconds)" })
    .fill("8");
  await expect(page.getByText("Delivers 8 s (192 frames).")).toBeVisible();
  const firstStart = page.locator('[data-h3-focus-key="app-submit"]');
  await expect(firstStart).toBeEnabled();
  await firstStart.click();
  await expect(
    page.locator('[data-shell-reason="canvas_ready"]'),
  ).toBeVisible();
  expect((await snapshot(page)).queueCount).toBe(0);
  await firstStart.click();
  await expect.poll(async () => (await snapshot(page)).queueCount).toBe(1);
  await dispatch(page, "dispatchBootstrap");
  await dispatch(page, "dispatchInterruption");
  await expect(page.locator('[data-shell-status="error"]')).toBeVisible();

  const failed = await snapshot(page);
  expect(failed.projectSegmentCount).toBe(0);
  expect(failed.queueCount).toBe(1);
  const projectHandle = failed.projectWorkspaceHandle;
  expect(projectHandle).not.toBeNull();
  await page.getByRole("button", { name: "Production" }).click();
  await expect(page.getByText("No generated segments yet.")).toBeVisible();
  await expect(page.getByText("Latest attempt: Cancelled.")).toBeVisible();

  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("button", { name: "Edit App Mode setup" }).click();
  await expect(page.locator('[data-shell-status="interactive"]')).toBeVisible();
  await page
    .getByRole("textbox", { name: "Intent" })
    .fill("A synthetic eight-second managed H3 browser journey.");
  const nextStart = page.locator('[data-h3-focus-key="app-submit"]');
  await expect(nextStart).toBeEnabled();
  await nextStart.click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).productionActions.filter(
          (action) => action === "admit_generation_destination_v2",
        ).length,
    )
    .toBe(2);
  await expect.poll(async () => (await snapshot(page)).queueCount).toBe(2);
  await dispatch(page, "dispatchBootstrap");
  await expect
    .poll(async () => (await snapshot(page)).coordinatorActions.slice(-2))
    .toEqual(["prepare_managed_run", "submit_managed_run"]);
  await dispatch(page, "dispatchTerminal");
  await expect(
    page.locator('[data-app-mode-phase="verifying_output"]'),
  ).toBeVisible();
  await dispatch(page, "dispatchArtifact");
  await expect(page.locator('[data-shell-status="projected"]')).toBeVisible();
  await page.getByRole("button", { name: "Production" }).click();
  await expect(
    page.getByText("1 of 1 segments", { exact: true }),
  ).toBeVisible();

  // Prepare the same-session editor explicitly before testing the import action. The fixture
  // answers the real Authoring and import clients with eligible synthetic media authority; this
  // setup does not queue another generation and does not stand in for cold-entry recovery.
  // the Clip editor function's project summary owns the explicit start.
  await page.getByRole("tab", { name: "Clip editor" }).click();
  const summary = page.getByRole("region", {
    name: "Clip editor project",
    exact: true,
  });
  await summary
    .getByRole("button", { name: "Start authoring from this context" })
    .click();
  await expect(
    summary.getByRole("button", { name: "Refresh workspace" }),
  ).toBeEnabled();
  // An explicit open of the full editor initializes the timeline history, so the import below
  // adopts an editor that already has one (the compact editor's "Load professional timeline" did
  // this before).
  await page.locator('[data-h3-nle-entry="open"]').click();
  const overlay = page.locator('[data-h3-nle-surface="overlay_v1"]');
  await expect(overlay).toHaveAttribute("data-h3-nle-state", "expanded");
  await expect(
    overlay.locator('[data-h3-nle-status="timeline"]'),
  ).toHaveAttribute("data-h3-nle-authoring", "ready");
  // B-M2561-01: since the Production import lives in the open editor's Media pane.
  await overlay.locator('[data-h3-nle-pane="assets"]').click();
  const importSelected = overlay.locator(
    '[data-h3-nle-control="asset.import_production"]',
  );
  await expect(importSelected).toBeEnabled();
  await importSelected.click();
  await expect(
    page.getByRole("tab", { name: "Clip editor", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // IMPORTANT (B-M2544-07): a succeeded import is published before its confirming history read,
  // and in the editor no tab switch separates the click from the sample, so wait for the recorded
  // list rather than sampling it once.
  await expect
    .poll(async () => (await snapshot(page)).authoringActions.length)
    .toBe(5);

  const succeeded = await snapshot(page);
  expect(succeeded.projectWorkspaceHandle).toBe(projectHandle);
  expect(succeeded.projectSegmentCount).toBe(1);
  expect(succeeded.queueCount).toBe(2);
  expect(
    succeeded.productionActions.filter(
      (action) => action === "admit_generation_destination_v2",
    ),
  ).toHaveLength(2);
  // import prepares through the live Production owner (adopting this same-lineage editor),
  // reads the accepted history before posting, then reads it again to confirm the receipt assets.
  expect(succeeded.authoringActions).toEqual([
    "create_authoring_workspace",
    "initialize_timeline_history",
    "ensure_authoring_from_production",
    "read_timeline_history",
    "read_timeline_history",
  ]);
  expect(succeeded.importCount).toBe(1);
  expect(succeeded.queueCount).toBe(2);
});

test("canonical 15-second route resolution carries 362 frames through one actual queue", async ({
  page,
}) => {
  await page.goto("/?mode=managed-entry&durationSeconds=15");
  const duration = page.getByRole("spinbutton", {
    name: "Clip duration (seconds)",
  });
  await page
    .getByRole("textbox", { name: "Intent" })
    .fill("A synthetic 15-second managed H3 browser journey.");
  await duration.fill("15");
  await expect(page.getByText("Delivers 15 s (362 frames).")).toBeVisible();

  await page
    .getByRole("button", { name: "Apply and queue current H3 graph" })
    .click();
  await expect.poll(async () => (await snapshot(page)).queueCount).toBe(1);
  let current = await snapshot(page);
  expect(
    current.durationResolutionRequests.filter((value) => value === 15),
  ).toHaveLength(1);
  expect(current.queueFrameCounts).toEqual([362]);

  await dispatch(page, "dispatchBootstrap");
  await expect
    .poll(async () => (await snapshot(page)).coordinatorExpectedFrames)
    .toEqual([362]);
  current = await snapshot(page);
  expect(current.queueCount).toBe(1);
  expect(current.queueFrameCounts).toEqual([362]);
});

test("actual Sidebar entry owns verified Production success across noisy queue wrappers and a browser reload", async ({
  page,
}) => {
  await page.goto("/?mode=managed-entry&queueWrapper=mutate_in_place");
  const first = await runManagedLifecycle(page);
  expect(first.requestLedgerIds).toHaveLength(5);
  expect(first.queuePromptWrapperMode).toBe("mutate_in_place");

  // The backend replay ledger outlives a browser document. Reloading therefore
  // reproduces the real collision boundary while the second installed-wrapper
  // family still exercises src/entry and the same one-call queue contract.
  await page.evaluate(() => {
    const next = new URL(window.location.href);
    next.searchParams.set("queueWrapper", "forward_copy");
    window.history.replaceState(null, "", next);
  });
  await page.reload();
  const second = await runAccumulatingMember(
    page,
    "A synthetic eight-second managed H3 browser journey.",
    1,
    2,
    "Apply and queue current H3 graph",
  );
  expect(second.requestLedgerIds).toHaveLength(9);
  expect(second.queuePromptWrapperMode).toBe("forward_copy");
  expect(new Set(second.requestLedgerIds).size).toBe(9);
  expect(
    second.requestLedgerIds.every((requestId) =>
      /^managed\.[0-9a-f]{16}\./.test(requestId),
    ),
  ).toBe(true);
});

for (const disposition of ["missing_asset", "asset_relocated"]) {
  test(`Sidebar prepares an advisory ${disposition} canvas before a manual queue`, async ({
    page,
  }) => {
    await page.goto(
      `/?mode=managed-entry&initialGraph=empty&generationProfile=${disposition}`,
    );
    await page
      .getByRole("textbox", { name: "Intent" })
      .fill("A synthetic eight-second managed H3 browser journey.");
    await page
      .getByRole("spinbutton", { name: "Clip duration (seconds)" })
      .fill("8");
    const submit = page.locator('[data-h3-focus-key="app-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(
      page.getByText("Canvas ready. Check its settings, then queue manually."),
    ).toBeVisible();
    const prepared = await snapshot(page);
    expect(prepared.queueCount).toBe(0);
    expect(prepared.productionActions).toEqual([]);
    expect(prepared.coordinatorActions).toEqual([]);
    await expect(submit).toHaveText("Apply and queue current H3 graph");
    await submit.click();
    await expect.poll(async () => (await snapshot(page)).queueCount).toBe(1);
    await expect(
      page.locator('[data-app-mode-phase="generating"]'),
    ).toBeVisible();
  });
}

test("existing managed generation never inherits a relocated materialize notice", async ({
  page,
}) => {
  await page.goto(
    "/?mode=managed-entry&generationProfile=asset_relocated&queueWrapper=mutate_in_place",
  );
  await page
    .getByRole("textbox", { name: "Intent" })
    .fill("A synthetic eight-second managed H3 browser journey.");
  await page
    .getByRole("spinbutton", { name: "Clip duration (seconds)" })
    .fill("8");
  await expect(page.getByText("Delivers 8 s (192 frames).")).toBeVisible();

  const submit = page.locator('[data-h3-focus-key="app-submit"]');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(async () => (await snapshot(page)).queueCount).toBe(1);
  await expect(
    page.locator('[data-app-mode-phase="generating"]'),
  ).toBeVisible();
  await expect(page.locator("#h3-app-mode-generation-blocker")).toHaveCount(0);
  await expect(page.locator(".h3-app-mode-actions")).not.toHaveAttribute(
    "data-h3-action-scope",
    "materialize",
  );
  await expect(submit).not.toHaveAttribute(
    "aria-describedby",
    /h3-app-mode-generation-blocker/,
  );
});

async function setupNativeStartup(page: Page, overlay = true) {
  await page.route("http://startup.invalid/**", (route) =>
    route.fulfill({
      body: overlay
        ? '<div data-testid="app-loading-overlay">Synthetic startup</div>'
        : "<div></div>",
      contentType: "text/html",
    }),
  );
  await page.goto("http://startup.invalid/");
  await page.evaluate(() => {
    const app = { extensionManager: {}, graph: { source: null } };
    (window as any).app = app;
    (window as any).comfyAPI = { app: { app } };
  });
}

test("native startup waits before source creation through late restore", async ({
  page,
}) => {
  await setupNativeStartup(page);
  const armRestore = (createEarly: boolean) =>
    page.evaluate((early) => {
      const app = (window as any).app;
      const overlay = document.querySelector<HTMLElement>(
        '[data-testid="app-loading-overlay"]',
      )!;
      overlay.style.display = "block";
      if (early) app.graph.source = { expected: true };
      setTimeout(() => {
        app.graph.source = null;
        overlay.style.display = "none";
      }, 50);
    }, createEarly);
  await armRestore(true);
  await waitForNativeFrameStartup(page, 2000);
  const oldRetained = await page.evaluate(
    () => (window as any).app.graph.source?.expected === true,
  );
  // The old ordering must fail retention after the same real browser restore.
  expect(oldRetained).toBe(false);
  await armRestore(false);
  await waitForNativeFrameStartup(page, 2000);
  await page.evaluate(() => {
    (window as any).app.graph.source = { expected: true };
  });
  expect(
    await page.evaluate(
      () => (window as any).app.graph.source?.expected === true,
    ),
  ).toBe(true);
});

test("native startup refuses missing or busy overlay and absent or mismatched authority", async ({
  page,
}) => {
  await setupNativeStartup(page, false);
  await expect(waitForNativeFrameStartup(page, 100)).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.dataset.testid = "app-loading-overlay";
    overlay.textContent = "Synthetic startup";
    document.body.append(overlay);
  });
  await expect(waitForNativeFrameStartup(page, 100)).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await page.evaluate(() => {
    (window as any).app.extensionManager = undefined;
  });
  await expect(waitForNativeFrameStartup(page, 100)).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await page.evaluate(() => {
    (window as any).app = { extensionManager: {} };
  });
  await expect(waitForNativeFrameStartup(page, 100)).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(
    await page.evaluate(() => (window as any).comfyAPI.app.app.graph.source),
  ).toBeNull();
});

test("native startup preserves failure identity and bounds URL and frame completion", async ({
  page,
}) => {
  await setupNativeStartup(page);
  const marker = {};
  let seen: unknown;
  try {
    await waitForNativeFrameStartup(
      {
        url: () => "http://startup.invalid/",
        waitForFunction: async () => {
          throw marker;
        },
      } as unknown as Page,
      100,
    );
  } catch (error) {
    seen = error;
  }
  expect(seen).toBe(marker);
  await page.goto("http://startup.invalid/?workflow=synthetic");
  await expect(waitForNativeFrameStartup(page, 100)).rejects.toBeInstanceOf(
    TypeError,
  );
  await setupNativeStartup(page);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(
      '[data-testid="app-loading-overlay"]',
    )!.style.display = "none";
    window.requestAnimationFrame = () => 1;
  });
  let frameFailure: unknown;
  try {
    await waitForNativeFrameStartup(page, 200);
  } catch (error) {
    frameFailure = error;
  }
  expect(frameFailure).toBeInstanceOf(Error);
  expect(frameFailure).toMatchObject({ name: "Error" });
  expect((frameFailure as Error).message.split("\n")[0]).toBe(
    "page.evaluate: Error: native startup frame deadline expired",
  );
});

test("native startup refuses a late final evaluate success at the shared deadline", async () => {
  const originalNow = Date.now;
  let clock = 0;
  let sourceCreationAdmitted = false;
  let failure: unknown;
  try {
    Date.now = () => clock;
    await waitForNativeFrameStartup(
      {
        url: () => "http://startup.invalid/",
        waitForFunction: async () => undefined,
        locator: () => ({ waitFor: async () => undefined }),
        evaluate: async () => {
          clock = 101;
        },
      } as unknown as Page,
      100,
    );
    sourceCreationAdmitted = true;
  } catch (error) {
    failure = error;
  } finally {
    Date.now = originalNow;
  }
  expect(sourceCreationAdmitted).toBe(false);
  expect(failure).toMatchObject({ message: "native startup deadline expired" });
});

for (const deferred of [false, true]) {
  test(`native preparation waits for real routed L2VA compilation deferred=${deferred}`, async ({
    page,
  }) => {
    const text = sidebarCopy("en");
    const intent = "Prepare a synthetic last-frame native canvas.";
    const source = {
      class_type: "LoadImage",
      inputs: { image: "synthetic-last.png" },
    };
    const output = createQualifiedBasePrompt(
      {
        task_mode: "l2va",
        user_intent: intent,
        duration_milliseconds: 8000,
        frame_count: 192,
        last_frame_source: "11",
      },
      { last_frame: source },
      { sharedDurationSource: true },
    );
    await page.route("**/templates/video_minimax_h3_i2v.json", (route) =>
      route.fulfill({ json: syntheticTemplate("video_minimax_h3_i2v") }),
    );
    await page.goto("/?mode=managed-entry&initialGraph=dirty");
    const shell = page.locator("#managed-entry-sidebar");
    await expect(
      shell.locator('[data-shell-status="interactive"]'),
    ).toBeVisible();
    await page.evaluate(
      async ({ output, source, deferred }) => {
        const fixtureUrl = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) =>
            new URL(url).pathname.endsWith(
              "/tests/fixtures/entryHostModules.ts",
            ),
          );
        if (fixtureUrl === undefined)
          throw new Error("the existing entry fixture module was not observed");
        const fixture = await import(/* @vite-ignore */ fixtureUrl);
        const shell = document.querySelector("#managed-entry-sidebar")!;
        const control = document.createElement("button");
        control.id = "release-native-source-compile";
        control.textContent = "Release synthetic source compilation";
        let release: (() => void) | undefined;
        control.addEventListener("click", () => release?.());
        document.body.append(control);
        shell.setAttribute("data-native-preparation-presses", "0");
        shell.setAttribute("data-native-preparation-compiles", "0");
        shell.addEventListener("click", (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-h3-focus-key="app-submit"]')
          )
            shell.setAttribute(
              "data-native-preparation-presses",
              String(
                Number(shell.getAttribute("data-native-preparation-presses")) +
                  1,
              ),
            );
        });
        fixture.setGraph({
          last_node_id: 11,
          last_link_id: 0,
          nodes: [
            {
              id: 11,
              type: "LoadImage",
              widgets_values: ["synthetic-last.png", "image"],
            },
          ],
          links: [],
          groups: [],
          config: {},
          extra: {},
          version: 0.4,
        });
        fixture.registeredExtension().nodeCreated();
        let calls = 0;
        fixture.setGraphToPromptHandler(async () => {
          calls += 1;
          shell.setAttribute("data-native-preparation-compiles", String(calls));
          if (calls === 1) {
            if (deferred)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return { output: { "11": source }, workflow: {} };
          }
          return { output, workflow: {} };
        });
      },
      { output, source, deferred },
    );
    await shell
      .locator('[data-h3-focus-key="app-task-mode"]')
      .selectOption("l2va");
    await expect(
      shell.locator('[data-h3-focus-key="app-last-frame"] option[value="11"]'),
    ).toHaveCount(1);
    await shell
      .locator('[data-h3-focus-key="app-last-frame"]')
      .selectOption("11");
    await shell.locator('[data-h3-focus-key="app-intent"]').fill(intent);
    await shell.locator('[data-h3-focus-key="app-duration-seconds"]').fill("8");
    await expect(shell.locator('[data-h3-focus-key="app-submit"]')).toHaveText(
      text.replaceAppMode,
    );
    await expect(
      shell.locator('[data-h3-focus-key="app-submit"]'),
    ).toBeEnabled();
    const compiler = await page.evaluateHandle(async () => {
      const fixtureUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) =>
          new URL(url).pathname.endsWith("/tests/fixtures/entryHostModules.ts"),
        );
      if (fixtureUrl === undefined)
        throw new Error("the existing entry fixture module was not observed");
      const fixture = await import(/* @vite-ignore */ fixtureUrl);
      return fixture.app as { graphToPrompt?: (...args: unknown[]) => unknown };
    });
    const observer = await page.evaluateHandle(
      createNativeCompileDiagnostics,
      compiler,
    );
    await compiler.dispose();
    let compileTrace:
      | ReturnType<ReturnType<typeof createNativeCompileDiagnostics>["finish"]>
      | undefined;
    let outcome = "pending";
    const prepared = prepareNativeFrameCanvas(
      shell,
      async () => (await snapshot(page)).queueCount,
    );
    const observed = prepared.then(
      (result) => {
        outcome = "ready";
        return { result };
      },
      () => {
        outcome = "refused";
        return { result: undefined };
      },
    );
    try {
      if (deferred) {
        // IMPORTANT: hold the real source compile, not a hand-authored DOM state;
        // an old census must not settle preparation or trigger a second Replace.
        await expect(shell).toHaveAttribute(
          "data-native-preparation-compiles",
          "1",
        );
        await expect(
          shell.locator('[data-shell-status="working"]'),
        ).toBeVisible();
        expect(outcome).toBe("pending");
        expect(
          (await observer.evaluate((trace) => trace.snapshot())).calls[0]
            ?.completion,
        ).toBe("pending");
        await expect(shell).toHaveAttribute(
          "data-native-preparation-presses",
          "1",
        );
        expect((await snapshot(page)).queueCount).toBe(0);
        await page.locator("#release-native-source-compile").click();
      }
      const { result } = await observed;
      expect(outcome).toBe("ready");
      expect(result?.submitPresses).toBe(1);
      expect(result?.terminalState).toMatch(
        /^interactive:(canvas_ready|native_preference)$/,
      );
    } finally {
      compileTrace = await observer.evaluate((trace) => trace.finish());
      await observer.dispose();
    }
    expect(compileTrace.restoration).toBe("restored");
    expect(compileTrace.callCount).toBe(2);
    expect(compileTrace.calls[0]?.shape?.selectedLoadImage).toBe(true);
    expect(JSON.stringify(compileTrace)).not.toMatch(
      /synthetic-last|synthetic-private/,
    );
    await expect(shell).toHaveAttribute("data-native-preparation-presses", "1");
    await expect(shell).toHaveAttribute(
      "data-native-preparation-compiles",
      "2",
    );
    expect((await snapshot(page)).queueCount).toBe(0);
  });
}

async function prepareUnchosenImageCanvas(
  page: Page,
  testInfo: TestInfo,
  initialGraph: "empty" | "dirty",
) {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const text = sidebarCopy("en");
  await page.route("**/templates/video_minimax_h3_i2v.json", (route) =>
    route.fulfill({ json: syntheticTemplate("video_minimax_h3_i2v") }),
  );
  await page.goto(`/?mode=managed-entry&initialGraph=${initialGraph}`);
  await expect(
    page.getByRole("combobox", { name: text.taskMode, exact: true }),
  ).toBeVisible();
  const output = createQualifiedBasePrompt(
    {
      task_mode: "i2va",
      user_intent: "Prepare the official canvas before choosing an image.",
      duration_milliseconds: 5000,
      frame_count: 120,
      first_frame_source: "17",
    },
    {
      first_frame: {
        class_type: "LoadImage",
        inputs: { image: "fixture.png" },
      },
    },
    { sharedDurationSource: true },
  );
  // Script the existing fixture compiler; the production preparation, validation and
  // canvas write still execute through src/entry and the declared host seams.
  await page.evaluate(async (compiledOutput) => {
    const fixtureUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) =>
        new URL(url).pathname.endsWith("/tests/fixtures/entryHostModules.ts"),
      );
    if (fixtureUrl === undefined)
      throw new Error("the existing entry fixture module was not observed");
    const fixture = await import(/* @vite-ignore */ fixtureUrl);
    fixture.setGraphToPromptHandler(() => ({
      output: compiledOutput,
      workflow: {},
    }));
  }, output);
  await page
    .getByRole("combobox", { name: text.taskMode, exact: true })
    .selectOption("i2va");
  await page
    .getByRole("textbox", { name: "Intent" })
    .fill("Prepare the official canvas before choosing an image.");
  const submit = page.locator('[data-h3-focus-key="app-submit"]');
  const source = page.getByRole("combobox", {
    name: text.firstFrameSource,
    exact: true,
  });
  await expect(
    page.getByText(text.sourceGuidance.noImage, { exact: true }),
  ).toBeVisible();
  await expect(source).toHaveAttribute(
    "aria-describedby",
    "h3-app-mode-source-guidance",
  );
  await expect(submit).toHaveText(
    initialGraph === "empty" ? text.startAppMode : text.replaceAppMode,
  );
  await expect(submit).toBeEnabled();
  await page.locator("#managed-entry-sidebar").screenshot({
    path: testInfo.outputPath(`${initialGraph}-current-empty.png`),
  });

  // Model the host's ordinary node-created callback after its graph API changes.
  // The same mounted Sidebar must refresh; no page reload or remount is used.
  await page.evaluate(async () => {
    const fixtureUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) =>
        new URL(url).pathname.endsWith("/tests/fixtures/entryHostModules.ts"),
      );
    if (fixtureUrl === undefined)
      throw new Error("the existing entry fixture module was not observed");
    const fixture = await import(/* @vite-ignore */ fixtureUrl);
    const graph = fixture.app.graph.serialize();
    fixture.app.loadGraphData({
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 901,
          type: "LoadImage",
          widgets_values: ["fixture.png", "image"],
        },
      ],
    });
    fixture.registeredExtension().nodeCreated();
  });
  await expect(source.locator('option[value="901"]')).toHaveCount(1);
  await expect(
    page.getByText(text.sourceGuidance.noImage, { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    const fixtureUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) =>
        new URL(url).pathname.endsWith("/tests/fixtures/entryHostModules.ts"),
      );
    if (fixtureUrl === undefined)
      throw new Error("the existing entry fixture module was not observed");
    const fixture = await import(/* @vite-ignore */ fixtureUrl);
    const graph = fixture.app.graph.serialize();
    fixture.app.loadGraphData({
      ...graph,
      nodes: graph.nodes.filter((node: { id: number }) => node.id !== 901),
    });
    fixture.registeredExtension().nodeCreated();
  });
  await expect(
    page.getByText(text.sourceGuidance.noImage, { exact: true }),
  ).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.locator('[data-shell-reason="canvas_ready"]'),
  ).toBeVisible();
  // Reproduce the ordinary post-write inspection through the subscribed host
  // graph seam; inspecting only the transient ready state misses lost guidance.
  await page.evaluate(async () => {
    const fixtureUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) =>
        new URL(url).pathname.endsWith("/tests/fixtures/entryHostModules.ts"),
      );
    if (fixtureUrl === undefined)
      throw new Error("the existing entry fixture module was not observed");
    const fixture = await import(/* @vite-ignore */ fixtureUrl);
    fixture.app.graph.events.dispatchEvent(new Event("graphChanged"));
  });
  await expect(
    page.locator('[data-shell-reason="native_preference"]'),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const wire = await page.evaluate(() =>
        localStorage.getItem("h3-context.managed-journal.v1"),
      );
      const journal = createManagedJournal();
      journal.initialize({
        getItem: () => wire,
        setItem: () => undefined,
        removeItem: () => undefined,
      });
      const entries = journal.snapshot();
      const ready = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.kind === "transition" && entry.event === "CANVAS_READY",
        );
      return (
        ready !== undefined &&
        entries.some(
          (entry) =>
            entry.run === ready.run &&
            entry.seq > ready.seq &&
            entry.kind === "state" &&
            entry.name === "interactive" &&
            entry.reason === "native_preference",
        )
      );
    })
    .toBe(true);
  await expect(page.locator("[data-h3-prepared-source-guidance]")).toHaveText(
    text.sourceGuidance.readyFrames
      .replace("{roles}", text.sourceGuidance.roles.firstFrame)
      .replace("{queue}", text.queueCurrentGraph),
  );
  await expect(submit).toHaveText(text.queueCurrentGraph);
  expect((await snapshot(page)).queueCount).toBe(0);
  const loaderCount = await page.evaluate(async () => {
    const fixtureUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) =>
        new URL(url).pathname.endsWith("/tests/fixtures/entryHostModules.ts"),
      );
    if (fixtureUrl === undefined)
      throw new Error("the existing entry fixture module was not observed");
    const fixture = await import(/* @vite-ignore */ fixtureUrl);
    return fixture.app.graph
      .serialize()
      .nodes.filter((node: { type: string }) => node.type === "LoadImage")
      .length;
  });
  expect(loaderCount).toBe(1);
  await page.locator("#managed-entry-sidebar").screenshot({
    path: testInfo.outputPath(`${initialGraph}-canvas-ready.png`),
  });
}

test("I2VA Start prepares an unchosen image and refreshes source guidance", async ({
  page,
}, testInfo) => {
  await prepareUnchosenImageCanvas(page, testInfo, "empty");
});

test("I2VA Replace prepares an unchosen image and refreshes source guidance", async ({
  page,
}, testInfo) => {
  await prepareUnchosenImageCanvas(page, testInfo, "dirty");
});

test("Replace prepares a ready canvas and native model refusal ends manual queue work", async ({
  page,
}) => {
  await page.goto(
    "/?mode=managed-entry&initialGraph=dirty&queueReject=true&generationProfile=asset_relocated",
  );
  await page
    .getByRole("textbox", { name: "Intent" })
    .fill("A synthetic eight-second managed H3 browser journey.");
  await page
    .getByRole("spinbutton", { name: "Clip duration (seconds)" })
    .fill("8");
  const submit = page.locator('[data-h3-focus-key="app-submit"]');
  await expect(submit).toHaveText("Replace canvas and start H3 App Mode");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.locator('[data-shell-reason="canvas_ready"]'),
  ).toBeVisible();
  const prepared = await snapshot(page);
  expect(prepared.queueCount).toBe(0);
  expect(prepared.productionActions).toEqual([]);
  expect(prepared.coordinatorActions).toEqual([]);
  await dispatch(page, "destroySidebar");
  await dispatch(page, "renderSidebar");
  await expect(submit).toHaveText("Apply and queue current H3 graph");
  await submit.click();
  await expect(page.locator('[data-shell-status="error"]')).toBeVisible();
  await expect(page.locator('[data-shell-status="working"]')).toHaveCount(0);
  await expect(
    page.getByText(/ComfyUI rejected this graph before accepting it/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry H3 App Mode" }),
  ).toBeEnabled();
  expect((await snapshot(page)).queueCount).toBe(1);
});
