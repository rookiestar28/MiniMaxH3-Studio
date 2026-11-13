import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { resolveTitleFont } from "../src/components/nle/nleTitleCoverage";

describe("packaged regional title decisions", () => {
  it("matches the real backend cmap decisions, weights, refusals and layout scalars", () => {
    const root = resolve(process.cwd(), "..");
    const python = join(
      root,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const rows = [
      "Latin Ω Привет",
      "繁體中文",
      "汉语",
      "日本語かな",
      "한국어",
      "かな한국어",
      "漢字\t\n",
      "😀",
      "中文😀",
      "",
      "\uff76\uff85",
      "\u1100\u1161",
    ].flatMap((text) =>
      ([400, 700] as const).flatMap((weight) =>
        (["normal", "italic"] as const).map((style) => ({
          text,
          weight,
          style,
          font_asset_id: "h3.font.noto_sans.v1",
        })),
      ),
    );
    const source = `import json, sys
from comfyui_h3_context.adapters.authoring_fonts import load_packaged_font_manifest, require_text_coverage, AuthoringFontError
manifest=load_packaged_font_manifest()
out=[]
for row in json.load(sys.stdin):
 try:
  face=require_text_coverage(manifest, row['font_asset_id'], row['weight'], row['style'], row['text'])
  out.append({'artifactId': face.artifact_id, 'fontAssetId': face.font_asset_id})
 except AuthoringFontError as error:
  out.append({'reason': error.code})
print(json.dumps(out))`;
    const result = spawnSync(python, ["-c", source], {
      cwd: root,
      input: JSON.stringify(rows),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const backend = JSON.parse(result.stdout);
    expect(
      rows.map(({ text, ...style }) => resolveTitleFont(text, style)),
    ).toEqual(backend);
    expect(resolveTitleFont("日本語かな", rows[0]!)).toMatchObject({
      fontAssetId: "h3.font.noto_sans_jp.v1",
    });
    expect(resolveTitleFont("한국어", rows[0]!)).toMatchObject({
      fontAssetId: "h3.font.noto_sans_kr.v1",
    });
  });
});
