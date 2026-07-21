import type { InstalledModelRecord } from "../models/types";
import { PromptApiRuntimeAdapter } from "./prompt-api";
import type {
  GenerationEvent,
  GenerationControlOutcome,
  GenerationOptions,
  PromptApiRuntimeSession,
  RuntimeId,
  RuntimeLoadEvent,
  RuntimeMessage,
  RuntimeSession,
  WllamaBackend,
  WllamaRuntimeSession,
} from "./types";
import { WllamaRuntimeAdapter, wllamaGenerationDefaults } from "./wllama";

declare const sessionHandleBrand: unique symbol;

export interface SessionHandle {
  readonly id: string;
  readonly runtimeId: RuntimeId;
  readonly [sessionHandleBrand]: true;
}

export type ControllerGenerationEvent =
  | GenerationEvent
  | {
      readonly type: "complete";
      readonly controls: readonly GenerationControlOutcome[];
    };

export interface ControllerEventEnvelope {
  readonly sessionId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly event: ControllerGenerationEvent;
}

export interface SessionCreationResult<TSession extends RuntimeSession = RuntimeSession> {
  readonly handle: SessionHandle;
  readonly session: TSession;
  readonly requested: unknown;
  readonly effective: unknown;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function handle(runtimeId: RuntimeId): SessionHandle {
  return { id: id("session"), runtimeId } as SessionHandle;
}

function resolvedWllamaOptions(options: GenerationOptions): GenerationOptions {
  return {
    temperature: options.temperature ?? wllamaGenerationDefaults.temperature,
    topP: options.topP ?? wllamaGenerationDefaults.topP,
    topK: options.topK ?? wllamaGenerationDefaults.topK,
    repeatPenalty: options.repeatPenalty ?? wllamaGenerationDefaults.repeatPenalty,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
  };
}

function wllamaControlOutcomes(options: GenerationOptions): readonly GenerationControlOutcome[] {
  const resolved = resolvedWllamaOptions(options);
  return Object.entries(resolved).map(([control, requested]) => ({
    control: control as keyof GenerationOptions,
    requested,
    effective: control === "thinking" ? undefined : requested,
    status: control === "thinking" ? "requested-not-verifiable" : "honored",
    explanation:
      control === "thinking"
        ? "The request reached the model chat template, but the adapter cannot prove that this template honored it."
        : "The pinned wllama wrapper forwarded this value to llama.cpp.",
  }));
}

export class RuntimeController {
  readonly wllama: WllamaRuntimeAdapter;
  readonly promptApi: PromptApiRuntimeAdapter;
  #sessions = new Map<string, RuntimeSession>();
  #activeByRuntime = new Map<RuntimeId, SessionHandle>();
  #activeRequests = new Map<
    string,
    { readonly requestId: string; readonly abort: AbortController }
  >();

  constructor(wllama = new WllamaRuntimeAdapter(), promptApi = new PromptApiRuntimeAdapter()) {
    this.wllama = wllama;
    this.promptApi = promptApi;
  }

  async createWllamaSession(
    model: InstalledModelRecord,
    backend: WllamaBackend,
    onProgress?: (event: RuntimeLoadEvent) => void,
  ): Promise<SessionCreationResult<WllamaRuntimeSession>> {
    await this.#invalidateRuntime("wllama");
    const session = await this.wllama.createSession(model, backend, onProgress);
    const nextHandle = handle("wllama");
    this.#sessions.set(nextHandle.id, session);
    this.#activeByRuntime.set("wllama", nextHandle);
    return {
      handle: nextHandle,
      session,
      requested: backend,
      effective: session.backend,
    };
  }

