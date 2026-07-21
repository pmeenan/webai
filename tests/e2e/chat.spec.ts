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

function ggufFixture(contextLength = 8192): Buffer {
  return Buffer.concat([
    Buffer.from("GGUF"),
    u32(3),
    u64(0),
    u64(5),
    ggufEntry("general.architecture", 8, ggufString("llama")),
    ggufEntry("general.name", 8, ggufString("Chat loading fixture")),
    ggufEntry("llama.context_length", 4, u32(contextLength)),
    ggufEntry(
      "tokenizer.ggml.tokens",
      9,
      ggufArray(8, [ggufString("ordinary"), ggufString("<mystery|>"), ggufString("<channel|>")]),
    ),
    ggufEntry("tokenizer.ggml.token_type", 9, ggufArray(4, [u32(1), u32(4), u32(4)])),
  ]);
}

async function importChatFixture(page: Page, contextLength = 8192): Promise<void> {
  await page.goto("./models/");
  await expect(page.getByText("No managed models yet")).toBeVisible();
  await page.getByLabel("Choose GGUF files").setInputFiles({
    name: "chat-load-Q4_K_M.gguf",
    mimeType: "application/octet-stream",
    buffer: ggufFixture(contextLength),
  });
  await expect(page.locator("[data-model-id]")).toContainText("chat-load-Q4_K_M.gguf");
}

async function stripChatFixtureInspection(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const result = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
    const database = await result(indexedDB.open("webai-v1"));
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
    await new Promise<void>((resolve, reject) => {
      write.addEventListener("complete", () => resolve(), { once: true });
      write.addEventListener("error", () => reject(write.error), { once: true });
      write.addEventListener("abort", () => reject(write.error), { once: true });
    });
  });
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
  await expect(page.getByRole("switch", { name: "Thinking" })).toBeChecked();
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
  await expect(page.getByRole("switch", { name: "Thinking" })).toBeDisabled();
  await expect(
    page.getByText("Chrome's Prompt API does not expose a thinking control."),
  ).toBeVisible();

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

  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(
    page.getByText("Start a new conversation before continuing with Gemini Nano."),
  ).toBeVisible();

  await page.getByLabel("wllama · managed GGUF").check();
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __webaiPromptDestroyCalls?: number })
          .__webaiPromptDestroyCalls,
    ),
  ).toBe(1);
  await promptRuntime.check();
  await page.getByRole("button", { name: "Load Gemini Nano" }).click();
  await expect(
    page.getByText(
      "This overflowed Gemini Nano transcript remains readable but cannot be replayed.",
    ),
  ).toBeVisible();
});

test("rebuilds Prompt API state from initial prompts before regeneration", async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __webaiPromptCreates?: unknown[];
      __webaiPromptInputs?: string[];
    };
    state.__webaiPromptCreates = [];
    state.__webaiPromptInputs = [];
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: {
        availability: async () => "available",
        create(options: { initialPrompts?: unknown[] }) {
          state.__webaiPromptCreates?.push(options.initialPrompts ?? []);
          const session = Object.assign(new EventTarget(), {
            contextUsage: 0,
            contextWindow: 4096,
            promptStreaming(input: string) {
              state.__webaiPromptInputs?.push(input);
              session.contextUsage += 5;
              return new ReadableStream<string>({
                start(controller) {
                  controller.enqueue(`Nano ${state.__webaiPromptInputs?.length ?? 0}`);
                  controller.close();
                },
              });
            },
            destroy() {},
          });
          return Promise.resolve(session);
        },
      },
    });
  });

  await page.goto("./chat/");
  await page.getByLabel("Chrome Prompt API · Gemini Nano").check();
  await page.getByLabel("System prompt").fill("Be exact.");
  await page.getByRole("button", { name: "Load Gemini Nano" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message-assistant")).toContainText("Nano 1");
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(page.locator(".chat-message-assistant")).toContainText("Nano 2");

  expect(
    await page.evaluate(() => ({
      creates: (globalThis as typeof globalThis & { __webaiPromptCreates?: unknown[] })
        .__webaiPromptCreates,
      inputs: (globalThis as typeof globalThis & { __webaiPromptInputs?: string[] })
        .__webaiPromptInputs,
    })),
  ).toEqual({
    creates: [
      [{ role: "system", content: "Be exact." }],
      [{ role: "system", content: "Be exact." }],
    ],
    inputs: ["Question", "Question"],
  });
});

