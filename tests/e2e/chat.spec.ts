import { expect, type Page, test } from "@playwright/test";
import { wllamaRuntimeAssets } from "../../src/lib/runtimes/wllama-assets";

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

function ggufArray(elementType: number, values: readonly Buffer[]): Buffer {
  return Buffer.concat([u32(elementType), u64(values.length), ...values]);
}

function ggufFixture(): Buffer {
  return Buffer.concat([
    Buffer.from("GGUF"),
    u32(3),
    u64(0),
    u64(5),
    ggufEntry("general.architecture", 8, ggufString("llama")),
    ggufEntry("general.name", 8, ggufString("Chat loading fixture")),
    ggufEntry("llama.context_length", 4, u32(8192)),
    ggufEntry(
      "tokenizer.ggml.tokens",
      9,
      ggufArray(8, [ggufString("ordinary"), ggufString("<mystery|>"), ggufString("<channel|>")]),
    ),
    ggufEntry("tokenizer.ggml.token_type", 9, ggufArray(4, [u32(1), u32(4), u32(4)])),
  ]);
}

async function importChatFixture(page: Page): Promise<void> {
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "chat-load-Q4_K_M.gguf",
    mimeType: "application/octet-stream",
    buffer: ggufFixture(),
  });
  await expect(page.locator("[data-model-id]")).toContainText("chat-load-Q4_K_M.gguf");
}

test("gates chat on an installed model and reports the measured MTP limitation", async ({
  page,
}) => {
  await page.goto("./chat/");
  await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "wllama session" })).toBeVisible();
  await expect(page.getByLabel("Managed GGUF model")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Load model" })).toBeDisabled();
  await expect(page.getByText("MTP unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByText("mounts an MTP companion separately", { exact: false }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Load a model first")).toBeDisabled();
  await expect(page.locator("#prompt-api-gate-reason")).toContainText("Gemini Nano");
});

test("disables Gemini Nano with a reason when the Prompt API is missing", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("./chat/");
  const promptRuntime = page.getByLabel("Chrome Prompt API · Gemini Nano");
  await expect(promptRuntime).toBeDisabled();
  await expect(promptRuntime).toHaveAttribute("aria-describedby", "prompt-api-gate-reason");
  await expect(page.locator("#prompt-api-gate-reason")).toContainText(
    "does not expose the LanguageModel Prompt API",
  );
  await expect(page.getByLabel("wllama · managed GGUF")).toBeEnabled();
});

test("refreshes a volatile unavailable Prompt API gate", async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __webaiPromptAvailability?: "unavailable" | "available";
    };
    state.__webaiPromptAvailability = "unavailable";
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: {
        availability: async () => state.__webaiPromptAvailability,
        create: async () => undefined,
      },
    });
  });
  await page.goto("./chat/");
  const promptRuntime = page.getByLabel("Chrome Prompt API · Gemini Nano");
  await expect(promptRuntime).toBeDisabled();
  const refreshAvailability = page.getByRole("button", { name: "Refresh availability" });
  await expect(refreshAvailability).toBeVisible();
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __webaiPromptAvailability?: string }
    ).__webaiPromptAvailability = "available";
  });
  await refreshAvailability.click();
  await expect(promptRuntime).toBeEnabled();
  await expect(page.getByText("Gemini Nano ready", { exact: true })).toBeVisible();
});

