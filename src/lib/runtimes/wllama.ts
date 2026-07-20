import { getStoredFile } from "../models/storage";
import type { InstalledModelRecord, ModelFailure } from "../models/types";
import { ModelOperationError } from "../models/types";
import { ChannelStreamParser } from "./channel-parser";
import type {
  GenerationEvent,
  GenerationOptions,
  RuntimeAdapter,
  RuntimeDescriptor,
  RuntimeLoadEvent,
  WllamaBackend,
  WllamaRuntimeDescriptor,
  WllamaRuntimeSession,
} from "./types";
import { wllamaRuntimeAssets } from "./wllama-assets";
import { isWllamaMtpCompanion, wllamaModelCompatibility } from "./wllama-compatibility";

const channelUpdateIntervalMs = 16;
const maximumUnrecognizedSpecialTokens = 32;
const knownChannelTokens = new Set(["<channel|>", "<|channel>", "<|channel|>", "<|message|>"]);

interface ChatCompletionLogprob {
  readonly id?: unknown;
  readonly token?: unknown;
}

interface ChatCompletionChunk {
  readonly choices: readonly {
    readonly delta?: { readonly content?: string | null };
    readonly logprobs?: {
      readonly content?: readonly ChatCompletionLogprob[] | null;
    } | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  } | null;
  readonly timings?: {
    readonly prompt_n: number;
    readonly prompt_per_second: number;
    readonly predicted_n: number;
    readonly predicted_per_second: number;
  };
}

interface WllamaInstance {
  setCompat(
    compat: { readonly wasm: string; readonly worker: { readonly code: string } },
    mode: "firefox_safari",
  ): void;
  loadModel(
    files: readonly Blob[],
    parameters: {
      readonly n_threads: number;
      readonly n_gpu_layers: number;
      readonly n_ctx: number;
      readonly warmup: boolean;
      readonly reasoning_format: "none";
      readonly ctx_shift: false;
    },
  ): Promise<void>;
  createChatCompletion(parameters: {
    readonly messages: readonly {
      readonly role: "user" | "assistant";
      readonly content: string;
    }[];
    readonly stream: true;
    readonly stream_options: { readonly include_usage: true };
    readonly timings_per_token: true;
    readonly logprobs: true;
    readonly top_logprobs: 1;
    readonly max_tokens: number;
    readonly temperature: number;
    readonly top_k: number;
    readonly top_p: number;
    readonly chat_template_kwargs?: { readonly enable_thinking: boolean };
    readonly abortSignal: AbortSignal;
  }): Promise<AsyncIterable<ChatCompletionChunk>>;
  exit(): Promise<void>;
}

interface WllamaConstructor {
  new (
    paths: { readonly default: string },
    configuration: {
      readonly suppressNativeLog: boolean;
      readonly logger: {
        readonly debug: () => void;
        readonly log: () => void;
        readonly warn: () => void;
        readonly error: () => void;
      };
    },
  ): WllamaInstance;
}

async function loadRuntimeAssets(): Promise<{
  readonly Constructor: WllamaConstructor;
  readonly compatWorkerCode: string;
}> {
  const script = new URL(wllamaRuntimeAssets.script, globalThis.location.origin).href;
  const [imported, workerResponse] = await Promise.all([
    import(/* @vite-ignore */ script) as Promise<unknown>,
    fetch(wllamaRuntimeAssets.compatWorker, { credentials: "same-origin" }),
  ]);
  if (
    typeof imported !== "object" ||
    imported === null ||
    !("Wllama" in imported) ||
    typeof imported.Wllama !== "function" ||
    !workerResponse.ok
  ) {
    throw failure("load", "The bundled wllama runtime assets are unavailable.", "storage", true);
  }
  return {
    Constructor: imported.Wllama as WllamaConstructor,
    compatWorkerCode: await workerResponse.text(),
  };
}

