import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MODE_TEMPLATE,
  spliceContextPipeline,
  type Json,
} from "../src/host/templateMaterialization";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES = join(
  ROOT,
  "reference/rm02/official/workflow_templates/templates",
);
const FACTS = JSON.parse(
  readFileSync(
    join(ROOT, "tests/fixtures/official_template_facts_v1.json"),
    "utf8",
  ),
) as { templates: { name: string; file_sha256: string }[] };
const MODES = ["t2va", "i2va", "fl2va", "l2va", "ref2va"] as const;
const IMAGE = { type: "LoadImage", widgetValues: ["chosen.png", "image"] };
const AUDIO = { type: "LoadAudio", widgetValues: ["chosen.wav"] };

function selectedMedia(mode: (typeof MODES)[number]) {
  if (mode === "ref2va")
    return {
      referenceImages: [IMAGE],
      referenceVideos: [],
      referenceAudios: [AUDIO],
    };
  return {
    ...(mode === "i2va" || mode === "fl2va" ? { firstFrame: IMAGE } : {}),
    ...(mode === "l2va" || mode === "fl2va"
      ? {
          lastFrame: {
            type: "LoadImage",
            widgetValues: ["tail.png", "image"],
          },
        }
      : {}),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// The ignored, read-only official corpus is optional on public checkouts. Local
// acceptance runs these exact bytes, pinned independently of the output snapshot.
describe.runIf(
  FACTS.templates.every((row) =>
    existsSync(join(TEMPLATES, `${row.name}.json`)),
  ),
)("uncropped materialization against the pinned official templates", () => {
  it("preserves workflow bytes and ownership for every mode and source policy", () => {
    const rows = MODES.flatMap((taskMode) =>
      ["chosen", "template_defaults"].map((sourcePolicy) => {
        const name = MODE_TEMPLATE[taskMode]!;
        const bytes = readFileSync(join(TEMPLATES, `${name}.json`));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          FACTS.templates.find((row) => row.name === name)!.file_sha256,
        );
        const result = spliceContextPipeline(
          JSON.parse(bytes.toString()) as Json,
          {
            taskMode,
            userIntent:
              "A red kite crosses the sky while the camera follows its arc.",
            durationSeconds: 5.167,
            ...(sourcePolicy === "chosen"
              ? { media: selectedMedia(taskMode) }
              : {}),
          },
        );
        return {
          taskMode,
          sourcePolicy,
          workflowSha256: createHash("sha256")
            .update(canonical(JSON.parse(JSON.stringify(result.workflow))))
            .digest("hex"),
          ownedNodeIds: result.ownedNodeIds,
          ownedLinkIds: result.ownedLinkIds,
          mediaNodeIds: result.mediaNodeIds,
        };
      }),
    );
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "mediaNodeIds": {
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            228,
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            237,
            238,
          ],
          "ownedNodeIds": [
            119,
            120,
            121,
            122,
            123,
            124,
            125,
            126,
          ],
          "sourcePolicy": "chosen",
          "taskMode": "t2va",
          "workflowSha256": "de59fba914e703ea8ebab52f4f6ab43dedbfacba0b025544d4590bfd729645b1",
        },
        {
          "mediaNodeIds": {
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            228,
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            237,
            238,
          ],
          "ownedNodeIds": [
            119,
            120,
            121,
            122,
            123,
            124,
            125,
            126,
          ],
          "sourcePolicy": "template_defaults",
          "taskMode": "t2va",
          "workflowSha256": "de59fba914e703ea8ebab52f4f6ab43dedbfacba0b025544d4590bfd729645b1",
        },
        {
          "mediaNodeIds": {
            "firstFrame": 114,
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            236,
            237,
            239,
            240,
            242,
          ],
          "ownedNodeIds": [
            121,
            122,
            123,
            124,
            125,
            126,
            127,
            128,
            129,
          ],
          "sourcePolicy": "chosen",
          "taskMode": "i2va",
          "workflowSha256": "4d855886ff12c30ebbc2573de22f2b1b63b1d48c5c8f9c5cbdb1c5a34c9226d8",
        },
        {
          "mediaNodeIds": {
            "firstFrame": 114,
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            236,
            237,
            239,
            240,
            242,
          ],
          "ownedNodeIds": [
            121,
            122,
            123,
            124,
            125,
            126,
            127,
            128,
            129,
          ],
          "sourcePolicy": "template_defaults",
          "taskMode": "i2va",
          "workflowSha256": "5f9382c55cec98f76ca2896ebf291d1f708f00a3e1561fb22239ea23089f3d3d",
        },
        {
          "mediaNodeIds": {
            "firstFrame": 114,
            "lastFrame": 130,
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            236,
            237,
            239,
            240,
            242,
            244,
          ],
          "ownedNodeIds": [
            121,
            122,
            123,
            124,
            125,
            126,
            127,
            128,
            129,
          ],
          "sourcePolicy": "chosen",
          "taskMode": "fl2va",
          "workflowSha256": "1363374d1340b5a48104d2d7fcce7cd92396a7fc8bacc4802495dc28fe86c85b",
        },
        {
          "mediaNodeIds": {
            "firstFrame": 114,
            "lastFrame": 130,
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            236,
            237,
            239,
            240,
            242,
            244,
          ],
          "ownedNodeIds": [
            121,
            122,
            123,
            124,
            125,
            126,
            127,
            128,
            129,
          ],
          "sourcePolicy": "template_defaults",
          "taskMode": "fl2va",
          "workflowSha256": "5d33a2363b343b02d46bc4f941b6575f79c5c8b8998424913aa70468385f5196",
        },
        {
          "mediaNodeIds": {
            "lastFrame": 114,
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            236,
            237,
            239,
            240,
            242,
          ],
          "ownedNodeIds": [
            121,
            122,
            123,
            124,
            125,
            126,
            127,
            128,
            129,
          ],
          "sourcePolicy": "chosen",
          "taskMode": "l2va",
          "workflowSha256": "5371ffa07e5f77e6d93b50d41cfc2db2a446491b2a5e1eb9918b4d7bdd05c8f7",
        },
        {
          "mediaNodeIds": {
            "lastFrame": 114,
            "referenceAudios": [],
            "referenceImages": [],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            229,
            230,
            231,
            232,
            233,
            234,
            235,
            236,
            237,
            239,
            240,
            242,
          ],
          "ownedNodeIds": [
            121,
            122,
            123,
            124,
            125,
            126,
            127,
            128,
            129,
          ],
          "sourcePolicy": "template_defaults",
          "taskMode": "l2va",
          "workflowSha256": "f5910b16ae9c12ee17ff90daa40cde733dab903434ac706f4ca665038918fdcb",
        },
        {
          "mediaNodeIds": {
            "referenceAudios": [
              149,
            ],
            "referenceImages": [
              137,
            ],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            283,
            284,
            285,
            286,
            287,
            288,
            289,
            290,
            291,
            292,
            293,
            295,
            297,
          ],
          "ownedNodeIds": [
            132,
            141,
            142,
            143,
            144,
            145,
            146,
            147,
            148,
          ],
          "sourcePolicy": "chosen",
          "taskMode": "ref2va",
          "workflowSha256": "b6b380ff06fcf40b0bbba82c04933419491c3997888f8d1ffae254f574cd8e14",
        },
        {
          "mediaNodeIds": {
            "referenceAudios": [],
            "referenceImages": [
              137,
              139,
            ],
            "referenceVideos": [],
          },
          "ownedLinkIds": [
            283,
            284,
            285,
            286,
            287,
            288,
            289,
            290,
            291,
            292,
            293,
            295,
            297,
          ],
          "ownedNodeIds": [
            132,
            141,
            142,
            143,
            144,
            145,
            146,
            147,
            148,
          ],
          "sourcePolicy": "template_defaults",
          "taskMode": "ref2va",
          "workflowSha256": "b1813e3b87ec53adcedba504374a267796104740a4f87ba6528f0a3aeb10b5ae",
        },
      ]
    `);
  });
});