test("downloads and chats with browser-managed Gemini Nano on the shared surface", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __webaiPromptProgress?: (loaded: number) => void;
      __webaiFinishPromptCreate?: () => void;
      __webaiPromptInputs?: string[];
      __webaiPromptDestroyCalls?: number;
    };
    state.__webaiPromptInputs = [];
    state.__webaiPromptDestroyCalls = 0;
    let installed = false;
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: {
        async availability(options: unknown) {
          (
            globalThis as typeof globalThis & { __webaiPromptAvailabilityOptions?: unknown }
          ).__webaiPromptAvailabilityOptions = options;
          return installed ? "available" : "downloadable";
        },
        create(options: {
          monitor(monitor: {
            addEventListener(
              type: "downloadprogress",
              listener: (event: { loaded: number; total: number }) => void,
            ): void;
          }): void;
        }) {
          let progressListener: ((event: { loaded: number; total: number }) => void) | undefined;
          options.monitor({
            addEventListener(_type, listener) {
              progressListener = listener;
            },
          });
          progressListener?.({ loaded: 0, total: 1 });
          state.__webaiPromptProgress = (loaded) => progressListener?.({ loaded, total: 1 });
          return new Promise((resolve) => {
            state.__webaiFinishPromptCreate = () => {
              installed = true;
              const events = new EventTarget();
              const session = {
                contextUsage: 0,
                contextWindow: 4_096,
                addEventListener: events.addEventListener.bind(events),
                removeEventListener: events.removeEventListener.bind(events),
                promptStreaming(input: string) {
                  state.__webaiPromptInputs?.push(input);
                  return new ReadableStream<string>({
                    start(controller) {
                      if (state.__webaiPromptInputs?.length === 2) {
                        events.dispatchEvent(new Event("contextoverflow"));
                      }
                      if (input !== "Empty response") {
                        controller.enqueue("Browser-managed ");
                        controller.enqueue("reply");
                      }
                      session.contextUsage += 12;
                      controller.close();
                    },
                  });
                },
                destroy() {
                  state.__webaiPromptDestroyCalls = (state.__webaiPromptDestroyCalls ?? 0) + 1;
                },
              };
              resolve(session);
            };
          });
        },
      },
    });
  });

  await page.goto("./chat/");
  const promptRuntime = page.getByLabel("Chrome Prompt API · Gemini Nano");
  await expect(promptRuntime).toBeEnabled();
  await promptRuntime.check();
  await expect(
    page.getByRole("heading", { level: 2, name: "Chrome Prompt API session" }),
  ).toBeVisible();
  await expect(page.getByLabel("Browser-managed model")).toHaveValue("gemini-nano");
  await expect(page.getByLabel("WASM threads")).toHaveCount(0);
  await expect(page.getByText("Stable web pages do not expose sampling controls")).toBeVisible();

  await page.getByRole("button", { name: "Download and load Gemini Nano" }).click();
  const progress = page.getByRole("progressbar", {
    name: "Downloading browser-managed Gemini Nano for Gemini Nano",
  });
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __webaiPromptProgress?: (loaded: number) => void }
    ).__webaiPromptProgress?.(0.5);
  });
  await expect(progress).toHaveAttribute("value", "0.5");
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __webaiPromptProgress?: (loaded: number) => void }
    ).__webaiPromptProgress?.(1);
  });
  const loadingProgress = page.getByRole("progressbar", {
    name: "Initializing browser-managed Gemini Nano for Gemini Nano",
  });
  await expect(loadingProgress).not.toHaveAttribute("value");
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __webaiFinishPromptCreate?: () => void }
    ).__webaiFinishPromptCreate?.();
  });
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Context window", { exact: true })).toBeVisible();
  await expect(page.getByText("4,096", { exact: true })).toBeVisible();

  const composer = page.getByLabel("Message");
  await composer.fill("First question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Browser-managed reply", { exact: true })).toBeVisible();
  await expect(page.locator(".response-metrics").first().getByText("First output")).toBeVisible();
  await expect(page.locator(".response-metrics").first().getByText("TTFT")).toHaveCount(0);
  await expect(page.getByText("12 / 4,096", { exact: true })).toBeVisible();
  await composer.fill("Second question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("24 / 4,096", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Chrome discarded one or more older conversation turns"),
  ).toBeVisible();
  await composer.fill("Empty response");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Gemini Nano completed without returning text.")).toBeVisible();
  await expect(page.getByText(/Expand the completed channels/)).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __webaiPromptInputs?: string[] }).__webaiPromptInputs,
    ),
  ).toEqual(["First question", "Second question", "Empty response"]);

  await page.getByLabel("wllama · managed GGUF").check();
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __webaiPromptDestroyCalls?: number })
          .__webaiPromptDestroyCalls,
    ),
  ).toBe(1);
});