test("seeds a manual replay and persists side-by-side response comparisons", async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __webaiReplayCreates?: unknown[][];
      __webaiReplayInputs?: string[];
    };
    state.__webaiReplayCreates = [];
    state.__webaiReplayInputs = [];
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: {
        availability: async () => "available",
        create(options: { initialPrompts?: unknown[] }) {
          state.__webaiReplayCreates?.push(options.initialPrompts ?? []);
          const session = Object.assign(new EventTarget(), {
            contextUsage: 0,
            contextWindow: 4096,
            promptStreaming(input: string) {
              state.__webaiReplayInputs?.push(input);
              const responseNumber = state.__webaiReplayInputs?.length ?? 0;
              session.contextUsage += 5;
              return new ReadableStream<string>({
                start(controller) {
                  controller.enqueue(`Measured reply ${responseNumber}`);
                  controller.close();
                },
              });
            },
            destroy() {},
          });
          return Promise.resolve(session);
        },
      },
    });
  });

  await page.goto("./chat/");
  await page.getByLabel("Chrome Prompt API · Gemini Nano").check();
  await page.getByLabel("Conversation name").fill("Replay source");
  await page.getByLabel("System prompt").fill("Keep the comparison exact.");
  await page.getByRole("button", { name: "Load Gemini Nano" }).click();
  await page.getByLabel("Message").fill("First source prompt");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message-assistant").last()).toContainText("Measured reply 1");
  await page.getByLabel("Message").fill("Second source prompt");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message-assistant").last()).toContainText("Measured reply 2");

  await page.getByRole("button", { name: "Manual replay" }).click();
  await expect(page.getByRole("heading", { name: "Compare with “Replay source”" })).toBeVisible();
  await expect(page.getByLabel("System prompt")).toHaveValue("Keep the comparison exact.");
  await expect(page.locator(".chat-message")).toHaveCount(0);
  await expect(page.getByLabel("Prompt 2 to send")).toHaveValue("Second source prompt");
  await page.getByLabel("Prompt 2 to send").fill("Adapted second prompt");
  await expect(page.getByRole("button", { name: "Send source prompt 2" })).toBeDisabled();

  await page.getByRole("button", { name: "Load Gemini Nano" }).click();
  await page.getByRole("button", { name: "Send source prompt 2" }).click();
  const secondComparison = page.locator(".replay-turn").nth(1);
  await expect(secondComparison.locator(".replay-response-grid article").nth(0)).toContainText(
    "Measured reply 2",
  );
  await expect(secondComparison.locator(".replay-response-grid article").nth(1)).toContainText(
    "Measured reply 3",
  );
  await expect(
    page.locator(".replay-turn").first().locator(".replay-response-grid article").nth(1),
  ).toContainText("Not sent yet.");
  await expect(secondComparison.locator(".replay-prompt-grid").locator("article")).toContainText(
    "Second source prompt",
  );
  await expect(page.locator(".chat-message-user")).toContainText("Adapted second prompt");
  await expect(page.getByRole("button", { name: /Edit user turn/ })).toHaveCount(0);

  expect(
    await page.evaluate(() => ({
      creates: (globalThis as typeof globalThis & { __webaiReplayCreates?: unknown[][] })
        .__webaiReplayCreates,
      inputs: (globalThis as typeof globalThis & { __webaiReplayInputs?: string[] })
        .__webaiReplayInputs,
    })),
  ).toEqual({
    creates: [
      [{ role: "system", content: "Keep the comparison exact." }],
      [{ role: "system", content: "Keep the comparison exact." }],
    ],
    inputs: ["First source prompt", "Second source prompt", "Adapted second prompt"],
  });

  await expect(page.getByText(/Saved locally in this browser/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Compare with “Replay source”" })).toBeVisible();
  await expect(
    page.locator(".replay-turn").nth(1).locator(".replay-response-grid article").nth(1),
  ).toContainText("Measured reply 3");
  await expect(page.getByLabel("Prompt 2 to send")).toHaveValue("Adapted second prompt");
  await expect(page.getByLabel("Prompt 2 to send")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Source prompt 2 sent" })).toBeDisabled();
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
  await expect(page.getByText("No session", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Load Gemini Nano" })).toBeEnabled();
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
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("8");
  await expect(page.getByText(/Model-declared maximum: 8 K tokens/u)).toBeVisible();
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
  await stripChatFixtureInspection(page);
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
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("2");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("8");
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __webaiRefreshLoadParameters?: { n_ctx?: number };
          }
        ).__webaiRefreshLoadParameters?.n_ctx,
    ),
  ).toBe(8192);

  await expect(page.getByText("Saved locally in this browser.")).toBeVisible();
  await stripChatFixtureInspection(page);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("webai-v1");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("chats", "readwrite");
    transaction.objectStore("chats").clear();
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
  });
  await page.evaluate(() => {
    delete (
      globalThis as typeof globalThis & {
        __webaiRefreshLoadParameters?: { n_ctx?: number };
      }
    ).__webaiRefreshLoadParameters;
  });
  await page.reload();
  await expect(page.getByLabel("Managed GGUF model")).not.toHaveValue("");
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("2");
  await page.getByLabel("Context (K tokens)").fill("4");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("4");
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
      const database = await result(indexedDB.open("webai-v1"));
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

