import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  H3Sidebar,
  initialAppModeDraft,
  type AppModeDraft,
} from "../src/components/H3Sidebar";
import { seamReady } from "../src/host/hostSeams";
import { initialShellState } from "../src/state/shellState";
import {
  sidebarCopy,
  SUPPORTED_LOCALES,
  type Locale,
} from "../src/i18n/catalog";

afterEach(cleanup);
const crop = {
  x: 80,
  y: 0,
  w: 480,
  h: 480,
  sourceWidth: 640,
  sourceHeight: 480,
};
function setup(
  initial: Partial<AppModeDraft> = {},
  existing = false,
  options: {
    locale?: Locale;
    busy?: boolean;
    pending?: boolean;
    connect?: boolean;
  } = {},
) {
  const onStart = vi.fn();
  const apply = vi.fn();
  const clear = vi.fn();
  const release = vi.fn();
  function Form() {
    const [draft, setDraft] = useState({
      ...initialAppModeDraft,
      taskMode: "i2va",
      firstFrameSource: "17",
      ...initial,
    } as AppModeDraft);
    return (
      <H3Sidebar
        locale={options.locale ?? "en"}
        state={
          existing
            ? {
                status: "interactive",
                reason: options.connect ? "incompatible_graph" : "canvas_ready",
                existingGraph: true,
              }
            : options.pending
              ? { status: "interactive", reason: "pending_capability" }
              : initialShellState
        }
        appModeDraft={draft}
        onAppModeDraftChange={setDraft}
        appMode={{
          capability: options.pending
            ? { status: "unavailable", reason: "missing_load_api_json" }
            : { status: "ready" },
          busy: options.busy,
          ...(options.connect
            ? {
                connect: {
                  tier: "connect" as const,
                  anchors: [
                    {
                      nodeId: 20,
                      anchorType: "MiniMaxH3ImageToVideo" as const,
                      nested: false,
                      taskMode: "i2va",
                    },
                  ],
                },
              }
            : {}),
          imageSources: [
            { node_id: "17", label: "Image 17" },
            { node_id: "18", label: "Image 18" },
          ],
          mediaSources: [
            { node_id: "17", label: "Image 17", kind: "image", output_slot: 0 },
            { node_id: "18", label: "Image 18", kind: "image", output_slot: 0 },
            { node_id: "22", label: "Video 22", kind: "video", output_slot: 0 },
          ],
          imageCrop: {
            available: true,
            actions: {
              open: async () => ({
                url: "/view?fixture=synthetic",
                width: 640,
                height: 480,
              }),
              apply,
              clear,
            },
            acquireKeyboardGuard: () => seamReady({ release }),
          },
          durationResolution: {
            status: "resolved",
            resolution: {
              schema: "h3.context.duration_resolution.v1",
              requested_seconds: 5,
              requested_milliseconds: 5000,
              effective_milliseconds: 5167,
              frame_count: 124,
              snapped: true,
            },
          },
          onStart,
        }}
      />
    );
  }
  render(<Form />);
  return { onStart, apply, clear, release };
}
describe("sidebar crop request builder and selection lifecycle", () => {
  it.each(["ref2va", "fl2va"] as const)(
    "preserves the complete %s weight-scenario preparation input",
    (taskMode) => {
      const lastCrop = {
        x: 27,
        y: 1,
        w: 426,
        h: 639,
        sourceWidth: 480,
        sourceHeight: 640,
      };
      const firstCrop = { ...crop, x: 80 };
      const imageCrops = { "17": firstCrop, "18": lastCrop };
      const { onStart } = setup({
        taskMode,
        userIntent: "A colorful kite crosses a clear sky.",
        lastFrameSource: "18",
        referenceImages: taskMode === "ref2va" ? ["17", "18"] : [],
        imageCrops,
      });
      fireEvent.submit(document.querySelector(".h3-app-mode-form")!);
      expect(onStart).toHaveBeenCalledExactlyOnceWith(
        {
          task_mode: taskMode,
          user_intent: "A colorful kite crosses a clear sky.",
          duration_milliseconds: 5000,
          frame_count: 124,
          image_crops: imageCrops,
          ...(taskMode === "ref2va"
            ? { reference_image_sources: ["17", "18"] }
            : { first_frame_source: "17", last_frame_source: "18" }),
        },
        { prepareOnly: true },
      );
    },
  );
  it("blocks connecting with a draft crop while replacement still prepares that crop", async () => {
    const user = userEvent.setup();
    const text = sidebarCopy("en");
    const { onStart } = setup({ imageCrops: { "17": crop } }, true, {
      connect: true,
    });
    const connect = screen.getByRole("button", { name: text.connect.action });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById("h3-app-mode-connect-blocker")?.textContent,
    ).toBe(text.crop.prepareRequired);
    await user.click(connect);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.submit(document.querySelector(".h3-app-mode-form")!);
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ image_crops: { "17": crop } }),
      { replaceExisting: true, prepareOnly: true },
    );
  });
  it.each(SUPPORTED_LOCALES)(
    "blocks Execute before a crop can be silently omitted in %s, and recovers after reset",
    async (locale) => {
      const user = userEvent.setup();
      const text = sidebarCopy(locale);
      const { onStart } = setup({ imageCrops: { "17": crop } }, false, {
        locale,
      });
      await user.click(screen.getByRole("tab", { name: text.stages[4] }));
      const start = screen.getByRole("button", {
        name: text.stageActionExecute,
      });
      expect((start as HTMLButtonElement).disabled).toBe(true);
      const reason = document.getElementById(
        start.getAttribute("aria-describedby")!,
      );
      expect(reason?.dataset.cropBlocker).toBe("crop_requires_preparation");
      expect(reason?.textContent).toBe(text.crop.prepareRequired);
      expect(reason?.textContent).toContain(text.stages[0]);
      expect(reason?.textContent).toContain(text.startAppMode);
      expect(reason?.textContent).toContain(text.replaceAppMode);
      await user.click(start);
      expect(onStart).not.toHaveBeenCalled();
      await user.click(screen.getByRole("tab", { name: text.stages[0] }));
      fireEvent.submit(document.querySelector(".h3-app-mode-form")!);
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ image_crops: { "17": crop } }),
        { prepareOnly: true },
      );
      onStart.mockClear();
      await user.click(screen.getByRole("button", { name: text.crop.action }));
      await screen.findByRole("group", { name: text.crop.regionLabel });
      await user.click(screen.getByRole("button", { name: text.crop.reset }));
      await user.click(screen.getByRole("button", { name: text.crop.apply }));
      await user.click(screen.getByRole("tab", { name: text.stages[4] }));
      const recovered = screen.getByRole("button", {
        name: text.stageActionExecute,
      });
      expect((recovered as HTMLButtonElement).disabled).toBe(false);
      await user.click(recovered);
      expect(onStart).toHaveBeenCalledOnce();
      expect(onStart.mock.calls[0]![0]).not.toHaveProperty("image_crops");
    },
  );
  it.each([false, true])(
    "uses the run-state crop reason while busy (pending=%s)",
    async (pending) => {
      const user = userEvent.setup();
      const text = sidebarCopy("en");
      setup({}, false, { busy: true, pending });
      const action = screen.getByRole("button", { name: text.crop.action });
      expect(action.getAttribute("aria-disabled")).toBe("true");
      await user.tab();
      action.focus();
      expect(screen.getByRole("tooltip").textContent).toContain(text.working);
      expect(screen.getByRole("tooltip").textContent).not.toContain(
        text.pending,
      );
    },
  );
  it("uses pending crop copy only for a pending capability", () => {
    const text = sidebarCopy("en");
    setup({}, false, { pending: true });
    screen.getByRole("button", { name: text.crop.action }).focus();
    expect(screen.getByRole("tooltip").textContent).toContain(text.pending);
  });
  it("applies a numeric crop and submits it only on preparation", async () => {
    const user = userEvent.setup();
    const { onStart, release } = setup();
    await user.click(screen.getByRole("button", { name: "Crop image" }));
    await screen.findByRole("group", { name: "Crop rectangle" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Aspect ratio" }),
      "1:1",
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("480 × 480")).toBeTruthy();
    expect(release).toHaveBeenCalledOnce();
    fireEvent.submit(document.querySelector(".h3-app-mode-form")!);
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ image_crops: { "17": crop } }),
      { prepareOnly: true },
    );
  });
  it("purges a deselected crop and disables the unchosen action", async () => {
    const user = userEvent.setup();
    const { apply, onStart } = setup({ imageCrops: { "17": crop } });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "First frame source" }),
      "",
    );
    expect(apply).toHaveBeenCalledWith("17", undefined);
    expect(screen.queryByText("480 × 480")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Crop image" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.submit(document.querySelector(".h3-app-mode-form")!);
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty("image_crops");
  });
  it("purges crops on mode switch and never offers video crop", async () => {
    const user = userEvent.setup();
    const { apply } = setup({ imageCrops: { "17": crop } });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Task mode" }),
      "ref2va",
    );
    expect(apply).toHaveBeenCalledWith("17", undefined);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reference images" }),
      "17",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reference videos" }),
      "22",
    );
    expect(screen.getAllByRole("button", { name: "Crop image" })).toHaveLength(
      1,
    );
    await user.click(
      screen.getByRole("button", { name: "Remove <Picture 1>" }),
    );
    expect(screen.queryByRole("button", { name: "Crop image" })).toBeNull();
  });
  it("purges stale draft crops under the existing-canvas action", () => {
    const { clear } = setup({ imageCrops: { "17": crop } }, true);
    expect(clear).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("button", { name: "Crop image" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByText("480 × 480")).toBeNull();
  });
});
