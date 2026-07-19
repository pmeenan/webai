import {
  modelWorkerProtocolVersion,
  parseModelWorkerEvent,
  type ModelWorkerEvent,
  type ModelWorkerRequest,
} from "./protocol";
import type {
  HuggingFaceArtifactChoice,
  ModelFailure,
  ModelInventory,
  ResolvedHuggingFaceRepository,
} from "./types";

type EventListener = (event: ModelWorkerEvent) => void;
type TerminalListener = (failure: ModelFailure) => void;
type WorkerRequestWithoutEnvelope = ModelWorkerRequest extends infer Request
  ? Request extends ModelWorkerRequest
    ? Omit<Request, "protocolVersion" | "requestId">
    : never
  : never;

export class ModelWorkerClient {
  readonly #worker: Worker;
  readonly #listeners = new Set<EventListener>();
  readonly #terminalListeners = new Set<TerminalListener>();
  readonly #pending = new Map<
    string,
    { resolve: (event: ModelWorkerEvent) => void; reject: (failure: ModelFailure) => void }
  >();
  #sequence = 0;
  #terminalFailure: ModelFailure | undefined;

  constructor() {
    this.#worker = new Worker(new URL("./model.worker.ts", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", (message: MessageEvent<unknown>) => {
      const event = parseModelWorkerEvent(message.data);
      if (event === undefined) {
        this.#terminate({
          code: "protocol",
          phase: "storage",
          message: "The model worker returned an invalid message.",
          retryable: true,
        });
        return;
      }
      for (const listener of this.#listeners) listener(event);
      const pending = this.#pending.get(event.requestId);
      if (pending === undefined) return;
      if (event.type === "model/error") {
        this.#pending.delete(event.requestId);
        pending.reject(event.failure);
      } else if (
        event.type === "model/resolved" ||
        event.type === "model/inventory" ||
        event.type === "model/complete"
      ) {
        this.#pending.delete(event.requestId);
        pending.resolve(event);
      }
    });
    this.#worker.addEventListener("error", () =>
      this.#terminate({
        code: "protocol",
        phase: "storage",
        message: "The model worker stopped unexpectedly. Durable partials can be resumed.",
        retryable: true,
      }),
    );
    this.#worker.addEventListener("messageerror", () =>
      this.#terminate({
        code: "protocol",
        phase: "storage",
        message: "The model worker message could not be read.",
        retryable: true,
      }),
    );
  }

  #failAll(failure: ModelFailure): void {
    for (const pending of this.#pending.values()) pending.reject(failure);
    this.#pending.clear();
  }

  #terminate(failure: ModelFailure, notify = true): void {
    if (this.#terminalFailure !== undefined) return;
    this.#terminalFailure = failure;
    this.#failAll(failure);
    if (notify) for (const listener of this.#terminalListeners) listener(failure);
  }

  #requestId(): string {
    this.#sequence += 1;
    return `${Date.now().toString(36)}-${this.#sequence.toString(36)}`;
  }

  #send(request: WorkerRequestWithoutEnvelope): Promise<ModelWorkerEvent> {
    if (this.#terminalFailure !== undefined) return Promise.reject(this.#terminalFailure);
    const requestId = this.#requestId();
    return new Promise<ModelWorkerEvent>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#worker.postMessage({
        protocolVersion: modelWorkerProtocolVersion,
        requestId,
        ...request,
      });
    });
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeTerminal(listener: TerminalListener): () => void {
    this.#terminalListeners.add(listener);
    if (this.#terminalFailure !== undefined) listener(this.#terminalFailure);
    return () => this.#terminalListeners.delete(listener);
  }

  async resolve(input: string): Promise<ResolvedHuggingFaceRepository> {
    const event = await this.#send({ type: "model/resolve", input });
    if (event.type !== "model/resolved") throw new Error("unexpected worker event");
    return event.repository;
  }

  async inventory(): Promise<ModelInventory> {
    const event = await this.#send({ type: "model/inventory" });
    if (event.type !== "model/inventory") throw new Error("unexpected worker event");
    return event.inventory;
  }

  async download(
    repository: ResolvedHuggingFaceRepository,
    choice: HuggingFaceArtifactChoice,
  ): Promise<void> {
    await this.#send({ type: "model/download", repository, choice });
  }

  async resume(jobId: string): Promise<void> {
    await this.#send({ type: "model/resume", jobId });
  }

  pause(jobId: string): void {
    const requestId = this.#requestId();
    this.#worker.postMessage({
      protocolVersion: modelWorkerProtocolVersion,
      type: "model/pause",
      requestId,
      jobId,
    });
  }

  async discard(jobId: string): Promise<void> {
    await this.#send({ type: "model/discard", jobId });
  }

  async import(files: readonly File[]): Promise<void> {
    await this.#send({ type: "model/import", files });
  }

  async delete(modelId: string): Promise<void> {
    await this.#send({ type: "model/delete", modelId });
  }

  async inspect(modelId: string): Promise<void> {
    await this.#send({ type: "model/inspect", modelId });
  }

  async split(modelId: string): Promise<void> {
    await this.#send({ type: "model/split", modelId });
  }

  dispose(): void {
    this.#worker.terminate();
    this.#terminate(
      {
        code: "aborted",
        phase: "storage",
        message: "The model worker was closed.",
        retryable: true,
      },
      false,
    );
  }
}
