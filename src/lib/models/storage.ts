import type {
  AcquisitionJobRecord,
  BlobRecord,
  DownloadJobRecord,
  InstalledModelRecord,
  LocalImportJobRecord,
  ModelFailure,
  ModelFileRecord,
  ModelInventory,
  StorageSummary,
} from "./types";
import { ModelOperationError, modelSchemaVersion } from "./types";
import { createSha256 } from "./hashing";

const databaseName = "webai-v1";
const databaseVersion = 3;
const rootPath = ["webai", "v1"] as const;

type StoreName = "models" | "jobs" | "blobs";
const storageOperationTimeoutMs = 5_000;

async function boundedStorageOperation<T>(operation: () => Promise<T>): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(undefined), storageOperationTimeoutMs);
    try {
      void operation().then(
        (value) => finish(value),
        () => finish(undefined),
      );
    } catch {
      finish(undefined);
    }
  });
}

function storageFailure(message: string, cause?: unknown): ModelOperationError {
  const quota = cause instanceof DOMException && cause.name === "QuotaExceededError";
  return new ModelOperationError({
    code: quota ? "quota" : "storage",
    phase: "storage",
    message,
    retryable: true,
  });
}

function inventoryFailure(error: unknown): ModelFailure {
  if (error instanceof ModelOperationError) return error.failure;
  return {
    code: "storage",
    phase: "storage",
    message: "This partial could not be reconciled with browser storage.",
    retryable: true,
  };
}

function oversizedPartialFailure(): ModelOperationError {
  return new ModelOperationError({
    code: "storage",
    phase: "storage",
    message: "A partial model file exceeds its pinned size and cannot be resumed safely.",
    retryable: false,
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

let databasePromise: Promise<IDBDatabase> | undefined;
let localMutationTail: Promise<void> = Promise.resolve();
let localAcquisitionTail: Promise<void> = Promise.resolve();

async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { readonly locks?: LockManager }).locks;
  if (locks !== undefined) {
    return await locks.request("webai-model-store-v1", async () => await operation());
  }
  const previous = localMutationTail;
  let release: () => void = () => undefined;
  localMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function withAcquisitionLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const locks = (navigator as Navigator & { readonly locks?: LockManager }).locks;
  if (locks !== undefined)
    return await locks.request(
      "webai-model-acquisition-v1",
      signal === undefined ? {} : { signal },
      async () => await operation(),
    );
  const previous = localAcquisitionTail;
  let release: () => void = () => undefined;
  localAcquisitionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
  }
}

async function isJobActive(jobId: string): Promise<boolean> {
  const locks = (navigator as Navigator & { readonly locks?: LockManager }).locks;
  if (locks === undefined) return false;
  let active = false;
  await locks.request(`webai-model-job-v1-${jobId}`, { ifAvailable: true }, (lock) => {
    active = lock === null;
  });
  return active;
}

function isDownloadJob(job: AcquisitionJobRecord): job is DownloadJobRecord {
  return job.source.kind === "hugging-face";
}

export function openModelDatabase(): Promise<IDBDatabase> {
  if (databasePromise !== undefined) return databasePromise;
  let rejected = false;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const rejectOpening = (failure: ModelOperationError) => {
      rejected = true;
      reject(failure);
    };
    if (typeof indexedDB === "undefined") {
      rejectOpening(
        storageFailure("IndexedDB is unavailable, so model manifests cannot be stored."),
      );
      return;
    }
    const request = indexedDB.open(databaseName, databaseVersion);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (database.objectStoreNames.contains("credentials"))
        database.deleteObjectStore("credentials");
      for (const store of ["models", "jobs", "blobs"] as const) {
        if (!database.objectStoreNames.contains(store))
          database.createObjectStore(store, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      if (rejected) {
        database.close();
        return;
      }
      database.addEventListener("versionchange", () => {
        database.close();
        if (databasePromise === opening) databasePromise = undefined;
      });
      resolve(database);
    });
    request.addEventListener(
      "blocked",
      () =>
        rejectOpening(
          storageFailure("A different WebAI tab is blocking the model database upgrade."),
        ),
      { once: true },
    );
    request.addEventListener(
      "error",
      () =>
        rejectOpening(
          storageFailure("The model manifest database could not be opened.", request.error),
        ),
      { once: true },
    );
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = undefined;
  });
  return opening;
}

