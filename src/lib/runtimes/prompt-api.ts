import { runBoundedOperation } from "../bounded-operation";
import type { ModelFailure } from "../models/types";
import { ModelOperationError } from "../models/types";
import {
  isPromptApiAvailability,
  type PromptApiAvailability,
  promptApiProbeTimeoutMs,
  promptApiTextOptions,
} from "../prompt-api-surface";
import type {
  GenerationEvent,
  GenerationOptions,
  PromptApiRuntimeDescriptor,
  PromptApiRuntimeSession,
  RuntimeAdapter,
  RuntimeLoadEvent,
  RuntimeMessage,
} from "./types";

export type { PromptApiAvailability } from "../prompt-api-surface";

export interface PromptApiProbe {
  readonly verdict: "supported" | "degraded" | "unsupported" | "unknown";
  readonly availability?: PromptApiAvailability;
  readonly reasonCode:
    | "available"
    | "download-required"
    | "download-in-progress"
    | "api-missing"
    | "model-unavailable"
    | "probe-failed"
    | "invalid-api-response";
  readonly explanation: string;
}

interface LanguageModelSessionSurface extends EventTarget {
  readonly contextUsage: number;
  readonly contextWindow: number;
  promptStreaming(
    input: string,
    options?: { readonly signal?: AbortSignal },
  ): ReadableStream<string>;
  destroy(): void;
}

interface LanguageModelCreateMonitor {
  addEventListener(
    type: "downloadprogress",
    listener: (event: { readonly loaded: number; readonly total: number }) => void,
  ): void;
}

interface LanguageModelCreateOptions {
  readonly expectedInputs: readonly [
    { readonly type: "text"; readonly languages: readonly ["en"] },
  ];
  readonly expectedOutputs: readonly [
    { readonly type: "text"; readonly languages: readonly ["en"] },
  ];
  readonly signal: AbortSignal;
  readonly monitor: (monitor: LanguageModelCreateMonitor) => void;
  readonly initialPrompts?: readonly RuntimeMessage[];
}

interface LanguageModelFactorySurface {
  availability(options: typeof promptApiTextOptions): Promise<unknown>;
  create(options: LanguageModelCreateOptions): Promise<unknown>;
}

export const promptApiModelTarget = {
  kind: "browser-managed",
  runtimeId: "prompt-api",
  model: "gemini-nano",
} as const;

export const promptApiDescriptor: PromptApiRuntimeDescriptor = {
  id: "prompt-api",
  displayName: "Chrome Prompt API",
  adapterVersion: "webai-1",
  engineVersion: "Browser-managed Gemini Nano",
  acquisitionOwnership: "browser-managed",
  executionContext: "browser-managed-main-thread",
  generationControls: {
    systemPrompt: true,
    temperature: false,
    topP: false,
    topK: false,
    maxTokens: false,
    repeatPenalty: false,
    seed: false,
  },
  contextCaching: {
    supported: true,
    kind: "browser-managed-state",
    explanation:
      "Chrome retains conversation state inside the browser-managed session. It exposes context usage, not KV-cache mechanics or cached-token counts.",
  },
  tokenizerInspection: {
    kind: "context-usage-only",
    explanation:
      "The Prompt API deliberately hides model tokenization. Chrome exposes implementation-defined context usage and window values only.",
  },
};

function failure(
  phase: ModelFailure["phase"],
  message: string,
  code: ModelFailure["code"] = "unsupported",
  retryable = false,
): ModelOperationError {
  return new ModelOperationError({ code, phase, message, retryable });
}

function languageModelFactory(): LanguageModelFactorySurface | undefined {
  const candidate = (globalThis as typeof globalThis & { readonly LanguageModel?: unknown })
    .LanguageModel;
  if (
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    candidate === null ||
    !("availability" in candidate) ||
    !("create" in candidate) ||
    typeof candidate.availability !== "function" ||
    typeof candidate.create !== "function"
  ) {
    return undefined;
  }
  return candidate as LanguageModelFactorySurface;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveNumberOrInfinity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value > 0 &&
    (Number.isFinite(value) || value === Number.POSITIVE_INFINITY)
  );
}