test("keeps a non-whole-K model context maximum valid and passes exact tokens", async ({
  page,
}) => {
  await importChatFixture(page, 2500);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel(_files, parameters) {
            globalThis.__webaiNonWholeContextParameters = parameters;
          }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  const context = page.getByLabel("Context (K tokens)");
  await expect(context).toHaveValue("2.44140625");
  expect(await context.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await context.fill("2.1");
  await context.blur();
  await expect(context).toHaveValue("2.44140625");
  expect(await context.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);

  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __webaiNonWholeContextParameters?: { n_ctx?: number };
          }
        ).__webaiNonWholeContextParameters?.n_ctx,
    ),
  ).toBe(2500);
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
                cache_n: 6,
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
  const thinkingRequest = page.getByRole("switch", { name: "Thinking" });
  await expect(thinkingRequest).toBeChecked();
  await thinkingRequest.uncheck();
  await expect(thinkingRequest).not.toBeChecked();
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("8");
  await page.getByLabel("Context (K tokens)").fill("7.1");
  await page.getByLabel("Context (K tokens)").blur();
  await expect(page.getByLabel("Context (K tokens)")).toHaveValue("8");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Give me a visible answer.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(thinkingRequest).toBeDisabled();

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
  await expect(metrics).toContainText("6 tokens");
  await expect(response.locator("details.response-token-inspector").last()).toContainText(
    "Tokenizer inspector",
  );
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
          messages?: Array<{ role?: string; content?: string }>;
          max_tokens?: number;
          temperature?: number;
          top_k?: number;
          top_p?: number;
          penalty_repeat?: number;
          seed?: number;
          cache_prompt?: boolean;
          logprobs?: boolean;
          top_logprobs?: number;
          chat_template_kwargs?: { enable_thinking?: boolean };
        };
      };
      return {
        reasoningFormat: state.__webaiLoadParameters?.reasoning_format,
        contextShift: state.__webaiLoadParameters?.ctx_shift,
        contextTokens: state.__webaiLoadParameters?.n_ctx,
        maxTokens: state.__webaiCompletionParameters?.max_tokens,
        temperature: state.__webaiCompletionParameters?.temperature,
        topK: state.__webaiCompletionParameters?.top_k,
        topP: state.__webaiCompletionParameters?.top_p,
        repeatPenalty: state.__webaiCompletionParameters?.penalty_repeat,
        seed: state.__webaiCompletionParameters?.seed,
        cachePrompt: state.__webaiCompletionParameters?.cache_prompt,
        firstMessage: state.__webaiCompletionParameters?.messages?.[0],
        logprobs: state.__webaiCompletionParameters?.logprobs,
        topLogprobs: state.__webaiCompletionParameters?.top_logprobs,
        thinking: state.__webaiCompletionParameters?.chat_template_kwargs?.enable_thinking,
        loadedFileNames: state.__webaiLoadedFileNames,
      };
    }),
  ).toEqual({
    reasoningFormat: "none",
    contextShift: false,
    contextTokens: 8192,
    maxTokens: -1,
    temperature: 0.7,
    topK: 40,
    topP: 0.95,
    repeatPenalty: 1.1,
    seed: 42,
    cachePrompt: true,
    firstMessage: { role: "system", content: "You are a helpful assistant." },
    logprobs: true,
    topLogprobs: 1,
    thinking: false,
    loadedFileNames: ["chat-load-Q4_K_M.gguf"],
  });
  await expect(thinkingRequest).toBeEnabled();

  const selectionColors = await page
    .locator(".chat-message-user .chat-message-content")
    .evaluate((element) => ({
      bubble: getComputedStyle(element.closest(".chat-message-user") as Element).backgroundColor,
      selection: getComputedStyle(element, "::selection").backgroundColor,
    }));
  expect(selectionColors.selection).not.toBe(selectionColors.bubble);
});