export const wllamaDescriptor: WllamaRuntimeDescriptor = {
  id: "wllama",
  displayName: "wllama",
  adapterVersion: "webai-1",
  engineVersion: "wllama 3.5.1 / llama.cpp b9640-dd4623a",
  acquisitionOwnership: "app-file",
  executionContext: "adapter-owned-library-worker",
  mtp: {
    verdict: "unsupported",
    reasonCode: "companion-mount-not-exposed",
    explanation:
      "wllama 3.5.1 exposes generic draft-model parameters, but loadModel renames every supplied non-mmproj GGUF as a target shard. It has no browser wrapper surface that mounts an MTP companion separately or selects llama.cpp's MTP path.",
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

function supportsMemory64(): boolean {
  try {
    new WebAssembly.Memory({
      address: "i64",
      initial: 1n,
    } as unknown as WebAssembly.MemoryDescriptor);
    return true;
  } catch {
    return false;
  }
}

function boundedRuntimeInteger(value: number, minimum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

async function loadableFiles(
  model: InstalledModelRecord,
  onProgress?: (event: RuntimeLoadEvent) => void,
): Promise<File[]> {
  if (model.state !== "installed") {
    throw failure(
      "load",
      "This model's managed bytes are missing from browser storage.",
      "storage",
      true,
    );
  }
  const compatibility = wllamaModelCompatibility(model);
  if (compatibility.status !== "ready") {
    throw failure("load", compatibility.explanation);
  }
  const selected = model.files.filter((file) => !isWllamaMtpCompanion(file));
  const files: File[] = [];
  onProgress?.({ phase: "opening-files", completedFiles: 0, totalFiles: selected.length });
  for (const [index, record] of selected.entries()) {
    const file = await getStoredFile(record.opfsPath);
    if (file === undefined || file.size !== record.size) {
      throw failure(
        "load",
        `The managed bytes for ${record.displayName} are missing or incomplete.`,
        "storage",
        true,
      );
    }
    files.push(
      new File([file], record.displayName, { type: file.type, lastModified: file.lastModified }),
    );
    onProgress?.({
      phase: "opening-files",
      completedFiles: index + 1,
      totalFiles: selected.length,
    });
  }
  return files;
}

async function hasWebGpuAdapter(): Promise<boolean> {
  const gpu = (
    navigator as Navigator & {
      readonly gpu?: { requestAdapter(): Promise<unknown | null> };
    }
  ).gpu;
  if (gpu === undefined) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function safeRuntimeFailure(error: unknown, phase: "load" | "generate"): ModelOperationError {
  if (error instanceof ModelOperationError) return error;
  const aborted = error instanceof Error && error.name === "AbortError";
  return failure(
    phase,
    aborted
      ? "Generation was stopped."
      : phase === "load"
        ? "wllama could not load this GGUF with the selected backend. Try fewer GPU layers, one thread, or a smaller model."
        : "wllama stopped before completing this response.",
    aborted ? "aborted" : "unsupported",
    !aborted,
  );
}

export class WllamaRuntimeAdapter implements RuntimeAdapter {
  #runtime: WllamaInstance | undefined;
  #loadingRuntime: WllamaInstance | undefined;
  #session: WllamaRuntimeSession | undefined;
  #lifecycle = 0;

  get descriptor(): RuntimeDescriptor {
    return wllamaDescriptor;
  }

  async createSession(
    model: InstalledModelRecord,
    requested: WllamaBackend,
    onProgress?: (event: RuntimeLoadEvent) => void,
  ): Promise<WllamaRuntimeSession> {
    await this.dispose();
    const lifecycle = this.#lifecycle;
    const files = await loadableFiles(model, onProgress);
    onProgress?.({ phase: "loading-assets" });
    const assets = await loadRuntimeAssets();
    if (lifecycle !== this.#lifecycle) {
      throw failure("load", "Model loading was stopped.", "aborted", true);
    }
    const isolated =
      globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
    const webgpuAvailable = await hasWebGpuAdapter();
    if (lifecycle !== this.#lifecycle) {
      throw failure("load", "Model loading was stopped.", "aborted", true);
    }
    const threads = isolated ? boundedRuntimeInteger(requested.threads, 1, 1) : 1;
    const gpuLayers = webgpuAvailable ? boundedRuntimeInteger(requested.gpuLayers, 0, 0) : 0;
    const contextSize = boundedRuntimeInteger(requested.contextSize, 256, 2_048);
    const runtime = new assets.Constructor(
      { default: wllamaRuntimeAssets.defaultWasm },
      {
        suppressNativeLog: true,
        logger: {
          debug: () => undefined,
          log: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
    );
    runtime.setCompat(
      { wasm: wllamaRuntimeAssets.compatWasm, worker: { code: assets.compatWorkerCode } },
      "firefox_safari",
    );
    this.#loadingRuntime = runtime;
    const started = performance.now();
    try {
      onProgress?.({ phase: "loading-model" });
      await runtime.loadModel(files, {
        n_threads: threads,
        n_gpu_layers: gpuLayers,
        n_ctx: contextSize,
        warmup: false,
        reasoning_format: "none",
        ctx_shift: false,
      });
      if (lifecycle !== this.#lifecycle || this.#loadingRuntime !== runtime) {
        throw failure("load", "Model loading was stopped.", "aborted", true);
      }
    } catch (error) {
      if (this.#loadingRuntime === runtime) {
        this.#loadingRuntime = undefined;
        await runtime.exit().catch(() => undefined);
      }
      if (lifecycle !== this.#lifecycle) {
        throw failure("load", "Model loading was stopped.", "aborted", true);
      }
      throw safeRuntimeFailure(error, "load");
    }
    const session: WllamaRuntimeSession = {
      runtimeId: "wllama",
      modelTarget: { kind: "artifact-set", model },
      backend: {
        threads,
        gpuLayers,
        contextSize,
        build: "Suspending" in WebAssembly && supportsMemory64() ? "default" : "compat",
        webgpuRequested: requested.gpuLayers > 0,
        webgpuAvailable,
      },
      loadTimeMs: performance.now() - started,
    };
    this.#loadingRuntime = undefined;
    this.#runtime = runtime;
    this.#session = session;
    return session;
  }

  async generate(
    messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
    options: GenerationOptions,
    signal: AbortSignal,
    onEvent: (event: GenerationEvent) => void,
  ): Promise<void> {
    const runtime = this.#runtime;
    const session = this.#session;
    if (runtime === undefined || session === undefined) {
      throw failure("generate", "Load a model before starting a chat.");
    }
    const started = performance.now();
    let firstTokenAt: number | undefined;
    let usage: ChatCompletionChunk["usage"];
    let timings: ChatCompletionChunk["timings"];
    const channelParser = new ChannelStreamParser();
    let pendingText = "";
    const declaredSpecialTokens = new Map(
      (
        session.modelTarget.model.files.find((file) => file.inspection?.specialTokens !== undefined)
          ?.inspection?.specialTokens ?? []
      ).map((token) => [token.id, token]),
    );
    const unrecognizedSpecialTokens = new Map<
      number,
      {
        readonly id: number;
        readonly text: string;
        readonly type: number;
        readonly typeName: string;
        occurrences: number;
      }
    >();
    let omittedDiagnosticOccurrences = 0;
    let diagnosticsDirty = false;
    let lastChannelUpdateAt = started;
    let rejectStopped: ((reason: DOMException) => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const stop = () => {
      if (this.#runtime === runtime) {
        this.#lifecycle += 1;
        this.#runtime = undefined;
        this.#session = undefined;
      }
      // wllama 3.5.1 only polls AbortSignal between native result requests. Exiting
      // its dedicated worker is the bounded cancellation path for an in-flight poll.
      void runtime.exit().catch(() => undefined);
      rejectStopped?.(new DOMException("Generation was stopped.", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const emitPending = () => {
      let emitted = false;
      if (pendingText.length > 0) {
        const channels = channelParser.push(pendingText);
        pendingText = "";
        lastChannelUpdateAt = performance.now();
        if (channels.some((channel) => channel.content.length > 0)) {
          firstTokenAt ??= lastChannelUpdateAt;
        }
        onEvent({ type: "channels", channels });
        emitted = true;
      }
      if (diagnosticsDirty) {
        onEvent({
          type: "output-diagnostics",
          diagnostics: {
            unrecognizedSpecialTokens: [...unrecognizedSpecialTokens.values()].map((token) => ({
              ...token,
            })),
            omittedOccurrences: omittedDiagnosticOccurrences,
          },
        });
        diagnosticsDirty = false;
        emitted = true;
      }
      if (emitted) lastChannelUpdateAt = performance.now();
    };
    const inspectLogprobs = (entries: readonly ChatCompletionLogprob[] | null | undefined) => {
      if (entries === null || entries === undefined) return;
      for (const entry of entries) {
        if (typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id < 0)
          continue;
        const declared = declaredSpecialTokens.get(entry.id);
        if (
          declared === undefined ||
          declared.textTruncated ||
          typeof entry.token !== "string" ||
          entry.token !== declared.text ||
          ![2, 3, 4, 5].includes(declared.type) ||
          knownChannelTokens.has(declared.text)
        )
          continue;
        const current = unrecognizedSpecialTokens.get(entry.id);
        if (current !== undefined) {
          current.occurrences += 1;
        } else if (unrecognizedSpecialTokens.size < maximumUnrecognizedSpecialTokens) {
          unrecognizedSpecialTokens.set(entry.id, {
            id: entry.id,
            text: declared.text,
            type: declared.type,
            typeName: declared.typeName,
            occurrences: 1,
          });
        } else {
          omittedDiagnosticOccurrences += 1;
        }
        diagnosticsDirty = true;
      }
    };
    try {
      const consumeStream = async () => {
        const stream = await runtime.createChatCompletion({
          messages: messages.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          stream_options: { include_usage: true },
          timings_per_token: true,
          logprobs: true,
          top_logprobs: 1,
          max_tokens: -1,
          temperature: 0.7,
          top_k: 40,
          top_p: 0.95,
          ...(options.thinking === undefined
            ? {}
            : { chat_template_kwargs: { enable_thinking: options.thinking } }),
          abortSignal: signal,
        });
        for await (const chunk of stream) {
          signal.throwIfAborted();
          usage = chunk.usage ?? usage;
          timings = chunk.timings ?? timings;
          const choice = chunk.choices[0];
          inspectLogprobs(choice?.logprobs?.content);
          const text = choice?.delta?.content;
          if (typeof text === "string" && text.length > 0) {
            pendingText += text;
            if (
              firstTokenAt === undefined ||
              performance.now() - lastChannelUpdateAt >= channelUpdateIntervalMs
            ) {
              emitPending();
            }
          } else if (
            diagnosticsDirty &&
            performance.now() - lastChannelUpdateAt >= channelUpdateIntervalMs
          ) {
            emitPending();
          }
        }
      };
      await Promise.race([consumeStream(), stopped]);
    } catch (error) {
      emitPending();
      onEvent({ type: "channels", channels: channelParser.finish() });
      throw safeRuntimeFailure(error, "generate");
    } finally {
      signal.removeEventListener("abort", stop);
    }
    emitPending();
    onEvent({ type: "channels", channels: channelParser.finish() });
    const completed = performance.now();
    const promptTokens = usage?.prompt_tokens ?? timings?.prompt_n;
    const completionTokens = usage?.completion_tokens ?? timings?.predicted_n;
    onEvent({
      type: "metrics",
      metrics: {
        loadTimeMs: session.loadTimeMs,
        ...(firstTokenAt === undefined ? {} : { timeToFirstTokenMs: firstTokenAt - started }),
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
        ...(timings?.prompt_per_second === undefined
          ? {}
          : { prefillTokensPerSecond: timings.prompt_per_second }),
        ...(timings?.predicted_per_second === undefined
          ? {}
          : { decodeTokensPerSecond: timings.predicted_per_second }),
        totalTimeMs: completed - started,
      },
    });
  }

  async dispose(): Promise<void> {
    this.#lifecycle += 1;
    const runtime = this.#runtime;
    const loadingRuntime = this.#loadingRuntime;
    this.#runtime = undefined;
    this.#loadingRuntime = undefined;
    this.#session = undefined;
    const runtimes = new Set([runtime, loadingRuntime].filter((value) => value !== undefined));
    await Promise.all(
      [...runtimes].map(async (value) => await value.exit().catch(() => undefined)),
    );
  }
}
