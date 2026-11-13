import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as candidateHarness from "./e2e/helpers/candidateBundleHarness";
import {
  CANDIDATE_BACKEND_HOST_ROOT_ENV,
  CANDIDATE_BUNDLE_PATH_ENV,
  CANDIDATE_BUNDLE_SHA256_ENV,
  CandidateInitiatorNetworkAttribution,
  H3NetworkAttribution,
  MAX_CANDIDATE_BUNDLE_BYTES,
  loadCandidateBundleEnvironment,
  verifyCandidateBackendRuntimeEnvironment,
} from "./e2e/helpers/candidateBundleHarness";

const temporaryRoots: string[] = [];
// IMPORTANT: these fixtures run from frontend; jsdom rewrites import.meta.url away from file:.
// Keep the existing repository-fixture cwd convention so collection can reach the shipped bytes.
const shippedRepositoryRoot = resolve(process.cwd(), "..");

function shippedBundleEntry() {
  const manifest = JSON.parse(
    readFileSync(
      join(shippedRepositoryRoot, "governance/contracts/supply_chain_v1.json"),
      "utf8",
    ),
  ) as {
    runtime_entries: Array<{ path: string; size: number; sha256: string }>;
  };
  const entry = manifest.runtime_entries.find(
    (row) => row.path === "comfyui_h3_context/web/h3-context-sidebar.js",
  );
  if (entry === undefined)
    throw new Error("shipped bundle manifest entry missing");
  return entry;
}