export async function probePromptApi(): Promise<PromptApiProbe> {
  let factory: LanguageModelFactorySurface | undefined;
  try {
    factory = languageModelFactory();
  } catch {
    return {
      verdict: "unknown",
      reasonCode: "probe-failed",
      explanation:
        "The browser's Prompt API surface could not be inspected safely. Refresh the probe or select wllama.",
    };
  }
  if (factory === undefined) {
    return {
      verdict: "unsupported",
      reasonCode: "api-missing",
      explanation:
        "This browser does not expose the LanguageModel Prompt API. Use an eligible desktop Chrome 148 or newer profile, or select wllama.",
    };
  }
  const result = await runBoundedOperation(
    () => Promise.resolve(factory.availability(promptApiTextOptions)),
    promptApiProbeTimeoutMs,
  );
  if (result.kind !== "value") {
    return {
      verdict: "unknown",
      reasonCode: "probe-failed",
      explanation:
        result.kind === "timeout"
          ? "The browser's Gemini Nano availability check did not finish within five seconds. Retry the probe or select wllama."
          : "The browser exposed the Prompt API, but its Gemini Nano availability check failed. Refresh the probe or select wllama.",
    };
  }
  const availability = result.value;
  if (!isPromptApiAvailability(availability)) {
    return {
      verdict: "unknown",
      reasonCode: "invalid-api-response",
      explanation:
        "The browser returned an unrecognized Prompt API availability state. The option stays disabled to avoid an unsafe assumption.",
    };
  }
  const common = {
    availability,
  };
  switch (availability) {
    case "available":
      return {
        ...common,
        verdict: "supported",
        reasonCode: "available",
        explanation: "Gemini Nano is installed and the browser reports it ready for text chat.",
      };
    case "downloadable":
      return {
        ...common,
        verdict: "degraded",
        reasonCode: "download-required",
        explanation:
          "Gemini Nano is supported but not installed. Loading a session will ask Chrome to download it and report browser-managed progress.",
      };
    case "downloading":
      return {
        ...common,
        verdict: "degraded",
        reasonCode: "download-in-progress",
        explanation:
          "Chrome is already downloading Gemini Nano. Loading a session will attach to browser-managed progress.",
      };
    case "unavailable":
      return {
        ...common,
        verdict: "unsupported",
        reasonCode: "model-unavailable",
        explanation:
          "This browser exposes the Prompt API, but Gemini Nano is unavailable for this device or profile. Check Chrome's desktop hardware, storage, and unmetered-network requirements.",
      };
  }
}

function isLanguageModelSession(value: unknown): value is LanguageModelSessionSurface {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<LanguageModelSessionSurface>;
  return (
    typeof session.promptStreaming === "function" &&
    typeof session.destroy === "function" &&
    typeof session.addEventListener === "function" &&
    typeof session.removeEventListener === "function" &&
    positiveNumberOrInfinity(session.contextWindow) &&
    nonNegativeFinite(session.contextUsage) &&
    session.contextUsage <= session.contextWindow
  );
}

function destroyIfPossible(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  try {
    const destroy = Reflect.get(value, "destroy");
    if (typeof destroy === "function") destroy.call(value);
  } catch {
    // The adapter has already rejected or abandoned this browser-owned object.
  }
}

