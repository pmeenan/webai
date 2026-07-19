import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
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
