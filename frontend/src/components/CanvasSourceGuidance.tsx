import type { AppModeTaskMode } from "../host/appMode";
import type { sidebarCopy } from "../i18n/catalog";
import type { ShellState } from "../state/shellState";

type Copy = ReturnType<typeof sidebarCopy>;

export function requiredFrameSourceBlocker(
  mode: AppModeTaskMode,
  first: string,
  last: string,
  text: Copy["sourceBlockers"],
): string | null {
  // IMPORTANT: preparation may omit frames, but managed non-preparation starts
  // must have them because validateInputs rejects missing or equal frame roles.
  if ((mode === "i2va" || mode === "fl2va") && first === "")
    return text.firstFrame;
  if ((mode === "l2va" || mode === "fl2va") && last === "")
    return text.lastFrame;
  return mode === "fl2va" && first === last ? text.distinctFrames : null;
}

export function frameSourceGuidance(
  mode: AppModeTaskMode,
  count: number,
  text: Copy["sourceGuidance"],
): string | undefined {
  if (mode === "fl2va" && count < 2)
    return text.needTwoImages.replace("{count}", String(count));
  if ((mode === "i2va" || mode === "l2va") && count === 0) return text.noImage;
  return undefined;
}

export function PreparedSourceGuidance({
  state,
  text,
}: {
  state: ShellState;
  text: Copy;
}) {
  if (
    state.status !== "interactive" ||
    !state.preparedGraphFingerprint ||
    !state.unchosenSourceRoles?.length
  )
    return null;
  const roles = state.unchosenSourceRoles
    .map((role) => text.sourceGuidance.roles[role])
    .join(text.sourceGuidance.roleSeparator);
  const copy = state.unchosenSourceRoles.includes("referenceImages")
    ? text.sourceGuidance.readyReferences
    : text.sourceGuidance.readyFrames;
  return (
    <p
      className="h3-reference-guidance"
      data-h3-prepared-source-guidance
      role="status"
    >
      {copy
        .replace("{roles}", roles)
        .replace("{queue}", text.queueCurrentGraph)}
    </p>
  );
}