test("changes the thinking template request between prompts without reloading", async ({
  page,
}) => {
  await importChatFixture(page);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel() {
            globalThis.__webaiThinkingLoadCount =
              (globalThis.__webaiThinkingLoadCount ?? 0) + 1;
          }
          async *createChatCompletion(parameters) {
            globalThis.__webaiThinkingRequests = [
              ...(globalThis.__webaiThinkingRequests ?? []),
              parameters.chat_template_kwargs?.enable_thinking,
            ];
            yield { choices: [{ delta: { content: "Local reply." } }] };
            yield {
              choices: [],
              usage: { prompt_tokens: 4, completion_tokens: 2 },
              timings: {
                prompt_n: 4,
                prompt_per_second: 8,
                predicted_n: 2,
                predicted_per_second: 4,
              },
            };
          }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  const thinkingRequest = page.getByRole("switch", { name: "Thinking" });
  const composer = page.getByLabel("Message");
  await expect(thinkingRequest).toBeChecked();
  await composer.fill("Use thinking.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message-assistant")).toHaveCount(1);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  await thinkingRequest.uncheck();
  await composer.fill("Skip thinking.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message-assistant")).toHaveCount(2);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  expect(
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __webaiThinkingLoadCount?: number;
        __webaiThinkingRequests?: boolean[];
      };
      return {
        loads: state.__webaiThinkingLoadCount,
        requests: state.__webaiThinkingRequests,
      };
    }),
  ).toEqual({ loads: 1, requests: [true, false] });
});