test("shows reacquisition progress and stops a pending browser-managed session load", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __webaiPromptLoadAborted?: boolean };
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: {
        availability: async () => "available",
        create(options: {
          signal: AbortSignal;
          monitor(monitor: {
            addEventListener(
              type: "downloadprogress",
              listener: (event: { loaded: number; total: number }) => void,
            ): void;
          }): void;
        }) {
          options.monitor({
            addEventListener(_type, listener) {
              listener({ loaded: 0, total: 1 });
              listener({ loaded: 0.5, total: 1 });
            },
          });
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => {
                state.__webaiPromptLoadAborted = true;
                reject(new DOMException("stopped", "AbortError"));
              },
              { once: true },
            );
          });
        },
      },
    });
  });

  await page.goto("./chat/");
  await page.getByLabel("Chrome Prompt API · Gemini Nano").check();
  await page.getByRole("button", { name: "Load Gemini Nano" }).click();
  await expect(
    page.getByRole("progressbar", {
      name: "Downloading browser-managed Gemini Nano for Gemini Nano",
    }),
  ).toHaveAttribute("value", "0.5");
  const stop = page.getByRole("button", { name: "Stop Gemini Nano loading" });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __webaiPromptLoadAborted?: boolean })
            .__webaiPromptLoadAborted,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Load Gemini Nano" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keeps an explicit stopped state when Gemini Nano is aborted before output", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const events = new EventTarget();
    const session = {
      contextUsage: 0,
      contextWindow: 2_048,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      promptStreaming(_input: string, options?: { signal?: AbortSignal }) {
        return new ReadableStream<string>({
          start(controller) {
            options?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("racing failure", "NetworkError")),
              { once: true },
            );
          },
        });
      },
      destroy() {},
    };
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: {
        availability: async () => "available",
        async create(options: { monitor(monitor: { addEventListener(): void }): void }) {
          options.monitor({ addEventListener() {} });
          return session;
        },
      },
    });
  });

  await page.goto("./chat/");
  await page.getByLabel("Chrome Prompt API · Gemini Nano").check();
  await page.getByRole("button", { name: "Load Gemini Nano" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Wait forever");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(
    page.getByText("Generation stopped before the runtime returned text."),
  ).toBeVisible();
  await expect(page.getByText("Stopped response.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keeps runtime axes and the chat stream usable at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("./chat/");
  await expect(page.getByLabel("WASM threads")).toBeVisible();
  await expect(page.getByText("Full (wllama default)")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
});

test("shows truthful staged UI while wllama loads stored model bytes", async ({ page }) => {
  await importChatFixture(page);

  let releaseRuntimeAsset!: () => void;
  const runtimeAssetGate = new Promise<void>((resolve) => {
    releaseRuntimeAsset = resolve;
  });
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await runtimeAssetGate;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel() {
            await new Promise((resolve) => { globalThis.__webaiResolveModelLoad = resolve; });
          }
          async exit() {}
        }
      `,
    });
  });
  await page.goto("./chat/");
  await expect(page.getByLabel("Managed GGUF model")).not.toHaveValue("");
  await expect(page.getByLabel("Context tokens")).toHaveValue("8192");
  await expect(page.getByText("Model-declared maximum: 8,192")).toBeVisible();
  await page.getByRole("button", { name: "Load model" }).click();

  const loadingPanel = page.locator(".chat-load-progress");
  await expect(loadingPanel.getByText("Loading bundled wllama code")).toBeVisible();
  const assetsProgress = page.getByRole("progressbar", {
    name: "Loading bundled wllama code for chat-load-Q4_K_M.gguf",
  });
  await expect(assetsProgress).toBeVisible();
  await expect(assetsProgress).not.toHaveAttribute("value");

  releaseRuntimeAsset();
  await expect(
    loadingPanel.getByText("Initializing wllama and loading model weights"),
  ).toBeVisible();
  const progress = page.getByRole("progressbar", {
    name: "Initializing wllama and loading model weights for chat-load-Q4_K_M.gguf",
  });
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute("value");
  await expect(page.getByRole("button", { name: "Loading model" })).toBeDisabled();
  await expect(page.locator(".chat-panel")).toHaveAttribute("aria-busy", "true");

  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __webaiResolveModelLoad?: () => void };
    state.__webaiResolveModelLoad?.();
  });
  await expect(loadingPanel).toHaveCount(0);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Model load", { exact: true })).toBeVisible();
});

test("refreshes pre-diagnostic tokenizer metadata before loading an existing model", async ({
  page,
}) => {
  await importChatFixture(page);
  await page.evaluate(async () => {
    const result = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
    const database = await result(indexedDB.open("webai-v1", 1));
    const read = database.transaction("models", "readonly");
    const models = await result(read.objectStore("models").getAll());
    const write = database.transaction("models", "readwrite");
    for (const model of models) {
      write.objectStore("models").put({
        ...model,
        files: model.files.map((file: { inspection?: Record<string, unknown> }) => {
          if (file.inspection === undefined) return file;
          const inspection = { ...file.inspection };
          delete inspection.contextLength;
          if (Array.isArray(inspection.entries)) {
            inspection.entries = inspection.entries.filter(
              (entry: unknown) =>
                typeof entry !== "object" ||
                entry === null ||
                !("key" in entry) ||
                typeof entry.key !== "string" ||
                !entry.key.endsWith(".context_length"),
            );
          }
          delete inspection.specialTokenInventoryInspected;
          delete inspection.specialTokens;
          delete inspection.specialTokenCount;
          delete inspection.specialTokensTruncated;
          return { ...file, inspection };
        }),
      });
    }
  });
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel(_files, parameters) {
            globalThis.__webaiRefreshLoadParameters = parameters;
          }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  await expect(page.getByLabel("Managed GGUF model")).not.toHaveValue("");
  await expect(page.getByLabel("Context tokens")).toHaveValue("2048");
  await page.getByLabel("Context tokens").fill("4096");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __webaiRefreshLoadParameters?: { n_ctx?: number };
          }
        ).__webaiRefreshLoadParameters?.n_ctx,
    ),
  ).toBe(4096);
  expect(
    await page.evaluate(async () => {
      const result = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener("error", () => reject(request.error), { once: true });
        });
      const database = await result(indexedDB.open("webai-v1", 1));
      const transaction = database.transaction("models", "readonly");
      const models = await result(transaction.objectStore("models").getAll());
      return models.some((model) =>
        model.files.some(
          (file: { inspection?: { specialTokenInventoryInspected?: boolean } }) =>
            file.inspection?.specialTokenInventoryInspected === true,
        ),
      );
    }),
  ).toBe(true);
});

test("clears loading state and exposes a retry after wllama rejects a model", async ({ page }) => {
  await importChatFixture(page);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel() { throw new Error("controlled load rejection"); }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  await expect(page.getByLabel("Managed GGUF model")).not.toHaveValue("");
  const loadButton = page.getByRole("button", { name: "Load model" });
  await loadButton.click();

  await expect(page.getByRole("alert")).toContainText("wllama operation failed");
  await expect(page.locator(".chat-load-progress")).toHaveCount(0);
  await expect(page.locator(".chat-panel")).toHaveAttribute("aria-busy", "false");
  await expect(loadButton).toHaveAttribute("aria-busy", "false");
  await expect(loadButton).toBeEnabled();
});

test("disposes a wllama instance when selection changes during model load", async ({ page }) => {
  await importChatFixture(page);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel() {
            await new Promise((resolve) => { globalThis.__webaiResolveDisposedLoad = resolve; });
          }
          async exit() {
            globalThis.__webaiDisposedLoadExitCalls =
              (globalThis.__webaiDisposedLoadExitCalls ?? 0) + 1;
            globalThis.__webaiResolveDisposedLoad?.();
          }
        }
      `,
    });
  });

  await page.goto("./chat/");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(
    page.locator(".chat-load-progress").getByText("Initializing wllama and loading model weights"),
  ).toBeVisible();
  await page.getByLabel("Managed GGUF model").dispatchEvent("change");
  await expect(page.locator(".chat-load-progress")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __webaiDisposedLoadExitCalls?: number;
          }
        ).__webaiDisposedLoadExitCalls,
    ),
  ).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("streams reasoning-capable output and keeps response metrics compact", async ({ page }) => {
  await importChatFixture(page);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel(files, parameters) {
            globalThis.__webaiLoadedFileNames = files.map((file) => file.name);
            globalThis.__webaiLoadParameters = parameters;
          }
          async *createChatCompletion(parameters) {
            globalThis.__webaiCompletionParameters = parameters;
            yield {
              choices: [{ delta: { content: "Inspect the iron." } }],
            };
            await new Promise((resolve) => { globalThis.__webaiReleaseFinalChannel = resolve; });
            yield {
              choices: [{ delta: { content: "<chan" } }],
            };
            yield {
              choices: [{
                delta: { content: "nel|>Visible local reply." },
                logprobs: { content: [{ id: 2, token: "<channel|>" }] },
              }],
            };
            yield {
              choices: [{
                delta: { content: "<mystery|>" },
                logprobs: { content: [{ id: 1, token: "<mystery|>" }] },
              }],
            };
            yield { choices: [{}] };
            yield {
              choices: [{
                delta: { content: "<mystery|>" },
                logprobs: { content: [{ id: 1, token: "<mystery|>" }] },
              }],
            };
            yield {
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 4 },
              timings: {
                prompt_n: 12,
                prompt_per_second: 24,
                predicted_n: 4,
                predicted_per_second: 8,
              },
            };
          }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  await expect(page.getByLabel("Managed GGUF model")).not.toHaveValue("");
  await expect(page.getByLabel("Context tokens")).toHaveValue("8192");
  await page.getByLabel("Context tokens").fill("7168");
  await expect(page.getByLabel("Context tokens")).toHaveValue("7168");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Give me a visible answer.");
  await page.getByRole("button", { name: "Send" }).click();

  const response = page.locator(".chat-message-assistant");
  const thinking = response.locator("details.response-channel");
  await expect(response).toContainText("Inspect the iron.");
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __webaiReleaseFinalChannel?: () => void };
    state.__webaiReleaseFinalChannel?.();
  });
  await expect(thinking).toContainText("Thinking");
  await expect(thinking).toContainText("Inspect the iron.");
  await expect(response).toContainText("Visible local reply.");
  const outputDiagnostics = response.locator("details.response-output-diagnostics");
  await expect(outputDiagnostics).toContainText("Unrecognized model output");
  await expect(outputDiagnostics).toContainText("2 occurrences");
  await expect(outputDiagnostics).not.toHaveAttribute("open", "");
  await outputDiagnostics.locator("summary").click();
  await expect(outputDiagnostics).toContainText('"id":1');
  await expect(outputDiagnostics).toContainText('"typeName":"user-defined"');
  await expect(outputDiagnostics).not.toContainText('"id":2');
  await expect(thinking).not.toHaveAttribute("open", "");
  await thinking.locator("summary").click();
  await expect(thinking).toHaveAttribute("open", "");
  const metrics = response.locator(".response-metrics");
  await expect(metrics).toContainText("12 in · 4 out");
  await expect(metrics).not.toContainText("Not observed");
  expect(await metrics.evaluate((element) => getComputedStyle(element).display)).toBe("flex");
  expect(
    await metrics
      .locator("div")
      .first()
      .evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        display: getComputedStyle(element).display,
      })),
  ).toEqual({ background: "rgba(0, 0, 0, 0)", display: "flex" });
  expect(
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __webaiLoadParameters?: {
          reasoning_format?: string;
          ctx_shift?: boolean;
          n_ctx?: number;
        };
        __webaiLoadedFileNames?: string[];
        __webaiCompletionParameters?: {
          max_tokens?: number;
          logprobs?: boolean;
          top_logprobs?: number;
        };
      };
      return {
        reasoningFormat: state.__webaiLoadParameters?.reasoning_format,
        contextShift: state.__webaiLoadParameters?.ctx_shift,
        contextTokens: state.__webaiLoadParameters?.n_ctx,
        maxTokens: state.__webaiCompletionParameters?.max_tokens,
        logprobs: state.__webaiCompletionParameters?.logprobs,
        topLogprobs: state.__webaiCompletionParameters?.top_logprobs,
        loadedFileNames: state.__webaiLoadedFileNames,
      };
    }),
  ).toEqual({
    reasoningFormat: "none",
    contextShift: false,
    contextTokens: 7168,
    maxTokens: -1,
    logprobs: true,
    topLogprobs: 1,
    loadedFileNames: ["chat-load-Q4_K_M.gguf"],
  });

  const selectionColors = await page
    .locator(".chat-message-user .chat-message-content")
    .evaluate((element) => ({
      bubble: getComputedStyle(element.closest(".chat-message-user") as Element).backgroundColor,
      selection: getComputedStyle(element, "::selection").backgroundColor,
    }));
  expect(selectionColors.selection).not.toBe(selectionColors.bubble);
});

test("coalesces a runaway token stream without blocking the page", async ({ page }) => {
  await importChatFixture(page);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel() {}
          async *createChatCompletion() {
            yield { choices: [{ delta: { content: "<|channel>thought\\n" } }] };
            for (let index = 0; index < 50_000; index += 1) {
              yield { choices: [{ delta: { content: "<unused49>" } }] };
            }
            yield { choices: [{ delta: { content: "<|channel>final\\nDone." } }] };
          }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Stress the token stream.");
  await page.getByRole("button", { name: "Send" }).click();
  const response = page.locator(".chat-message-assistant");
  await expect(response).toContainText("Done.", { timeout: 10_000 });
  const thinking = response.locator("details.response-channel");
  await expect(thinking).not.toHaveAttribute("open", "");
  expect(await thinking.locator("p").evaluate((element) => element.textContent?.length)).toBe(
    500_000,
  );
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
});
