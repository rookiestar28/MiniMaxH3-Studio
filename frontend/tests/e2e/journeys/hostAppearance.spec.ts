import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { openIntegratedShell } from "../helpers/nleShell";
import { sidebarCopy } from "../../../src/i18n/catalog";

const dark = "#0d0f13";
const light = "#eceff4";
async function palette(page: Page): Promise<string> {
  return page
    .locator(".h3c")
    .evaluate((node) =>
      getComputedStyle(node).getPropertyValue("--h3-canvas").trim(),
    );
}
async function frame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

test("new host dark theme uses color-scheme [theme-red]", async ({
  page,
}, info) => {
  await page.goto("/hostAppearance.html?scheme=dark");
  await expect(page.locator(".h3c")).toBeVisible();
  await page
    .locator(".h3c")
    .screenshot({ path: info.outputPath("host-theme.png") });
  expect(await palette(page)).toBe(dark);
});

for (const [name, query, expected] of [
  ["new light", "scheme=light", light],
  ["old dark", "darkClass=1", dark],
  ["old light", "", light],
  ["class beats scheme", "darkClass=1&scheme=light", dark],
  ["hermetic", "host=none", dark],
  ["hermetic ambiguous scheme", "host=none&scheme=light%20dark", dark],
] as const) {
  test(`theme precedence: ${name}`, async ({ page }) => {
    await page.goto(`/hostAppearance.html?${query}`);
    await expect(page.locator(".h3c")).toBeVisible();
    expect(await palette(page)).toBe(expected);
  });
}

test("host switches by the next frame and explicit harness overrides win", async ({
  page,
}) => {
  await page.goto("/hostAppearance.html?scheme=dark");
  await expect(page.locator(".h3c")).toBeVisible();
  for (const [signal, expected] of [
    ["light", light],
    ["dark", dark],
    ["class", dark],
    ["old-light", light],
  ] as const) {
    await page.evaluate((value) => {
      const html = document.documentElement;
      html.classList.toggle("dark-theme", value === "class");
      html.style.colorScheme =
        value === "class" || value === "old-light" ? "" : value;
    }, signal);
    await frame(page);
    expect(await palette(page)).toBe(expected);
  }
  for (const [target, theme, expected] of [
    ["html", "dark", dark],
    [".h3c", "dark", dark],
    ["html", "light", light],
    [".h3c", "light", light],
  ] as const) {
    await page.evaluate(
      ({ target, theme }) => {
        document.documentElement.removeAttribute("data-theme");
        document.querySelector(".h3c")!.removeAttribute("data-theme");
        document.documentElement.style.colorScheme =
          theme === "light" ? "dark" : "light";
        document.querySelector(target)!.setAttribute("data-theme", theme);
      },
      { target, theme },
    );
    await frame(page);
    expect(await palette(page)).toBe(expected);
  }
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-theme");
    document.querySelector(".h3c")!.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "dark";
    document.body.classList.add("light-theme");
  });
  await frame(page);
  expect(await palette(page)).toBe(light);
});

