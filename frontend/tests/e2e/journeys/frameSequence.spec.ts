import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { snapshot as frameSnapshot } from "../../../e2e/frameSequence";
import { sidebarCopy } from "../../../src/i18n/catalog";
import { reduceShellState } from "../../../src/state/shellState";
import {
  frameSequenceMediaRoot,
  prepareNativeFrameCanvas,
} from "../host/frameModeSequence";

test("original local media copies isolate frozen evidence namespaces", async ({
  page,
}, testInfo) => {
  await page.goto("/frameSequence.html?task=l2va&crop=false");
  await expect(page.locator("#status")).toHaveText("idle");
  const scratch = testInfo.outputPath("original-copy-namespaces");
  const old = resolve(scratch, ".tmp/frame-sequence-generated/fl2va-fixed-26");
  await mkdir(old, { recursive: true });
  const sentinel = resolve(old, "child-1.mp4");
  await writeFile(sentinel, "synthetic previous-window media", { flag: "wx" });
  const identities = [
    ".planning/evidence/frame/a36/host-w38-attempt36",
    ".planning/evidence/frame/a37/host-w38-attempt37",
  ];
  for (const identity of identities) {
    const root = resolve(scratch, frameSequenceMediaRoot(identity));
    const leaf = resolve(root, "fl2va-fixed-26");
    await mkdir(dirname(leaf), { recursive: true });
    await mkdir(leaf, { recursive: false });
    await expect(mkdir(leaf, { recursive: false })).rejects.toMatchObject({
      code: "EEXIST",
    });
  }
  expect(await readFile(sentinel, "utf8")).toBe(
    "synthetic previous-window media",
  );
});

test("original local media namespace preserves canonical UTF-8 identity", async ({
  page,
}) => {
  await page.goto("/frameSequence.html?task=l2va&crop=false");
  await expect(page.locator("#status")).toHaveText("idle");
  for (const [evidence, digest] of [
    [
      ".planning/evidence/frame/a36/host-w38-attempt36",
      "250845c4e48552bd802f8bb340e1a3c4cca4b26e18639b0dceb8ee6b16759183", // pragma: allowlist secret -- Public UTF-8 SHA256 test vector
    ],
    [
      ".planning/evidence/中文/a36/host-w38-attempt36",
      "fbdf9c6dad28382e6056ae27564db5297f774cbc832a3e701a5a10aac80ab897", // pragma: allowlist secret -- Public UTF-8 SHA256 test vector
    ],
  ]) {
    expect(frameSequenceMediaRoot(evidence!)).toBe(
      `.tmp/frame-sequence-generated/${digest}`,
    );
    expect(frameSequenceMediaRoot(evidence!)).toBe(
      frameSequenceMediaRoot(evidence!),
    );
  }
  const current = [
    "fl2va-fixed-26",
    "l2va-reviewed-19",
    "l2va-fixed-18",
    "i2va-cropped-10",
  ].map((row) =>
    frameSequenceMediaRoot(
      `.planning/evidence/frame/a36-${row}/host-w38-attempt36`,
    ),
  );
  expect(new Set(current).size).toBe(4);
  expect(
    frameSequenceMediaRoot(".planning/evidence/frame/A36/output"),
  ).not.toBe(frameSequenceMediaRoot(".planning/evidence/frame/a36/output"));
});

test("original local media namespace refuses noncanonical path aliases", async ({
  page,
}) => {
  await page.goto("/frameSequence.html?task=l2va&crop=false");
  await expect(page.locator("#status")).toHaveText("idle");
  for (const evidence of [
    "",
    "/absolute",
    "C:/absolute",
    "c:relative",
    "\\\\server\\share",
    "relative\\alias",
    "./relative",
    "relative/./alias",
    "relative/../alias",
    "relative//alias",
    "relative/",
    "relative/\0alias",
  ]) {
    expect(() => frameSequenceMediaRoot(evidence)).toThrow(
      "canonical project-relative evidence path required",
    );
  }
});