const PACKAGED_FONT_FIXTURES = Object.freeze({
  "NotoSans-Regular.ttf": Buffer.from("synthetic regular font bytes\n"),
  "NotoSans-Bold.ttf": Buffer.from("synthetic bold font bytes\n"),
  "NotoSans-Italic.ttf": Buffer.from("synthetic italic font bytes\n"),
  "NotoSans-BoldItalic.ttf": Buffer.from("synthetic bold italic font bytes\n"),
  "LICENSE-OFL-1.1.txt": Buffer.from("synthetic OFL license text\n"),
  "LICENSE-NotoSansCJK-OFL-1.1.txt": Buffer.from("synthetic Adobe OFL\n"),
  "NotoSansTC-Regular.otf": Buffer.from("synthetic TC Regular font\n"),
  "NotoSansTC-Bold.otf": Buffer.from("synthetic TC Bold font\n"),
  "NotoSansSC-Regular.otf": Buffer.from("synthetic SC Regular font\n"),
  "NotoSansSC-Bold.otf": Buffer.from("synthetic SC Bold font\n"),
  "NotoSansJP-Regular.otf": Buffer.from("synthetic JP Regular font\n"),
  "NotoSansJP-Bold.otf": Buffer.from("synthetic JP Bold font\n"),
  "NotoSansKR-Regular.otf": Buffer.from("synthetic KR Regular font\n"),
  "NotoSansKR-Bold.otf": Buffer.from("synthetic KR Bold font\n"),
});

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "h3-candidate-bundle-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "frontend"));
  return root;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function backendRuntimeFixture(): {
  repositoryRoot: string;
  hostRoot: string;
  installedPackageRoot: string;
} {
  const repositoryRoot = temporaryRepository();
  const hostRoot = join(repositoryRoot, "explicit-host");
  const candidatePackageRoot = join(repositoryRoot, "comfyui_h3_context");
  const installedPackageRoot = join(
    hostRoot,
    "custom_nodes",
    "ComfyUI-MiniMaxH3-Context",
    "comfyui_h3_context",
  );
  for (const packageRoot of [candidatePackageRoot, installedPackageRoot]) {
    mkdirSync(join(packageRoot, "core"), { recursive: true });
    mkdirSync(join(packageRoot, "contracts"), { recursive: true });
    mkdirSync(join(packageRoot, "fonts"), { recursive: true });
    writeFileSync(join(packageRoot, "__init__.py"), "# exact runtime\n");
    writeFileSync(
      join(packageRoot, "core", "product_shell.py"),
      "SUPPORTED_CORE_VERSION = '0.32.0'\n",
    );
    writeFileSync(
      join(packageRoot, "contracts", "identity.json"),
      '{"schema":"h3.test"}\n',
    );
    for (const [filename, bytes] of Object.entries(PACKAGED_FONT_FIXTURES))
      writeFileSync(join(packageRoot, "fonts", filename), bytes);
  }
  return { repositoryRoot, hostRoot, installedPackageRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("candidate bundle environment", () => {
  it("keeps an entirely absent binding as an explicit non-acceptance mode", () => {
    expect(
      loadCandidateBundleEnvironment({
        repositoryRoot: temporaryRepository(),
        environment: {},
      }),
    ).toBeNull();
  });

  it.each([
    [CANDIDATE_BUNDLE_PATH_ENV, "frontend/candidate.js"],
    [CANDIDATE_BUNDLE_SHA256_ENV, "0".repeat(64)],
  ])("rejects a partial binding with only %s", (key, value) => {
    expect(() =>
      loadCandidateBundleEnvironment({
        repositoryRoot: temporaryRepository(),
        environment: { [key]: value },
      }),
    ).toThrow(/must be provided together/);
  });

  it("loads only exact regular repo-owned bytes", () => {
    const repositoryRoot = temporaryRepository();
    const bytes = Buffer.from("export const candidate = true;\n");
    writeFileSync(join(repositoryRoot, "frontend", "candidate.js"), bytes);

    const candidate = loadCandidateBundleEnvironment({
      repositoryRoot,
      environment: {
        [CANDIDATE_BUNDLE_PATH_ENV]: "frontend/candidate.js",
        [CANDIDATE_BUNDLE_SHA256_ENV]: digest(bytes),
      },
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sha256).toBe(digest(bytes));
    expect(candidate?.bytes).toEqual(bytes);
    expect(candidate).not.toHaveProperty("path");
  });

  it("rejects malformed and mismatched digests", () => {
    const repositoryRoot = temporaryRepository();
    const bytes = Buffer.from("export {};\n");
    writeFileSync(join(repositoryRoot, "frontend", "candidate.js"), bytes);
    const load = (sha256: string) =>
      loadCandidateBundleEnvironment({
        repositoryRoot,
        environment: {
          [CANDIDATE_BUNDLE_PATH_ENV]: "frontend/candidate.js",
          [CANDIDATE_BUNDLE_SHA256_ENV]: sha256,
        },
      });

    expect(() => load("ABC")).toThrow(/lowercase SHA-256/);
    expect(() => load("0".repeat(64))).toThrow(/hash mismatch/);
  });

  it("admits the integrated runtime size and rejects bytes above the bounded envelope", () => {
    const repositoryRoot = temporaryRepository();
    const load = (size: number) => {
      const bytes = Buffer.alloc(size, 32);
      writeFileSync(join(repositoryRoot, "frontend", "candidate.js"), bytes);
      return loadCandidateBundleEnvironment({
        repositoryRoot,
        environment: {
          [CANDIDATE_BUNDLE_PATH_ENV]: "frontend/candidate.js",
          [CANDIDATE_BUNDLE_SHA256_ENV]: digest(bytes),
        },
      });
    };
    expect(load(MAX_CANDIDATE_BUNDLE_BYTES)?.bytes.length).toBe(
      MAX_CANDIDATE_BUNDLE_BYTES,
    );
    expect(() => load(MAX_CANDIDATE_BUNDLE_BYTES + 1)).toThrow(
      /outside the accepted bound/,
    );
    expect(() => load(0)).toThrow(/outside the accepted bound/);
  });

  it("admits the exact manifest-bound current runtime bundle", () => {
    const entry = shippedBundleEntry();
    const bytes = readFileSync(join(shippedRepositoryRoot, entry.path));
    expect(bytes.length).toBe(entry.size);
    const candidate = loadCandidateBundleEnvironment({
      repositoryRoot: shippedRepositoryRoot,
      environment: {
        [CANDIDATE_BUNDLE_PATH_ENV]: entry.path,
        [CANDIDATE_BUNDLE_SHA256_ENV]: entry.sha256.replace(/^sha256:/, ""),
      },
    });
    expect(candidate?.bytes).toEqual(bytes);
    expect(candidate?.sha256).toBe(entry.sha256.replace(/^sha256:/, ""));
  });

  it("keeps the shipped runtime within the candidate admission cap", () => {
    const entry = shippedBundleEntry();
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.size).toBeLessThanOrEqual(MAX_CANDIDATE_BUNDLE_BYTES);
  });

  it("rejects outside-repository and non-regular targets", () => {
    const repositoryRoot = temporaryRepository();
    const outside = join(repositoryRoot, "..", "outside-candidate.js");
    writeFileSync(outside, "export {};\n");
    temporaryRoots.push(outside);
    const outsideHash = digest(Buffer.from("export {};\n"));

    expect(() =>
      loadCandidateBundleEnvironment({
        repositoryRoot,
        environment: {
          [CANDIDATE_BUNDLE_PATH_ENV]: outside,
          [CANDIDATE_BUNDLE_SHA256_ENV]: outsideHash,
        },
      }),
    ).toThrow(/inside the repository/);
    expect(() =>
      loadCandidateBundleEnvironment({
        repositoryRoot,
        environment: {
          [CANDIDATE_BUNDLE_PATH_ENV]: "frontend",
          [CANDIDATE_BUNDLE_SHA256_ENV]: outsideHash,
        },
      }),
    ).toThrow(/regular file/);
  });

  it("rejects a missing repo-relative candidate", () => {
    expect(() =>
      loadCandidateBundleEnvironment({
        repositoryRoot: temporaryRepository(),
        environment: {
          [CANDIDATE_BUNDLE_PATH_ENV]: "frontend/missing.js",
          [CANDIDATE_BUNDLE_SHA256_ENV]: "0".repeat(64),
        },
      }),
    ).toThrow();
  });

  it("rejects a symlink or junction in the candidate path", (context) => {
    const repositoryRoot = temporaryRepository();
    const target = join(repositoryRoot, "target");
    const link = join(repositoryRoot, "frontend", "linked");
    mkdirSync(target);
    const bytes = Buffer.from("export {};\n");
    writeFileSync(join(target, "candidate.js"), bytes);
    try {
      symlinkSync(target, link, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip();
        return;
      }
      throw error;
    }

    expect(() =>
      loadCandidateBundleEnvironment({
        repositoryRoot,
        environment: {
          [CANDIDATE_BUNDLE_PATH_ENV]: "frontend/linked/candidate.js",
          [CANDIDATE_BUNDLE_SHA256_ENV]: digest(bytes),
        },
      }),
    ).toThrow(/symbolic link/);
  });
});

describe("candidate backend runtime identity", () => {
  it("admits large pinned font paths while retaining ordinary and font byte limits", () => {
    const fixture = backendRuntimeFixture();
    const candidateRoot = join(fixture.repositoryRoot, "comfyui_h3_context");
    const verify = () =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: fixture.repositoryRoot,
        environment: { [CANDIDATE_BACKEND_HOST_ROOT_ENV]: fixture.hostRoot },
      });
    for (const root of [candidateRoot, fixture.installedPackageRoot])
      writeFileSync(
        join(root, "fonts", "NotoSansSC-Bold.otf"),
        Buffer.alloc(8_543_168),
      );
    expect(verify().status).toBe("exact");
    writeFileSync(
      join(fixture.installedPackageRoot, "fonts", "NotoSansSC-Bold.otf"),
      Buffer.alloc(12 * 1_048_576 + 1),
    );
    expect(verify).toThrow(/installed_runtime_unsafe/);
    writeFileSync(
      join(candidateRoot, "fonts", "NotoSansSC-Bold.otf"),
      Buffer.alloc(12 * 1_048_576 + 1),
    );
    expect(verify).toThrow(/candidate_inventory_unsafe/);
    writeFileSync(
      join(candidateRoot, "fonts", "NotoSansSC-Bold.otf"),
      Buffer.alloc(8_543_168),
    );
    writeFileSync(
      join(candidateRoot, "core", "product_shell.py"),
      Buffer.alloc(1_048_576 + 1),
    );
    expect(verify).toThrow(/candidate_inventory_unsafe/);
  });

  it("accepts only the exact bounded candidate-owned backend inventory", () => {
    const fixture = backendRuntimeFixture();
    const receipt = verifyCandidateBackendRuntimeEnvironment({
      repositoryRoot: fixture.repositoryRoot,
      environment: {
        [CANDIDATE_BACKEND_HOST_ROOT_ENV]: fixture.hostRoot,
      },
    });

    expect(receipt).toMatchObject({
      status: "exact",
      candidateFileCount: 17,
      matchedFileCount: 17,
      missingFileCount: 0,
      staleFileCount: 0,
    });
    expect(receipt.inventorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt).not.toHaveProperty("path");
    expect(JSON.stringify(receipt)).not.toContain(fixture.hostRoot);
  });

  it("reports only closed counts and a mismatch class for stale or partial bytes", () => {
    const stale = backendRuntimeFixture();
    writeFileSync(
      join(stale.installedPackageRoot, "core", "product_shell.py"),
      "SUPPORTED_CORE_VERSION = '0.30.0'\n",
    );
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: stale.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: stale.hostRoot,
        },
      }),
    ).toThrow(/stale_bytes.*expected=17.*matched=16.*missing=0.*stale=1/);

    const partial = backendRuntimeFixture();
    rmSync(join(partial.installedPackageRoot, "contracts", "identity.json"));
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: partial.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: partial.hostRoot,
        },
      }),
    ).toThrow(/missing_bytes.*expected=17.*matched=16.*missing=1.*stale=0/);
  });

  it("requires exact packaged font and license bytes in the installed runtime", () => {
    const missing = backendRuntimeFixture();
    rmSync(join(missing.installedPackageRoot, "fonts", "NotoSans-Regular.ttf"));
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: missing.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: missing.hostRoot,
        },
      }),
    ).toThrow(/missing_bytes.*expected=17.*matched=16.*missing=1.*stale=0/);

    const stale = backendRuntimeFixture();
    writeFileSync(
      join(stale.installedPackageRoot, "fonts", "LICENSE-OFL-1.1.txt"),
      "different license bytes\n",
    );
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: stale.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: stale.hostRoot,
        },
      }),
    ).toThrow(/stale_bytes.*expected=17.*matched=16.*missing=0.*stale=1/);
  });

  it("rejects packaged font symlinks", (context) => {
    const linked = backendRuntimeFixture();
    const fontRoot = join(linked.repositoryRoot, "comfyui_h3_context", "fonts");
    const targetRoot = join(linked.repositoryRoot, "font-target");
    rmSync(fontRoot, { force: true, recursive: true });
    mkdirSync(targetRoot);
    for (const [filename, bytes] of Object.entries(PACKAGED_FONT_FIXTURES))
      writeFileSync(join(targetRoot, filename), bytes);
    try {
      symlinkSync(targetRoot, fontRoot, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip();
        return;
      }
      throw error;
    }

    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: linked.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: linked.hostRoot,
        },
      }),
    ).toThrow(/candidate_inventory_unsafe/);
  });

  it.each(["NotoSans-Medium.ttf", "README.txt"])(
    "rejects an unlisted fonts/%s candidate file",
    (filename) => {
      const unknown = backendRuntimeFixture();
      writeFileSync(
        join(unknown.repositoryRoot, "comfyui_h3_context", "fonts", filename),
        "unlisted packaged data\n",
      );
      expect(() =>
        verifyCandidateBackendRuntimeEnvironment({
          repositoryRoot: unknown.repositoryRoot,
          environment: {
            [CANDIDATE_BACKEND_HOST_ROOT_ENV]: unknown.hostRoot,
          },
        }),
      ).toThrow(/candidate_inventory_unsafe/);
    },
  );

  it("rejects absent roots and candidate symlink traversal", (context) => {
    const absent = backendRuntimeFixture();
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: absent.repositoryRoot,
        environment: {},
      }),
    ).toThrow(/explicit host root is required/);

    const linked = backendRuntimeFixture();
    const target = join(linked.repositoryRoot, "linked-runtime-target");
    mkdirSync(target);
    writeFileSync(join(target, "linked.py"), "# outside fixed inventory\n");
    try {
      symlinkSync(
        target,
        join(linked.repositoryRoot, "comfyui_h3_context", "linked"),
        "junction",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip();
        return;
      }
      throw error;
    }
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: linked.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: linked.hostRoot,
        },
      }),
    ).toThrow(/candidate_inventory_unsafe/);
  });

  it("rejects an installed junction", (context) => {
    const linked = backendRuntimeFixture();
    const installedPackage = join(
      linked.hostRoot,
      "custom_nodes",
      "ComfyUI-MiniMaxH3-Context",
      "comfyui_h3_context",
    );
    const installedTarget = join(linked.repositoryRoot, "installed-target");
    rmSync(installedPackage, { force: true, recursive: true });
    mkdirSync(installedTarget);
    try {
      symlinkSync(installedTarget, installedPackage, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip();
        return;
      }
      throw error;
    }
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: linked.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: linked.hostRoot,
        },
      }),
    ).toThrow(/installed_runtime_unsafe/);
  });

  it("rejects a candidate inventory above its fixed bound", () => {
    const unbounded = backendRuntimeFixture();
    const generated = join(
      unbounded.repositoryRoot,
      "comfyui_h3_context",
      "generated",
    );
    mkdirSync(generated);
    for (let index = 0; index < 510; index += 1)
      writeFileSync(
        join(generated, `runtime_${String(index)}.py`),
        "# bounded\n",
      );
    expect(() =>
      verifyCandidateBackendRuntimeEnvironment({
        repositoryRoot: unbounded.repositoryRoot,
        environment: {
          [CANDIDATE_BACKEND_HOST_ROOT_ENV]: unbounded.hostRoot,
        },
      }),
    ).toThrow(/candidate_inventory_unsafe/);
  });
});

