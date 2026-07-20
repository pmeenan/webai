import { createHash } from "node:crypto";
import { expect, type Page, type Route, test } from "@playwright/test";
import { ggufSplitToolVersion } from "../../src/lib/models/gguf-split-profile";

const commit = "b".repeat(40);

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.byteLength), bytes]);
}

function ggufEntry(key: string, type: number, value: Buffer): Buffer {
  return Buffer.concat([ggufString(key), u32(type), value]);
}

function ggufFixture(size?: number, name = "Playwright fixture"): Buffer {
  const header = Buffer.concat([
    Buffer.from("GGUF"),
    u32(3),
    u64(0),
    u64(4),
    ggufEntry("general.architecture", 8, ggufString("llama")),
    ggufEntry("general.name", 8, ggufString(name)),
    ggufEntry("general.file_type", 4, u32(15)),
    ggufEntry("llama.context_length", 4, u32(131_072)),
  ]);
  if (size === undefined) return header;
  const fixture = Buffer.alloc(size);
  header.copy(fixture);
  return fixture;
}

async function routeModelInfo(
  page: Page,
  fixture: Buffer,
  filename = "fixture-Q4_K_M.gguf",
  digest = createHash("sha256").update(fixture).digest("hex"),
): Promise<void> {
  await page.route("https://huggingface.co/api/models/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        sha: commit,
        private: false,
        gated: false,
        siblings: [
          {
            rfilename: filename,
            size: fixture.byteLength,
            blobId: "c".repeat(40),
            lfs: { size: fixture.byteLength, sha256: digest },
          },
        ],
      }),
    });
  });
}

async function fulfillRange(
  route: Route,
  fixture: Buffer,
  start: number,
  end: number,
): Promise<void> {
  await route.fulfill({
    status: 206,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length",
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${fixture.byteLength}`,
      "Content-Length": String(end - start + 1),
    },
    body: fixture.subarray(start, end + 1),
  });
}

async function holdAcquisitionLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as Window & { __webaiTestLockHeld?: boolean };
    void navigator.locks.request("webai-model-acquisition-v1", async () => {
      state.__webaiTestLockHeld = true;
      await new Promise<void>(() => undefined);
    });
  });
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => (window as Window & { __webaiTestLockHeld?: boolean }).__webaiTestLockHeld === true,
        ),
    )
    .toBe(true);
}

test("resumes a durable range after a page and worker restart, then inspects the verified GGUF", async ({
  page,
}) => {
  const fixture = ggufFixture(2 * 1024 * 1024);
  await routeModelInfo(page, fixture);
  const starts: number[] = [];
  let allowResume = false;
  await page.route(
    `https://huggingface.co/fixture/model/resolve/${commit}/fixture-Q4_K_M.gguf`,
    async (route) => {
      const header = route.request().headers().range ?? "";
      const match = header.match(/^bytes=(\d+)-$/u);
      if (match === null) {
        await route.abort();
        return;
      }
      const start = Number(match[1]);
      starts.push(start);
      if (start === 0) {
        await fulfillRange(route, fixture, 0, 1024 * 1024 - 1);
        return;
      }
      while (!allowResume) await new Promise((resolve) => setTimeout(resolve, 25));
      await fulfillRange(route, fixture, start, fixture.byteLength - 1);
    },
  );

  await page.goto("./models/");
  await page.getByLabel("Model ID or URL").fill("fixture/model");
  await page.getByRole("button", { name: "List files" }).click();
  const resolved = page.getByTestId("resolved-repository");
  await expect(resolved.getByText(commit)).toBeVisible();
  await resolved.getByRole("button", { name: "Download" }).click();
  await expect(page.getByText("1.0 MiB of 2.0 MiB durable", { exact: false })).toBeVisible();

  await page.reload();
  const partial = page.locator("[data-job-id]");
  await expect(partial.getByText("1.0 MiB of 2.0 MiB durable", { exact: false })).toBeVisible();
  await expect(partial.getByRole("button", { name: "Resume and verify" })).toBeVisible();
  allowResume = true;
  await partial.getByRole("button", { name: "Resume and verify" }).click();

  const installed = page.locator("[data-model-id]");
  await expect(installed).toContainText("fixture/model · Q4_K_M");
  await expect(installed.getByText("installed", { exact: true })).toBeVisible();
  await installed.getByText("Inspect files and metadata").click();
  const inspectedFile = installed.locator("details.model-file-inspection");
  await expect(inspectedFile.getByText("Name: Playwright fixture")).toBeVisible();
  await expect(installed.getByRole("rowheader", { name: "general.architecture" })).toBeHidden();
  await inspectedFile.locator("summary").click();
  await expect(installed.getByRole("rowheader", { name: "general.architecture" })).toBeVisible();
  await expect(installed.getByRole("cell", { name: "llama" })).toBeVisible();
  expect(starts[0]).toBe(0);
  expect(starts.slice(1).every((start) => start === 1024 * 1024)).toBe(true);

  await page.unroute("https://huggingface.co/api/models/**");
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.includes("/revision/")
      ? {
          sha: commit,
          private: false,
          gated: false,
          config: { model_type: "llama" },
          tags: ["gguf"],
          siblings: [
            {
              rfilename: "fixture-Q4_K_M.gguf",
              size: fixture.byteLength,
              lfs: {
                size: fixture.byteLength,
                sha256: createHash("sha256").update(fixture).digest("hex"),
              },
            },
          ],
        }
      : [{ id: "fixture/model", sha: commit, private: false, gated: false, tags: ["gguf"] }];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });
  });
  await page.getByLabel("Search models").fill("fixture model");
  await page.getByRole("button", { name: "Browse models" }).click();
  const hierarchy = page.getByTestId("browse-hierarchy");
  await expect(
    hierarchy.locator(".browse-hierarchy-column").nth(0).getByRole("button"),
  ).toContainText("1 of 1 visible variant downloaded");
  await expect(
    hierarchy.locator(".browse-hierarchy-column").nth(1).getByRole("button"),
  ).toContainText("1 of 1 visible variant downloaded");
  await expect(
    hierarchy.locator(".browse-hierarchy-column").nth(2).getByRole("button"),
  ).toContainText("Downloaded");
  const browseDetail = page.getByTestId("browse-selected-detail");
  await expect(
    browseDetail.locator(".status-badge").filter({ hasText: "Downloaded" }),
  ).toBeVisible();
  await expect(
    browseDetail.getByRole("button", { name: "Q4_K_M for fixture/model is downloaded" }),
  ).toBeDisabled();
});

test("fails closed on a non-range response and does not promote the artifact", async ({ page }) => {
  const fixture = ggufFixture();
  await routeModelInfo(page, fixture);
  await page.route(
    `https://huggingface.co/fixture/model/resolve/${commit}/fixture-Q4_K_M.gguf`,
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: fixture,
      });
    },
  );
  await page.goto("./models/");
  await page.getByLabel("Model ID or URL").fill("fixture/model");
  await page.getByRole("button", { name: "List files" }).click();
  await page.getByTestId("resolved-repository").getByRole("button", { name: "Download" }).click();
  await expect(page.getByRole("alert")).toContainText("exact partial response was required");
  await expect(page.locator("[data-model-id]")).toHaveCount(0);
  await expect(page.locator("[data-job-id]")).toContainText("failed");
});

