import { afterEach, describe, expect, test, vi } from "vitest";
import { PromptApiRuntimeAdapter, probePromptApi } from "./prompt-api";
import type { GenerationEvent, RuntimeLoadEvent } from "./types";

const originalLanguageModel = Object.getOwnPropertyDescriptor(globalThis, "LanguageModel");

function installLanguageModel(value: unknown): void {
  Object.defineProperty(globalThis, "LanguageModel", {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  if (originalLanguageModel === undefined) {
    Reflect.deleteProperty(globalThis, "LanguageModel");
  } else {
    Object.defineProperty(globalThis, "LanguageModel", originalLanguageModel);
  }
  vi.restoreAllMocks();
});

describe("PromptApiRuntimeAdapter", () => {
  test("distinguishes a missing API, unavailable model, and invalid browser response", async () => {
    installLanguageModel(undefined);
    await expect(probePromptApi()).resolves.toMatchObject({
      verdict: "unsupported",
      reasonCode: "api-missing",
    });

    installLanguageModel({
      availability: async () => "unavailable",
      create: async () => undefined,
    });
    await expect(probePromptApi()).resolves.toMatchObject({
      verdict: "unsupported",
      availability: "unavailable",
      reasonCode: "model-unavailable",
    });

    installLanguageModel({
      availability: async () => "surprising-new-state",
      create: async () => undefined,
    });
    await expect(probePromptApi()).resolves.toMatchObject({
      verdict: "unknown",
      reasonCode: "invalid-api-response",
    });

    installLanguageModel({
      availability: async () => ({ toString: () => "available" }),
      create: async () => undefined,
    });
    await expect(probePromptApi()).resolves.toMatchObject({
      verdict: "unknown",
      reasonCode: "invalid-api-response",
    });
  });

  test("bounds an availability check that never settles", async () => {
    vi.useFakeTimers();
    try {
      installLanguageModel({
        availability: () => new Promise(() => undefined),
        create: async () => undefined,
      });
      const probe = probePromptApi();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(probe).resolves.toMatchObject({
        verdict: "unknown",
        reasonCode: "probe-failed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("starts browser acquisition synchronously and reports fractional then indeterminate progress", async () => {
    const progress: RuntimeLoadEvent[] = [];
    let createCalls = 0;
    let createOptions:
      | {
          readonly expectedInputs: readonly unknown[];
          readonly expectedOutputs: readonly unknown[];
          readonly signal: AbortSignal;
        }
      | undefined;
    const session = Object.assign(new EventTarget(), {
      contextUsage: 7,
      contextWindow: 4_096,
      promptStreaming: () => new ReadableStream<string>(),
      destroy: vi.fn(),
    });
    installLanguageModel({
      availability: async () => "downloadable",
      create: async (
        options: typeof createOptions & {
          monitor: (monitor: {
            addEventListener: (
              type: "downloadprogress",
              listener: (event: { loaded: number; total: number }) => void,
            ) => void;
          }) => void;
        },
      ) => {
        createCalls += 1;
        createOptions = options;
        options.monitor({
          addEventListener: (_type, listener) => {
            listener({ loaded: 0.25, total: 1 });
            listener({ loaded: 1, total: 1 });
            listener({ loaded: 1, total: 1 });
            listener({ loaded: 0.75, total: 1 });
          },
        });
        return session;
      },
    });

    const adapter = new PromptApiRuntimeAdapter();
    await expect(adapter.probe()).resolves.toMatchObject({ availability: "downloadable" });
    const creation = adapter.createSession((event) => progress.push(event));
    expect(createCalls).toBe(1);
    await expect(creation).resolves.toMatchObject({
      runtimeId: "prompt-api",
      contextUsage: 7,
      contextWindow: 4_096,
      modelTarget: { kind: "browser-managed", model: "gemini-nano" },
    });
    expect(createOptions?.expectedInputs).toEqual([{ type: "text", languages: ["en"] }]);
    expect(createOptions?.expectedOutputs).toEqual([{ type: "text", languages: ["en"] }]);
    expect(createOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(progress).toEqual([
      { phase: "browser-model-download", loaded: 0.25, total: 1 },
      { phase: "browser-model-loading" },
    ]);
  });

  test("streams only the new user turn and reports only browser-observable metrics", async () => {
    let receivedPrompt = "";
    const session = Object.assign(new EventTarget(), {
      contextUsage: 0,
      contextWindow: 2_048,
      promptStreaming: (prompt: string) => {
        receivedPrompt = prompt;
        return new ReadableStream<string>({
          start(controller) {
            session.dispatchEvent(new Event("contextoverflow"));
            controller.enqueue("Local ");
            controller.enqueue("reply");
            session.contextUsage = 42;
            controller.close();
          },
        });
      },
      destroy: vi.fn(),
    });
    installLanguageModel({
      availability: async () => "available",
      create: async () => session,
    });
    const adapter = new PromptApiRuntimeAdapter();
    await adapter.probe();
    await adapter.createSession();
    const events: GenerationEvent[] = [];
    await adapter.generate(
      [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      {},
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(receivedPrompt).toBe("new question");
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Local " },
      { type: "text", text: "reply" },
    ]);
    expect(events).toContainEqual({
      type: "warning",
      warning: expect.objectContaining({ code: "context-overflow" }),
    });
    const metrics = events.find((event) => event.type === "metrics");
    expect(metrics).toMatchObject({
      type: "metrics",
      metrics: { contextUsage: 42, contextWindow: 2_048 },
    });
    if (metrics?.type !== "metrics") throw new Error("Expected metrics");
    expect(metrics.metrics.promptTokens).toBeUndefined();
    expect(metrics.metrics.completionTokens).toBeUndefined();
    expect(metrics.metrics.prefillTokensPerSecond).toBeUndefined();
    expect(metrics.metrics.decodeTokensPerSecond).toBeUndefined();
    expect(metrics.metrics.timeToFirstOutputMs).toEqual(expect.any(Number));
    expect(metrics.metrics.timeToFirstTokenMs).toBeUndefined();

    for (const thinking of [false, true])
      await expect(
        adapter.generate(
          [{ role: "user", content: "try explicit thinking" }],
          { thinking },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toMatchObject({
        failure: {
          code: "unsupported",
          message: expect.stringContaining("does not expose a thinking control"),
        },
      });

    await adapter.dispose();
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  test("maps browser failures to safe typed messages without exposing native detail", async () => {
    installLanguageModel({
      availability: async () => "downloadable",
      create: async () => {
        throw new DOMException("private browser path", "NetworkError");
      },
    });
    const adapter = new PromptApiRuntimeAdapter();
    await adapter.probe();
    await expect(adapter.createSession()).rejects.toMatchObject({
      failure: {
        code: "network",
        phase: "load",
        retryable: true,
      },
    });
    await expect(adapter.createSession()).rejects.not.toThrow("private browser path");
  });

  test("gives load and generation failures phase-appropriate recovery advice", async () => {
    installLanguageModel({
      availability: async () => "downloadable",
      create: async () => {
        throw new DOMException("private storage detail", "QuotaExceededError");
      },
    });
    const adapter = new PromptApiRuntimeAdapter();
    await adapter.probe();
    await expect(adapter.createSession()).rejects.toMatchObject({
      failure: {
        code: "quota",
        phase: "load",
        message: expect.stringContaining("browser storage"),
      },
    });
    await expect(adapter.createSession()).rejects.not.toThrow("shorter prompt");

    const session = Object.assign(new EventTarget(), {
      contextUsage: 0,
      contextWindow: 2_048,
      promptStreaming: () =>
        new ReadableStream<string>({
          start(controller) {
            controller.error(new DOMException("private network detail", "NetworkError"));
          },
        }),
      destroy: vi.fn(),
    });
    installLanguageModel({
      availability: async () => "available",
      create: async () => session,
    });
    await adapter.probe();
    await adapter.createSession();
    const generation = adapter.generate(
      [{ role: "user", content: "hello" }],
      {},
      new AbortController().signal,
      () => undefined,
    );
    await expect(generation).rejects.toMatchObject({
      failure: {
        code: "network",
        phase: "generate",
        message: expect.stringContaining("response was interrupted"),
      },
    });
    await expect(
      adapter.generate(
        [{ role: "user", content: "hello" }],
        {},
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.not.toThrow("download the browser-managed");
  });

  test("accepts the specification's fractional usage and unbounded context window", async () => {
    const session = Object.assign(new EventTarget(), {
      contextUsage: 1.5,
      contextWindow: Number.POSITIVE_INFINITY,
      promptStreaming: () => new ReadableStream<string>(),
      destroy: vi.fn(),
    });
    installLanguageModel({
      availability: async () => "available",
      create: async () => session,
    });
    const adapter = new PromptApiRuntimeAdapter();
    await adapter.probe();
    await expect(adapter.createSession()).resolves.toMatchObject({
      contextUsage: 1.5,
      contextWindow: Number.POSITIVE_INFINITY,
    });
  });

  test("settles creation when disposal aborts a browser promise that does not cooperate", async () => {
    installLanguageModel({
      availability: async () => "available",
      create: () => new Promise(() => undefined),
    });
    const adapter = new PromptApiRuntimeAdapter();
    await adapter.probe();
    const creation = adapter.createSession();
    await adapter.dispose();
    await expect(creation).rejects.toMatchObject({ failure: { code: "aborted", phase: "load" } });
  });

  test("destroys a malformed session that resolves after creation was aborted", async () => {
    let resolveCreation: ((value: unknown) => void) | undefined;
    installLanguageModel({
      availability: async () => "available",
      create: () =>
        new Promise((resolve) => {
          resolveCreation = resolve;
        }),
    });
    const adapter = new PromptApiRuntimeAdapter();
    await adapter.probe();
    const creation = adapter.createSession();
    await adapter.dispose();
    await expect(creation).rejects.toMatchObject({ failure: { code: "aborted", phase: "load" } });

    const destroy = vi.fn();
    resolveCreation?.({ destroy });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  });
});