describe("H3 interaction network attribution", () => {
  it("separates anonymous startup diagnostics from resettable H3 phases", () => {
    const attribution = new H3NetworkAttribution("http://127.0.0.1:8188");
    attribution.observeRequest("https://startup.invalid/font.woff2");
    attribution.observeRequest("http://127.0.0.1:8188/api/chat");
    expect(attribution.snapshot()).toEqual({
      startupRemoteCount: 1,
      interactionRemoteCount: 0,
      interactionProviderCount: 0,
    });

    attribution.beginH3InteractionPhase();
    attribution.observeRequest("http://127.0.0.1:8188/api/view");
    attribution.observeRequest("https://interaction.invalid/asset.js");
    attribution.observeRequest("http://127.0.0.1:8188/api/generate");
    expect(attribution.snapshot()).toEqual({
      startupRemoteCount: 1,
      interactionRemoteCount: 1,
      interactionProviderCount: 1,
    });

    attribution.pauseForHostInitialization();
    attribution.observeRequest("https://reload.invalid/asset.js");
    attribution.beginH3InteractionPhase();
    expect(attribution.snapshot()).toEqual({
      startupRemoteCount: 2,
      interactionRemoteCount: 0,
      interactionProviderCount: 0,
    });
  });

  it("requires a bounded quiet window before starting H3 attribution", async () => {
    const waitForStartupNetworkQuiet = (
      candidateHarness as unknown as {
        waitForStartupNetworkQuiet?: (
          attribution: H3NetworkAttribution,
          wait: (milliseconds: number) => Promise<void>,
          options: {
            quietWindowMs: number;
            pollIntervalMs: number;
            timeoutMs: number;
          },
        ) => Promise<void>;
      }
    ).waitForStartupNetworkQuiet;
    expect(waitForStartupNetworkQuiet).toBeTypeOf("function");
    if (waitForStartupNetworkQuiet === undefined) return;

    const attribution = new H3NetworkAttribution("http://127.0.0.1:8188");
    attribution.observeRequest("https://startup.invalid/first.js");
    let polls = 0;
    await waitForStartupNetworkQuiet(
      attribution,
      async () => {
        polls += 1;
        if (polls === 2)
          attribution.observeRequest("https://startup.invalid/late.js");
      },
      { quietWindowMs: 20, pollIntervalMs: 10, timeoutMs: 60 },
    );

    expect(polls).toBe(4);
    expect(attribution.snapshot().startupRemoteCount).toBe(2);
  });

  it("uses the live-proven five-second quiet default without sleeping in unit tests", async () => {
    const attribution = new H3NetworkAttribution("http://127.0.0.1:8188");
    let elapsedMs = 0;
    await candidateHarness.waitForStartupNetworkQuiet(
      attribution,
      async (milliseconds) => {
        elapsedMs += milliseconds;
      },
    );
    expect(elapsedMs).toBe(5_000);
  });
});