async function allRecords<T>(storeName: StoreName): Promise<T[]> {
  const database = await openModelDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(
    transaction.objectStore(storeName).getAll() as IDBRequest<T[]>,
  );
  await done;
  return result;
}

export async function getJob(jobId: string): Promise<AcquisitionJobRecord | undefined> {
  const database = await openModelDatabase();
  const transaction = database.transaction("jobs", "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(
    transaction.objectStore("jobs").get(jobId) as IDBRequest<AcquisitionJobRecord | undefined>,
  );
  await done;
  return result;
}

export async function getModel(modelId: string): Promise<InstalledModelRecord | undefined> {
  const database = await openModelDatabase();
  const transaction = database.transaction("models", "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(
    transaction.objectStore("models").get(modelId) as IDBRequest<InstalledModelRecord | undefined>,
  );
  await done;
  return result;
}

export async function updateModelInspections(
  modelId: string,
  inspectedFiles: readonly ModelFileRecord[],
): Promise<InstalledModelRecord | undefined> {
  return await withMutationLock(async () => {
    const database = await openModelDatabase();
    const transaction = database.transaction("models", "readwrite");
    const done = transactionDone(transaction);
    const models = transaction.objectStore("models");
    const current = await requestResult(
      models.get(modelId) as IDBRequest<InstalledModelRecord | undefined>,
    );
    if (current === undefined) {
      await done;
      return undefined;
    }
    if (
      inspectedFiles.length !== current.files.length ||
      inspectedFiles.some(
        (file, index) =>
          file.blobId !== current.files[index]?.blobId ||
          file.opfsPath !== current.files[index]?.opfsPath,
      )
    ) {
      transaction.abort();
      await done.catch(() => undefined);
      throw storageFailure("The installed model changed while its metadata was inspected.");
    }
    const next: InstalledModelRecord = { ...current, files: inspectedFiles };
    models.put(next);
    await done;
    return next;
  });
}

