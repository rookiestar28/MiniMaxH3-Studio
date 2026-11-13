import { describe, expect, it } from "vitest";
import { nleCopy } from "../src/components/nle/nleCopy";
import {
  PLAIN_REASON_TABLES,
  plainReason,
} from "../src/components/plainReasons";

describe("frame sequence corrective copy", () => {
  it.each(["en", "zh-TW", "zh-CN"] as const)(
    "names supported modes and actionable source recovery in %s",
    (locale) => {
      const readiness = plainReason(
        locale,
        "readiness",
        "qualification_host_bindings_unavailable",
      );
      const unsupported = plainReason(
        locale,
        "sequence",
        "unsupported_prepared_context",
      );
      for (const text of [readiness, unsupported]) {
        expect(text).toContain("Reference to Video");
        expect(text).toContain("First-Last Frame");
        expect(text).not.toMatch(
          /text-to-video segments without reference media|不含參考媒體的文字轉影片|不含参考媒体的文本生成视频/u,
        );
      }
      for (const code of [
        "sequence_media_binding_missing",
        "sequence_media_binding_invalid",
        "sequence_media_changed",
        "sequence_media_unavailable",
      ]) {
        expect(
          Object.hasOwn(PLAIN_REASON_TABLES[locale].sequence.codes, code),
        ).toBe(true);
        const text = plainReason(locale, "sequence", code);
        expect(text).not.toContain(code);
        expect(text).not.toMatch(
          /receipt|fingerprint|qualification|收據|指紋|收据|指纹/iu,
        );
        expect(text).toMatch(
          locale === "en" ? /retry|again/iu : /重試|重试|重新/u,
        );
      }
      expect(
        plainReason(locale, "sequence", "sequence_media_changed"),
      ).not.toBe(plainReason(locale, "sequence", "sequence_media_unavailable"));
      expect(nleCopy(locale).sequence.describe.readiness).toMatch(
        locale === "en" ? /frame sources.*generation/iu : /影格來源|帧来源/u,
      );
      expect(nleCopy(locale).sequence.readinessState.ready).toMatch(
        locale === "en" ? /plan/iu : /計畫|计划/u,
      );
    },
  );
});