  async createPromptApiSession(
    initialPrompts: readonly RuntimeMessage[],
    onProgress?: (event: RuntimeLoadEvent) => void,
  ): Promise<SessionCreationResult<PromptApiRuntimeSession>> {
    // Prompt API create() must stay in the synchronous user-activation stack. The
    // adapter's disposal is synchronous even though its common interface returns a
    // settled Promise, so start the replacement before the first await.
    this.#dropRuntimeState("prompt-api");
    void this.promptApi.dispose();
    const creation = this.promptApi.createSession(initialPrompts, onProgress);
    const session = await creation;
    const nextHandle = handle("prompt-api");
    this.#sessions.set(nextHandle.id, session);
    this.#activeByRuntime.set("prompt-api", nextHandle);
    return {
      handle: nextHandle,
      session,
      requested: { initialPrompts },
      effective: {
        contextUsage: session.contextUsage,
        contextWindow: session.contextWindow,
        systemPrompt: initialPrompts[0]?.role === "system" ? "accepted-at-creation" : "none",
      },
    };
  }

  generate(
    sessionHandle: SessionHandle,
    messages: readonly RuntimeMessage[],
    options: GenerationOptions,
    onEvent: (event: ControllerEventEnvelope) => void,
  ): { readonly requestId: string; readonly completion: Promise<void> } {
    const session = this.#sessions.get(sessionHandle.id);
    if (session === undefined || session.runtimeId !== sessionHandle.runtimeId)
      return {
        requestId: id("request"),
        completion: Promise.reject(new Error("The runtime session handle is no longer valid.")),
      };
    const requestId = id("request");
    const abort = new AbortController();
    this.#activeRequests.get(sessionHandle.id)?.abort.abort();
    this.#activeRequests.set(sessionHandle.id, { requestId, abort });
    let sequence = 0;
    const emit = (event: ControllerGenerationEvent) => {
      if (this.#activeRequests.get(sessionHandle.id)?.requestId !== requestId) return;
      onEvent({ sessionId: sessionHandle.id, requestId, sequence: sequence++, event });
    };
    const adapter = sessionHandle.runtimeId === "wllama" ? this.wllama : this.promptApi;
    const resolved =
      sessionHandle.runtimeId === "wllama" ? resolvedWllamaOptions(options) : options;
    const controls = sessionHandle.runtimeId === "wllama" ? wllamaControlOutcomes(resolved) : [];
    const completion = adapter
      .generate(messages, resolved, abort.signal, emit)
      .catch((error: unknown) => {
        if (abort.signal.aborted) throw new DOMException("Generation was stopped.", "AbortError");
        throw error;
      })
      .then(() => {
        if (abort.signal.aborted) throw new DOMException("Generation was stopped.", "AbortError");
        emit({ type: "complete", controls });
      })
      .finally(() => {
        if (this.#activeRequests.get(sessionHandle.id)?.requestId === requestId)
          this.#activeRequests.delete(sessionHandle.id);
      });
    return { requestId, completion };
  }

  abort(sessionHandle: SessionHandle, requestId: string): void {
    const active = this.#activeRequests.get(sessionHandle.id);
    if (active?.requestId === requestId) active.abort.abort();
  }

  async disposeSession(sessionHandle: SessionHandle): Promise<void> {
    if (!this.#sessions.has(sessionHandle.id)) return;
    await this.#invalidateRuntime(sessionHandle.runtimeId);
  }

  async dispose(): Promise<void> {
    for (const active of this.#activeRequests.values()) active.abort.abort();
    this.#activeRequests.clear();
    this.#sessions.clear();
    this.#activeByRuntime.clear();
    await Promise.all([this.wllama.dispose(), this.promptApi.dispose()]);
  }

  async #invalidateRuntime(runtimeId: RuntimeId): Promise<void> {
    this.#dropRuntimeState(runtimeId);
    await (runtimeId === "wllama" ? this.wllama.dispose() : this.promptApi.dispose());
  }

  #dropRuntimeState(runtimeId: RuntimeId): void {
    const current = this.#activeByRuntime.get(runtimeId);
    if (current !== undefined) {
      const active = this.#activeRequests.get(current.id);
      active?.abort.abort();
      this.#activeRequests.delete(current.id);
      this.#sessions.delete(current.id);
      this.#activeByRuntime.delete(runtimeId);
    }
  }
}
