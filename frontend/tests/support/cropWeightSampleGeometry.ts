export type CropWeightPrompt = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

export function assertCropWeightSampleGeometry(
  mode: "ref2va" | "fl2va",
  prompt: CropWeightPrompt,
  selectedWidgets: number,
  chosenFirstImage?: string,
): void {
  try {
    // IMPORTANT: only I2VA derives size from its source scaler. FL2VA uses the
    // canvas ResolutionSelector; treating its unused scaler as size authority rejects valid crops.
    if (selectedWidgets !== (mode === "fl2va" ? 2 : 1))
      throw new Error(
        "crop weight sample has an unexpected resolution widget count",
      );
    const selectors = Object.values(prompt).filter(
      (node) => node.class_type === "ResolutionSelector",
    );
    if (selectors.length !== 1 || selectors[0]!.inputs.megapixels !== 0.2)
      throw new Error("crop weight sample resolution must be 0.2 MP");
    if (mode === "ref2va") return;

    const generators = Object.values(prompt).filter(
      (node) => node.class_type === "MiniMaxH3ImageToVideo",
    );
    if (generators.length !== 1)
      throw new Error("FL2VA requires one image-to-video generator");
    const { width, height } = generators[0]!.inputs;
    if (
      !Array.isArray(width) ||
      width.length !== 2 ||
      typeof width[0] !== "string" ||
      width[1] !== 0 ||
      !Array.isArray(height) ||
      height.length !== 2 ||
      height[0] !== width[0] ||
      height[1] !== 1
    )
      throw new Error(
        "FL2VA generation dimensions must share selector outputs",
      );
    const selector = prompt[width[0]];
    if (selector !== selectors[0])
      throw new Error("FL2VA generation must use the 0.2 MP selector");
    const firstFrame = generators[0]!.inputs.first_frame;
    if (
      !Array.isArray(firstFrame) ||
      firstFrame.length !== 2 ||
      typeof firstFrame[0] !== "string" ||
      firstFrame[1] !== 0 ||
      prompt[firstFrame[0]]?.class_type !== "ImageCropV2"
    )
      throw new Error("FL2VA first frame must use the cropped first frame");
    const source = prompt[firstFrame[0]]!.inputs.image;
    if (
      !Array.isArray(source) ||
      source.length !== 2 ||
      typeof source[0] !== "string" ||
      source[1] !== 0 ||
      prompt[source[0]]?.class_type !== "LoadImage" ||
      chosenFirstImage === undefined ||
      prompt[source[0]]!.inputs.image !== chosenFirstImage
    )
      throw new Error("FL2VA first frame crop must read the chosen LoadImage");
  } catch (error) {
    if (mode === "fl2va" && error instanceof Error)
      throw new Error(
        `${JSON.stringify(geometryFailureFacts(prompt, error.message.startsWith("FL2VA first frame")))}\n${error.message}`,
      );
    throw error;
  }
}

const geometryClasses = new Set([
  "GetImageSize",
  "ImageScaleToTotalPixels",
  "ImageCropV2",
  "LoadImage",
  "ResolutionSelector",
  "MiniMaxH3ImageToVideo",
  "Reroute",
]);

function geometryFailureFacts(prompt: CropWeightPrompt, traceFrame = false) {
  const generator = Object.values(prompt).find(
    (node) => node.class_type === "MiniMaxH3ImageToVideo",
  );
  const key = (link: unknown): string | undefined => {
    if (!Array.isArray(link)) return;
    const id = link[0];
    if (typeof id === "string") return id;
    if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  };
  const linkShape = (link: unknown) => ({
    kind: link === null ? "null" : Array.isArray(link) ? "array" : typeof link,
    length: Array.isArray(link) ? Math.min(link.length, 4) : null,
    idKind: Array.isArray(link) ? typeof link[0] : null,
    slot:
      Array.isArray(link) &&
      Number.isSafeInteger(link[1]) &&
      link[1] >= 0 &&
      link[1] <= 64
        ? link[1]
        : null,
    colon: key(link)?.includes(":") ?? false,
  });
  const nodeFacts = (link: unknown) => {
    const id = key(link);
    const present = id !== undefined && Object.hasOwn(prompt, id);
    const node = present ? prompt[id!] : undefined;
    return {
      keyPresent: present,
      nodeClass:
        node !== undefined && geometryClasses.has(node.class_type)
          ? node.class_type
          : "Other",
      megapixels:
        node !== undefined && Object.hasOwn(node.inputs, "megapixels")
          ? typeof node.inputs.megapixels === "number" &&
            Number.isFinite(node.inputs.megapixels)
            ? node.inputs.megapixels
            : "Other"
          : null,
      link: linkShape(link),
    };
  };
  const width = generator?.inputs.width;
  const height = generator?.inputs.height;
  const hops = [];
  const frame = generator?.inputs.first_frame;
  let link = traceFrame ? frame : width;
  // IMPORTANT: diagnostic traversal is bounded and never emits ids or input text.
  for (let index = 0; index < 3; index++) {
    const facts = nodeFacts(link);
    const id = key(link);
    const node = facts.keyPresent ? prompt[id!] : undefined;
    hops.push({
      ...facts,
      imagePresent: node !== undefined && Object.hasOwn(node.inputs, "image"),
      imageLink: linkShape(node?.inputs.image),
    });
    if (node === undefined) break;
    link = node.inputs.image;
  }
  const compactLink = (shape: ReturnType<typeof linkShape>) => [
    shape.kind,
    shape.length,
    shape.slot,
    shape.colon,
    shape.idKind,
  ];
  const heightNode = nodeFacts(height);
  // The generic host receipt caps each message at 400 characters. Facts go first
  // and use documented tuples so all three hops survive that existing limit.
  return {
    ...(traceFrame ? { f: compactLink(linkShape(frame)) } : {}),
    w: compactLink(linkShape(width)),
    h: compactLink(linkShape(height)),
    hn: [heightNode.keyPresent, heightNode.nodeClass, heightNode.megapixels],
    hops: hops.map((hop) => [
      hop.keyPresent,
      hop.nodeClass,
      hop.megapixels,
      hop.imagePresent,
      compactLink(hop.imageLink),
    ]),
  };
}
