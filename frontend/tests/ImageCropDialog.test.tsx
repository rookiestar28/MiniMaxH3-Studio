import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageCropDialog } from "../src/components/ImageCropDialog";
import { sidebarCopy } from "../src/i18n/catalog";
import { seamReady } from "../src/host/hostSeams";

afterEach(cleanup);
const source = { url: "/view?fixture=synthetic", width: 640, height: 480 };

describe("crop dialog interaction and keyboard lease lifecycle", () => {
  it("chooses an exact ratio, nudges in source pixels and applies numeric crop only", async () => {
    const applied = vi.fn();
    const closed = vi.fn();
    const release = vi.fn();
    const user = userEvent.setup();
    render(
      <ImageCropDialog
        sourceId="17"
        text={sidebarCopy("en").crop}
        actions={{ open: async () => source, apply: applied, clear() {} }}
        acquireKeyboardGuard={() => seamReady({ release })}
        onClose={closed}
      />,
    );
    await screen.findByRole("group", { name: "Crop rectangle" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Aspect ratio" }),
      "1:1",
    );
    const region = screen.getByRole("group", { name: "Crop rectangle" });
    region.focus();
    await user.keyboard("{ArrowRight}{Shift>}{ArrowDown}{/Shift}");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(applied).toHaveBeenCalledWith("17", {
      x: 81,
      y: 0,
      w: 480,
      h: 480,
      sourceWidth: 640,
      sourceHeight: 480,
    });
    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({ x: 81, w: 480, h: 480 }),
    );
  });

  it("guards unapplied changes, traps focus and restores it on unmount", async () => {
    const user = userEvent.setup();
    const closed = vi.fn();
    const release = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <ImageCropDialog
        sourceId="17"
        text={sidebarCopy("en").crop}
        actions={{ open: async () => source, apply() {}, clear() {} }}
        acquireKeyboardGuard={() => seamReady({ release })}
        onClose={closed}
      />,
    );
    await screen.findByRole("group", { name: "Crop rectangle" });
    await user.selectOptions(screen.getByRole("combobox"), "1:1");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Discard");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(closed).toHaveBeenCalledWith();
    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it.each(["image", "apply"])(
    "keeps focus and shortcuts inside the error dialog after %s fails",
    async (failure) => {
      const user = userEvent.setup();
      const closed = vi.fn();
      const release = vi.fn();
      const escaped = vi.fn();
      document.addEventListener("keydown", escaped);
      try {
        render(
          <ImageCropDialog
            sourceId="17"
            text={sidebarCopy("en").crop}
            actions={{
              open: async () => source,
              apply() {
                if (failure === "apply") throw new Error("synthetic failure");
              },
              clear() {},
            }}
            acquireKeyboardGuard={() => seamReady({ release })}
            onClose={closed}
          />,
        );
        const region = await screen.findByRole("group", {
          name: "Crop rectangle",
        });
        if (failure === "image") {
          region.querySelector("button")!.focus();
          fireEvent.error(document.querySelector(".h3-crop-image img")!);
        } else {
          await user.click(screen.getByRole("button", { name: "Apply" }));
        }
        expect(document.activeElement).toBe(screen.getByRole("dialog"));
        expect(release).toHaveBeenCalledOnce();
        escaped.mockClear();
        await user.keyboard("{Delete}");
        expect(escaped).not.toHaveBeenCalled();
        await user.tab();
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Cancel" }),
        );
        await user.tab({ shift: true });
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Cancel" }),
        );
        await user.keyboard("{Escape}");
        expect(closed).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        document.removeEventListener("keydown", escaped);
      }
    },
  );

  it("grows a fixed-ratio handle back with arrow keys", async () => {
    const user = userEvent.setup();
    const applied = vi.fn();
    render(
      <ImageCropDialog
        sourceId="17"
        text={sidebarCopy("en").crop}
        actions={{ open: async () => source, apply: applied, clear() {} }}
        acquireKeyboardGuard={() => seamReady({ release() {} })}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("group", { name: "Crop rectangle" });
    await user.selectOptions(screen.getByRole("combobox"), "16:9");
    screen.getByRole("button", { name: "Resize right" }).focus();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(applied).toHaveBeenCalledWith(
      "17",
      expect.objectContaining({ x: 0, y: 60, w: 640, h: 360 }),
    );
  });

  it("releases the keyboard lease when image decoding fails", async () => {
    const release = vi.fn();
    const view = render(
      <ImageCropDialog
        sourceId="17"
        text={sidebarCopy("en").crop}
        actions={{
          open: async () => {
            throw new Error("private detail");
          },
          apply() {},
          clear() {},
        }}
        acquireKeyboardGuard={() => seamReady({ release })}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not"),
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "private detail",
    );
    expect(release).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