test("retains a failed partial but never promotes bytes with the wrong final digest", async ({
  page,
}) => {
  const fixture = ggufFixture();
  await routeModelInfo(page, fixture, "fixture-Q4_K_M.gguf", "d".repeat(64));
  await page.route(
    `https://huggingface.co/fixture/model/resolve/${commit}/fixture-Q4_K_M.gguf`,
    async (route) => {
      await fulfillRange(route, fixture, 0, fixture.byteLength - 1);
    },
  );
  await page.goto("./models/");
  await page.getByLabel("Model ID or URL").fill("fixture/model");
  await page.getByRole("button", { name: "List files" }).click();
  await page.getByTestId("resolved-repository").getByRole("button", { name: "Download" }).click();
  await expect(page.getByRole("alert")).toContainText("Integrity verification failed");
  await expect(page.locator("[data-model-id]")).toHaveCount(0);
  const partial = page.locator("[data-job-id]");
  await expect(partial).toContainText("failed");
  await expect(partial.getByRole("button", { name: "Resume and verify" })).toHaveCount(0);
  await partial.getByRole("button", { name: "Discard partial" }).click();
  await partial.getByRole("button", { name: "Confirm discard" }).click();
  await expect(partial).toHaveCount(0);
});

test("treats a queued first request as active instead of offering concurrent resume", async ({
  page,
}) => {
  const fixture = ggufFixture();
  await routeModelInfo(page, fixture);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `https://huggingface.co/fixture/model/resolve/${commit}/fixture-Q4_K_M.gguf`,
    async (route) => {
      await held;
      await fulfillRange(route, fixture, 0, fixture.byteLength - 1).catch(() => undefined);
    },
  );
  await page.goto("./models/");
  await page.getByLabel("Model ID or URL").fill("fixture/model");
  await page.getByRole("button", { name: "List files" }).click();
  await page.getByTestId("resolved-repository").getByRole("button", { name: "Download" }).click();
  const partial = page.locator("[data-job-id]");
  await expect(partial.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(partial.getByRole("button", { name: "Resume and verify" })).toHaveCount(0);
  await expect(partial.getByRole("button", { name: "Discard partial" })).toHaveCount(0);
  await partial.getByRole("button", { name: "Pause" }).click();
  release?.();
  await expect(partial).toContainText("paused");
});

test("offers llama.cpp's same-directory MTP companion without listing sidecars as models", async ({
  page,
}) => {
  const fixture = ggufFixture();
  const mtpFixture = ggufFixture(undefined, "MTP fixture");
  const digest = createHash("sha256").update(fixture).digest("hex");
  const mtpDigest = createHash("sha256").update(mtpFixture).digest("hex");
  const downloaded: string[] = [];
  await page.route("https://huggingface.co/api/models/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        sha: commit,
        private: false,
        gated: false,
        siblings: [
          {
            rfilename: "model-Q4_K_XL.gguf",
            size: fixture.byteLength,
            lfs: { size: fixture.byteLength, sha256: digest },
          },
          {
            rfilename: "mtp-model-Q4_0.gguf",
            size: mtpFixture.byteLength,
            lfs: { size: mtpFixture.byteLength, sha256: mtpDigest },
          },
          {
            rfilename: "MTP/mtp-model-Q8_0.gguf",
            size: 97_836_352,
            lfs: { size: 97_836_352, sha256: "e".repeat(64) },
          },
          {
            rfilename: "mmproj-F16.gguf",
            size: 100,
            lfs: { size: 100, sha256: "f".repeat(64) },
          },
        ],
      }),
    });
  });
  for (const [path, body] of [
    ["model-Q4_K_XL.gguf", fixture],
    ["mtp-model-Q4_0.gguf", mtpFixture],
  ] as const) {
    await page.route(
      `https://huggingface.co/fixture/model/resolve/${commit}/${path}`,
      async (route) => {
        downloaded.push(path);
        await fulfillRange(route, body, 0, body.byteLength - 1);
      },
    );
  }
  await page.goto("./models/");
  await page.getByLabel("Model ID or URL").fill("fixture/model");
  await page.getByRole("button", { name: "List files" }).click();
  const resolved = page.getByTestId("resolved-repository");
  await expect(resolved.locator(".quant-list > li")).toHaveCount(1);
  await expect(resolved).toContainText("Optional llama.cpp MTP companion: mtp-model-Q4_0.gguf");
  await expect(resolved.getByRole("button", { name: "Download model + MTP" })).toBeVisible();
  await expect(resolved.getByRole("button", { name: "Download model only" })).toBeVisible();
  await expect(resolved).not.toContainText("MTP/mtp-model-Q8_0.gguf");
  await expect(resolved).not.toContainText("mmproj-F16.gguf");
  await expect(resolved.getByRole("link", { name: "pinned repository" })).toHaveAttribute(
    "href",
    `https://huggingface.co/fixture/model/tree/${commit}`,
  );
  await resolved.getByRole("button", { name: "Download model + MTP" }).click();
  const installed = page.locator("[data-model-id]");
  await expect(installed).toContainText("2 files");
  await installed.getByText("Inspect files and metadata").click();
  await expect(installed).toContainText("MTP fixture");
  const mtpFile = installed
    .locator("details.model-file-inspection")
    .filter({ hasText: "mtp-model-Q4_0.gguf" });
  await mtpFile.locator("summary").click();
  await expect(mtpFile).toContainText("Role: MTP speculative-decoding companion");
  expect(downloaded).toEqual(["model-Q4_K_XL.gguf", "mtp-model-Q4_0.gguf"]);
});

test("imports and deletes a local GGUF without network traffic", async ({ page }) => {
  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://huggingface.co/")) unexpectedRequests.push(request.url());
  });
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  const opfsMoveAvailable = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("webai-m2-move-probe", { create: true });
    const available =
      typeof (handle as FileSystemFileHandle & { move?: unknown }).move === "function";
    await root.removeEntry("webai-m2-move-probe");
    return available;
  });
  expect(opfsMoveAvailable).toBe(true);
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "local-Q4_K_M.gguf",
    mimeType: "application/octet-stream",
    buffer: ggufFixture(),
  });
  const installed = page.locator("[data-model-id]");
  await expect(installed).toContainText("local-Q4_K_M.gguf");
  await expect(installed).toContainText("Trained context");
  await expect(installed).toContainText("131,072 tokens");
  await installed.getByText("Inspect files and metadata").click();
  const inspectedFile = installed.locator("details.model-file-inspection");
  await expect(inspectedFile).toContainText("Name: Playwright fixture");
  await expect(inspectedFile.locator("table")).toBeHidden();
  await installed.getByRole("button", { name: "Delete model" }).click();
  await installed.getByRole("button", { name: "Confirm delete" }).click();
  await expect(installed).toHaveCount(0);
  await expect(page.getByText("No managed models yet")).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test("installs integrity-checked local bytes when metadata inspection is unavailable", async ({
  page,
}) => {
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "hostile.gguf",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a gguf"),
  });
  const installed = page.locator("[data-model-id]");
  await expect(installed).toContainText("hostile.gguf");
  await expect(installed).toContainText("Metadata unavailable");
  await installed.getByText("Inspect files and metadata").click();
  const inspectedFile = installed.locator("details.model-file-inspection");
  await inspectedFile.locator("summary").click();
  await expect(inspectedFile).toContainText("does not start with the GGUF magic bytes");
  await expect(inspectedFile).toContainText("The verified model bytes remain installed");
});