function safePromptApiFailure(error: unknown, phase: "load" | "generate"): ModelOperationError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "AbortError") {
    return failure(
      phase,
      phase === "load" ? "Gemini Nano session loading was stopped." : "Generation was stopped.",
      "aborted",
      true,
    );
  }
  if (name === "QuotaExceededError") {
    return failure(
      phase,
      phase === "load"
        ? "Chrome could not allocate enough browser storage for Gemini Nano. Free storage and retry the session load."
        : "Gemini Nano could not fit this request in its context window. Start a new session or use a shorter prompt.",
      "quota",
      true,
    );
  }
  if (name === "NetworkError") {
    return failure(
      phase,
      phase === "load"
        ? "Chrome could not download the browser-managed Gemini Nano model. Check the network and storage requirements, then retry."
        : "The Prompt API response was interrupted by a browser or network failure. Retry the prompt.",
      "network",
      true,
    );
  }
  if (name === "NotSupportedError") {
    return failure(
      phase,
      "Gemini Nano does not support the requested English text session on this device.",
      "unsupported",
      false,
    );
  }
  if (name === "NotAllowedError") {
    return failure(
      phase,
      phase === "load"
        ? "Chrome did not allow Prompt API session creation. Use the Load button in the top-level page and check browser policy permissions."
        : "Chrome did not allow this Prompt API request in the current page context.",
      "unsupported",
      true,
    );
  }
  if (name === "InvalidStateError") {
    return failure(
      phase,
      "The Prompt API requires an active page. Return to this tab and retry the operation.",
      "unsupported",
      true,
    );
  }
  if (name === "NotReadableError") {
    return failure(
      phase,
      "Chrome filtered this Gemini Nano response and did not expose its text.",
      "unsupported",
      true,
    );
  }
  return failure(
    phase,
    phase === "load"
      ? "Chrome could not create a Gemini Nano Prompt API session. Check its availability and retry."
      : "The Prompt API stopped before completing this response.",
    "unsupported",
    true,
  );
}

export class PromptApiRuntimeAdapter implements RuntimeAdapter {
  #runtime: LanguageModelSessionSurface | undefined;
  #session: PromptApiRuntimeSession | undefined;
  #creationController: AbortController | undefined;
  #lastProbe: PromptApiProbe | undefined;
  #probeGeneration = 0;
  #lifecycle = 0;

  get descriptor(): PromptApiRuntimeDescriptor {
    return promptApiDescriptor;
  }