async function snapshot(
  page: import("@playwright/test").Page,
): Promise<ReturnType<typeof frameSnapshot>> {
  return page.evaluate(() => window.h3FrameSequence.snapshot());
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const diagnostic = JSON.stringify(await snapshot(page));
    console.log("FRAME_BRIDGE_DIAGNOSTIC " + diagnostic);
    await testInfo.attach("frame-bridge-content-free", {
      body: diagnostic,
      contentType: "application/json",
    });
  }
});

const rescannedPreparedState = reduceShellState(
  { status: "interactive", reason: "canvas_ready", existingGraph: true },
  {
    type: "graph",
    inspection: {
      status: "ready",
      anchors: [
        {
          executionId: "8",
          nodeId: "comfyui_h3_context.H3Context.ProductShell",
        },
      ],
      nodeCount: 24,
      existingGraphCompatible: true,
    },
  },
);
if (
  rescannedPreparedState.status !== "interactive" ||
  rescannedPreparedState.reason !== "native_preference"
)
  throw new Error("the real compatible preparation rescan contract changed");

for (const [scenario, expectedPresses, passes] of [
  ["canvas_ready", 1, true],
  ["native_preference", 1, true],
  ["replace", 2, true],
  ["ambiguous_graph", 1, false],
  ["error", 1, false],
  ["prequeued", 0, false],
  ["repeat_dirty", 2, false],
  ["wrong_replace_label", 1, false],
  ["expired_replace", 1, false],
  ["expired_ready", 1, false],
  ["expired_initial", 0, false],
] as const) {
  test(`native baseline preparation ${scenario} preserves the prequeue boundary`, async ({
    page,
  }) => {
    await page.goto("/frameSequence.html?task=l2va&crop=false");
    await expect(page.locator("#status")).toHaveText("idle");
    await page.evaluate(
      ({ scenario, readyReason, replaceLabel, queueLabel }) => {
        const shell = document.createElement("section");
        shell.id = "native-baseline-control";
        const state = document.createElement("div");
        state.dataset.shellStatus = "interactive";
        state.dataset.shellReason = "pending_capability";
        const submit = document.createElement("button");
        submit.dataset.h3FocusKey = "app-submit";
        submit.textContent = "Start H3 App Mode";
        shell.dataset.presses = "0";
        shell.dataset.queued = scenario === "prequeued" ? "1" : "0";
        submit.addEventListener("click", () => {
          const presses = Number(shell.dataset.presses) + 1;
          shell.dataset.presses = String(presses);
          // This boundary has the same dangerous ready action as the real Sidebar:
          // an unnecessary submit after preparation would admit a native prompt.
          if (
            ["canvas_ready", "native_preference"].includes(
              state.dataset.shellReason ?? "",
            )
          )
            shell.dataset.queued = String(Number(shell.dataset.queued) + 1);
          if (
            (scenario === "replace" && presses === 1) ||
            scenario === "expired_replace" ||
            scenario === "repeat_dirty" ||
            scenario === "wrong_replace_label"
          ) {
            state.dataset.shellReason = "dirty_graph";
            submit.textContent =
              scenario === "wrong_replace_label" ? queueLabel : replaceLabel;
            if (scenario === "wrong_replace_label") submit.disabled = true;
          } else if (scenario === "ambiguous_graph") {
            state.dataset.shellReason = "ambiguous_graph";
          } else if (scenario === "error") {
            state.dataset.shellStatus = "error";
            state.dataset.shellReason = "closed";
          } else {
            state.dataset.shellReason =
              scenario === "canvas_ready" ? "canvas_ready" : readyReason;
            submit.textContent = queueLabel;
          }
        });
        shell.append(state, submit);
        document.body.append(shell);
      },
      {
        scenario,
        readyReason: rescannedPreparedState.reason,
        replaceLabel: sidebarCopy("en").replaceAppMode,
        queueLabel: sidebarCopy("en").queueCurrentGraph,
      },
    );
    const shell = page.locator("#native-baseline-control");
    let clock = 0;
    let admissionReads = 0;
    const admissionCount = async () => {
      admissionReads += 1;
      const count = Number(await shell.getAttribute("data-queued"));
      if (
        (scenario === "expired_initial" && admissionReads === 1) ||
        (scenario === "expired_replace" && admissionReads === 2) ||
        (scenario === "expired_ready" && admissionReads === 3)
      )
        clock = 120_001;
      return count;
    };
    if (passes) {
      const prepared = await prepareNativeFrameCanvas(shell, admissionCount);
      expect(prepared.submitPresses).toBe(expectedPresses);
      expect(prepared.terminalState).toMatch(
        /^interactive:(canvas_ready|native_preference)$/,
      );
    } else {
      const pending = prepareNativeFrameCanvas(
        shell,
        admissionCount,
        scenario.startsWith("expired_") ? () => clock : undefined,
      );
      if (scenario.startsWith("expired_"))
        await expect(pending).rejects.toThrow("preparation deadline expired");
      else await expect(pending).rejects.toThrow();
    }
    await expect(shell).toHaveAttribute(
      "data-presses",
      String(expectedPresses),
    );
    await expect(shell).toHaveAttribute(
      "data-queued",
      scenario === "prequeued" ? "1" : "0",
    );
    expect((await snapshot(page)).queues).toBe(0);
  });
}

