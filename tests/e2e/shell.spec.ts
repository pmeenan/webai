import { expect, test } from "@playwright/test";

test("navigates between shell pages and identifies the current page", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Measure browser AI");
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About WebAI");
  await expect(page.getByRole("link", { name: "About", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "Third-party notices" })).toHaveAttribute(
    "href",
    "/licenses/THIRD-PARTY-NOTICES.txt",
  );
});

test("persists an explicit theme and exposes keyboard-operable choices", async ({ page }) => {
  await page.goto("./");
  const trigger = page.getByRole("button", { name: /^Theme:/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const lightTheme = page.getByRole("menuitemradio", { name: "Light" });
  await expect(lightTheme).toBeFocused();
  await expect
    .poll(() => lightTheme.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe("solid");
  await page.keyboard.press("Enter");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("keeps the pre-hydration theme trigger neutral when a saved theme is applied", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("webai-theme", "light"));
  await page.route(/\/_astro\/.*\.js$/, (route) => route.abort());
  await page.goto("./");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Choose theme" })).toBeVisible();
  await expect(page.locator(".theme-trigger .lucide-monitor")).toBeVisible();
});

test("keeps keyboard focus visible in the theme menu under forced colors", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("./");
  const trigger = page.getByRole("button", { name: /^Theme:/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const lightTheme = page.getByRole("menuitemradio", { name: "Light" });
  await expect(lightTheme).toBeFocused();
  await expect
    .poll(() => lightTheme.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe("solid");
});

test("system theme follows operating-system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("./");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("offers a first-focusable skip link", async ({ page }) => {
  await page.goto("./");
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("removes nonessential transition duration for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./");
  const duration = await page
    .getByRole("link", { name: "Inspect this browser" })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(duration.split(",").every((value) => value.trim() === "0s")).toBe(true);
});

test("reflows without horizontal overflow at a narrow, 200%-zoom-equivalent width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("./");
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});

test("exposes named landmarks and keeps decorative art out of the accessibility tree", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId("arachne-hero")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("img")).toHaveCount(0);
});

test.describe("coarse-pointer layout", () => {
  test.use({ hasTouch: true });

  test("keeps actions at the coarse-pointer target height", async ({ page }) => {
    await page.goto("./");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const height = await page
      .getByRole("link", { name: "Inspect this browser" })
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  });
});