export async function putJob(job: AcquisitionJobRecord): Promise<void> {
  const database = await openModelDatabase();
  const transaction = database.transaction("jobs", "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("jobs").put(job);
  await done;
}

export async function deleteJob(jobId: string): Promise<void> {
  const database = await openModelDatabase();
  const transaction = database.transaction("jobs", "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("jobs").delete(jobId);
  await done;
}

export async function discardAcquisitionJob(job: AcquisitionJobRecord): Promise<void> {
  await withAcquisitionLock(
    async () =>
      await withMutationLock(async () => {
        const referenced = new Set(
          (await allRecords<BlobRecord>("blobs"))
            .filter((blob) => blob.referenceCount > 0 && blob.state !== "garbage")
            .map((blob) => blob.opfsPath),
        );
        for (const file of job.files) {
          await deleteStoredPath(file.partialPath);
          if (file.verifiedSha256 !== undefined) {
            const promotedPath = `blobs/${file.verifiedSha256}`;
            if (!referenced.has(promotedPath)) await deleteStoredPath(promotedPath);
          }
        }
        await deleteJob(job.id);
      }),
  );
}

async function opfsRoot(create: boolean): Promise<FileSystemDirectoryHandle> {
  if (navigator.storage === undefined || typeof navigator.storage.getDirectory !== "function") {
    throw new ModelOperationError({
      code: "unsupported",
      phase: "storage",
      message: "This browser does not expose the Origin Private File System.",
      retryable: false,
    });
  }
  let directory = await navigator.storage.getDirectory();
  for (const part of rootPath) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

function safeInternalParts(path: string): string[] {
  const parts = path.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")
  ) {
    throw storageFailure("An internal model storage path is invalid.");
  }
  return parts;
}

async function parentForPath(
  path: string,
  create: boolean,
): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  const parts = safeInternalParts(path);
  const name = parts.pop();
  if (name === undefined) throw storageFailure("An internal model storage path is incomplete.");
  let directory = await opfsRoot(create);
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}

export async function getStoredFile(path: string): Promise<File | undefined> {
  try {
    const { directory, name } = await parentForPath(path, false);
    return await (await directory.getFileHandle(name)).getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw storageFailure("A stored model file could not be read.", error);
  }
}

export async function getWritableFileHandle(path: string): Promise<FileSystemFileHandle> {
  try {
    const { directory, name } = await parentForPath(path, true);
    return await directory.getFileHandle(name, { create: true });
  } catch (error) {
    throw storageFailure("A model file could not be created in browser storage.", error);
  }
}

export async function deleteStoredPath(path: string): Promise<void> {
  try {
    const { directory, name } = await parentForPath(path, false);
    await directory.removeEntry(name, { recursive: true });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw storageFailure("A stored model file could not be removed.", error);
  }
}

interface SyncAccessHandleLike {
  write(bytes: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

export class DurableFileWriter {
  readonly #handle: FileSystemFileHandle;
  #sync: SyncAccessHandleLike | undefined;

  private constructor(handle: FileSystemFileHandle) {
    this.#handle = handle;
  }

  static async open(path: string): Promise<DurableFileWriter> {
    const writer = new DurableFileWriter(await getWritableFileHandle(path));
    const syncFactory = (
      writer.#handle as unknown as {
        createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
      }
    ).createSyncAccessHandle;
    if (typeof syncFactory === "function") {
      try {
        writer.#sync = await syncFactory.call(writer.#handle);
      } catch {
        // Writable-stream checkpoints are slower, but retain the same durable-prefix contract.
      }
    }
    return writer;
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    try {
      if (this.#sync !== undefined) {
        const written = this.#sync.write(bytes, { at: offset });
        if (written !== bytes.byteLength)
          throw storageFailure("The browser wrote only part of a model chunk.");
        this.#sync.flush();
        return;
      }
      const writable = await this.#handle.createWritable({ keepExistingData: true });
      await writable.seek(offset);
      const ownedBytes = new Uint8Array(bytes.byteLength);
      ownedBytes.set(bytes);
      await writable.write(ownedBytes);
      await writable.close();
    } catch (error) {
      if (error instanceof ModelOperationError) throw error;
      throw storageFailure("A model chunk could not be durably written.", error);
    }
  }

  close(): void {
    this.#sync?.close();
    this.#sync = undefined;
  }
}

interface MovableFileHandle extends FileSystemFileHandle {
  move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
}

export async function promotePartialFile(
  partialPath: string,
  sha256: string,
  expectedSize: number,
): Promise<string> {
  const finalPath = `blobs/${sha256}`;
  const existing = await getStoredFile(finalPath);
  if (existing !== undefined) {
    let valid = existing.size === expectedSize;
    if (valid) {
      const existingHash = createSha256();
      const reader = existing.stream().getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        existingHash.update(result.value);
      }
      valid = existingHash.digestHex() === sha256;
    }
    if (valid) {
      await deleteStoredPath(partialPath);
      return finalPath;
    }
    await deleteStoredPath(finalPath);
  }
  const partialLocation = await parentForPath(partialPath, false);
  const sourceHandle = await partialLocation.directory.getFileHandle(partialLocation.name);
  const finalLocation = await parentForPath(finalPath, true);
  const move = (sourceHandle as MovableFileHandle).move;
  if (typeof move === "function") {
    try {
      await move.call(sourceHandle, finalLocation.directory, finalLocation.name);
      return finalPath;
    } catch {
      // Other engines retain the verified copy-and-delete fallback below.
    }
  }
  const source = await sourceHandle.getFile();
  const target = await finalLocation.directory.getFileHandle(finalLocation.name, { create: true });
  const writable = await target.createWritable();
  try {
    await source.stream().pipeTo(writable);
  } catch (error) {
    await writable.abort().catch(() => undefined);
    await finalLocation.directory.removeEntry(finalLocation.name).catch(() => undefined);
    throw storageFailure("The verified model file could not be finalized.", error);
  }
  const finalized = await target.getFile();
  if (finalized.size !== expectedSize) {
    await finalLocation.directory.removeEntry(finalLocation.name).catch(() => undefined);
    throw storageFailure("The finalized model file has an inconsistent size.");
  }
  await deleteStoredPath(partialPath);
  return finalPath;
}

async function installModelLocked(model: InstalledModelRecord): Promise<void> {
  const database = await openModelDatabase();
  const transaction = database.transaction(["models", "blobs", "jobs"], "readwrite");
  const done = transactionDone(transaction);
  const models = transaction.objectStore("models");
  const installed = await requestResult(
    models.get(model.id) as IDBRequest<InstalledModelRecord | undefined>,
  );
  if (installed !== undefined) {
    transaction.objectStore("jobs").delete(model.id);
    await done;
    return;
  }
  const blobs = transaction.objectStore("blobs");
  for (const file of model.files) {
    const existing = await requestResult(
      blobs.get(file.blobId) as IDBRequest<BlobRecord | undefined>,
    );
    const next: BlobRecord =
      existing === undefined
        ? {
            schemaVersion: modelSchemaVersion,
            id: file.blobId,
            sha256: file.sha256,
            size: file.size,
            opfsPath: file.opfsPath,
            verification: "sha256",
            referenceCount: 1,
            state: "verified",
          }
        : { ...existing, referenceCount: existing.referenceCount + 1, state: "verified" };
    blobs.put(next);
  }
  models.put(model);
  transaction.objectStore("jobs").delete(model.id);
  await done;
}

export async function installModel(model: InstalledModelRecord): Promise<void> {
  await withMutationLock(async () => await installModelLocked(model));
}

export async function recordModelRuntimeIssue(
  modelId: string,
  issue: NonNullable<InstalledModelRecord["runtimeIssues"]>[number],
): Promise<InstalledModelRecord> {
  return await withMutationLock(async () => {
    const database = await openModelDatabase();
    const transaction = database.transaction("models", "readwrite");
    const done = transactionDone(transaction);
    const models = transaction.objectStore("models");
    const current = await requestResult(
      models.get(modelId) as IDBRequest<InstalledModelRecord | undefined>,
    );
    if (current === undefined) {
      transaction.abort();
      await done.catch(() => undefined);
      throw storageFailure("The model no longer exists while recording runtime compatibility.");
    }
    const next: InstalledModelRecord = {
      ...current,
      runtimeIssues: [
        ...(current.runtimeIssues?.filter((entry) => entry.runtimeId !== issue.runtimeId) ?? []),
        issue,
      ],
    };
    models.put(next);
    await done;
    return next;
  });
}

export async function replaceModelFiles(
  modelId: string,
  sourceFile: ModelFileRecord,
  derivedFiles: readonly ModelFileRecord[],
  derivation: NonNullable<InstalledModelRecord["derivation"]>,
): Promise<InstalledModelRecord> {
  const garbage = await withMutationLock(async () => {
    const database = await openModelDatabase();
    const transaction = database.transaction(["models", "blobs"], "readwrite");
    const done = transactionDone(transaction);
    const models = transaction.objectStore("models");
    const blobs = transaction.objectStore("blobs");
    const current = await requestResult(
      models.get(modelId) as IDBRequest<InstalledModelRecord | undefined>,
    );
    if (
      current === undefined ||
      !current.files.some(
        (file) => file.blobId === sourceFile.blobId && file.opfsPath === sourceFile.opfsPath,
      )
    ) {
      transaction.abort();
      await done.catch(() => undefined);
      throw storageFailure("The model changed while its GGUF shards were being prepared.");
    }

    for (const file of derivedFiles) {
      const existing = await requestResult(
        blobs.get(file.blobId) as IDBRequest<BlobRecord | undefined>,
      );
      blobs.put(
        existing === undefined
          ? {
              schemaVersion: modelSchemaVersion,
              id: file.blobId,
              sha256: file.sha256,
              size: file.size,
              opfsPath: file.opfsPath,
              verification: "sha256",
              referenceCount: 1,
              state: "verified",
            }
          : { ...existing, referenceCount: existing.referenceCount + 1, state: "verified" },
      );
    }

    const sourceBlob = await requestResult(
      blobs.get(sourceFile.blobId) as IDBRequest<BlobRecord | undefined>,
    );
    const nextSourceReferences = Math.max(0, (sourceBlob?.referenceCount ?? 1) - 1);
    if (sourceBlob !== undefined) {
      blobs.put({
        ...sourceBlob,
        referenceCount: nextSourceReferences,
        state: nextSourceReferences === 0 ? "garbage" : "verified",
      });
    }
    const files = current.files.flatMap((file) =>
      file.blobId === sourceFile.blobId && file.opfsPath === sourceFile.opfsPath
        ? derivedFiles
        : [file],
    );
    const next: InstalledModelRecord = {
      ...current,
      files,
      totalSize: files.reduce((total, file) => total + file.size, 0),
      derivation,
      runtimeIssues: current.runtimeIssues?.filter((issue) => issue.runtimeId !== "wllama") ?? [],
    };
    models.put(next);
    await done;
    return {
      model: next,
      garbage:
        sourceBlob !== undefined && nextSourceReferences === 0
          ? { id: sourceBlob.id, path: sourceBlob.opfsPath }
          : undefined,
    };
  });
  if (garbage.garbage !== undefined) {
    await finishGarbageBlob(garbage.garbage.id, garbage.garbage.path);
  }
  return garbage.model;
}

async function finishGarbageBlob(blobId: string, path: string): Promise<void> {
  const beforeDatabase = await openModelDatabase();
  const beforeTransaction = beforeDatabase.transaction("blobs", "readonly");
  const beforeDone = transactionDone(beforeTransaction);
  const before = await requestResult(
    beforeTransaction.objectStore("blobs").get(blobId) as IDBRequest<BlobRecord | undefined>,
  );
  await beforeDone;
  if (before?.state !== "garbage" || before.referenceCount !== 0) return;
  try {
    await deleteStoredPath(path);
  } catch {
    return;
  }
  const database = await openModelDatabase();
  const transaction = database.transaction("blobs", "readwrite");
  const done = transactionDone(transaction);
  const blobs = transaction.objectStore("blobs");
  const current = await requestResult(blobs.get(blobId) as IDBRequest<BlobRecord | undefined>);
  if (current?.state === "garbage" && current.referenceCount === 0) blobs.delete(blobId);
  await done;
}

async function deleteModelLocked(modelId: string): Promise<void> {
  const database = await openModelDatabase();
  const transaction = database.transaction(["models", "blobs"], "readwrite");
  const done = transactionDone(transaction);
  const models = transaction.objectStore("models");
  const blobs = transaction.objectStore("blobs");
  const model = await requestResult(
    models.get(modelId) as IDBRequest<InstalledModelRecord | undefined>,
  );
  if (model === undefined) {
    await done;
    return;
  }
  const allModels = await requestResult(models.getAll() as IDBRequest<InstalledModelRecord[]>);
  const garbage: Array<{ readonly id: string; readonly path: string }> = [];
  for (const file of model.files) {
    const blob = await requestResult(blobs.get(file.blobId) as IDBRequest<BlobRecord | undefined>);
    const remainingReferences = allModels
      .filter((entry) => entry.id !== modelId)
      .reduce(
        (count, entry) =>
          count + entry.files.filter((entryFile) => entryFile.blobId === file.blobId).length,
        0,
      );
    if (blob === undefined && remainingReferences === 0) {
      blobs.put({
        schemaVersion: modelSchemaVersion,
        id: file.blobId,
        sha256: file.sha256,
        size: file.size,
        opfsPath: file.opfsPath,
        verification: "sha256",
        referenceCount: 0,
        state: "garbage",
      } satisfies BlobRecord);
      garbage.push({ id: file.blobId, path: file.opfsPath });
    } else if (blob !== undefined && remainingReferences === 0) {
      blobs.put({ ...blob, referenceCount: 0, state: "garbage" });
      garbage.push({ id: file.blobId, path: file.opfsPath });
    } else if (blob !== undefined) {
      blobs.put({ ...blob, referenceCount: remainingReferences, state: "verified" });
    }
  }
  models.delete(modelId);
  await done;
  for (const item of garbage) await finishGarbageBlob(item.id, item.path);
}

export async function deleteModel(modelId: string): Promise<void> {
  await withAcquisitionLock(
    async () => await withMutationLock(async () => await deleteModelLocked(modelId)),
  );
}

async function collectGarbage(): Promise<void> {
  await withAcquisitionLock(
    async () =>
      await withMutationLock(async () => {
        const blobs = await allRecords<BlobRecord>("blobs");
        const garbage = blobs.filter(
          (blob) => blob.state === "garbage" && blob.referenceCount === 0,
        );
        for (const blob of garbage) await finishGarbageBlob(blob.id, blob.opfsPath);
        await collectOrphanedBlobs();
        await collectOrphanedSplitPartials();
      }),
  );
}

async function collectOrphanedSplitPartials(): Promise<void> {
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await (await opfsRoot(false)).getDirectoryHandle("partials");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw storageFailure("The partial-model directory could not be reconciled.", error);
  }
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "directory" && name.startsWith("split-")) {
      await deleteStoredPath(`partials/${name}`);
    }
  }
}

