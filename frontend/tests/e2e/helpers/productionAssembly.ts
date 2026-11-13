import { expect, type Locator } from "@playwright/test";

const assemblyDiagnosticStates = new Set([
  "unavailable",
  "planned",
  "running",
  "cancelling",
  "succeeded",
  "failed",
]);
const assemblyDiagnosticCodes = new Set([
  "media_runtime_not_authorized",
  "predecessor_not_ready",
  "cancelled",
  "assembly_worker_unavailable",
  "assembly_runtime_invalid",
  "assembly_profile_unavailable",
  "assembly_clock_failed",
  "assembly_authorization_stale",
  "assembly_geometry_mismatch",
  "assembly_predecessor_type",
  "assembly_source_factory_invalid",
  "assembly_non_integer_duration",
  "assembly_derived_input_failed",
  "assembly_original_descriptor_mismatch",
  "assembly_derived_descriptor_mismatch",
  "assembly_execution_failed",
  "assembly_cleanup_failed",
  "assembly_publication_mismatch",
  "assembly_publication_stale",
  "assembly_publication_busy",
  "workspace_capacity",
]);

export function productionAssemblyObservation(
  assembly: Readonly<{ state: unknown; failureCode: unknown }> | undefined,
): Readonly<{ state: string; failureCode: string | null }> {
  if (assembly === undefined)
    return { state: "not_observed", failureCode: null };
  // IMPORTANT: decoded codes are not a finite enum. Copy only these literals;
  // spreading the projection or passing identifier-shaped text can leak private data.
  return {
    state:
      typeof assembly.state === "string" &&
      assemblyDiagnosticStates.has(assembly.state)
        ? assembly.state
        : "unrecognized",
    failureCode:
      assembly.failureCode === null
        ? null
        : typeof assembly.failureCode === "string" &&
            assemblyDiagnosticCodes.has(assembly.failureCode)
          ? assembly.failureCode
          : "unrecognized",
  };
}

const minimumRefreshCycleMilliseconds = 100;

export async function refreshProductionAssembly(
  sequence: Locator,
  timeout: number,
): Promise<void> {
  const deadline = performance.now() + timeout;
  const remaining = () => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds <= 0) throw new Error("assembly_wait_timeout");
    return milliseconds;
  };
  const assembly = sequence.locator("[data-h3-nle-assembly-state]");
  const refresh = sequence.locator(
    '[data-h3-nle-control="production.refresh"]',
  );
  // IMPORTANT: assembly runs asynchronously; waiting on the old DOM before
  // refreshing never observes completion. Every nested wait shares one deadline.
  let firstCycle = true;
  for (;;) {
    // IMPORTANT: a later cycle started with only a few milliseconds left ends in
    // Playwright's own click timeout, which hides this helper's deadline code.
    // Below the floor no new cycle starts. The first cycle always runs, so a
    // control that never becomes actionable still surfaces Playwright's error.
    if (
      !firstCycle &&
      deadline - performance.now() < minimumRefreshCycleMilliseconds
    )
      throw new Error("assembly_wait_timeout");
    firstCycle = false;
    await refresh.click({ timeout: remaining() });
    // Production renders pending before transport; await its settled UI before
    // another refresh. The host journey separately checks HTTP/decode failures.
    await expect(refresh).toBeEnabled({ timeout: remaining() });
    const state = await assembly.getAttribute("data-h3-nle-assembly-state", {
      timeout: remaining(),
    });
    if (state === "failed") throw new Error("assembly_terminal_failed");
    if (state === "succeeded") {
      await expect(assembly).toHaveAttribute(
        "data-h3-nle-assembly-state",
        "succeeded",
        { timeout: remaining() },
      );
      return;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(500, remaining())),
    );
  }
}
