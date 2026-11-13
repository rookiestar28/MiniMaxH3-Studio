import {
  TemplateSpliceError,
  type SpliceOptions,
} from "./templateGraphTopology";

/** Private sequence geometry is selected by the frozen parent mode. */
export function sequenceUsesSourceGeometry(options: SpliceOptions): boolean {
  const mode = options.sequenceTaskMode;
  const donor = options.media?.geometryDonor;
  const refuse = (): never => {
    throw new TemplateSpliceError(
      "invalid_sequence_geometry",
      "invalid_sequence_geometry",
    );
  };
  if (mode === undefined) {
    if (donor !== undefined) return refuse();
    return options.taskMode === "i2va";
  }
  const children: Record<string, readonly string[]> = {
    i2va: ["i2va", "t2va"],
    l2va: ["t2va", "l2va"],
    fl2va: ["i2va", "t2va", "l2va", "fl2va"],
  };
  if (options.connect || !children[mode]?.includes(options.taskMode))
    return refuse();
  if (
    donor !== undefined &&
    (mode !== "i2va" ||
      options.taskMode !== "t2va" ||
      donor.type !== "LoadImage")
  )
    return refuse();
  if (mode === "i2va" && options.taskMode === "t2va" && donor === undefined)
    return refuse();
  // CRITICAL: a FL2VA opening child is I2VA only for role dispatch. Sizing by that
  // child mode changes the parent's template canvas and breaks single-clip parity.
  return mode === "i2va";
}