test("persists a measured wllama shard-limit warning on the model card", async ({ page }) => {
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "unsplittable.gguf",
    mimeType: "application/octet-stream",
    buffer: ggufFixture(),
  });
  await expect(page.locator("[data-model-id]")).toContainText("unsplittable.gguf");
  await page.evaluate(async (splitterVersion) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("models", "readwrite");
    const store = transaction.objectStore("models");
    const model = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.getAll();
      request.addEventListener("success", () => resolve(request.result[0]), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    store.put({
      ...model,
      runtimeIssues: [
        {
          runtimeId: "wllama",
          reasonCode: "minimum-shard-size",
          message: "Measured minimum shard is 2.1 GB, above wllama's file limit.",
          measuredAt: "2026-07-18T00:00:00.000Z",
          limitBytes: 2_000_000_000,
          requiredShardBytes: 2_100_000_000,
          splitterVersion,
        },
      ],
    });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
  }, ggufSplitToolVersion);
  await page.reload();
  const installed = page.locator("[data-model-id]");
  await expect(installed.getByText("Not compatible with wllama")).toBeVisible();
  await expect(installed).toContainText("Measured minimum shard is 2.1 GB");
  await expect(installed.getByRole("button", { name: /Split|Prepare/u })).toHaveCount(0);
});

test("re-runs metadata extraction from installed OPFS bytes without a source or network", async ({
  page,
}) => {
  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://huggingface.co/")) unexpectedRequests.push(request.url());
  });
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "reinspect-Q4_K_M.gguf",
    mimeType: "application/octet-stream",
    buffer: ggufFixture(),
  });
  const installed = page.locator("[data-model-id]");
  await expect(installed).toContainText("Playwright fixture");

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("models", "readwrite");
    const store = transaction.objectStore("models");
    const model = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.getAll();
      request.addEventListener("success", () => resolve(request.result[0]), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const files = (model.files as Array<Record<string, unknown>>).map((file) => {
      const identity = { ...file };
      delete identity.inspection;
      delete identity.inspectionError;
      return {
        ...identity,
        inspectionError: {
          code: "gguf-invalid",
          phase: "inspect",
          message: "Synthetic old-inspector failure.",
          retryable: false,
        },
      };
    });
    store.put({ ...model, files });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
  });

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(installed).toContainText("Metadata unavailable");
  await installed.getByRole("button", { name: "Re-run metadata inspection" }).click();
  await expect(installed).toContainText("Playwright fixture");
  await expect(installed).not.toContainText("Synthetic old-inspector failure");
  expect(unexpectedRequests).toEqual([]);
});

test("keeps an interrupted local import as explicit needs-source state", async ({ page }) => {
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  await holdAcquisitionLock(page);
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "interrupted-Q4_K_M.gguf",
    mimeType: "application/octet-stream",
    buffer: ggufFixture(2 * 1024 * 1024),
  });
  const partial = page.locator("[data-job-id]");
  await expect(partial).toContainText("Partial local import");
  await partial.getByRole("button", { name: "Stop import" }).click();
  await expect(partial).toContainText("needs-source");
  await page.reload();
  await expect(partial).toContainText("needs-source");
  await expect(partial.getByRole("button", { name: "Resume and verify" })).toHaveCount(0);
  await partial.getByRole("button", { name: "Discard partial" }).click();
  await partial.getByRole("button", { name: "Confirm discard" }).click();
  await expect(partial).toHaveCount(0);
});

test("links resolve failures to the source field and identifies pasted-file selection", async ({
  page,
}) => {
  const fixture = ggufFixture();
  await routeModelInfo(page, fixture);
  await page.goto("./models/");
  const input = page.getByLabel("Model ID or URL");
  await input.fill("invalid");
  await page.getByRole("button", { name: "List files" }).click();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#model-source-error")).toContainText("owner/model");

  await input.fill("https://huggingface.co/fixture/model/blob/main/fixture-Q4_K_M.gguf");
  await page.getByRole("button", { name: "List files" }).click();
  await expect(page.getByText("From pasted file URL")).toBeVisible();
});

test("renders a terminal unavailable state when the model worker cannot start", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class BrokenWorker {
        constructor() {
          throw new Error("worker unavailable");
        }
      },
    });
  });
  await page.goto("./models/");
  await expect(page.getByText("background worker could not start")).toBeVisible();
  await expect(page.getByRole("button", { name: "List files" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();
});

test("keeps worker-backed form values inert until the Models island hydrates", async ({ page }) => {
  let releaseScripts!: () => void;
  const scriptsReleased = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route(/\/_astro\/.*\.js$/u, async (route) => {
    await scriptsReleased;
    await route.continue();
  });

  await page.goto("./models/", { waitUntil: "commit" });
  await expect(page.getByLabel("Search models")).toBeDisabled();
  await expect(page.getByLabel("Thinking")).toBeDisabled();
  await expect(page.getByLabel("Minimum declared context (K tokens)")).toBeDisabled();
  await expect(page.getByLabel("Maximum download size (GiB)")).toBeDisabled();
  await expect(page.getByLabel("Model ID or URL")).toBeDisabled();

  releaseScripts();
  await expect(page.getByLabel("Search models")).toBeEnabled();
  await expect(page.getByLabel("Thinking")).toBeEnabled();
  await expect(page.getByLabel("Minimum declared context (K tokens)")).toBeEnabled();
  await expect(page.getByLabel("Maximum download size (GiB)")).toBeEnabled();
  await expect(page.getByLabel("Model ID or URL")).toBeEnabled();
});

test("upgrades the version-one model database without losing existing records", async ({
  page,
}) => {
  await page.goto("./about/");
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1", 1);
      request.addEventListener("upgradeneeded", () => {
        for (const store of ["models", "jobs", "blobs"]) {
          request.result.createObjectStore(store, { keyPath: "id" });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("models", "readwrite");
    transaction.objectStore("models").put({
      schemaVersion: 1,
      id: "legacy-model",
      displayName: "Legacy model record",
      createdAt: "2026-07-18T00:00:00.000Z",
      totalSize: 0,
      state: "missing",
      source: { kind: "local-import", filenames: [], lastModified: [], sha256: [] },
      files: [],
    });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
  });

  await page.goto("./models/");
  await expect(page.getByRole("heading", { name: "Managed model inventory" })).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("webai-v1");
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          const ready =
            database.version === 3 && !database.objectStoreNames.contains("credentials");
          database.close();
          return ready;
        }),
    )
    .toBe(true);
  await expect(page.getByText("Legacy model record")).toBeVisible();
  const migrated = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("models", "readonly");
    const record = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore("models").get("legacy-model");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    return {
      version: database.version,
      stores: [...database.objectStoreNames],
      hasLegacyRecord: record !== undefined,
    };
  });
  expect(migrated).toEqual({
    version: 3,
    stores: ["blobs", "jobs", "models"],
    hasLegacyRecord: true,
  });
});

