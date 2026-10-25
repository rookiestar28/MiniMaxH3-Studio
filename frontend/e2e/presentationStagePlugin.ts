import type { Plugin } from "vite";

// Instrument served E2E modules only. The shipped sources and bundle stay byte-identical.
// Exact unique anchors fail closed on drift instead of silently measuring a different stage.
export function instrumentPresentationStages(
  source: string,
  id: string,
): string | null {
  const path = id.replaceAll("\\", "/");
  let replacements: Array<readonly [string, string]>;
  if (path.endsWith("/src/runtime/visualCompositionSession.ts")) {
    replacements = [
      [
        "function requestMove(frame: number, pauseBefore: boolean) {",
        'function requestMove(frame: number, pauseBefore: boolean) {\n    window.__nleStageTrace?.mark("seek-request");',
      ],
      [
        "const receipt = await ownRuntime.seek(frame);",
        'window.__nleStageTrace?.mark("runtime-seek");\n    const receipt = await ownRuntime.seek(frame);',
      ],
      [
        "const paintStarted = performance.now();",
        'const stageToken = window.__nleStageTrace?.mark("paint-start");\n    const paintStarted = performance.now();',
      ],
      [
        "const paintDuration = performance.now() - paintStarted;",
        'const paintDuration = performance.now() - paintStarted;\n    if (stageToken) window.__nleStageTrace?.mark("paint-end", stageToken);',
      ],
      [
        "presentationFrames.delete(handle);",
        'presentationFrames.delete(handle);\n        if (stageToken) window.__nleStageTrace?.mark("delivered", stageToken);',
      ],
    ];
  } else if (path.endsWith("/src/runtime/editorRuntime.ts")) {
    replacements = [
      [
        "const pending = this.waitForPresentation(",
        "if (this.sourceOwner.element instanceof HTMLVideoElement) window.__nleStageTrace?.observeVideo(this.sourceOwner.element);\n    const pending = this.waitForPresentation(",
      ],
      [
        "): Promise<NativeFrameObservation> {\n    const element = this.sourceOwner.element;",
        "): Promise<NativeFrameObservation> {\n    const nativeStageToken = window.__nleStageTrace?.capture();\n    const element = this.sourceOwner.element;",
      ],
      [
        "(_now, metadata) => {\n              frameRequest = undefined;",
        '(_now, metadata) => {\n              if (nativeStageToken) window.__nleStageTrace?.mark("native-frame", nativeStageToken);\n              frameRequest = undefined;',
      ],
    ];
  } else return null;
  // CRITICAL: Hosted Windows checkouts use CRLF. Bare \n anchors drift there,
  // breaking every journey that loads editorRuntime. Keep matching and injected
  // text line-ending neutral without changing the instrumented output's line count.
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  for (const [lfAnchor, lfReplacement] of replacements) {
    const anchor = lfAnchor.replaceAll("\n", lineEnding);
    const replacement = lfReplacement.replaceAll("\n", lineEnding);
    if (source.split(anchor).length !== 2)
      throw new Error("presentation stage anchor drift");
    source = source.replace(anchor, replacement);
  }
  return source;
}

export function presentationStagePlugin(): Plugin {
  return {
    name: "h3-context-e2e-presentation-stages",
    enforce: "pre",
    transform(source, id) {
      return instrumentPresentationStages(source, id);
    },
  };
}
