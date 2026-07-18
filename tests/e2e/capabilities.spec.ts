import { expect, test } from "@playwright/test";

test("capability report reaches terminal evidence and refreshes", async ({ page }) => {
  await page.goto("./capabilities/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Browser capabilities");
  const refresh = page.getByRole("button", { name: "Refresh diagnostics" });
  await expect(refresh).toBeEnabled({ timeout: 25_000 });
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  const report = page.getByTestId("capability-grid");
  const measurementStatus = page.locator(".capability-report > [role=status]");
  await measurementStatus.evaluate((element) => {
    const recordStatus = () => {
      const history = window.sessionStorage.getItem("webai-test-status-history") ?? "";
      window.sessionStorage.setItem(
        "webai-test-status-history",
        `${history}\n${element.textContent ?? ""}`,
      );
    };
    recordStatus();
    new MutationObserver(recordStatus).observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
  await expect(report).toHaveAttribute("aria-busy", "false");
  await expect(measurementStatus).toHaveText("Browser capability measurement complete.");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Environment and isolation",
    "WebAssembly and shared memory",
    "Accelerated compute",
    "Storage",
  ]);

  const pageIsolation = page.locator(
    '[data-capability-id="environment.page.cross-origin-isolated"]',
  );
  await expect(pageIsolation.getByText("supported", { exact: true })).toBeVisible();
  const initialRaw = await pageIsolation.getByText(/page · stable-session/).textContent();

  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeEnabled({ timeout: 25_000 });
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(report).toHaveAttribute("aria-busy", "false");
  await expect(measurementStatus).toHaveText("Browser capability measurement complete.");
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem("webai-test-status-history")))
    .toContain("Measuring browser capabilities.");
  await expect(pageIsolation.getByText(/page · stable-session/)).not.toHaveText(initialRaw ?? "");
});

test("does not request persistence during initial measurement", async ({ page }) => {
  await page.addInitScript(() => {
    const storage = navigator.storage;
    if (storage !== undefined && typeof storage.persist === "function") {
      const original = storage.persist.bind(storage);
      Object.defineProperty(storage, "persist", {
        configurable: true,
        value: async () => {
          window.sessionStorage.setItem("webai-test-persist-called", "yes");
          return await original();
        },
      });
    }
  });
  await page.goto("./capabilities/");
  await expect(page.getByRole("button", { name: "Refresh diagnostics" })).toBeEnabled({
    timeout: 25_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem("webai-test-persist-called")))
    .toBeNull();
});

test("retains the persistence action label while the request is busy", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "persisted", {
      configurable: true,
      value: async () => false,
    });
    Object.defineProperty(navigator.storage, "persist", {
      configurable: true,
      value: async () => {
        window.sessionStorage.setItem("webai-test-persist-started", "yes");
        while (window.sessionStorage.getItem("webai-test-release-persist") !== "yes") {
          await new Promise((resolve) => window.setTimeout(resolve, 10));
        }
        return false;
      },
    });
  });
  await page.goto("./capabilities/");
  const persistenceAction = page.locator(".persistence-action");
  const request = persistenceAction.getByRole("button", { name: "Request persistence" });
  await expect(request).toBeEnabled({ timeout: 25_000 });
  await expect(request).toHaveAttribute("aria-busy", "false");

  await request.click();
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem("webai-test-persist-started")))
    .toBe("yes");
  await expect(request).toBeDisabled();
  await expect(request).toHaveAttribute("aria-busy", "true");
  await expect(persistenceAction.getByRole("status")).toHaveText("Requesting origin persistence…");

  await page.evaluate(() => window.sessionStorage.setItem("webai-test-release-persist", "yes"));
  await expect(request).toBeEnabled();
  await expect(request).toHaveAttribute("aria-busy", "false");
  await expect(persistenceAction.getByRole("status")).toHaveText(
    "The browser kept this origin in best-effort storage.",
  );
});