for (const [mode, cropped, expectedModes, observations] of [
  ["i2va", false, ["i2va", "t2va"], 2],
  ["l2va", false, ["t2va", "l2va"], 1],
  ["fl2va", false, ["i2va", "l2va"], 2],
  ["i2va", true, ["i2va", "t2va"], 2],
] as const) {
  test(`real private resolver runner controller serial chain ${mode} crop=${cropped}`, async ({
    page,
  }) => {
    await page.goto(`/frameSequence.html?task=${mode}&crop=${cropped}`);
    await expect(page.locator("#status")).toHaveText("idle");
    expect((await snapshot(page)).queues).toBe(0);
    await page
      .getByRole("button", { name: "Generate approved sequence" })
      .click();
    await expect(page.locator("#status")).toHaveText("active");
    const first = await snapshot(page);
    expect(first.queues).toBe(1);
    expect(first.reads).toBe(1);
    await page.getByRole("button", { name: "Complete current child" }).click();
    await expect.poll(async () => (await snapshot(page)).queues).toBe(2);
    const second = await snapshot(page);
    expect(second.childModes).toEqual(expectedModes);
    expect(second.observations).toBe(observations);
    expect(second.uniqueReceiptCount).toBe(observations);
    expect(second.writes).toBe(2);
    expect(second.reads).toBe(2);
    expect(second.lastFailure).toBeNull();
    expect(second.actions.indexOf("child:release_sequence")).toBeLessThan(
      second.actions.indexOf("parent:record_terminal"),
    );
    // Plan step 6: 24*S-1 in the kept interval; assembly discards 158-frame native padding.
    if (mode !== "i2va")
      expect(second.queuedGuideIndices[1]).toEqual([24 * 6 - 1]);
    await page.getByRole("button", { name: "Complete current child" }).click();
    await expect(page.locator("#status")).toHaveText("succeeded");
    expect((await snapshot(page)).queues).toBe(2);
  });
}

for (const mode of ["i2va", "fl2va"] as const) {
  test(`changed retained source between children refuses before bind write queue ${mode}`, async ({
    page,
  }) => {
    await page.goto(`/frameSequence.html?task=${mode}&crop=false`);
    await page
      .getByRole("button", { name: "Generate approved sequence" })
      .click();
    await expect(page.locator("#status")).toHaveText("active");
    const first = await snapshot(page);
    await page.getByRole("button", { name: "Change source identity" }).click();
    await page.getByRole("button", { name: "Complete current child" }).click();
    await expect(page.locator("#status")).toHaveText("failed");
    const stopped = await snapshot(page);
    expect(stopped.lastFailure).toBe("sequence_media_changed");
    expect(stopped.runner.parentState).toBe("paused_failure");
    expect(stopped.reads).toBe(2);
    expect(stopped.starts).toBe(2);
    expect(stopped.queues).toBe(first.queues);
    expect(stopped.writes).toBe(first.writes);
    expect(stopped.bindCounts).toEqual(first.bindCounts);
    expect(
      stopped.actions.filter(
        (action) => action === "parent:fail_prepared_child",
      ),
    ).toHaveLength(1);
  });
}