  async probe(): Promise<PromptApiProbe> {
    const generation = ++this.#probeGeneration;
    const result = await probePromptApi();
    if (generation === this.#probeGeneration) this.#lastProbe = result;
    return result;
  }

  async createSession(
    initialPrompts: readonly RuntimeMessage[] = [],
    onProgress?: (event: RuntimeLoadEvent) => void,
  ): Promise<PromptApiRuntimeSession> {
    // Keep create() in the synchronous part of the user-click call stack. Starting a
    // browser-managed download can require transient user activation.
    this.#disposeCurrent();
    const lifecycle = this.#lifecycle;
    let factory: LanguageModelFactorySurface | undefined;
    try {
      factory = languageModelFactory();
    } catch {
      throw failure(
        "load",
        "Chrome's Prompt API surface could not be inspected safely. Refresh availability and retry.",
        "protocol",
        true,
      );
    }
    if (factory === undefined) {
      throw failure("load", "This browser does not expose the LanguageModel Prompt API.");
    }
    const probe = this.#lastProbe;
    if (probe?.availability === "unavailable") {
      throw failure("load", probe.explanation, "unsupported", probe.verdict === "unknown");
    }
    const controller = new AbortController();
    this.#creationController = controller;
    const started = performance.now();
    let finishedDownload = false;
    let lastDownloadProgress = 0;
    try {
      const creation = factory.create({
        ...promptApiTextOptions,
        ...(initialPrompts.length === 0 ? {} : { initialPrompts }),
        signal: controller.signal,
        monitor: (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            if (lifecycle !== this.#lifecycle || finishedDownload) return;
            const loaded = Math.max(
              lastDownloadProgress,
              Math.min(1, Math.max(0, nonNegativeFinite(event.loaded) ? event.loaded : 0)),
            );
            lastDownloadProgress = loaded;
            if (loaded === 1) {
              finishedDownload = true;
              onProgress?.({ phase: "browser-model-loading" });
              return;
            }
            onProgress?.({ phase: "browser-model-download", loaded, total: 1 });
          });
        },
      });
      const created = await this.#awaitCreation(creation, controller.signal);
      if (lifecycle !== this.#lifecycle) {
        destroyIfPossible(created);
        throw failure("load", "Gemini Nano session loading was stopped.", "aborted", true);
      }
      if (!isLanguageModelSession(created)) {
        destroyIfPossible(created);
        throw failure(
          "load",
          "Chrome returned an invalid Prompt API session shape, so WebAI refused to use it.",
          "protocol",
        );
      }
      const session: PromptApiRuntimeSession = {
        runtimeId: "prompt-api",
        modelTarget: promptApiModelTarget,
        contextWindow: created.contextWindow,
        contextUsage: created.contextUsage,
        loadTimeMs: performance.now() - started,
      };
      this.#runtime = created;
      this.#session = session;
      return session;
    } catch (error) {
      if (error instanceof ModelOperationError) throw error;
      throw safePromptApiFailure(error, "load");
    } finally {
      if (this.#creationController === controller) this.#creationController = undefined;
    }
  }

  async generate(
    messages: readonly RuntimeMessage[],
    options: GenerationOptions,
    signal: AbortSignal,
    onEvent: (event: GenerationEvent) => void,
  ): Promise<void> {
    const runtime = this.#runtime;
    const session = this.#session;
    const latestUserMessage = messages.findLast((message) => message.role === "user");
    if (runtime === undefined || session === undefined || latestUserMessage === undefined) {
      throw failure("generate", "Load Gemini Nano before starting a chat.");
    }
    if (Object.values(options).some((value) => value !== undefined)) {
      throw failure(
        "generate",
        "Chrome's stable Prompt API does not expose these generation controls. Use its browser-managed defaults.",
        "unsupported",
      );
    }
    const started = performance.now();
    let firstOutputAt: number | undefined;
    const contextOverflow = () => {
      onEvent({
        type: "warning",
        warning: {
          code: "context-overflow",
          message:
            "Gemini Nano reached its context window and Chrome discarded one or more older conversation turns.",
        },
      });
    };
    let listeningForOverflow = false;
    try {
      runtime.addEventListener("contextoverflow", contextOverflow);
      listeningForOverflow = true;
      const stream = runtime.promptStreaming(latestUserMessage.content, { signal });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (typeof chunk !== "string") {
          throw failure(
            "generate",
            "Chrome returned a non-text Prompt API stream chunk, so WebAI stopped the response.",
            "protocol",
          );
        }
        if (chunk.length === 0) continue;
        firstOutputAt ??= performance.now();
        onEvent({ type: "text", text: chunk });
      }
    } catch (error) {
      if (error instanceof ModelOperationError) throw error;
      throw safePromptApiFailure(error, "generate");
    } finally {
      if (listeningForOverflow) {
        try {
          runtime.removeEventListener("contextoverflow", contextOverflow);
        } catch {
          // The session is being discarded after an invalid platform lifecycle.
        }
      }
    }
    const completed = performance.now();
    const contextUsage = nonNegativeFinite(runtime.contextUsage)
      ? Math.min(runtime.contextUsage, runtime.contextWindow)
      : undefined;
    onEvent({
      type: "metrics",
      metrics: {
        loadTimeMs: session.loadTimeMs,
        ...(firstOutputAt === undefined ? {} : { timeToFirstOutputMs: firstOutputAt - started }),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        contextWindow: session.contextWindow,
        totalTimeMs: completed - started,
      },
    });
  }

  async dispose(): Promise<void> {
    this.#disposeCurrent();
  }

  #awaitCreation(creation: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        reject(new DOMException("Prompt API session creation was stopped.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void creation.then(
        (created) => {
          signal.removeEventListener("abort", abort);
          if (settled) {
            destroyIfPossible(created);
            return;
          }
          settled = true;
          resolve(created);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  }

  #disposeCurrent(): void {
    this.#lifecycle += 1;
    this.#creationController?.abort();
    this.#creationController = undefined;
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#session = undefined;
    try {
      runtime?.destroy();
    } catch {
      // Disposal is idempotent and the adapter has already dropped the session.
    }
  }
}