test("purges the retired Hugging Face credential store during the version-three upgrade", async ({
  page,
}) => {
  await page.goto("./about/");
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1", 2);
      request.addEventListener("upgradeneeded", () => {
        for (const store of ["models", "jobs", "blobs", "credentials"])
          request.result.createObjectStore(store, { keyPath: "id" });
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("credentials", "readwrite");
    transaction.objectStore("credentials").put({
      id: "hugging-face",
      token: `hf_${"s".repeat(32)}`,
      updatedAt: new Date().toISOString(),
    });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
  });

  await page.goto("./models/");
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("webai-v1");
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          const migrated =
            database.version === 3 && !database.objectStoreNames.contains("credentials");
          database.close();
          return migrated;
        }),
    )
    .toBe(true);
});

test("reopens IndexedDB after another tab stops blocking the version upgrade", async ({
  context,
  page,
}) => {
  const blocker = await context.newPage();
  await blocker.goto("./about/");
  await blocker.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1", 1);
      request.addEventListener("upgradeneeded", () => {
        for (const store of ["models", "jobs", "blobs"])
          request.result.createObjectStore(store, { keyPath: "id" });
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    (window as typeof window & { modelDatabaseBlocker?: IDBDatabase }).modelDatabaseBlocker =
      database;
  });

  await page.goto("./models/");
  await expect(page.getByText("blocking the model database upgrade")).toBeVisible();
  await blocker.evaluate(() => {
    (
      window as typeof window & { modelDatabaseBlocker?: IDBDatabase }
    ).modelDatabaseBlocker?.close();
  });
  await blocker.close();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("heading", { name: "No managed models yet" })).toBeVisible();
});

test("browses beyond the first candidate page, excludes restricted repositories, and downloads a match", async ({
  page,
}) => {
  const fixture = ggufFixture();
  const digest = createHash("sha256").update(fixture).digest("hex");
  const firstCommit = "1".repeat(40);
  const matchingCommit = "3".repeat(40);
  let searchPages = 0;
  let enrichmentRequests = 0;
  const searchParameters: Array<{
    filter: string | null;
    task: string | null;
    expand: string[];
  }> = [];
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/revision/")) {
      enrichmentRequests += 1;
      const matching = url.pathname.includes("fixture/browse-model");
      const sha = matching ? matchingCommit : firstCommit;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha,
          private: false,
          gated: false,
          pipeline_tag: "text-generation",
          tags: [
            "gguf",
            ...(matching ? ["reasoning", "tool-calling"] : []),
            matching ? "license:apache-2.0" : "license:mit",
          ],
          ...(matching ? { gguf: { architecture: "llama", context_length: 65_536 } } : {}),
          siblings: [
            {
              rfilename: matching ? "browse-Q4_K_M.gguf" : "first-Q8_0.gguf",
              size: matching ? fixture.byteLength : 6 * 1024 ** 3,
              lfs: {
                size: matching ? fixture.byteLength : 6 * 1024 ** 3,
                sha256: matching ? digest : "d".repeat(64),
              },
            },
          ],
        }),
      });
      return;
    }
    searchPages += 1;
    searchParameters.push({
      filter: url.searchParams.get("filter"),
      task: url.searchParams.get("pipeline_tag"),
      expand: url.searchParams.getAll("expand"),
    });
    if (url.searchParams.has("cursor")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify([
          {
            id: "fixture/browse-model",
            sha: matchingCommit,
            gated: false,
            downloads: 42,
            pipeline_tag: "text-generation",
            tags: ["gguf", "license:apache-2.0"],
          },
        ]),
      });
      return;
    }
    const next = new URL(url);
    next.searchParams.set("cursor", "opaque-fixture");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Link",
        Link: `<${next.href}>; rel="next"`,
      },
      body: JSON.stringify([
        {
          id: "fixture/first-model",
          sha: firstCommit,
          gated: false,
          pipeline_tag: "text-generation",
          tags: ["gguf", "license:mit"],
        },
        {
          id: "fixture/gated-model",
          sha: "2".repeat(40),
          gated: "manual",
          tags: ["gguf", "license:other"],
        },
        {
          id: "fixture/private-model",
          sha: "5".repeat(40),
          private: true,
          gated: false,
          tags: ["gguf", "license:other"],
        },
      ]),
    });
  });
  await page.route(
    `https://huggingface.co/fixture/browse-model/resolve/${matchingCommit}/browse-Q4_K_M.gguf`,
    async (route) => await fulfillRange(route, fixture, 0, fixture.byteLength - 1),
  );

  await page.goto("./models/");
  await expect(page.getByLabel("Minimum declared context (K tokens)")).toHaveValue("32");
  await expect(page.getByLabel("Maximum download size (GiB)")).toHaveValue("4");
  await page.getByLabel("Search models").fill("Qwen");
  await page.getByLabel("Thinking").check();
  await page.getByLabel("Tool Calling").check();
  await page.getByLabel("4-bit").check();
  const minimumContext = page.getByLabel("Minimum declared context (K tokens)");
  await minimumContext.fill("31.1");
  await page.getByLabel("Maximum download size (GiB)").fill("1");
  await page.getByRole("button", { name: "Browse models" }).click();
  await expect(minimumContext).toHaveValue("32");
  await expect(page.getByTestId("browse-filter-disclosure")).not.toHaveAttribute("open", "");

  const results = page.getByTestId("model-search-results");
  await expect(results).toContainText("persistent SQLite in OPFS");
  const match = results.getByTestId("browse-selected-detail");
  await expect(match).toHaveAttribute("data-enrichment-state", "ready");
  await expect(match).toHaveAttribute("data-repo-id", "fixture/browse-model");
  await expect(match).toContainText("Search filters matched");
  await expect(match).toContainText("apache-2.0");
  await expect(match).toContainText("Runtime memory fit unknown");
  await expect(match.getByRole("link", { name: "Open pinned model card" })).toHaveAttribute(
    "href",
    `https://huggingface.co/fixture/browse-model/blob/${matchingCommit}/README.md`,
  );
  await expect(match.getByRole("link", { name: "Open current model page" })).toHaveAttribute(
    "href",
    "https://huggingface.co/fixture/browse-model",
  );
  await expect(results).toContainText("3 excluded by confirmed metadata or artifact filters");
  await expect(results.locator('[data-repo-id="fixture/gated-model"]')).toHaveCount(0);
  await expect(results.locator('[data-repo-id="fixture/private-model"]')).toHaveCount(0);
  expect(searchPages).toBe(2);
  expect(searchParameters).toHaveLength(2);
  expect(
    searchParameters.every(
      (parameters) =>
        parameters.filter === "gguf" &&
        parameters.task === null &&
        parameters.expand.includes("gated"),
    ),
  ).toBe(true);
  await expect(match).toContainText(/Storage fit unknown|estimated remaining origin quota/u);
  expect(enrichmentRequests).toBe(2);

  await results
    .getByRole("region", { name: "Family / architecture" })
    .getByRole("button", { name: /^Llama/u })
    .click();
  await expect(match).toHaveAttribute("data-repo-id", "fixture/browse-model");
  await match.getByRole("button", { name: "Download Q4_K_M for fixture/browse-model" }).click();
  await expect(page.locator("[data-model-id]")).toContainText("fixture/browse-model · Q4_K_M");
  await page.getByTestId("browse-filter-disclosure").locator("summary").click();
  await expect(page.getByLabel("Search models")).toBeVisible();
  await page.getByLabel("Search models").fill("refined query");
  await expect(results.getByTestId("browse-selected-detail")).toHaveAttribute(
    "data-repo-id",
    "fixture/browse-model",
  );
  await expect(results).toContainText("These are the previous results");
  await page.getByLabel("Search models").fill("Qwen");
  await expect(results.locator(".browse-filter-stale")).toHaveCount(0);
  await minimumContext.fill("1");
  await page.getByRole("button", { name: "Browse models" }).click();
  await expect(page.getByTestId("browse-filter-disclosure")).not.toHaveAttribute("open", "");
  await page.getByTestId("browse-filter-disclosure").locator("summary").click();
  await minimumContext.fill("0.5");
  await expect(results).toContainText("These are the previous results");
});

