import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageCropDialog } from "../src/components/ImageCropDialog";
import { NleOverlay } from "../src/components/nle/NleOverlay";
import { acquireCanvasKeyboardGuard } from "../src/host/canvasKeyboardGuard";
import { acquireModalKeyboardGuard } from "../src/host/modalKeyboardGuard";
import { seamReady } from "../src/host/hostSeams";
import { sidebarCopy } from "../src/i18n/catalog";
import { bindingFixture } from "./support/nleWorkspaceBinding";
import {
  createModalKeyboardHost,
  fixtureBackedAppModeHost,
} from "./support/hostSeamTestDouble";

afterEach(cleanup);

for (const shape of ["data", "accessor", "absent"] as const)
  for (const surface of ["editor", "crop"] as const)
    it(`${surface} contains host undo/redo and canvas keys with the ${shape} predicate`, async () => {
      const subject = createModalKeyboardHost(shape);
      const source = Object.defineProperty({}, "constructor", {
        value: subject.constructor,
        configurable: true,
        writable: true,
      });
      const host = fixtureBackedAppModeHost(source, {}).app as {
        canvas: { _key_callback: EventListener };
      };
      const canvasKey = vi.fn();
      host.canvas._key_callback = canvasKey;
      document.addEventListener("keyup", canvasKey, true);
      const counts = [0, 0];
      const captures = [0, 0];
      // JSDOM has no layout/checkVisibility; the browser journey uses the host's
      // rendered check. Here mirror its hidden/style and aria-modal containment.
      const modalOpen = () =>
        Array.from(
          document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
        ).some(
          (node) =>
            node.closest('[hidden], [aria-hidden="true"]') === null &&
            getComputedStyle(node).display !== "none" &&
            getComputedStyle(node).visibility !== "hidden",
        );
      const readers = [
        () =>
          Reflect.get(subject.constructor, "maskeditor_is_opended") as
            (() => unknown) | undefined,
        () => subject.store.predicate,
      ];
      const handlers = readers.map((read, index) => (event: KeyboardEvent) => {
        if (!event.ctrlKey || !["z", "y"].includes(event.key)) return;
        captures[index]! += 1;
        if (read()?.() || modalOpen()) return;
        counts[index]! += 1;
      });
      for (const handler of handlers)
        window.addEventListener("keydown", handler, true);
      const tiers: string[] = [];
      const acquire = vi.fn((invalidated: () => void) => {
        const modal = acquireModalKeyboardGuard(host);
        if (modal.status !== "ready") return modal;
        tiers.push(modal.value.tier);
        const canvas = acquireCanvasKeyboardGuard(host, invalidated);
        if (canvas.status !== "ready") {
          modal.value.release();
          return canvas;
        }
        return seamReady({
          release() {
            canvas.value.release();
            modal.value.release();
          },
        });
      });
      try {
        const base = bindingFixture();
        const binding = {
          ...base,
          state: {
            ...base.state,
            surface: { ...base.state.surface, status: "opening" as const },
          },
        };
        const closed = vi.fn();
        const view = render(
          surface === "editor" ? (
            <NleOverlay
              binding={{
                ...binding,
                actions: {
                  ...binding.actions,
                  acquireKeyboardGuard: acquire,
                  close: closed,
                },
              }}
            />
          ) : (
            <ImageCropDialog
              sourceId="17"
              text={sidebarCopy("en").crop}
              actions={{
                open: async () => ({
                  url: "/synthetic-crop.png",
                  width: 640,
                  height: 480,
                }),
                apply() {},
                clear() {},
              }}
              acquireKeyboardGuard={acquire}
              onClose={closed}
            />
          ),
        );
        const dialog = await screen.findByRole("dialog");
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(modalOpen()).toBe(true);
        expect(acquire).toHaveBeenCalledOnce();
        expect(tiers).toEqual([shape]);
        if (surface === "editor")
          expect(binding.actions.mounted).toHaveBeenCalledOnce();
        else {
          await screen.findByRole("group", { name: "Crop rectangle" });
          expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
            "/synthetic-crop.png",
          );
        }
        fireEvent.keyDown(dialog, { key: "z", ctrlKey: true });
        fireEvent.keyDown(dialog, { key: "y", ctrlKey: true });
        fireEvent.keyUp(dialog, { key: "Delete" });
        expect(captures).toEqual([2, 2]);
        expect(counts).toEqual([0, 0]);
        expect(canvasKey).not.toHaveBeenCalled();
        fireEvent.click(
          screen.getByRole("button", {
            name: surface === "editor" ? "Close full editor" : "Cancel",
          }),
        );
        expect(closed).toHaveBeenCalledOnce();
        view.unmount();
        expect(modalOpen()).toBe(false);
        fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
        fireEvent.keyUp(document.body, { key: "Delete" });
        expect(counts).toEqual([1, 1]);
        expect(canvasKey).toHaveBeenCalledOnce();
      } finally {
        cleanup();
        for (const handler of handlers)
          window.removeEventListener("keydown", handler, true);
        document.removeEventListener("keyup", canvasKey, true);
      }
    });
