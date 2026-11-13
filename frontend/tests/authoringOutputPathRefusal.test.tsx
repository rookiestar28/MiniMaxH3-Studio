import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthoringOutput } from "../src/components/AuthoringOutput";
import {
  OUTPUT_CAPABILITY,
  decodeOutputError,
} from "../src/contracts/authoringOutputCodec";
import { OutputClientError } from "../src/host/authoringOutputActions";

afterEach(cleanup);
const binding = {
  workspace_handle: `authoring-${"a".repeat(32)}`,
  workspace_revision: 1,
  timeline_revision: 2,
  snapshot_fingerprint: `sha256:${"b".repeat(64)}`,
};

it.each([
  [
    "en",
    "The ComfyUI folder path is too deep for rendering on Windows. Move ComfyUI to a shorter folder.",
  ],
  [
    "zh-TW",
    "ComfyUI 資料夾路徑太深，無法在 Windows 算繪。請將 ComfyUI 移至較短的資料夾路徑。",
  ],
  [
    "zh-CN",
    "ComfyUI 文件夹路径过深，无法在 Windows 渲染。请将 ComfyUI 移至较短的文件夹路径。",
  ],
] as const)(
  "explains the closed refusal and clears it on a later action in %s",
  async (locale, message) => {
    const { code } = decodeOutputError(
      { schema: "h3.authoring.output_error.v1", code: "path_too_deep" },
      503,
    );
    const create = vi
      .fn()
      .mockRejectedValueOnce(new OutputClientError(code))
      .mockRejectedValueOnce(new OutputClientError("runtime_unavailable"));
    const preview = { open: vi.fn(), close: vi.fn() };
    render(
      <AuthoringOutput
        binding={binding}
        capability={{ ...OUTPUT_CAPABILITY, supported: true }}
        locale={locale}
        client={{ create, status: vi.fn(), cancel: vi.fn() }}
        preview={preview}
      />,
    );
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(preview.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
    await waitFor(() =>
      expect((buttons[0] as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).not.toBe(message),
    );
  },
);

it("does not accept the typed refusal at a mismatched HTTP status", () => {
  expect(() =>
    decodeOutputError(
      { schema: "h3.authoring.output_error.v1", code: "path_too_deep" },
      400,
    ),
  ).toThrow();
});