test("restores and applies real default suitability filters", async ({ page }) => {
  const gibibyte = 1024 ** 3;
  const repositories = [
    { repo: "defaults/match", commit: "6".repeat(40), context: 32_768, size: 4 * gibibyte },
    { repo: "defaults/short", commit: "7".repeat(40), context: 16_384, size: gibibyte },
    {
      repo: "defaults/large",
      commit: "8".repeat(40),
      context: 32_768,
      size: 4 * gibibyte + 1,
    },
  ] as const;
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/revision/")) {
      const repository = repositories.find(({ repo }) => url.pathname.includes(repo));
      if (repository === undefined) throw new Error(`Unexpected repository URL: ${url.href}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: repository.commit,
          private: false,
          gated: false,
          tags: ["gguf"],
          gguf: { architecture: "llama", context_length: repository.context },
          siblings: [
            {
              rfilename: "model-Q4_K_M.gguf",
              size: repository.size,
              lfs: { size: repository.size, sha256: "c".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(
        repositories.map((repository) => ({
          id: repository.repo,
          sha: repository.commit,
          gated: false,
          tags: ["gguf"],
        })),
      ),
    });
  });

  await page.goto("./models/");
  const minimumContext = page.getByLabel("Minimum declared context (K tokens)");
  const maximumDownload = page.getByLabel("Maximum download size (GiB)");

  await minimumContext.fill("");
  await minimumContext.press("Enter");
  await expect(minimumContext).toHaveValue("32");
  let results = page.getByTestId("model-search-results");
  await expect(results).toContainText("1 matching repo");
  await expect(results).toContainText("2 excluded by confirmed metadata or artifact filters");
  await expect(results.getByTestId("browse-selected-detail")).toHaveAttribute(
    "data-repo-id",
    "defaults/match",
  );

  await page.getByTestId("browse-filter-disclosure").locator("summary").click();
  await maximumDownload.fill("");
  await maximumDownload.press("Enter");
  await expect(maximumDownload).toHaveValue("4");
  results = page.getByTestId("model-search-results");
  await expect(results).toContainText("1 matching repo");
  await expect(results).toContainText("2 excluded by confirmed metadata or artifact filters");
  await expect(page.getByTestId("browse-filter-disclosure")).toContainText("2 active filters");
});

test("requires every checked capability and excludes an incompatible declared task", async ({
  page,
}) => {
  const repositories = [
    {
      repo: "popular/parakeet",
      commit: "6".repeat(40),
      downloads: 1_000_000,
      pipelineTask: "automatic-speech-recognition",
      tags: ["gguf", "automatic-speech-recognition", "text-generation"],
      architecture: "parakeet",
    },
    {
      repo: "small/tool-model",
      commit: "7".repeat(40),
      downloads: 1,
      pipelineTask: "text-generation",
      tags: ["gguf", "tool-calling"],
      architecture: "llama",
    },
  ] as const;
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    const repository = repositories.find(({ repo }) => url.pathname.includes(repo));
    if (url.pathname.includes("/revision/") && repository !== undefined) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: repository.commit,
          private: false,
          gated: false,
          pipeline_tag: repository.pipelineTask,
          tags: repository.tags,
          gguf: { architecture: repository.architecture, context_length: 65_536 },
          siblings: [
            {
              rfilename: "model-Q4_K_M.gguf",
              size: 10,
              lfs: { size: 10, sha256: "a".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(
        repositories.map((item) => ({
          id: item.repo,
          sha: item.commit,
          private: false,
          gated: false,
          downloads: item.downloads,
          pipeline_tag: item.pipelineTask,
          tags: item.tags,
        })),
      ),
    });
  });

  await page.goto("./models/");
  await expect(page.getByText("Every checked capability is required (AND).")).toBeVisible();
  await page.getByLabel("Text generation").check();
  await page.getByLabel("Tool calling").check();
  await page.getByRole("button", { name: "Browse models" }).click();

  const results = page.getByTestId("model-search-results");
  await expect(results).toContainText("1 matching repo");
  await expect(results).toContainText("1 excluded by confirmed metadata or artifact filters");
  await expect(results.getByTestId("browse-selected-detail")).toHaveAttribute(
    "data-repo-id",
    "small/tool-model",
  );
  await expect(results.getByRole("region", { name: "Family / architecture" })).not.toContainText(
    "Parakeet",
  );
});

test("keeps the rendered ancestry within the admitted 32-repository graph", async ({ page }) => {
  const rootCommit = "8".repeat(40);
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/publisher/deep-lineage/revision/")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: rootCommit,
          private: false,
          gated: false,
          tags: ["gguf"],
          baseModels: { models: [{ id: "base/model-0" }] },
          gguf: { architecture: "deep", context_length: 65_536 },
          siblings: [
            {
              rfilename: "deep-Q4_K_M.gguf",
              size: 10,
              lfs: { size: 10, sha256: "a".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname !== "/api/models") {
      const repo = decodeURIComponent(url.pathname.slice("/api/models/".length));
      const index = Number(repo.split("-").at(-1));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: (index + 1).toString(16).padStart(40, "0"),
          private: false,
          gated: false,
          baseModels: { models: [{ id: `base/model-${index + 1}` }] },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify([
        {
          id: "publisher/deep-lineage",
          sha: rootCommit,
          private: false,
          gated: false,
          tags: ["gguf"],
        },
      ]),
    });
  });

  await page.goto("./models/");
  await page.getByRole("button", { name: "Browse models" }).click();
  const detail = page.getByTestId("browse-selected-detail");
  await expect(detail.locator(".lineage-warnings")).toContainText("safety boundary");
  await expect(detail.locator(".lineage-tree a")).toHaveCount(32);
  await expect(
    detail.locator('.lineage-tree a[href="https://huggingface.co/base/model-31"]'),
  ).toHaveCount(0);
});

test("drills from a declared family through models and repository variants into static details", async ({
  page,
}) => {
  const repositories: readonly {
    repo: string;
    commit: string;
    parents: readonly string[];
    relation?: "quantized";
    architecture?: string;
    downloads?: number;
  }[] = [
    {
      repo: "publisher/small-variant-a",
      commit: "a".repeat(40),
      parents: ["base/gemma-4-E2B"],
      relation: "quantized",
      architecture: "gemma4",
      downloads: Number.MAX_SAFE_INTEGER,
    },
    {
      repo: "publisher/small-variant-b",
      commit: "c".repeat(40),
      parents: ["base/gemma-4-E2B"],
      relation: "quantized",
      architecture: "gemma-4",
      downloads: 1,
    },
    {
      repo: "publisher/large-variant",
      commit: "d".repeat(40),
      parents: ["base/gemma-4-14B"],
      relation: "quantized",
      architecture: "gemma_4",
    },
    {
      repo: "publisher/literal-unknown",
      commit: "e".repeat(40),
      parents: ["base/alpha", "base/beta"],
      architecture: "unknown",
      downloads: Number.MAX_SAFE_INTEGER,
    },
    {
      repo: "publisher/literal-unknown-second",
      commit: "9".repeat(40),
      parents: ["base/alpha", "base/beta"],
      architecture: "unknown",
      downloads: 2,
    },
    {
      repo: "publisher/missing-architecture",
      commit: "f".repeat(40),
      parents: ["base/missing"],
    },
  ];
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/revision/")) {
      const repository = repositories.find(({ repo }) =>
        url.pathname.includes(`/${repo}/revision/`),
      );
      if (repository === undefined) throw new Error(`Unexpected repository URL: ${url.href}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: repository.commit,
          private: false,
          gated: false,
          tags: ["gguf", "license:apache-2.0"],
          baseModels: {
            ...(repository.relation === undefined ? {} : { relation: repository.relation }),
            models: repository.parents.map((id) => ({ id })),
          },
          gguf: {
            ...(repository.architecture === undefined
              ? {}
              : { architecture: repository.architecture }),
            context_length: 131_072,
          },
          siblings: [
            {
              rfilename: `${repository.repo.split("/")[1]}-Q4_K_M.gguf`,
              size: 10,
              lfs: { size: 10, sha256: "b".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname !== "/api/models") {
      const repo = decodeURIComponent(url.pathname.slice("/api/models/".length));
      if (repo === "base/missing") {
        await route.fulfill({
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
        return;
      }
      const lineageParents = new Map<string, readonly string[]>([
        ["base/gemma-4-E2B", ["base/gemma-4"]],
        ["base/gemma-4-14B", ["base/gemma-4"]],
        ["base/gemma-4", []],
        ["base/alpha", ["base/shared"]],
        ["base/beta", ["base/shared"]],
        ["base/shared", []],
      ]);
      const parents = lineageParents.get(repo);
      if (parents === undefined) throw new Error(`Unexpected lineage URL: ${url.href}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: createHash("sha1").update(repo).digest("hex"),
          private: false,
          gated: false,
          baseModels: {
            relation: "finetune",
            models: parents.map((id) => ({ id })),
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(
        repositories.map((repository) => ({
          id: repository.repo,
          sha: repository.commit,
          gated: false,
          downloads: repository.downloads,
          tags: ["gguf"],
        })),
      ),
    });
  });

  await page.goto("./models/");
  await page.getByLabel("Search models").fill("Gemma 4");
  await page.getByRole("button", { name: "Browse models" }).click();
  await expect(page.getByTestId("browse-filter-disclosure")).not.toHaveAttribute("open", "");

  const hierarchy = page.getByTestId("browse-hierarchy");
  expect(
    await hierarchy.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
    ),
  ).toBe(4);
  const columnHeights = await hierarchy
    .locator(":scope > section")
    .evaluateAll((columns) => columns.map((column) => column.getBoundingClientRect().height));
  expect(Math.max(...columnHeights) - Math.min(...columnHeights)).toBeLessThanOrEqual(1);
  const familyColumn = hierarchy.getByRole("region", { name: "Family / architecture" });
  await expect(familyColumn.getByRole("button")).toHaveCount(3);
  await expect(
    familyColumn.getByRole("button", { name: /^Architecture not declared/u }),
  ).toContainText("Hub downloads not reported");
  await expect(familyColumn.getByRole("button", { name: /^Unknown/u })).toBeVisible();
  const family = familyColumn.getByRole("button", { name: /^Gemma 4/u });
  await expect(familyColumn.getByRole("button").first()).toContainText("Unknown");
  await expect(family).toContainText("2 models · 3 variants");
  await expect(family).toContainText("1 variant unreported");
  await family.click();

  const modelColumn = hierarchy.locator(".browse-hierarchy-column").nth(1);
  await expect(modelColumn.getByRole("button").first()).toContainText("gemma-4-E2B");
  await expect(modelColumn.getByRole("button").first()).toContainText(
    `${(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toLocaleString()} Hub downloads (last 30 days)`,
  );
  await modelColumn.getByRole("button", { name: /^gemma-4-E2B/u }).click();
  const variantColumn = hierarchy.locator(".browse-hierarchy-column").nth(2);
  await expect(variantColumn.getByRole("button")).toHaveCount(2);
  const smallVariant = variantColumn.getByRole("button", {
    name: /^publisher\/small-variant-b/u,
  });
  await expect(smallVariant).toContainText("1 Hub download (last 30 days)");
  await smallVariant.click();
  const detail = page.getByTestId("browse-selected-detail");
  await expect(detail).toHaveAttribute("data-repo-id", "publisher/small-variant-b");
  await expect(detail.locator(".lineage-tree a")).toHaveText([
    "base/gemma-4",
    "base/gemma-4-E2B",
    "publisher/small-variant-b",
  ]);
  await expect(detail).not.toContainText("Quantized from");
  await expect(detail).not.toContainText("Current parent snapshot");
  await expect(detail.getByRole("link", { name: "Open pinned model card" })).toHaveAttribute(
    "href",
    `https://huggingface.co/publisher/small-variant-b/blob/${"c".repeat(40)}/README.md`,
  );

  await modelColumn.getByRole("button", { name: /^gemma-4-14B/u }).click();
  await expect(variantColumn.getByRole("button")).toHaveCount(1);
  await expect(detail).toHaveAttribute("data-repo-id", "publisher/large-variant");

  await familyColumn.getByRole("button", { name: /^Unknown/u }).click();
  await modelColumn.getByRole("button", { name: /^Multiple base models/u }).click();
  await expect(detail).toHaveAttribute("data-repo-id", "publisher/literal-unknown");
  await expect(
    detail.locator('.lineage-tree a[href="https://huggingface.co/base/alpha"]'),
  ).toBeVisible();
  await expect(
    detail.locator('.lineage-tree a[href="https://huggingface.co/base/beta"]'),
  ).toBeVisible();
  await expect(
    detail.locator('.lineage-tree a[href="https://huggingface.co/base/shared"]'),
  ).toBeVisible();

  await familyColumn.getByRole("button", { name: /^Architecture not declared/u }).click();
  await modelColumn.getByRole("button", { name: /^missing/u }).click();
  await expect(detail).toHaveAttribute("data-repo-id", "publisher/missing-architecture");
  await expect(detail.locator(".lineage-warnings")).toContainText(
    "Ancestry for base/missing could not be inspected: access is required.",
  );

  await page.setViewportSize({ width: 480, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    await hierarchy.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
    ),
  ).toBe(1);
});

test("automatically exhausts bounded cursor pages without an inspect-more action", async ({
  page,
}) => {
  const repositories = [
    { repo: "publisher/zeta", commit: "1".repeat(40), architecture: "zeta" },
    { repo: "publisher/beta", commit: "2".repeat(40), architecture: "beta" },
    { repo: "publisher/gamma", commit: "3".repeat(40), architecture: "gamma" },
    { repo: "publisher/delta", commit: "4".repeat(40), architecture: "delta" },
    { repo: "publisher/alpha", commit: "5".repeat(40), architecture: "alpha" },
  ] as const;
  const candidate = (index: number, declaresTask = true) => ({
    id: repositories[index]?.repo,
    sha: repositories[index]?.commit,
    gated: false,
    tags: ["gguf"],
    ...(declaresTask ? { pipeline_tag: "text-generation" } : {}),
  });
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/revision/")) {
      const repository = repositories.find(({ repo }) => url.pathname.includes(repo));
      if (repository === undefined) throw new Error(`Unexpected repository URL: ${url.href}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: repository.commit,
          private: false,
          gated: false,
          tags: ["gguf"],
          gguf: { architecture: repository.architecture, context_length: 32_768 },
          siblings: [
            {
              rfilename: `${repository.architecture}-Q4_K_M.gguf`,
              size: 10,
              lfs: { size: 10, sha256: "b".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    const cursor = url.searchParams.get("cursor");
    const pageIndex = cursor === null ? 0 : Number(cursor) - 1;
    const finalPage = cursor === "5";
    const body = finalPage ? [candidate(0, false), candidate(4)] : [candidate(pageIndex)];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Link",
        ...(finalPage
          ? {}
          : { Link: `<https://huggingface.co/api/models?cursor=${pageIndex + 2}>; rel="next"` }),
      },
      body: JSON.stringify(body),
    });
  });

  await page.goto("./models/");
  await page.getByLabel("Text Generation").check();
  await page.getByRole("button", { name: "Browse models" }).click();
  const hierarchy = page.getByTestId("browse-hierarchy");
  const familyColumn = hierarchy.getByRole("region", { name: "Family / architecture" });
  await expect(familyColumn.getByRole("button", { name: /^Alpha/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect more candidates" })).toHaveCount(0);
  await familyColumn.getByRole("button", { name: /^Zeta/u }).click();
  const detail = page.getByTestId("browse-selected-detail");
  await expect(detail).toHaveAttribute("data-repo-id", "publisher/zeta");
  await expect(detail).toHaveAttribute("data-enrichment-state", "ready");
  await expect(
    hierarchy.locator(".browse-hierarchy-column").nth(2).getByRole("button"),
  ).toHaveCount(1);
});

test("reports the actual inspected count when automatic discovery reaches its page boundary", async ({
  page,
}) => {
  let pageNumber = 0;
  await page.route("https://huggingface.co/api/models**", async (route) => {
    pageNumber += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Link",
        Link: `<https://huggingface.co/api/models?cursor=${pageNumber + 1}>; rel="next"`,
      },
      body: JSON.stringify(
        Array.from({ length: 8 }, (_, candidateIndex) => ({
          id: `publisher/truncated-${(pageNumber - 1) * 8 + candidateIndex + 1}`,
          gated: false,
          tags: ["gguf"],
        })),
      ),
    });
  });

  await page.goto("./models/");
  await page.getByRole("button", { name: "Browse models" }).click();

  const results = page.getByTestId("model-search-results");
  await expect(results).toContainText(
    "This broad search inspected 1,024 candidates and reached the bounded page/candidate safety boundary",
  );
  await expect(results.getByText("1024 results could not be inspected")).toBeVisible();
  expect(pageNumber).toBe(128);
});

test("persists anonymous revision details in the local SQLite catalog across a worker reload", async ({
  page,
}) => {
  const catalogRepositories = ["6", "7", "8", "a"].map((digit, index) => ({
    repo: `fixture/catalog-model-${index + 1}`,
    commit: digit.repeat(40),
  }));
  let revisionRequests = 0;
  const revisionAuthorizations: Array<string | undefined> = [];
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/revision/")) {
      const repository = catalogRepositories.find(({ repo }) =>
        url.pathname.includes(`/api/models/${repo}/revision/`),
      );
      if (repository === undefined) throw new Error(`Unexpected repository URL: ${url.href}`);
      revisionRequests += 1;
      revisionAuthorizations.push(route.request().headers().authorization);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: repository.commit,
          private: false,
          gated: false,
          pipeline_tag: "text-generation",
          tags: ["gguf", "reasoning", "license:apache-2.0"],
          baseModels: {
            relation: "quantized",
            models: [{ id: "base/catalog-model" }],
          },
          gguf: { architecture: "llama", context_length: 32_768 },
          siblings: [
            {
              rfilename: "catalog-Q4_K_M.gguf",
              size: 10,
              lfs: { size: 10, sha256: "f".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(
        catalogRepositories.map((repository) => ({
          id: repository.repo,
          sha: repository.commit,
          gated: false,
          tags: ["gguf"],
        })),
      ),
    });
  });

  const browse = async () => {
    await page.getByLabel("Search models").fill("catalog-model");
    await page.getByLabel("4-bit").check();
    await page.getByRole("button", { name: "Browse models" }).click();
    await expect(page.getByTestId("model-search-results")).toContainText(
      "persistent SQLite in OPFS",
    );
  };

  await page.goto("./models/");
  await expect(page.getByLabel("Hugging Face access token")).toHaveCount(0);
  await browse();
  expect(revisionRequests).toBe(4);
  expect(revisionAuthorizations).toEqual([undefined, undefined, undefined, undefined]);
  await page.getByTestId("browse-filter-disclosure").locator("summary").click();
  await page.getByLabel("Thinking").check();
  await page.getByRole("button", { name: "Browse models" }).click();
  expect(revisionRequests).toBe(4);
  await expect(page.getByTestId("model-search-results")).toContainText("4 cache hits this pass");
  await page.reload();
  await browse();
  expect(revisionRequests).toBe(4);
  await expect(page.getByTestId("model-search-results")).toContainText("4 cache hits this pass");
  await expect(
    page
      .locator(".browse-hierarchy-column")
      .nth(1)
      .getByRole("button", {
        name: /^catalog-model/u,
      }),
  ).toBeVisible();
});

test("falls back to network discovery instead of waiting for a busy catalog lock", async ({
  page,
}) => {
  const busyCommit = "9".repeat(40);
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(
        url.pathname.includes("/revision/")
          ? {
              sha: busyCommit,
              private: false,
              gated: false,
              tags: ["gguf"],
              siblings: [
                {
                  rfilename: "busy-Q4_K_M.gguf",
                  size: 10,
                  lfs: { size: 10, sha256: "e".repeat(64) },
                },
              ],
            }
          : [{ id: "fixture/busy-catalog", sha: busyCommit, gated: false, tags: ["gguf"] }],
      ),
    });
  });

  await page.goto("./models/");
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { releaseCatalogLock?: () => void };
    void navigator.locks.request(
      "webai-hugging-face-catalog-v1",
      async () =>
        await new Promise<void>((resolve) => {
          state.releaseCatalogLock = resolve;
        }),
    );
  });
  await expect
    .poll(async () => {
      const snapshot = await page.evaluate(async () => await navigator.locks.query());
      return snapshot.held?.some((lock) => lock.name === "webai-hugging-face-catalog-v1");
    })
    .toBe(true);

  await page.getByLabel("Search models").fill("busy-catalog");
  await page.getByRole("button", { name: "Browse models" }).click();
  const results = page.getByTestId("model-search-results");
  await expect(results.getByTestId("browse-selected-detail")).toHaveAttribute(
    "data-repo-id",
    "fixture/busy-catalog",
  );
  await expect(results).toContainText("memory fallback");
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { releaseCatalogLock?: () => void };
    state.releaseCatalogLock?.();
  });
});

