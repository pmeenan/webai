import type {
  CapabilityEvidence,
  CapabilityId,
  CapabilitySnapshot,
  ProbeOutcome,
} from "./evidence";
import {
  requestStoragePersistence,
  runStablePageProbes,
  runVolatilePromptApiProbe,
  runVolatileStorageProbes,
} from "./page-probes";
import { runCapabilityWorker } from "./worker-client";

export type RegistryListener = (snapshot: CapabilitySnapshot, probing: boolean) => void;
export type StorageInvalidationCause =
  | "deletion"
  | "download"
  | "import"
  | "persistence-request"
  | "quota-error"
  | "reconciliation"
  | "visibility-return";

function mergeEvidence(
  snapshot: CapabilitySnapshot,
  evidence: readonly CapabilityEvidence[],
): CapabilitySnapshot {
  const next: Partial<Record<CapabilityId, CapabilityEvidence>> = { ...snapshot };
  for (const item of evidence) next[item.id] = item;
  return Object.freeze(next) as CapabilitySnapshot;
}

export class CapabilityRegistry {
  #snapshot: CapabilitySnapshot = Object.freeze({});
  #probing = false;
  #generation = 0;
  #storageGeneration = 0;
  #promptGeneration = 0;
  #listeners = new Set<RegistryListener>();
  #visibilityWasHidden = false;

  get snapshot(): CapabilitySnapshot {
    return this.#snapshot;
  }

  get probing(): boolean {
    return this.#probing;
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot, this.#probing);
    return () => this.#listeners.delete(listener);
  }

  async refresh(trigger: "initial" | "explicit-refresh" = "explicit-refresh"): Promise<void> {
    const generation = ++this.#generation;
    const storageGeneration = ++this.#storageGeneration;
    const promptGeneration = ++this.#promptGeneration;
    this.#probing = true;
    this.#snapshot = this.#markAllStale();
    this.#emit();
    try {
      const stablePage = runStablePageProbes(trigger);
      this.#snapshot = mergeEvidence(this.#snapshot, stablePage);
      this.#emit();
      const [worker, storage, promptApi] = await Promise.all([
        runCapabilityWorker(trigger),
        runVolatileStorageProbes(trigger),
        runVolatilePromptApiProbe(trigger),
      ]);
      if (generation !== this.#generation) return;
      this.#snapshot = Object.freeze({ ...this.#snapshot, ...worker });
      if (storageGeneration === this.#storageGeneration) {
        this.#snapshot = mergeEvidence(this.#snapshot, storage);
      }
      if (promptGeneration === this.#promptGeneration) {
        this.#snapshot = mergeEvidence(this.#snapshot, [promptApi]);
      }
    } finally {
      if (generation === this.#generation) {
        this.#probing = false;
        this.#emit();
      }
    }
  }

  async invalidateStorage(cause: StorageInvalidationCause): Promise<void> {
    void cause;
    const generation = ++this.#storageGeneration;
    this.#snapshot = this.#markStale(["storage.estimate", "storage.persisted"]);
    this.#emit();
    const evidence = await runVolatileStorageProbes("storage-invalidation");
    if (generation !== this.#storageGeneration) return;
    this.#snapshot = mergeEvidence(this.#snapshot, evidence);
    this.#emit();
  }

  async requestPersistence(): Promise<ProbeOutcome<boolean>> {
    const result = await requestStoragePersistence();
    await this.invalidateStorage("persistence-request");
    return result;
  }

  attachVisibilityInvalidation(): () => void {
    const listener = () => {
      if (document.visibilityState === "hidden") {
        this.#visibilityWasHidden = true;
      } else if (this.#visibilityWasHidden) {
        this.#visibilityWasHidden = false;
        void this.#invalidateVolatile();
      }
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }

  async #invalidateVolatile(): Promise<void> {
    const generation = ++this.#storageGeneration;
    const promptGeneration = ++this.#promptGeneration;
    this.#snapshot = this.#markStale([
      "storage.estimate",
      "storage.persisted",
      "prompt-api.page.availability",
    ]);
    this.#emit();
    const [storage, promptApi] = await Promise.all([
      runVolatileStorageProbes("storage-invalidation"),
      runVolatilePromptApiProbe("browser-model-invalidation"),
    ]);
    if (generation !== this.#storageGeneration && promptGeneration !== this.#promptGeneration)
      return;
    if (generation === this.#storageGeneration) {
      this.#snapshot = mergeEvidence(this.#snapshot, storage);
    }
    if (promptGeneration === this.#promptGeneration) {
      this.#snapshot = mergeEvidence(this.#snapshot, [promptApi]);
    }
    this.#emit();
  }

  #markAllStale(): CapabilitySnapshot {
    return this.#markStale(Object.keys(this.#snapshot) as CapabilityId[]);
  }

  #markStale(ids: readonly CapabilityId[]): CapabilitySnapshot {
    const next: Partial<Record<CapabilityId, CapabilityEvidence>> = { ...this.#snapshot };
    for (const id of ids) {
      const item = this.#snapshot[id] as CapabilityEvidence | undefined;
      if (item !== undefined) next[id] = { ...item, freshness: "stale" } as CapabilityEvidence;
    }
    return Object.freeze(next) as CapabilitySnapshot;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#snapshot, this.#probing);
  }
}