for (const shape of ["reka", "prime"] as const) {
  test(`${shape} clamps stale width to canvas, opposite panel and viewport [width-red]`, async ({
    page,
  }, info) => {
    await page.goto(`/hostAppearance.html?shape=${shape}`);
    await expect(page.locator(".h3c")).toBeVisible();
    await page
      .locator("#surface")
      .screenshot({ path: info.outputPath(`${shape}-width.png`) });
    expect(
      await page
        .locator("#panel")
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(712);
    await page.setViewportSize({ width: 700, height: 900 });
    await frame(page);
    expect(
      await page
        .locator("#panel")
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(642);
    expect(
      await page
        .locator("#root")
        .evaluate((node) => getComputedStyle(node).minWidth),
    ).toBe("642px");
  });
}

for (const shape of ["reka", "prime"] as const) {
  test(`${shape} continuous shrink clamps a collapsed canvas and grows back`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto(`/hostAppearance.html?shape=${shape}&layout=continuous`);
    await expect(page.locator(".h3c")).toBeVisible();
    for (const [step, width] of [1920, 1100, 800, 650, 800, 1100].entries()) {
      await page.setViewportSize({ width, height: 900 });
      await frame(page);
      await frame(page);
      const geometry = await page.evaluate(() => {
        const bounds = (id: string) => {
          const node = document.getElementById(id)!;
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        };
        return {
          surface: bounds("surface"),
          owner: bounds("panel"),
          main: bounds("main"),
          canvas: bounds("canvas"),
          minimum: Number.parseFloat(
            getComputedStyle(document.getElementById("panel")!).minWidth,
          ),
        };
      });
      const geometryPath = info.outputPath(`geometry-${step}-${width}.json`);
      await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
      await info.attach(`geometry-${step}-${width}`, {
        path: geometryPath,
        contentType: "application/json",
      });
      await page.screenshot({
        path: info.outputPath(`${shape}-${step}-${width}.png`),
      });
      expect(geometry.owner.left).toBe(56);
      expect(geometry.surface.right).toBe(width);
      if (width === 650) {
        expect(geometry.main.width).toBe(0);
        expect(geometry.canvas.width).toBe(0);
        expect.soft(geometry.owner.right).toBeLessThanOrEqual(width);
        expect.soft(geometry.minimum).toBeLessThanOrEqual(width - 56);
      } else {
        expect(geometry.minimum).toBe(704);
        expect(geometry.owner.width).toBe(704);
      }
    }
  });
}

test("unknown topology still respects its measured parent", async ({
  page,
}) => {
  await page.goto("/hostAppearance.html?shape=unknown");
  await expect(page.locator(".h3c")).toBeVisible();
  expect(
    await page
      .locator("#panel")
      .evaluate((node) => node.getBoundingClientRect().width),
  ).toBe(620);
});

async function portalPalettes(page: Page, root: Locator) {
  // Both harnesses open on a fresh page with no host marker or theme signal.
  expect(
    await page
      .locator("body")
      .evaluate((node) => node.classList.contains("litegraph")),
  ).toBe(false);
  expect(
    await root.evaluate((node) =>
      getComputedStyle(node).getPropertyValue("--h3-canvas").trim(),
    ),
  ).toBe(dark);
  for (const [signal, expected] of [
    ["new-dark", dark],
    ["new-light", light],
    ["old-dark", dark],
    ["old-light", light],
    ["hermetic", dark],
  ] as const) {
    await page.evaluate((signal) => {
      document.body.classList.toggle("litegraph", signal !== "hermetic");
      document.documentElement.classList.toggle(
        "dark-theme",
        signal === "old-dark",
      );
      document.documentElement.style.colorScheme =
        signal === "new-dark"
          ? "dark"
          : signal === "new-light"
            ? "light"
            : signal === "hermetic"
              ? "normal"
              : "";
    }, signal);
    await frame(page);
    expect(
      await root.evaluate((node) =>
        getComputedStyle(node).getPropertyValue("--h3-canvas").trim(),
      ),
      signal,
    ).toBe(expected);
  }
  for (const [theme, expected] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    await page.evaluate((theme) => {
      document.body.classList.add("litegraph");
      document.documentElement.style.colorScheme =
        theme === "light" ? "dark" : "light";
    }, theme);
    await root.evaluate(
      (node, theme) => node.setAttribute("data-theme", theme),
      theme,
    );
    await frame(page);
    expect(
      await root.evaluate((node) =>
        getComputedStyle(node).getPropertyValue("--h3-canvas").trim(),
      ),
    ).toBe(expected);
  }
}

test("crop portal renders both host theme shapes and preserves explicit overrides", async ({
  page,
}, info) => {
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
  const text = sidebarCopy("en");
  await page.goto("/?mode=image-crop");
  await page.getByLabel("Picker locale").selectOption("en");
  await page
    .getByRole("combobox", { name: text.referenceImages, exact: true })
    .selectOption("10");
  await page
    .getByRole("button", { name: text.crop.action, exact: true })
    .click();
  const root = page.locator(".h3-crop-backdrop");
  await expect(root).toBeVisible();
  await expect(
    root.getByRole("group", { name: text.crop.regionLabel }),
  ).toBeVisible();
  expect(
    await root.locator("img").evaluate((image) => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    })),
  ).toEqual({ width: 640, height: 480 });
  await portalPalettes(page, root);
  await root.screenshot({ path: info.outputPath("crop-theme.png") });
});

test("editor portal renders both host theme shapes and preserves explicit overrides", async ({
  page,
}, info) => {
  await openIntegratedShell(page, "smoke");
  const root = page.locator("[data-h3-nle-root]");
  await expect(root).toBeVisible();
  await expect(root.locator('[data-h3-nle-area="timeline"]')).toBeVisible();
  await portalPalettes(page, root);
  await root.screenshot({ path: info.outputPath("editor-theme.png") });
});
