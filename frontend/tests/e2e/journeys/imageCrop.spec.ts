import { expect, test, type Locator } from "../fixtures/h3Page";
import { sidebarCopy, SUPPORTED_LOCALES } from "../../../src/i18n/catalog";
import { observeFrontendHostSeamsInPage } from "../../support/hostSeamLiveProbe";

for (const shape of ["data", "accessor", "absent"] as const)
  test(`crop contains host undo and canvas keys with ${shape} predicate`, async ({
    page,
  }) => {
    const text = sidebarCopy("en");
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#439e86";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await page.route("**/view?*", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(image, "base64"),
      }),
    );
    await page.goto("/?mode=image-crop");
    await page.route("**/scripts/app.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: 'export { app } from "/hostKeyboard.ts";',
      }),
    );
    await page.route("**/scripts/api.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: 'export { api } from "/hostKeyboard.ts";',
      }),
    );
    await page.evaluate(async (shape) => {
      const modulePath = "/hostKeyboard.ts";
      const fixture = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import("../../../e2e/hostKeyboard");
      fixture.configureHostModalPredicate(shape);
      (window as any).cropHostKeyWitness = fixture.installHostCapture(true);
    }, shape);
    const probe = await page.evaluate(observeFrontendHostSeamsInPage);
    expect(probe.modalKeyboardTier).toBe(shape);
    expect(
      probe.observations.find(
        (row) => row.seam_id === "frontend.app.modal_keyboard_guard",
      )?.readiness_state,
    ).toBe("ready");
    await page
      .getByRole("combobox", { name: text.referenceImages, exact: true })
      .selectOption("10");
    await page
      .getByRole("button", { name: text.crop.action, exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: text.crop.title });
    await expect(
      dialog.getByRole("group", { name: text.crop.regionLabel }),
    ).toBeVisible();
    expect(
      await dialog
        .locator("img")
        .evaluate((image) =>
          image instanceof HTMLImageElement ? image.naturalWidth : 0,
        ),
    ).toBeGreaterThan(0);
    const containment = await page.evaluate(async () => {
      const modulePath = "/hostKeyboard.ts";
      const fixture = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import("../../../e2e/hostKeyboard");
      return {
        predicate: fixture.hostModalPredicateActive(),
        modal: fixture.hostAriaModalOpen(),
      };
    });
    expect(containment).toEqual({ predicate: shape !== "absent", modal: true });
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    expect(
      await page.evaluate(() => (window as any).cropHostKeyWitness),
    ).toMatchObject({
      undoCapture: 2,
      undoActions: 0,
      canvasKeyups: 0,
      ghostActions: 0,
    });
    await dialog
      .getByRole("button", { name: text.crop.cancel, exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#crop-guard-leases")).toHaveText("0");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Delete");
    const witness = await page.evaluate(
      () => (window as any).cropHostKeyWitness,
    );
    expect(witness.undoActions).toBe(1);
    expect(witness.ghostActions).toBe(1);
    expect(witness.canvasKeyups).toBeGreaterThan(0);
  });

async function descriptionGeometry(tip: Locator) {
  return tip.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = style.font;
    const text = node.firstChild!;
    const words = [...(text.textContent ?? "").matchAll(/[A-Za-z]+/g)];
    const broken = words.flatMap((word) => {
      const range = document.createRange();
      range.setStart(text, word.index!);
      range.setEnd(text, word.index! + word[0].length);
      const lines = new Set(
        [...range.getClientRects()].map((r) => Math.round(r.top)),
      );
      return lines.size > 1 ? [word[0]] : [];
    });
    let left = 0;
    let right = document.documentElement.clientWidth;
    for (
      let parent = node.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (getComputedStyle(parent).overflowX !== "visible") {
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left + parent.clientLeft);
        right = Math.min(
          right,
          clip.left + parent.clientLeft + parent.clientWidth,
        );
      }
    }
    return {
      group: node.parentElement!.getAttribute("aria-label"),
      groupWidth: node.parentElement!.getBoundingClientRect().width,
      width: box.width,
      widestWord: Math.max(
        0,
        ...words.map((word) => context.measureText(word[0]).width),
      ),
      broken,
      left: box.left,
      right: box.right,
      clipLeft: left,
      clipRight: right,
      lines: (box.height - 14) / parseFloat(style.lineHeight),
    };
  });
}