test("rejects an unsafe maximum-size filter before sending a Hub request", async ({ page }) => {
  let hubRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).origin === "https://huggingface.co") hubRequests += 1;
  });
  await page.goto("./models/");
  const maximum = page.getByLabel("Maximum download size (GiB)");
  await maximum.fill("20000");
  expect(await maximum.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await page.getByRole("button", { name: "Browse models" }).click();
  await expect
    .poll(async () => await maximum.evaluate((input: HTMLInputElement) => input.validationMessage))
    .not.toBe("");
  expect(hubRequests).toBe(0);
});

test("keeps cancellation visible while automatic discovery is waiting", async ({ page }) => {
  const stoppedCommit = "4".repeat(40);
  let searchRequests = 0;
  let lineageRequests = 0;
  await page.route("https://huggingface.co/api/models**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/revision/")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: stoppedCommit,
          private: false,
          gated: false,
          tags: ["gguf"],
          baseModels: { models: [{ id: "base/stopped-parent" }] },
          gguf: { architecture: "llama", context_length: 65_536 },
          siblings: [
            {
              rfilename: "model-Q4_K_M.gguf",
              size: 10,
              lfs: { size: 10, sha256: "a".repeat(64) },
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname !== "/api/models") {
      lineageRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          sha: "5".repeat(40),
          private: false,
          gated: false,
          baseModels: { models: [] },
        }),
      });
      return;
    }
    searchRequests += 1;
    if (searchRequests === 1) {
      const next = new URL(url);
      next.searchParams.set("cursor", "rate-limited-page");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Link",
          Link: "<" + next.href + '>; rel="next"',
        },
        body: JSON.stringify([
          {
            id: "fixture/collected-before-stop",
            sha: stoppedCommit,
            gated: false,
            tags: ["gguf"],
          },
        ]),
      });
      return;
    }
    await route.fulfill({
      status: 429,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Retry-After",
        "Retry-After": "30",
      },
    });
  });

  await page.goto("./models/");
  await page.getByRole("button", { name: "Browse models" }).click();
  const pending = page.locator('[data-enrichment-state="pending"]');
  const stop = pending.getByRole("button", { name: "Stop searching" });
  await expect(stop).toBeVisible();
  await expect(pending).toContainText("1 candidate inspected across 1 page");
  await expect(pending.getByRole("progressbar")).toHaveCount(0);
  await expect(pending.getByRole("progressbar")).toBeVisible({ timeout: 2_000 });
  await stop.click();
  await expect(pending).toHaveCount(0);
  const results = page.getByTestId("model-search-results");
  await expect(results).toContainText("1 matching repo");
  await expect(results).toContainText("results collected before cancellation");
  await expect(results.getByTestId("browse-selected-detail")).toHaveAttribute(
    "data-repo-id",
    "fixture/collected-before-stop",
  );
  await expect(results.getByTestId("browse-selected-detail")).toContainText(
    "Full ancestry was not fetched because this search was stopped.",
  );
  await expect(
    results.getByTestId("browse-selected-detail").getByRole("link", {
      name: "base/stopped-parent",
    }),
  ).toHaveAttribute("href", "https://huggingface.co/base/stopped-parent");
  expect(lineageRequests).toBe(0);
  await expect(page.locator(".model-manager > p[role='status']")).toContainText(
    "Collected results are shown",
  );
});

