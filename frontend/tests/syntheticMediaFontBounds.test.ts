import { afterEach, expect, it, vi } from "vitest";
import { workspaceMediaClient } from "../e2e/nleWorkspaceMedia";
import { AUTHORING_MEDIA_LEASE_REQUEST_SCHEMA } from "../src/contracts/authoringMediaLeaseCodec";

afterEach(async () => {
  await workspaceMediaClient.close();
  vi.unstubAllGlobals();
});

it.each([
  ["packaged_font_face", 8_543_168, true],
  ["packaged_font_face", 12 * 1_048_576 + 1, false],
  ["image_proxy", 1_048_576 + 1, false],
] as const)(
  "bounds synthetic %s at %i bytes",
  async (derivativeKind, size, allowed) => {
    const fingerprint = "sha256:" + "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers(),
        blob: async () =>
          new Blob([new Uint8Array(size)], {
            type:
              derivativeKind === "packaged_font_face"
                ? "font/otf"
                : "image/png",
          }),
      })),
    );
    const signal = new AbortController().signal;
    const lease = await workspaceMediaClient.create(
      {
        schema: AUTHORING_MEDIA_LEASE_REQUEST_SCHEMA,
        operation: "create",
        requestId: "fixture-font-bound",
        workspaceHandle: "fixture",
        workspaceRevision: 1,
        timelineRevision: 1,
        publicFingerprint: fingerprint,
        manifestFingerprint: fingerprint,
        profileFingerprint: fingerprint,
        scope: "clip",
        clipId: "fixture",
        assetId: "fixture",
        derivativeKind,
        ownerId: "fixture",
        runtimeEpoch: 1,
        sourceStartFrame: 0,
        sourceEndFrame: 1,
      },
      signal,
      fingerprint,
    );
    try {
      if (allowed) expect((await lease.open(signal)).blob.size).toBe(size);
      else
        await expect(lease.open(signal)).rejects.toThrow(
          "synthetic_media_bound",
        );
    } finally {
      await lease.release();
    }
  },
);
