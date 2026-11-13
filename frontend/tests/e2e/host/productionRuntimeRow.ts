import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { Locator, Response } from "@playwright/test";

import type { ProductionWorkbenchProjection } from "../../../src/contracts/productionWorkbenchCodec";
import { expect, type Page } from "./fixture";
import { repositoryRoot } from "./environment";

/** Same-origin POST from the host page, so host routing and credentials match the product. */
export async function post(
  page: Page,
  route: string,
  body: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ route, body }) => {
      const response = await fetch(route, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === "" ? null : JSON.parse(text),
      };
    },
    { route, body },
  );
}

export function ownedPath(value: string): string {
  if (isAbsolute(value))
    throw new Error("fixture paths must be repository relative");
  const result = resolve(repositoryRoot, value);
  if (relative(repositoryRoot, result).startsWith(".."))
    throw new Error("fixture path escapes the repository");
  return result;
}

export async function readReadyPreviewBytes(
  player: Locator,
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const headers = await response.allHeaders();
  expect(headers["content-type"]).toBe("video/mp4");
  expect(headers["content-length"]).toMatch(/^[1-9][0-9]*$/);
  const expectedBytes = Number(headers["content-length"]);
  expect(Number.isSafeInteger(expectedBytes)).toBe(true);
  expect(expectedBytes).toBeLessThanOrEqual(maximumBytes);
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => player.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(2);
  // IMPORTANT: BYOB clients own the ready Blob, while CDP may discard the HTTP body.
  // Read the displayed object without a second owned request or a response replacement.
  const observed = await player.evaluate(
    async (node: HTMLVideoElement, expectedBytes) => {
      const source = node.currentSrc;
      if (
        !source.startsWith("blob:") ||
        new URL(source).origin !== location.origin
      )
        throw new Error("preview must use its same-origin ready Blob");
      const response = await fetch(source, {
        signal: AbortSignal.timeout(5_000),
      });
      if (
        response.status !== 200 ||
        response.headers.get("content-type") !== "video/mp4" ||
        response.headers.get("content-length") !== String(expectedBytes)
      )
        throw new Error(
          "ready Blob metadata differs from the preview response",
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== expectedBytes || node.currentSrc !== source)
        throw new Error(
          "ready Blob identity or length changed during observation",
        );
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32_768)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32_768),
        );
      return btoa(binary);
    },
    expectedBytes,
  );
  const bytes = Buffer.from(observed, "base64");
  expect(bytes.length).toBe(expectedBytes);
  return bytes;
}

export type OwnerCaptureOperation = "observe" | "capture" | "stop";

async function absentCaptureFile(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("capture exchange final name already exists");
}

const OWNER_CAPTURE_RESULT_MAX_BYTES = 8_388_608;

async function readCaptureResult(path: string) {
  const before = await lstat(path);
  // CRITICAL: full capture evidence uses the 8 MiB result contract. Applying the
  // 4096-byte command bound here rejects valid plans and receipts before readback.
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > OWNER_CAPTURE_RESULT_MAX_BYTES
  )
    throw new Error("capture exchange target refused");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("capture exchange identity changed");
    const buffer = Buffer.alloc(OWNER_CAPTURE_RESULT_MAX_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      OWNER_CAPTURE_RESULT_MAX_BYTES,
      0,
    );
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      bytesRead !== before.size
    )
      throw new Error("capture exchange identity changed");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/**
 * File-command client for the instrumented host's passive M26 assembly observer. Each command is
 * bound to the current qualification session and host process; results are retained as evidence.
 */
export async function createOwnerCapture(apparatus: string, evidence: string) {
  await mkdir(evidence, { recursive: true });
  const session = JSON.parse(
    await readFile(resolve(apparatus, "qualification-session.json"), "utf8"),
  );
  let captureSequence = 0;
  return async (
    operation: OwnerCaptureOperation,
    projection?: ProductionWorkbenchProjection,
  ) => {
    const sequence = ++captureSequence;
    if (sequence > 64) throw new Error("capture command limit exceeded");
    const command = {
      schema: "M26OwnerCaptureCommandV2",
      nonce: randomBytes(16).toString("hex"),
      session: session.sessionId,
      sequence,
      operation,
      workspaceHandle: projection?.workspaceHandle ?? null,
      workspaceId: projection?.workspaceId ?? null,
      expectedWorkspaceRevision: projection?.workspaceRevision ?? null,
      expectedWorkspaceFingerprint: projection?.workspaceFingerprint ?? null,
      assemblyJobId: projection?.assembly.assemblyJobId ?? null,
    };
    // CRITICAL: Windows cannot replace a target another peer holds open. Each
    // nonce owns new command/result names; keep every prior exchange as evidence.
    const suffix = `${sequence}.${command.nonce}`;
    const pending = resolve(apparatus, `m26-capture-command.${suffix}.pending`);
    const published = resolve(apparatus, `m26-capture-command.${suffix}.json`);
    const resultPath = resolve(apparatus, `m26-capture-result.${suffix}.json`);
    const raw = JSON.stringify(command);
    if (Buffer.byteLength(raw) > 4096)
      throw new Error("capture command too large");
    await writeFile(pending, raw, { flag: "wx" });
    await absentCaptureFile(published);
    await rename(pending, published);
    let result: Record<string, any> | undefined;
    await expect
      .poll(
        async () => {
          result = await readCaptureResult(resultPath).catch(() => undefined);
          return (
            // A fresh helper restarts sequence at 1: only this command's nonce can
            // admit its result, including a previous closure's delayed acknowledgement.
            result?.schema === "M26OwnerCaptureResultV2" &&
            result?.nonce === command.nonce &&
            result?.session === command.session &&
            result?.sequence === sequence &&
            result?.operation === operation
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(result!.schema).toBe("M26OwnerCaptureResultV2");
    expect(result!.hostPid).toBe(session.hostPid);
    expect(result!.hostCreateTime).toBe(session.hostCreateTime);
    await writeFile(
      resolve(evidence, `owner-${sequence}-${operation}-${command.nonce}.json`),
      JSON.stringify(result, null, 2),
      { flag: "wx" },
    );
    expect(result!.status, JSON.stringify(result)).toBe("pass");
    return result!;
  };
}