async function collectOrphanedBlobs(): Promise<void> {
  const [blobs, models, jobs] = await Promise.all([
    allRecords<BlobRecord>("blobs"),
    allRecords<InstalledModelRecord>("models"),
    allRecords<AcquisitionJobRecord>("jobs"),
  ]);
  const retainedPaths = new Set(blobs.map((blob) => blob.opfsPath));
  for (const model of models) for (const file of model.files) retainedPaths.add(file.opfsPath);
  for (const job of jobs) {
    for (const file of job.files) {
      if (file.verifiedSha256 !== undefined) retainedPaths.add(`blobs/${file.verifiedSha256}`);
    }
  }
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await (await opfsRoot(false)).getDirectoryHandle("blobs");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw storageFailure("The content-addressed model directory could not be reconciled.", error);
  }
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || !/^[a-f0-9]{64}$/u.test(name)) continue;
    const path = `blobs/${name}`;
    if (!retainedPaths.has(path)) await deleteStoredPath(path);
  }
}

async function storageSummary(
  models: readonly InstalledModelRecord[],
  jobs: readonly AcquisitionJobRecord[],
): Promise<StorageSummary> {
  const [estimate, persisted] = await Promise.all([
    typeof navigator.storage?.estimate === "function"
      ? boundedStorageOperation(async () => await navigator.storage.estimate())
      : undefined,
    typeof navigator.storage?.persisted === "function"
      ? boundedStorageOperation(async () => await navigator.storage.persisted())
      : undefined,
  ]);
  const installedPaths = new Map<string, number>();
  for (const model of models) {
    if (model.state !== "installed") continue;
    for (const file of model.files) installedPaths.set(file.opfsPath, file.size);
  }
  return {
    modelBytes: [...installedPaths.values()].reduce((total, size) => total + size, 0),
    partialBytes: jobs.reduce(
      (total, job) => total + job.files.reduce((sum, file) => sum + file.durableBytes, 0),
      0,
    ),
    ...(estimate?.usage === undefined ? {} : { originUsage: estimate.usage }),
    ...(estimate?.quota === undefined ? {} : { originQuota: estimate.quota }),
    ...(persisted === undefined ? {} : { persisted }),
  };
}

