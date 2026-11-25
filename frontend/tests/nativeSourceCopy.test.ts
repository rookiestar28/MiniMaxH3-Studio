import { describe, expect, it } from "vitest";
import {
  PLAIN_REASON_TABLES,
  plainReason,
} from "../src/components/plainReasons";
import { decodeManagedReadiness } from "../src/contracts/managedQualificationCodec";

// The closed reason the producer sends when the loaded native MiniMax H3 source was read and no
// audited lineage admits it. Its copy says the installed nodes are a version this extension
// cannot use for longer videos, and names no file, module or internal state.
//
// CRITICAL: the advice order is part of the contract. The same reason reaches two different users:
// one whose ComfyUI is older than the audited sources (nothing the extension ships can help, the
// host must be updated) and one whose ComfyUI is newer (only a later extension release helps).
// Telling both to wait for an extension update sent the first user to the wrong fix, so the copy
// must name a ComfyUI update first and the extension update second, in every locale.
const CODE = "native_source_structure_unrecognized";
const LOCALES = ["en", "zh-TW", "zh-CN"] as const;
const MESSAGES = {
  en: [/longer videos/iu, /single clip/iu],
  "zh-TW": [/較長影片/u, /單一片段/u],
  "zh-CN": [/较长视频/u, /单个片段/u],
} as const;
const ADVICE_ORDER = {
  en: /Update ComfyUI[\s\S]*update this extension/u,
  "zh-TW": /請更新 ComfyUI[\s\S]*請在此擴充功能推出新版時更新/u,
  "zh-CN": /请更新 ComfyUI[\s\S]*请在此扩展推出新版时更新/u,
} as const;
const INTERNAL =
  /\.py|nodes_minimax|module|lineage|fingerprint|manifest|structure|blob|\bsha\b|hash|ast\b|baseline|registered|模組|模块|指紋|指纹|雜湊|哈希/iu;

function heldReadiness(reason: string) {
  return decodeManagedReadiness({
    schema: "h3.context.managed_readiness.v1",
    request_id: "prepare.readiness",
    status: "held",
    reason,
    qualification_fingerprint: null,
    qualification: null,
  });
}

describe("unrecognized native source copy", () => {
  it.each(LOCALES)("reaches the user as plain copy in %s", (locale) => {
    const readiness = heldReadiness(CODE);
    expect(readiness.status).toBe("held");
    expect(readiness.reason).toBe(CODE);
    expect(
      Object.hasOwn(PLAIN_REASON_TABLES[locale].readiness.codes, CODE),
    ).toBe(true);
    const text = plainReason(locale, "readiness", readiness.reason);
    expect(text).not.toBe(PLAIN_REASON_TABLES[locale].readiness.fallback);
    expect(text).not.toContain(CODE);
    expect(text).not.toMatch(INTERNAL);
    for (const message of MESSAGES[locale]) expect(text).toMatch(message);
  });

  it.each(LOCALES)(
    "advises a ComfyUI update before an extension update in %s",
    (locale) => {
      expect(plainReason(locale, "readiness", CODE)).toMatch(
        ADVICE_ORDER[locale],
      );
    },
  );

  it.each(LOCALES)(
    "never tells the user to wait for an extension update alone in %s",
    (locale) => {
      // The old copy said longer videos stay unavailable "until the extension is updated". That is
      // wrong for a host older than the audited sources, so the extension update is conditional.
      const text = plainReason(locale, "readiness", CODE);
      expect(text).not.toMatch(
        /until the extension is updated|在擴充功能更新前|在扩展更新前/u,
      );
    },
  );

  it.each(LOCALES)(
    "is not the generic missing-workflow sentence in %s",
    (locale) => {
      expect(plainReason(locale, "readiness", CODE)).not.toBe(
        plainReason(
          locale,
          "readiness",
          "qualification_composition_unqualified",
        ),
      );
    },
  );

  it.each(LOCALES)(
    "leaves every existing readiness sentence alone in %s",
    (locale) => {
      // The generic reasons keep their meaning: a missing native workflow is still reported as such.
      for (const code of [
        "qualification_host_unqualified",
        "qualification_modes_incomplete",
        "qualification_composition_unqualified",
      ])
        expect(plainReason(locale, "readiness", code)).toMatch(
          locale === "en"
            ? /does not provide every native MiniMax H3 workflow/u
            : /MiniMax H3 工作流/u,
        );
    },
  );
});