function expectReadable(
  measured: Awaited<ReturnType<typeof descriptionGeometry>>,
) {
  const detail = JSON.stringify(measured);
  expect(measured.width, detail).toBeGreaterThanOrEqual(
    measured.widestWord + 18,
  );
  expect(measured.broken, detail).toEqual([]);
  expect(measured.left, detail).toBeGreaterThanOrEqual(measured.clipLeft - 1);
  expect(measured.right, detail).toBeLessThanOrEqual(measured.clipRight + 1);
}

test("narrow crop descriptions remain readable on hover and focus", async ({
  page,
}, testInfo) => {
  const text = sidebarCopy("en");
  for (const width of [704, 960]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?mode=image-crop");
    await page.getByLabel(text.taskMode, { exact: true }).selectOption("i2va");
    const crop = page.getByRole("button", {
      name: text.crop.action,
      exact: true,
    });
    await expect(crop).toHaveAttribute("aria-disabled", "true");
    for (const interaction of ["hover", "focus"] as const) {
      if (interaction === "hover") await crop.hover();
      else await crop.focus();
      const tip = page.getByRole("tooltip");
      await expect(tip).toHaveText(text.crop.choose);
      await page.screenshot({
        path: testInfo.outputPath(`crop-${width}-${interaction}.png`),
      });
      const measured = await descriptionGeometry(tip);
      console.log(
        "crop description",
        width,
        interaction,
        JSON.stringify(measured),
      );
      expectReadable(measured);
      if (interaction === "focus") await page.keyboard.press("Escape");
      else await page.mouse.move(0, 0);
      await expect(tip).toHaveCount(0);
      await crop.blur();
      await page.mouse.move(0, 0);
    }
  }
});

test("short and long crop descriptions use real props in every locale", async ({
  page,
}) => {
  for (const width of [704, 960]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const reason of ["choose", "useExisting"] as const) {
      await page.goto(`/?mode=image-crop&crop-description=${reason}`);
      for (const locale of SUPPORTED_LOCALES) {
        await page.getByLabel("Picker locale").selectOption(locale);
        const text = sidebarCopy(locale);
        const crop = page.getByRole("button", {
          name: text.crop.action,
          exact: true,
        });
        for (const interaction of ["hover", "focus"] as const) {
          if (interaction === "hover") await crop.hover();
          else await crop.focus();
          const tip = page.getByRole("tooltip");
          await expect(tip).toHaveText(text.crop[reason]);
          const sample = await descriptionGeometry(tip);
          console.log(
            "crop sample",
            locale,
            reason,
            width,
            interaction,
            JSON.stringify(sample),
          );
          expectReadable(sample);
          expect(sample.lines).toBeLessThanOrEqual(6.1);
          if (interaction === "focus") await page.keyboard.press("Escape");
          else await page.mouse.move(0, 0);
          await expect(tip).toHaveCount(0);
          await crop.blur();
          await page.mouse.move(0, 0);
        }
      }
    }
  }
});

test("every sidebar and editor icon group keeps descriptions readable inside its clip", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  // Non-vacuous minima pinned to the rendered owners: H3Sidebar (one/two frame rows),
  // ReferenceSourcePicker (three image rows with four actions), NlePlanningSection (five main
  // actions), and the editor's NleTimelineToolbar (at least undo/redo) / sequence planning.
  for (const [scenario, route, minimum] of [
    ["first", "/?mode=image-crop", 1],
    ["first-last", "/?mode=image-crop", 2],
    ["references", "/?mode=image-crop", 12],
    ["planning", "/?mode=production&planning=1", 5],
    ["workspace", "/nleWorkspace.html", 2],
    ["sequence", "/nleSequence.html", 5],
  ] as const) {
    await page.setViewportSize({
      width: route.startsWith("/?") ? 704 : 1280,
      height: 1100,
    });
    await page.goto(route);
    if (scenario === "first" || scenario === "first-last")
      await page
        .getByLabel(sidebarCopy("en").taskMode, { exact: true })
        .selectOption(scenario === "first" ? "i2va" : "fl2va");
    if (scenario === "references")
      await page.getByLabel("Picker preset").selectOption("sample");
    if (route.includes("production"))
      await page
        .getByRole("button", { name: "Production", exact: true })
        .click();
    if (route === "/nleWorkspace.html")
      await page.getByRole("button", { name: "Open full editor" }).click();
    const controls = page.locator("button.h3-icon-button");
    await expect(controls.first()).toBeVisible();
    let measured = 0;
    for (let index = 0; index < (await controls.count()); index++) {
      const button = controls.nth(index);
      if (!(await button.isVisible())) continue;
      const slot = button.locator("xpath=..");
      await slot.hover();
      const tip = button
        .locator("xpath=ancestor::*[contains(@class,'h3-icon-group')][1]")
        .getByRole("tooltip");
      await expect(tip).toBeVisible();
      const geometry = await descriptionGeometry(tip);
      console.log(
        "icon group sweep",
        scenario,
        await button.getAttribute("data-h3-nle-control"),
        JSON.stringify(geometry),
      );
      expectReadable(geometry);
      if (measured === 0)
        await page.screenshot({
          path: testInfo.outputPath(
            `toolbar-${route.includes("Sequence") ? "sequence" : route.includes("Workspace") ? "workspace" : route.includes("production") ? "planning" : "sidebar"}.png`,
          ),
        });
      measured++;
      await page.mouse.move(0, 0);
    }
    expect(measured, scenario).toBeGreaterThanOrEqual(minimum);
  }
});