describe("candidate initiator network attribution", () => {
  const hostOrigin = "http://127.0.0.1:8188";
  const candidateUrl = `${hostOrigin}/extensions/ComfyUI-MiniMaxH3-Context/h3-context-sidebar.js`;
  const frame = (url: string) => ({ url });
  const event = (
    requestUrl: string,
    stack?: Record<string, unknown>,
  ): Record<string, unknown> => ({
    request: { url: requestUrl },
    initiator:
      stack === undefined ? { type: "other" } : { type: "script", stack },
  });

  it("attributes only exact candidate frames across nested async parents", () => {
    const attribution = new CandidateInitiatorNetworkAttribution(
      hostOrigin,
      candidateUrl,
    );
    attribution.beginH3InteractionPhase();
    attribution.observeRequestWillBeSent(
      event("https://remote.invalid/asset.js", {
        callFrames: [frame(candidateUrl)],
        parentId: { id: "irrelevant-after-exact-match" },
      }),
    );
    attribution.observeRequestWillBeSent(
      event(`${hostOrigin}/api/view`, {
        callFrames: [frame(candidateUrl)],
      }),
    );
    attribution.observeRequestWillBeSent(
      event(`${hostOrigin}/api/generate`, {
        callFrames: [frame(candidateUrl)],
      }),
    );
    attribution.observeRequestWillBeSent(
      event("https://nested.invalid/asset.js", {
        callFrames: [frame(`${hostOrigin}/scripts/app.js`)],
        parent: {
          callFrames: [frame(candidateUrl)],
        },
      }),
    );
    attribution.observeRequestWillBeSent(
      event("https://unrelated.invalid/asset.js", {
        callFrames: [frame(`${hostOrigin}/extensions/unrelated.js`)],
      }),
    );

    expect(attribution.snapshot()).toEqual({
      candidateInteractionRemoteCount: 2,
      candidateInteractionProviderCount: 1,
    });
  });

  it("resets candidate counters and ignores paused requests", () => {
    const attribution = new CandidateInitiatorNetworkAttribution(
      hostOrigin,
      candidateUrl,
    );
    const remoteCandidateEvent = event("https://remote.invalid/asset.js", {
      callFrames: [frame(candidateUrl)],
    });
    attribution.beginH3InteractionPhase();
    attribution.observeRequestWillBeSent(remoteCandidateEvent);
    expect(attribution.snapshot().candidateInteractionRemoteCount).toBe(1);
    attribution.pauseForHostInitialization();
    attribution.observeRequestWillBeSent(remoteCandidateEvent);
    attribution.beginH3InteractionPhase();
    expect(attribution.snapshot()).toEqual({
      candidateInteractionRemoteCount: 0,
      candidateInteractionProviderCount: 0,
    });
  });

  it("fails closed on malformed or ambiguous CDP identity", () => {
    const malformedUrl = new CandidateInitiatorNetworkAttribution(
      hostOrigin,
      candidateUrl,
    );
    malformedUrl.beginH3InteractionPhase();
    malformedUrl.observeRequestWillBeSent(
      event("not a URL", { callFrames: [frame(candidateUrl)] }),
    );
    expect(() => malformedUrl.snapshot()).toThrow(
      "candidate network attribution unavailable",
    );

    const malformedStack = new CandidateInitiatorNetworkAttribution(
      hostOrigin,
      candidateUrl,
    );
    malformedStack.beginH3InteractionPhase();
    malformedStack.observeRequestWillBeSent(
      event("https://remote.invalid/asset.js", { callFrames: "invalid" }),
    );
    expect(() => malformedStack.snapshot()).toThrow(
      "candidate network attribution unavailable",
    );

    const unresolvedAsyncParent = new CandidateInitiatorNetworkAttribution(
      hostOrigin,
      candidateUrl,
    );
    unresolvedAsyncParent.beginH3InteractionPhase();
    unresolvedAsyncParent.observeRequestWillBeSent(
      event("https://remote.invalid/asset.js", {
        callFrames: [frame(`${hostOrigin}/scripts/app.js`)],
        parentId: { id: "unresolved", debuggerId: "unresolved" },
      }),
    );
    expect(() => unresolvedAsyncParent.snapshot()).toThrow(
      "candidate network attribution unavailable",
    );

    expect(
      () =>
        new CandidateInitiatorNetworkAttribution(
          hostOrigin,
          "https://ambiguous.invalid/h3-context-sidebar.js",
        ),
    ).toThrow("candidate network attribution unavailable");
  });

  it("retains only content-free candidate-owned integer counters", () => {
    const attribution = new CandidateInitiatorNetworkAttribution(
      hostOrigin,
      candidateUrl,
    );
    attribution.beginH3InteractionPhase();
    attribution.observeRequestWillBeSent(
      event("https://private.invalid/private-path?secret=value", {
        callFrames: [frame(candidateUrl)],
      }),
    );
    const serialized = JSON.stringify(attribution.snapshot());
    expect(serialized).toBe(
      '{"candidateInteractionRemoteCount":1,"candidateInteractionProviderCount":0}',
    );
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("ComfyUI-MiniMaxH3-Context");
  });
});