export async function reconcileModelInventory(): Promise<ModelInventory> {
  await collectGarbage();
  const models = await allRecords<InstalledModelRecord>("models");
  const jobs = await allRecords<AcquisitionJobRecord>("jobs");
  const reconciledModels: InstalledModelRecord[] = [];
  const reconciledJobs: AcquisitionJobRecord[] = [];
  const changedModels: Array<{
    readonly original: InstalledModelRecord;
    readonly next: InstalledModelRecord;
  }> = [];
  const changedJobs: Array<{
    readonly original: AcquisitionJobRecord;
    readonly next: AcquisitionJobRecord;
  }> = [];

  for (const model of models) {
    let missing = false;
    try {
      for (const file of model.files) {
        const stored = await getStoredFile(file.opfsPath);
        if (stored === undefined || stored.size !== file.size) {
          missing = true;
          break;
        }
      }
    } catch {
      missing = true;
    }
    const reconciled =
      model.state === (missing ? "missing" : "installed")
        ? model
        : { ...model, state: missing ? ("missing" as const) : ("installed" as const) };
    if (reconciled !== model) changedModels.push({ original: model, next: reconciled });
    reconciledModels.push(reconciled);
  }

  for (const job of jobs) {
    let reconciled: AcquisitionJobRecord;
    try {
      const active = await isJobActive(job.id);
      if (isDownloadJob(job)) {
        const files: DownloadJobRecord["files"] = await Promise.all(
          job.files.map(async (file) => {
            const stored = await getStoredFile(file.partialPath);
            const actual = stored?.size ?? 0;
            if (actual > file.source.size) throw oversizedPartialFailure();
            return actual === file.durableBytes ? file : { ...file, durableBytes: actual };
          }),
        );
        const state =
          !active &&
          (job.state === "queued" || job.state === "downloading" || job.state === "verifying")
            ? ("paused" as const)
            : job.state;
        reconciled =
          files.every((file, index) => file === job.files[index]) && state === job.state
            ? job
            : { ...job, files, state, updatedAt: new Date().toISOString() };
      } else {
        const files: LocalImportJobRecord["files"] = await Promise.all(
          job.files.map(async (file) => {
            const stored = await getStoredFile(file.partialPath);
            const promoted =
              stored === undefined && file.verifiedSha256 !== undefined
                ? await getStoredFile(`blobs/${file.verifiedSha256}`)
                : undefined;
            const actual = stored?.size ?? promoted?.size ?? 0;
            if (actual > file.source.size) throw oversizedPartialFailure();
            return actual === file.durableBytes ? file : { ...file, durableBytes: actual };
          }),
        );
        const complete = files.every(
          (file) => file.phase === "verified" && file.durableBytes === file.source.size,
        );
        const state =
          complete && !active
            ? ("ready-to-install" as const)
            : !active && job.state === "importing"
              ? ("needs-source" as const)
              : job.state;
        reconciled =
          files.every((file, index) => file === job.files[index]) && state === job.state
            ? job
            : { ...job, files, state, updatedAt: new Date().toISOString() };
      }
    } catch (error) {
      reconciled = {
        ...job,
        state: "failed",
        error: inventoryFailure(error),
        updatedAt: new Date().toISOString(),
      };
    }
    if (reconciled !== job) changedJobs.push({ original: job, next: reconciled });
    reconciledJobs.push(reconciled);
  }
  const removedModels = new Set<string>();
  const removedJobs = new Set<string>();
  const currentJobs = new Map<string, AcquisitionJobRecord>();
  if (changedModels.length > 0 || changedJobs.length > 0) {
    const database = await openModelDatabase();
    const transaction = database.transaction(["models", "jobs"], "readwrite");
    const done = transactionDone(transaction);
    const modelStore = transaction.objectStore("models");
    const jobStore = transaction.objectStore("jobs");
    for (const change of changedModels) {
      const current = await requestResult(
        modelStore.get(change.original.id) as IDBRequest<InstalledModelRecord | undefined>,
      );
      if (current === undefined) removedModels.add(change.original.id);
      else modelStore.put(change.next);
    }
    for (const change of changedJobs) {
      const current = await requestResult(
        jobStore.get(change.original.id) as IDBRequest<AcquisitionJobRecord | undefined>,
      );
      if (current === undefined) removedJobs.add(change.original.id);
      else if (current.updatedAt === change.original.updatedAt) jobStore.put(change.next);
      else currentJobs.set(current.id, current);
    }
    await done;
  }
  const finalModels = reconciledModels.filter((model) => !removedModels.has(model.id));
  const finalJobs = reconciledJobs
    .filter((job) => !removedJobs.has(job.id))
    .map((job) => currentJobs.get(job.id) ?? job);
  return {
    models: finalModels.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    jobs: finalJobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    storage: await storageSummary(finalModels, finalJobs),
  };
}

export async function requestStoragePersistence(): Promise<boolean> {
  if (navigator.storage === undefined || typeof navigator.storage.persist !== "function") {
    throw new ModelOperationError({
      code: "unsupported",
      phase: "storage",
      message: "This browser does not offer a storage persistence request.",
      retryable: false,
    });
  }
  try {
    const persisted = await boundedStorageOperation(async () => await navigator.storage.persist());
    if (persisted === undefined) throw storageFailure("The storage persistence request timed out.");
    return persisted;
  } catch (error) {
    if (error instanceof ModelOperationError) throw error;
    throw storageFailure("The browser did not complete the storage persistence request.", error);
  }
}