test("crop images at the sidebar floor in every locale with exact geometry and keyboard containment", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 704, height: 900 });
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#b94738";
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "#439e86";
    ctx.fillRect(320, 0, 320, 240);
    ctx.fillStyle = "#527eb0";
    ctx.fillRect(0, 240, 320, 240);
    ctx.fillStyle = "#d1a546";
    ctx.fillRect(320, 240, 320, 240);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const views: string[] = [];
  await page.route("**/view?*", async (route) => {
    views.push(route.request().url());
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(fixture, "base64"),
    });
  });
  for (const locale of SUPPORTED_LOCALES) {
    const text = sidebarCopy(locale);
    await page.goto("/?mode=image-crop");
    await page.getByLabel("Picker locale").selectOption(locale);
    await page
      .getByRole("combobox", { name: text.referenceImages, exact: true })
      .selectOption("10");
    const opener = page.getByRole("button", {
      name: text.crop.action,
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: text.crop.title });
    const region = dialog.getByRole("group", { name: text.crop.regionLabel });
    await expect(region).toBeVisible();
    await expect(page.locator("#crop-guard-leases")).toHaveText("1");
    await dialog.screenshot({
      path: testInfo.outputPath(`${locale}-full-source.png`),
    });
    await dialog.getByRole("combobox").selectOption("16:9");
    await region
      .getByRole("button", { name: text.crop.handles.e, exact: true })
      .focus();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.locator("output")).toHaveText("624 × 351 · 0, 65");
    await page.keyboard.press("ArrowRight");
    await expect(dialog.locator("output")).toHaveText("640 × 360 · 0, 60");
    await dialog
      .getByRole("button", { name: text.crop.reset, exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: text.crop.aspectRatio })
      .selectOption("1:1");
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await region
      .getByRole("button", { name: text.crop.handles.e, exact: true })
      .focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(dialog.locator("output")).toHaveText("470 × 470 · 81, 5");
    const geometry = await dialog.evaluate((element) => {
      const picture = element
        .querySelector(".h3-crop-image")!
        .getBoundingClientRect();
      const box = element
        .querySelector(".h3-crop-region")!
        .getBoundingClientRect();
      return {
        overflow: element.scrollWidth - element.clientWidth,
        width: element.getBoundingClientRect().width,
        aspect: box.width / box.height,
        scaleX: picture.width / 640,
        scaleY: picture.height / 480,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.width).toBeLessThanOrEqual(672);
    expect(geometry.aspect).toBeCloseTo(1, 2);
    expect(geometry.scaleX).toBeCloseTo(geometry.scaleY, 3);
    await dialog.screenshot({
      path: testInfo.outputPath(`${locale}-square-crop.png`),
    });
    const pictureBounds = await dialog.locator(".h3-crop-image").boundingBox();
    const regionBounds = await region.boundingBox();
    if (!pictureBounds || !regionBounds) throw new Error("crop bounds missing");
    const scale = pictureBounds.width / 640;
    const center = {
      x: regionBounds.x + regionBounds.width / 2,
      y: regionBounds.y + regionBounds.height / 2,
    };
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 10 * scale, center.y + 5 * scale);
    await page.mouse.up();
    await expect(dialog.locator("output")).toHaveText("470 × 470 · 91, 10");
    const east = await region
      .getByRole("button", { name: text.crop.handles.e, exact: true })
      .boundingBox();
    if (!east) throw new Error("crop resize handle missing");
    await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      east.x + east.width / 2 - 20 * scale,
      east.y + east.height / 2,
    );
    await page.mouse.up();
    await expect(dialog.locator("output")).toHaveText("450 × 450 · 91, 20");
    await dialog
      .getByRole("button", { name: text.crop.cancel, exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(text.crop.dirty);
    await dialog
      .getByRole("button", { name: text.crop.keep, exact: true })
      .click();
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("alert")).toContainText(text.crop.dirty);
    await dialog
      .getByRole("button", { name: text.crop.keep, exact: true })
      .click();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await dialog
      .getByRole("button", { name: text.crop.apply, exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator("#crop-guard-leases")).toHaveText("0");
    await expect(page.locator(".h3-crop-chip")).toHaveText(" · 450 × 450");
    await page.getByRole("tab", { name: text.stages[4], exact: true }).click();
    const execute = page.getByRole("button", {
      name: text.stageActionExecute,
      exact: true,
    });
    await expect(execute).toBeDisabled();
    await expect(page.locator("#h3-execute-source-blocker")).toHaveText(
      text.crop.prepareRequired,
    );
    await expect(page.locator("#h3-execute-source-blocker")).toHaveAttribute(
      "data-crop-blocker",
      "crop_requires_preparation",
    );
    await page.getByRole("tab", { name: text.stages[0], exact: true }).click();
    await page
      .getByRole("button", { name: text.startAppMode, exact: true })
      .click();
    const payload = JSON.parse(await page.locator("#crop-request").innerText());
    expect(payload.image_crops).toEqual({
      "10": {
        x: 91,
        y: 20,
        w: 450,
        h: 450,
        sourceWidth: 640,
        sourceHeight: 480,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("crop-fixture.png");
  }
  expect(views.length).toBeGreaterThanOrEqual(3);
  for (const view of views) {
    const url = new URL(view);
    expect(url.searchParams.has("preview")).toBe(false);
    expect(url.searchParams.has("channel")).toBe(false);
  }
});

test("an image error after handle focus keeps keyboard containment after releasing the lease", async ({
  page,
}) => {
  const text = sidebarCopy("en");
  await page.goto("/?mode=image-crop");
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.route("**/view?*", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(fixture, "base64"),
    }),
  );
  await page
    .getByRole("combobox", { name: text.referenceImages, exact: true })
    .selectOption("10");
  const opener = page.getByRole("button", {
    name: text.crop.action,
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: text.crop.handles.e, exact: true })
    .focus();
  await page.route("**/view?fixture=missing", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await dialog.locator("img").evaluate((image) => {
    (image as HTMLImageElement).src = "/view?fixture=missing";
  });
  await expect(dialog.getByRole("alert")).toHaveText(text.crop.failed);
  await expect(page.locator("#crop-guard-leases")).toHaveText("0");
  await expect(dialog).toBeFocused();
  await page.evaluate(() => {
    document.body.dataset.cropEscapedKeys = "0";
    document.addEventListener("keydown", () => {
      document.body.dataset.cropEscapedKeys = String(
        Number(document.body.dataset.cropEscapedKeys) + 1,
      );
    });
  });
  await page.keyboard.press("Delete");
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: text.crop.cancel, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: text.crop.cancel, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator("body")).toHaveAttribute(
    "data-crop-escaped-keys",
    "0",
  );
});

test("crop host capability and image failure explain recovery and release the lease", async ({
  page,
}) => {
  const text = sidebarCopy("en");
  await page.goto("/?mode=image-crop");
  await page
    .getByRole("combobox", { name: text.referenceImages, exact: true })
    .selectOption("10");
  await page.getByLabel("Crop available", { exact: true }).uncheck();
  const crop = page.getByRole("button", {
    name: text.crop.action,
    exact: true,
  });
  await expect(crop).toHaveAttribute("aria-disabled", "true");
  await crop.focus();
  await expect(page.getByRole("tooltip")).toContainText(text.crop.unavailable);
  await page.getByLabel("Crop available", { exact: true }).check();
  await expect(crop).not.toHaveAttribute("aria-disabled", "true");
  await page.route("**/view?*", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await crop.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText(text.crop.failed);
  await expect(page.locator("#crop-guard-leases")).toHaveText("0");
  await dialog
    .getByRole("button", { name: text.crop.cancel, exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(crop).toBeFocused();
});