test.describe("model browser coarse-pointer layout", () => {
  test.use({ hasTouch: true });

  test("keeps discovery inputs at the coarse-pointer target height", async ({ page }) => {
    await page.goto("./models/");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const control of [
      page.getByLabel("Search models"),
      page.locator(".browse-capabilities label").filter({ hasText: "Thinking" }),
    ]) {
      expect(
        await control.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
    }
  });
});

test("downloads and verifies a complete public Hugging Face LFS/Xet-backed GGUF", async ({
  page,
}) => {
  test.skip(
    process.env.WEBAI_LIVE_HF !== "1",
    "Set WEBAI_LIVE_HF=1 for the focused external-contract check.",
  );
  await page.goto("./models/");
  await page
    .getByLabel("Model ID or URL")
    .fill("ybelkada/tiny-random-llama-Q4_K_M-GGUF@429fe92916dae4839bfefb46bd0f61f50cc02c73");
  await page.getByRole("button", { name: "List files" }).click();
  await expect(page.getByTestId("resolved-repository")).toContainText("1.6 MiB");
  await page.getByTestId("resolved-repository").getByRole("button", { name: "Download" }).click();
  const installed = page.locator("[data-model-id]");
  await expect(installed).toContainText("ybelkada/tiny-random-llama-Q4_K_M-GGUF · Q4_K_M", {
    timeout: 60_000,
  });
  await expect(installed).toContainText("llama");
});
