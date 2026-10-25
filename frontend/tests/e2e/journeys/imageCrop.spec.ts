import { expect, test } from "../fixtures/h3Page";
import { sidebarCopy, SUPPORTED_LOCALES } from "../../../src/i18n/catalog";

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
