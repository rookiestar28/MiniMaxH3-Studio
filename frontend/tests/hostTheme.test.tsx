import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { H3Sidebar } from "../src/components/H3Sidebar";
import { ImageCropDialog } from "../src/components/ImageCropDialog";
import { NleOverlay } from "../src/components/nle/NleOverlay";
import { createHostThemeController } from "../src/host/hostTheme";
import { seamReady } from "../src/host/hostSeams";
import { sidebarCopy } from "../src/i18n/catalog";
import { initialShellState } from "../src/state/shellState";
import { bindingFixture } from "./support/nleWorkspaceBinding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
  document.body.classList.remove("litegraph");
});

function observers() {
  const NativeObserver = MutationObserver;
  const active = new Set<MutationObserver>();
  class TrackedObserver extends NativeObserver {
    override observe(target: Node, options: MutationObserverInit) {
      super.observe(target, options);
      if (target === document.documentElement) active.add(this);
    }
    override disconnect() {
      super.disconnect();
      active.delete(this);
    }
  }
  vi.stubGlobal("MutationObserver", TrackedObserver);
  return active;
}

it("restores a prior attribute and disconnects once, including queued changes", async () => {
  const active = observers();
  const root = document.createElement("div");
  root.setAttribute("data-h3-host-theme", "prior");
  document.documentElement.style.colorScheme = "dark";
  const dispose = createHostThemeController(root);
  expect(root.getAttribute("data-h3-host-theme")).toBe("dark");
  expect(active.size).toBe(1);
  document.documentElement.style.colorScheme = "light";
  dispose();
  dispose();
  await act(async () => {});
  expect(active.size).toBe(0);
  expect(root.getAttribute("data-h3-host-theme")).toBe("prior");
});

for (const kind of ["sidebar", "crop", "editor"] as const) {
  it(`${kind} owns exactly one native theme observer under StrictMode and releases it`, async () => {
    const active = observers();
    const baseline = active.size;
    document.body.classList.add("litegraph");
    document.documentElement.style.colorScheme = "light";
    const binding = bindingFixture();
    const crop = (
      <ImageCropDialog
        sourceId="synthetic"
        text={sidebarCopy("en").crop}
        actions={{
          open: async () => ({
            url: "/view?synthetic",
            width: 640,
            height: 480,
          }),
          apply() {},
          clear() {},
        }}
        acquireKeyboardGuard={() => seamReady({ release() {} })}
        onClose={() => {}}
      />
    );
    const view = render(
      <StrictMode>
        {kind === "sidebar" ? (
          <H3Sidebar state={initialShellState} locale="en" />
        ) : kind === "crop" ? (
          crop
        ) : (
          <NleOverlay binding={binding} />
        )}
      </StrictMode>,
    );
    await act(async () => {});
    const root = document.querySelector<HTMLElement>(
      kind === "editor" ? "[data-h3-nle-root]" : ".h3c",
    )!;
    expect(root).not.toBeNull();
    expect(root.getAttribute("data-h3-host-theme")).toBe("light");
    expect(active.size).toBe(baseline + 1);
    await act(async () => {
      document.documentElement.style.colorScheme = "dark";
    });
    expect(root.getAttribute("data-h3-host-theme")).toBe("dark");
    if (kind === "editor") {
      view.rerender(
        <StrictMode>
          <NleOverlay
            binding={{
              ...binding,
              state: {
                ...binding.state,
                surface: {
                  ...binding.state.surface,
                  generation: binding.state.surface.generation + 1,
                },
              },
            }}
          />
        </StrictMode>,
      );
      expect(active.size).toBe(baseline + 1);
      view.rerender(
        <StrictMode>
          <NleOverlay
            binding={{
              ...binding,
              state: {
                ...binding.state,
                surface: { ...binding.state.surface, status: "compact_ready" },
              },
            }}
          />
        </StrictMode>,
      );
      expect(active.size).toBe(baseline);
      view.rerender(
        <StrictMode>
          <NleOverlay binding={binding} />
        </StrictMode>,
      );
      expect(active.size).toBe(baseline + 1);
    }
    view.unmount();
    expect(active.size).toBe(baseline);
    await act(async () => {
      document.documentElement.style.colorScheme = "light";
    });
    expect(root.hasAttribute("data-h3-host-theme")).toBe(false);
  });
}