test("recovers when the capability worker cannot be constructed", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    class ThrowingWorker {
      constructor() {
        throw new DOMException("local details", "SecurityError");
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: ThrowingWorker,
      writable: true,
    });
  });
  await page.goto("./capabilities/");
  await expect(page.getByRole("button", { name: "Refresh diagnostics" })).toBeEnabled();
  const workerCard = page.locator('[data-capability-id="webgpu.worker"]');
  await expect(workerCard.getByText("unknown", { exact: true })).toBeVisible();
  await expect(workerCard.getByText("Not determined: worker error.")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("does not offer persistence when the browser lacks the request API", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "persist", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("./capabilities/");
  await expect(page.getByRole("button", { name: "Refresh diagnostics" })).toBeEnabled({
    timeout: 25_000,
  });
  const storageCard = page.locator('[data-capability-id="storage.page.api"]');
  await expect(storageCard.getByText("degraded", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Persistence unavailable" })).toBeDisabled();
});

test("explains why the threaded wasm gate is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: false,
    });
  });
  await page.goto("./capabilities/");
  await expect(page.getByRole("button", { name: "Refresh diagnostics" })).toBeEnabled({
    timeout: 25_000,
  });
  const summary = page.locator(".capability-toolbar");
  await expect(summary.getByText("unsupported", { exact: true })).toBeVisible();
  await expect(
    summary.getByText("Threaded wasm runtimes cannot be enabled in this environment."),
  ).toBeVisible();
  await expect(summary.getByText(/The page is not cross-origin isolated/)).toBeVisible();
  const sharedMemory = page.locator('[data-capability-id="shared-memory.worker.round-trip"]');
  await expect(sharedMemory.getByText("unsupported", { exact: true })).toBeVisible();
  await expect(sharedMemory.getByText(/atomic sentinel not verified/)).toBeVisible();
  const webGpu = page.locator('[data-capability-id="webgpu.worker"]');
  await expect(webGpu.getByText("Not determined: worker error.")).toHaveCount(0);
  await expect(webGpu.getByText(/dedicated-worker · stable-session/)).toBeVisible();
});

test("finishes refresh when the storage estimate never settles", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "estimate", {
      configurable: true,
      value: () => new Promise(() => {}),
    });
  });
  await page.goto("./capabilities/");
  const refresh = page.getByRole("button", { name: "Refresh diagnostics" });
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeDisabled();
  await expect(refresh).toBeEnabled({ timeout: 8_000 });
  await expect(refresh).toHaveAttribute("aria-busy", "false");

  const estimateCard = page.locator('[data-capability-id="storage.estimate"]');
  await expect(estimateCard.getByText("unknown", { exact: true })).toBeVisible();
  await expect(estimateCard.getByText("Not determined: probe timeout.")).toBeVisible();

  const persistedCard = page.locator('[data-capability-id="storage.persisted"]');
  await expect(persistedCard.getByText("Observed:")).toBeVisible();

  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeDisabled();
  await expect(refresh).toBeEnabled({ timeout: 8_000 });
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(estimateCard.getByText("Not determined: probe timeout.")).toBeVisible();
});

test("releases the persistence action when its request never settles", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "persist", {
      configurable: true,
      value: () => new Promise(() => {}),
    });
  });
  await page.goto("./capabilities/");
  const persistenceAction = page.locator(".persistence-action");
  const request = persistenceAction.getByRole("button", { name: "Request persistence" });
  await expect(request).toBeEnabled({ timeout: 8_000 });

  await request.click();
  await expect(request).toBeDisabled();
  await expect(request).toHaveAttribute("aria-busy", "true");
  await expect(request).toBeEnabled({ timeout: 8_000 });
  await expect(request).toHaveAttribute("aria-busy", "false");
  await expect(persistenceAction.getByRole("status")).toHaveText(
    "The persistence request could not be completed.",
  );
});