test("persists configured chats and supports edit-and-resend plus regenerate", async ({ page }) => {
  await importChatFixture(page);
  await page.route(`**${wllamaRuntimeAssets.script}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        export class Wllama {
          setCompat() {}
          async loadModel() {}
          async *createChatCompletion(parameters) {
            globalThis.__webaiM6Requests = [...(globalThis.__webaiM6Requests ?? []), parameters];
            const count = globalThis.__webaiM6Requests.length;
            yield { choices: [{ delta: { content: "Reply " + count }, logprobs: { content: [{ id: count, token: "Reply" }] } }] };
            yield {
              choices: [],
              usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
              timings: { cache_n: count === 1 ? 0 : 5, prompt_n: count === 1 ? 9 : 4, prompt_per_second: 9, predicted_n: 2, predicted_per_second: 2 },
            };
          }
          async exit() {}
        }
      `,
    });
  });

  await page.goto("./chat/");
  await page.getByLabel("System prompt").fill("Answer in exactly one sentence.");
  await page.getByLabel("Seed").fill("7");
  await page.getByLabel("Max output tokens").fill("33");
  await page.getByLabel("Temperature").fill("0.25");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByLabel("System prompt")).toHaveValue("Answer in exactly one sentence.");
  await page.getByLabel("Message").fill("Original question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message-assistant")).toContainText("Reply 1");
  await expect(page.getByText("Saved locally in this browser.")).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("webai-v1");
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          const transaction = database.transaction("chats", "readonly");
          const records = await new Promise<
            Array<{
              systemPrompt?: string;
              messages?: Array<{ execution?: { systemPrompt?: string } }>;
            }>
          >((resolve, reject) => {
            const request = transaction.objectStore("chats").getAll();
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          database.close();
          return {
            conversation: records[0]?.systemPrompt,
            response: records[0]?.messages?.find((message) => message.execution !== undefined)
              ?.execution?.systemPrompt,
          };
        }),
    )
    .toEqual({
      conversation: "Answer in exactly one sentence.",
      response: "Answer in exactly one sentence.",
    });

  await page.reload();
  await expect(page.getByText("Original question", { exact: true })).toBeVisible();
  await expect(page.getByText("Reply 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("System prompt")).toHaveValue("Answer in exactly one sentence.");
  await expect(page.getByLabel("Seed")).toHaveValue("7");
  await expect(page.getByLabel("Max output tokens")).toHaveValue("33");
  await expect(page.getByPlaceholder("Load a model first")).toBeDisabled();

  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit user turn 1" }).click();
  await page.getByLabel("Edit message").fill("Edited question");
  await page.getByRole("button", { name: "Resend and replace later turns" }).click();
  await expect(page.locator(".chat-message-user")).toHaveText(/Edited question/);
  await expect(page.locator(".chat-message-assistant")).toContainText("Reply 1");

  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(page.locator(".chat-message-assistant")).toContainText("Reply 2");
  expect(
    await page.evaluate(() => {
      const requests = (
        globalThis as typeof globalThis & {
          __webaiM6Requests?: Array<{
            messages: Array<{ role: string; content: string }>;
            temperature: number;
            max_tokens: number;
            seed: number;
            cache_prompt: boolean;
          }>;
        }
      ).__webaiM6Requests;
      return requests?.map((request) => ({
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        seed: request.seed,
        cachePrompt: request.cache_prompt,
      }));
    }),
  ).toEqual([
    {
      messages: [
        { role: "system", content: "Answer in exactly one sentence." },
        { role: "user", content: "Edited question" },
      ],
      temperature: 0.25,
      maxTokens: 33,
      seed: 7,
      cachePrompt: true,
    },
    {
      messages: [
        { role: "system", content: "Answer in exactly one sentence." },
        { role: "user", content: "Edited question" },
      ],
      temperature: 0.25,
      maxTokens: 33,
      seed: 7,
      cachePrompt: true,
    },
  ]);
  await page.getByLabel("Context (K tokens)").fill("4");
  await page.getByLabel("Context (K tokens)").press("Tab");
  await expect(page.getByText("No session", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Load a model first")).toBeDisabled();
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
            yield { choices: [{ delta: { content: "<|channel>thought\\n\\u0000" } }] };
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
  expect(
    await thinking.locator("p").evaluate((element) => element.textContent?.length ?? 0),
  ).toBeLessThanOrEqual(256 * 1024);
  await expect(page.getByText(/replaced it before displaying and saving/u)).toBeVisible();
  await expect(page.getByText(/was truncated for safe display and persistence/u)).toBeVisible();
  await expect(page.getByText("Saved locally in this browser.")).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
});

test("stops a wllama response even when the runtime does not poll its abort signal", async ({
  page,
}) => {
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
            yield { choices: [{ delta: { content: "Runaway partial output.<|cha" } }] };
            await new Promise(() => {});
          }
          async exit() {
            globalThis.__webaiStoppedGenerationExitCalls =
              (globalThis.__webaiStoppedGenerationExitCalls ?? 0) + 1;
          }
        }
      `,
    });
  });

  await page.goto("./chat/");
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message").fill("Do not stop on your own.");
  await page.getByRole("button", { name: "Send" }).click();
  const partialOutput = page.locator(".chat-message-assistant .chat-message-content");
  await expect(partialOutput).toHaveText("Runaway partial output.");
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByText("No session", { exact: true })).toBeVisible();
  await expect(partialOutput).toHaveText("Runaway partial output.<|cha");
  await expect(page.getByText("Stopped response. Partial output remains visible.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load model" })).toBeEnabled();
  await expect(page.getByLabel("Message")).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __webaiStoppedGenerationExitCalls?: number;
          }
        ).__webaiStoppedGenerationExitCalls,
    ),
  ).toBe(1);
});

test.describe("chat coarse-pointer layout", () => {
  test.use({ hasTouch: true });

  test("keeps the thinking switch at the coarse-pointer target height", async ({ page }) => {
    await page.goto("./chat/");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const height = await page
      .locator(".chat-thinking-toggle")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  });
});
