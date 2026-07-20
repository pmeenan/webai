/// <reference lib="webworker" />

import { openHuggingFaceCatalog } from "./catalog";
import { inspectGgufBlob } from "./gguf";
import { splitGgufFile, WllamaShardLimitError } from "./gguf-split";
import {
  ggufSplitMaxShardBytes,
  ggufSplitThresholdBytes,
  ggufSplitToolVersion,
} from "./gguf-split-profile";
import { createIntegrityHasher, createSha256 } from "./hashing";
import {
  browseHuggingFaceModels,
  fetchHuggingFaceLineage,
  fetchWith429Backoff,
  resolveHuggingFaceModel,
  resolverUrl,
  validateRangeResponse,
} from "./hugging-face";
import {
  type ModelWorkerEvent,
  type ModelWorkerRequest,
  modelWorkerProtocolVersion,
} from "./protocol";
import {
  DurableFileWriter,
  deleteModel,
  discardAcquisitionJob,
  getJob,
  getModel,
  getStoredFile,
  installModel,
  promotePartialFile,
  putJob,
  reconcileModelInventory,
  recordModelRuntimeIssue,
  replaceModelFiles,
  updateModelInspections,
  withAcquisitionLock,
} from "./storage";
import type {
  DownloadJobFile,
  DownloadJobRecord,
  GgufInspection,
  HuggingFaceArtifactChoice,
  HuggingFaceBaseModel,
  InstalledModelRecord,
  LocalImportJobFile,
  LocalImportJobRecord,
  ModelFailure,
  ModelFileRecord,
  ResolvedHuggingFaceRepository,
} from "./types";
import { ModelOperationError, modelSchemaVersion } from "./types";

const scope = self as DedicatedWorkerGlobalScope;
const checkpointBytes = 1024 * 1024;
const operations = new Map<string, AbortController>();
const browseOperations = new Map<string, AbortController>();
const lineageOperations = new Map<string, AbortController>();
const controlChannel =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("webai-model-control-v1");
let fallbackId = 0;

const lineageRelations = new Set(["adapter", "finetune", "merge", "quantized", "unknown"]);

function isLineageParent(value: unknown): value is HuggingFaceBaseModel {
  if (typeof value !== "object" || value === null) return false;
  const parent = value as { readonly repo?: unknown; readonly relation?: unknown };
  return (
    typeof parent.repo === "string" &&
    parent.repo.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(parent.repo) &&
    (parent.relation === undefined ||
      (typeof parent.relation === "string" && lineageRelations.has(parent.relation)))
  );
}

controlChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "pause" &&
    "jobId" in value &&
    typeof value.jobId === "string" &&
    value.jobId.length <= 160
  ) {
    operations.get(value.jobId)?.abort();
  }
});

function makeId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    fallbackId += 1;
    return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
  }
}

function isDownloadJob(job: Awaited<ReturnType<typeof getJob>>): job is DownloadJobRecord {
  return job?.source.kind === "hugging-face";
}

function restrictedSource(source: DownloadJobRecord["source"]): boolean {
  return (
    source.visibility === "private" ||
    source.gating === "automatic" ||
    source.gating === "manual" ||
    source.gating === "gated"
  );
}

type WorkerEventWithoutVersion = ModelWorkerEvent extends infer Event
  ? Event extends ModelWorkerEvent
    ? Omit<Event, "protocolVersion">
    : never
  : never;

function post(event: WorkerEventWithoutVersion): void {
  scope.postMessage({ protocolVersion: modelWorkerProtocolVersion, ...event });
}

function failureFrom(error: unknown, phase: ModelFailure["phase"]): ModelFailure {
  if (error instanceof ModelOperationError) return error.failure;
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "aborted", phase, message: "The operation was paused.", retryable: true };
  }
  return {
    code: "storage",
    phase,
    message: "The model operation could not be completed. Retry it or remove its partial data.",
    retryable: true,
  };
}

function jobProgress(job: DownloadJobRecord): number {
  return job.files.reduce((total, file) => total + file.durableBytes, 0);
}

function totalBytes(job: DownloadJobRecord): number {
  return job.files.reduce((total, file) => total + file.source.size, 0);
}

async function withJobLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
  const locks = (scope.navigator as Navigator & { readonly locks?: LockManager }).locks;
  if (locks === undefined) {
    if (operations.has(jobId)) {
      throw new ModelOperationError({
        code: "protocol",
        phase: "storage",
        message: "This model operation is already active.",
        retryable: true,
      });
    }
    return await operation();
  }
  let acquired = false;
  let result: T | undefined;
  await locks.request(`webai-model-job-v1-${jobId}`, { ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    acquired = true;
    result = await operation();
  });
  if (!acquired) {
    throw new ModelOperationError({
      code: "protocol",
      phase: "storage",
      message: "This model operation is already active in another tab.",
      retryable: true,
    });
  }
  return result as T;
}

async function persistJobFile(
  job: DownloadJobRecord,
  index: number,
  update: Partial<DownloadJobFile>,
  state: DownloadJobRecord["state"],
): Promise<DownloadJobRecord> {
  const files = job.files.map((file, fileIndex) =>
    fileIndex === index ? { ...file, ...update } : file,
  );
  const next: DownloadJobRecord = { ...job, files, state, updatedAt: new Date().toISOString() };
  await putJob(next);
  return next;
}

async function hashStoredFile(
  file: File,
  declared: DownloadJobFile["source"],
  signal: AbortSignal,
): Promise<{
  sha256: string;
  inspection?: GgufInspection;
  inspectionError?: ModelFailure;
}> {
  const integrity = createIntegrityHasher(declared.integrity, declared.size);
  const rawSha256 = createSha256();
  const reader = file.stream().getReader();
  let bytes = 0;
  while (true) {
    signal.throwIfAborted();
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > declared.size) {
      throw new ModelOperationError({
        code: "integrity-mismatch",
        phase: "verify",
        message: "The stored file exceeds its pinned size.",
        retryable: false,
      });
    }
    integrity.update(result.value);
    rawSha256.update(result.value);
  }
  if (bytes !== declared.size || integrity.digestHex() !== declared.integrity.digest) {
    throw new ModelOperationError({
      code: "integrity-mismatch",
      phase: "verify",
      message: `Integrity verification failed for ${declared.path}. The file was not installed.`,
      retryable: false,
    });
  }
  signal.throwIfAborted();
  return { sha256: rawSha256.digestHex(), ...(await inspectBestEffort(file)) };
}

async function inspectBestEffort(
  file: Blob,
): Promise<{ inspection?: GgufInspection; inspectionError?: ModelFailure }> {
  try {
    return { inspection: await inspectGgufBlob(file) };
  } catch (error) {
    return {
      inspectionError:
        error instanceof ModelOperationError
          ? error.failure
          : {
              code: "gguf-invalid",
              phase: "inspect",
              message: "This WebAI version could not extract metadata from the stored file.",
              retryable: true,
            },
    };
  }
}

async function hashBlobSha256(blob: Blob, signal: AbortSignal): Promise<string> {
  const hash = createSha256();
  const reader = blob.stream().getReader();
  while (true) {
    signal.throwIfAborted();
    const result = await reader.read();
    if (result.done) break;
    hash.update(result.value);
  }
  signal.throwIfAborted();
  return hash.digestHex();
}

async function downloadFile(
  requestId: string,
  initialJob: DownloadJobRecord,
  fileIndex: number,
  signal: AbortSignal,
): Promise<DownloadJobRecord> {
  let job = initialJob;
  const jobFile = job.files[fileIndex];
  if (jobFile === undefined) throw new Error("missing job file");
  let stored = await getStoredFile(jobFile.partialPath);
  let durable = stored?.size ?? 0;
  if (durable > jobFile.source.size) {
    throw new ModelOperationError({
      code: "storage",
      phase: "download",
      message: "The durable partial exceeds the pinned file size.",
      retryable: false,
    });
  }
  job = await persistJobFile(
    job,
    fileIndex,
    { durableBytes: durable, phase: "downloading" },
    "downloading",
  );

  while (durable < jobFile.source.size) {
    signal.throwIfAborted();
    const url = resolverUrl(job.source.repo, job.source.commit, jobFile.source.path);
    let response: Response;
    try {
      response = await fetchWith429Backoff(
        fetch,
        url,
        {
          headers: { Range: `bytes=${durable}-` },
          redirect: "follow",
          signal,
        },
        {
          signal,
          onRetry: ({ attempt, delayMs }) =>
            post({
              type: "model/retry",
              requestId,
              phase: "download",
              attempt,
              delayMs,
              message: `Hugging Face rate-limited ${jobFile.source.path}. Retrying automatically; pause to cancel.`,
            }),
        },
      );
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
        throw new DOMException("paused", "AbortError");
      throw new ModelOperationError({
        code: "network",
        phase: "download",
        message: `The transfer of ${jobFile.source.path} was interrupted. Its durable prefix was kept.`,
        retryable: true,
      });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelOperationError({
        code: "input-invalid",
        phase: "download",
        message: "This download is not public. WebAI supports only public, ungated models.",
        retryable: false,
      });
    }
    const range = validateRangeResponse(response, durable, jobFile.source.size);
    if (response.body === null) {
      throw new ModelOperationError({
        code: "range-invalid",
        phase: "download",
        message: "The partial response had no readable body.",
        retryable: true,
      });
    }
    const reader = response.body.getReader();
    const writer = await DurableFileWriter.open(jobFile.partialPath);
    let intervalBytes = 0;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const chunk = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        chunk.set(part, offset);
        offset += part.byteLength;
      }
      if (intervalBytes > range.length) {
        throw new ModelOperationError({
          code: "range-invalid",
          phase: "download",
          message: "The response body exceeded its declared byte range.",
          retryable: true,
        });
      }
      await writer.write(durable, chunk);
      durable += chunk.byteLength;
      pending = [];
      pendingBytes = 0;
      job = await persistJobFile(
        job,
        fileIndex,
        { durableBytes: durable, phase: "downloading" },
        "downloading",
      );
      post({
        type: "model/progress",
        requestId,
        jobId: job.id,
        phase: "downloading",
        completedBytes: jobProgress(job),
        totalBytes: totalBytes(job),
        currentFile: jobFile.source.path,
      });
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        intervalBytes += result.value.byteLength;
        if (intervalBytes > range.length) {
          await reader.cancel().catch(() => undefined);
          throw new ModelOperationError({
            code: "range-invalid",
            phase: "download",
            message: "The response body exceeded its declared byte range.",
            retryable: true,
          });
        }
        pending.push(result.value);
        pendingBytes += result.value.byteLength;
        if (pendingBytes >= checkpointBytes) await flush();
      }
      await flush();
    } catch (error) {
      if (error instanceof ModelOperationError) throw error;
      if (signal.aborted) throw new DOMException("paused", "AbortError");
      throw new ModelOperationError({
        code: "network",
        phase: "download",
        message: `The response body for ${jobFile.source.path} was interrupted. Its durable prefix was kept.`,
        retryable: true,
      });
    } finally {
      writer.close();
    }
    if (intervalBytes !== range.length) {
      throw new ModelOperationError({
        code: "range-invalid",
        phase: "download",
        message: "The response body ended before its declared byte range.",
        retryable: true,
      });
    }
  }

  job = await persistJobFile(
    job,
    fileIndex,
    { durableBytes: durable, phase: "verifying" },
    "verifying",
  );
  post({
    type: "model/progress",
    requestId,
    jobId: job.id,
    phase: "verifying",
    completedBytes: jobProgress(job),
    totalBytes: totalBytes(job),
    currentFile: jobFile.source.path,
  });
  stored = await getStoredFile(jobFile.partialPath);
  if (stored === undefined || stored.size !== jobFile.source.size) {
    throw new ModelOperationError({
      code: "storage",
      phase: "verify",
      message: "The durable partial disappeared before verification.",
      retryable: true,
    });
  }
  const verified = await hashStoredFile(stored, jobFile.source, signal);
  return await persistJobFile(
    job,
    fileIndex,
    {
      phase: "verified",
      verifiedSha256: verified.sha256,
      ...(verified.inspection === undefined ? {} : { inspection: verified.inspection }),
      ...(verified.inspectionError === undefined
        ? {}
        : { inspectionError: verified.inspectionError }),
    },
    "verifying",
  );
}

async function finishJob(
  job: DownloadJobRecord,
  signal: AbortSignal,
): Promise<InstalledModelRecord> {
  const files: ModelFileRecord[] = [];
  for (const jobFile of job.files) {
    signal.throwIfAborted();
    if (jobFile.verifiedSha256 === undefined) throw new Error("unverified job file");
    const opfsPath = await promotePartialFile(
      jobFile.partialPath,
      jobFile.verifiedSha256,
      jobFile.source.size,
    );
    files.push({
      blobId: `sha256:${jobFile.verifiedSha256}`,
      displayName: jobFile.source.path,
      size: jobFile.source.size,
      sha256: jobFile.verifiedSha256,
      opfsPath,
      ...(jobFile.inspection === undefined ? {} : { inspection: jobFile.inspection }),
      ...(jobFile.inspectionError === undefined
        ? {}
        : { inspectionError: jobFile.inspectionError }),
    });
  }
  signal.throwIfAborted();
  const model: InstalledModelRecord = {
    schemaVersion: modelSchemaVersion,
    id: job.id,
    displayName: job.displayName,
    createdAt: new Date().toISOString(),
    totalSize: totalBytes(job),
    state: "installed",
    source: job.source,
    files,
  };
  await installModel(model);
  return model;
}

async function executeDownloadJob(
  requestId: string,
  initial: DownloadJobRecord,
  signal: AbortSignal,
): Promise<void> {
  const { error: previousError, ...cleanJob } = initial;
  let job: DownloadJobRecord = {
    ...cleanJob,
    state: "queued",
    updatedAt: new Date().toISOString(),
  };
  if (previousError !== undefined) await putJob(job);
  for (let index = 0; index < job.files.length; index += 1) {
    if (job.files[index]?.phase !== "verified")
      job = await downloadFile(requestId, job, index, signal);
  }
  const model = await finishJob(job, signal);
  post({ type: "model/complete", requestId, modelId: model.id });
}

async function runJob(requestId: string, initial: DownloadJobRecord): Promise<void> {
  const controller = new AbortController();
  operations.set(initial.id, controller);
  try {
    await withJobLock(
      initial.id,
      async () =>
        await withAcquisitionLock(
          async () => await executeDownloadJob(requestId, initial, controller.signal),
          controller.signal,
        ),
    );
  } catch (error) {
    const failure = failureFrom(error, "download");
    const current = await getJob(initial.id);
    if (isDownloadJob(current)) {
      const state = failure.code === "aborted" ? "paused" : "failed";
      const next: DownloadJobRecord = {
        ...current,
        state,
        updatedAt: new Date().toISOString(),
        ...(failure.code === "aborted" ? {} : { error: failure }),
      };
      await putJob(next);
      post({ type: "model/job", requestId, job: next });
    }
    if (failure.code !== "aborted") post({ type: "model/error", requestId, failure });
    else post({ type: "model/complete", requestId });
  } finally {
    operations.delete(initial.id);
  }
}

function createJob(
  repository: ResolvedHuggingFaceRepository,
  choice: HuggingFaceArtifactChoice,
): DownloadJobRecord {
  const id = makeId("model");
  const now = new Date().toISOString();
  return {
    schemaVersion: modelSchemaVersion,
    id,
    displayName: `${repository.repo} · ${choice.quantization}`,
    createdAt: now,
    updatedAt: now,
    state: "queued",
    source: {
      kind: "hugging-face",
      repo: repository.repo,
      requestedRevision: repository.requestedRevision,
      commit: repository.commit,
      files: choice.files,
      ...(repository.metadata.license === undefined
        ? {}
        : { license: repository.metadata.license }),
      gating: repository.metadata.gating,
      ...(repository.metadata.visibility === undefined
        ? {}
        : { visibility: repository.metadata.visibility }),
      ...(repository.metadata.pipelineTask === undefined
        ? {}
        : { pipelineTask: repository.metadata.pipelineTask }),
    },
    files: choice.files.map((source, index) => ({
      source,
      partialPath: `partials/${id}/${index}.part`,
      durableBytes: 0,
      phase: "pending",
    })),
  };
}

function validateImportFiles(files: readonly File[]): void {
  if (files.length === 0 || files.length > 256) {
    throw new ModelOperationError({
      code: "input-invalid",
      phase: "import",
      message: "Select between 1 and 256 GGUF files.",
      retryable: false,
    });
  }
  const names = new Set<string>();
  for (const file of files) {
    let hasControlCharacter = false;
    for (const character of file.name) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 31 || code === 127) {
        hasControlCharacter = true;
        break;
      }
    }
    if (
      file.name.length === 0 ||
      file.name.length > 512 ||
      !file.name.toLowerCase().endsWith(".gguf") ||
      hasControlCharacter ||
      /[/\\]/u.test(file.name) ||
      names.has(file.name)
    ) {
      throw new ModelOperationError({
        code: "input-invalid",
        phase: "import",
        message: "Every imported file must have a unique, safe .gguf filename.",
        retryable: false,
      });
    }
    names.add(file.name);
  }
  if (files.length > 1) {
    const pattern = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/iu;
    const matches = files.map((file) => file.name.match(pattern));
    const first = matches[0];
    if (first === undefined || first === null) {
      throw new ModelOperationError({
        code: "input-invalid",
        phase: "import",
        message: "Multiple imports must form one complete GGUF shard set.",
        retryable: false,
      });
    }
    if (
      matches.some((match) => match === null || match[1] !== first[1] || match[3] !== first[3]) ||
      Number(first[3]) !== files.length
    ) {
      throw new ModelOperationError({
        code: "input-invalid",
        phase: "import",
        message: "Multiple imports must form one complete GGUF shard set.",
        retryable: false,
      });
    }
    const indexes = new Set(matches.map((match) => Number(match?.[2])));
    if (
      indexes.size !== files.length ||
      [...indexes].some((index) => index < 1 || index > files.length)
    ) {
      throw new ModelOperationError({
        code: "input-invalid",
        phase: "import",
        message: "The imported GGUF shard indexes are incomplete or duplicated.",
        retryable: false,
      });
    }
  }
}

async function importFiles(requestId: string, selected: readonly File[]): Promise<void> {
  validateImportFiles(selected);
  const files = [...selected].sort((left, right) => left.name.localeCompare(right.name));
  const id = makeId("import");
  const now = new Date().toISOString();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  let job: LocalImportJobRecord = {
    schemaVersion: modelSchemaVersion,
    id,
    displayName:
      files.length === 1
        ? (files[0]?.name ?? "Imported GGUF")
        : `${files[0]?.name.replace(/-\d{5}-of-\d{5}\.gguf$/iu, "") ?? "Imported GGUF"} (${files.length} shards)`,
    createdAt: now,
    updatedAt: now,
    state: "importing",
    source: {
      kind: "local-import",
      filenames: files.map((file) => file.name),
      lastModified: files.map((file) => file.lastModified),
    },
    files: files.map((file, index) => ({
      source: { name: file.name, size: file.size, lastModified: file.lastModified },
      partialPath: `partials/${id}/${index}.part`,
      durableBytes: 0,
      phase: "pending",
    })),
  };
  await putJob(job);
  post({ type: "model/job", requestId, job });
  const controller = new AbortController();
  operations.set(id, controller);
  try {
    await withJobLock(
      id,
      async () =>
        await withAcquisitionLock(async () => {
          for (let index = 0; index < files.length; index += 1) {
            controller.signal.throwIfAborted();
            const file = files[index];
            const jobFile = job.files[index];
            if (file === undefined || jobFile === undefined) continue;
            const writer = await DurableFileWriter.open(jobFile.partialPath);
            const hash = createSha256();
            const reader = file.stream().getReader();
            let offset = 0;
            let pending: Uint8Array[] = [];
            let pendingBytes = 0;
            const flush = async () => {
              if (pendingBytes === 0) return;
              controller.signal.throwIfAborted();
              const chunk = new Uint8Array(pendingBytes);
              let chunkOffset = 0;
              for (const part of pending) {
                chunk.set(part, chunkOffset);
                chunkOffset += part.byteLength;
              }
              await writer.write(offset, chunk);
              offset += chunk.byteLength;
              completed += chunk.byteLength;
              pending = [];
              pendingBytes = 0;
              const updatedFile: LocalImportJobFile = {
                ...jobFile,
                durableBytes: offset,
                phase: "importing",
              };
              job = {
                ...job,
                files: job.files.map((entry, entryIndex) =>
                  entryIndex === index ? updatedFile : entry,
                ),
                updatedAt: new Date().toISOString(),
              };
              await putJob(job);
              post({ type: "model/job", requestId, job });
              post({
                type: "model/progress",
                requestId,
                jobId: id,
                phase: "importing",
                completedBytes: completed,
                totalBytes: total,
                currentFile: file.name,
              });
            };
            try {
              while (true) {
                controller.signal.throwIfAborted();
                const result = await reader.read();
                if (result.done) break;
                hash.update(result.value);
                pending.push(result.value);
                pendingBytes += result.value.byteLength;
                if (pendingBytes >= checkpointBytes) await flush();
              }
              await flush();
            } finally {
              writer.close();
            }
            if (offset !== file.size)
              throw new ModelOperationError({
                code: "storage",
                phase: "import",
                message: `The import of ${file.name} was incomplete.`,
                retryable: true,
              });
            post({
              type: "model/progress",
              requestId,
              jobId: id,
              phase: "verifying",
              completedBytes: completed,
              totalBytes: total,
              currentFile: `Verifying stored bytes for ${file.name}`,
            });
            const stored = await getStoredFile(jobFile.partialPath);
            if (stored === undefined || stored.size !== file.size)
              throw new ModelOperationError({
                code: "storage",
                phase: "verify",
                message: `The stored import of ${file.name} is incomplete.`,
                retryable: true,
              });
            const sourceSha256 = hash.digestHex();
            const sha256 = await hashBlobSha256(stored, controller.signal);
            if (sha256 !== sourceSha256)
              throw new ModelOperationError({
                code: "integrity-mismatch",
                phase: "verify",
                message: `Stored bytes for ${file.name} do not match the selected file.`,
                retryable: false,
              });
            const inspection = await inspectBestEffort(stored);
            const verifiedFile: LocalImportJobFile = {
              ...jobFile,
              durableBytes: offset,
              phase: "verified",
              verifiedSha256: sha256,
              ...inspection,
            };
            job = {
              ...job,
              files: job.files.map((entry, entryIndex) =>
                entryIndex === index ? verifiedFile : entry,
              ),
              updatedAt: new Date().toISOString(),
            };
            await putJob(job);
            post({ type: "model/job", requestId, job });
          }
        }, controller.signal),
    );
  } catch (error) {
    const failure = failureFrom(error, "import");
    const stopped = failure.code === "aborted";
    const failed: LocalImportJobRecord = {
      ...job,
      state: stopped ? "needs-source" : "failed",
      ...(stopped ? {} : { error: failure }),
      updatedAt: new Date().toISOString(),
    };
    await putJob(failed);
    post({ type: "model/job", requestId, job: failed });
    if (stopped) {
      post({ type: "model/complete", requestId });
      return;
    }
    throw error;
  } finally {
    operations.delete(id);
  }
  job = {
    ...job,
    state: "ready-to-install",
    updatedAt: new Date().toISOString(),
  };
  await putJob(job);
  post({ type: "model/job", requestId, job });
  await withJobLock(
    job.id,
    async () => await withAcquisitionLock(async () => await attemptFinishImport(requestId, job)),
  );
}

async function attemptFinishImport(requestId: string, job: LocalImportJobRecord): Promise<void> {
  try {
    await finishImportJob(requestId, job);
  } catch (error) {
    if ((await getModel(job.id)) !== undefined) throw error;
    const retryable: LocalImportJobRecord = {
      ...job,
      state: "ready-to-install",
      error: failureFrom(error, "import"),
      updatedAt: new Date().toISOString(),
    };
    await putJob(retryable);
    post({ type: "model/job", requestId, job: retryable });
    throw error;
  }
}

async function finishImportJob(requestId: string, job: LocalImportJobRecord): Promise<void> {
  const records: ModelFileRecord[] = [];
  for (const jobFile of job.files) {
    if (jobFile.verifiedSha256 === undefined) throw new Error("unverified import file");
    const opfsPath = await promotePartialFile(
      jobFile.partialPath,
      jobFile.verifiedSha256,
      jobFile.source.size,
    );
    records.push({
      blobId: `sha256:${jobFile.verifiedSha256}`,
      displayName: jobFile.source.name,
      size: jobFile.source.size,
      sha256: jobFile.verifiedSha256,
      opfsPath,
      ...(jobFile.inspection === undefined ? {} : { inspection: jobFile.inspection }),
      ...(jobFile.inspectionError === undefined
        ? {}
        : { inspectionError: jobFile.inspectionError }),
    });
  }
  const model: InstalledModelRecord = {
    schemaVersion: modelSchemaVersion,
    id: job.id,
    displayName: job.displayName,
    createdAt: new Date().toISOString(),
    totalSize: job.files.reduce((sum, file) => sum + file.source.size, 0),
    state: "installed",
    source: {
      kind: "local-import",
      filenames: job.files.map((file) => file.source.name),
      lastModified: job.files.map((file) => file.source.lastModified),
      sha256: records.map((file) => file.sha256),
    },
    files: records,
  };
  post({
    type: "model/progress",
    requestId,
    jobId: job.id,
    phase: "verifying",
    completedBytes: job.files.reduce((sum, file) => sum + file.durableBytes, 0),
    totalBytes: job.files.reduce((sum, file) => sum + file.source.size, 0),
    currentFile: "Updating the verified manifest",
  });
  await installModel(model);
  post({ type: "model/complete", requestId, modelId: model.id });
}

function isCompanionFile(file: ModelFileRecord): boolean {
  const name = file.displayName.toLowerCase();
  return (
    name.includes("mtp-") ||
    name.includes("mmproj") ||
    file.inspection?.architecture === "gemma4-assistant" ||
    file.inspection?.architecture === "clip"
  );
}

function monolithicSplitCandidate(model: InstalledModelRecord): ModelFileRecord | undefined {
  const primary = model.files.filter((file) => !isCompanionFile(file));
  if (primary.length !== 1) return undefined;
  const file = primary[0];
  if (file === undefined || /-\d{5}-of-\d{5}\.gguf$/iu.test(file.displayName)) return undefined;
  return file;
}

async function splitInstalledModel(
  requestId: string,
  model: InstalledModelRecord,
  signal: AbortSignal,
): Promise<InstalledModelRecord> {
  const sourceFile = monolithicSplitCandidate(model);
  if (sourceFile === undefined) {
    throw new ModelOperationError({
      code: "unsupported",
      phase: "split",
      message: "This model is already sharded or does not contain one identifiable primary GGUF.",
      retryable: false,
    });
  }
  const source = await getStoredFile(sourceFile.opfsPath);
  if (source === undefined || source.size !== sourceFile.size) {
    throw new ModelOperationError({
      code: "storage",
      phase: "split",
      message: "The monolithic GGUF bytes are missing or incomplete.",
      retryable: true,
    });
  }
  let result: Awaited<ReturnType<typeof splitGgufFile>>;
  try {
    result = await splitGgufFile(
      source,
      sourceFile.displayName,
      `partials/split-${model.id}-${Date.now().toString(36)}`,
      signal,
      (completedBytes, totalBytes_, splitStage) =>
        post({
          type: "model/progress",
          requestId,
          jobId: model.id,
          phase: "splitting",
          splitStage,
          completedBytes,
          totalBytes: totalBytes_,
          currentFile: sourceFile.displayName,
        }),
    );
  } catch (error) {
    if (error instanceof WllamaShardLimitError) {
      await recordModelRuntimeIssue(model.id, {
        runtimeId: "wllama",
        reasonCode: "minimum-shard-size",
        message: error.failure.message,
        measuredAt: new Date().toISOString(),
        limitBytes: ggufSplitThresholdBytes,
        requiredShardBytes: error.requiredShardBytes,
        splitterVersion: ggufSplitToolVersion,
      });
    }
    throw error;
  }
  if (result.sourceSha256 !== sourceFile.sha256) {
    throw new ModelOperationError({
      code: "integrity-mismatch",
      phase: "split",
      message: "The stored source changed while GGUF shards were being generated.",
      retryable: false,
    });
  }
  return await replaceModelFiles(model.id, sourceFile, result.files, {
    kind: "gguf-split",
    sourceBlobId: sourceFile.blobId,
    sourceSha256: sourceFile.sha256,
    toolVersion: ggufSplitToolVersion,
    maxShardBytes: ggufSplitMaxShardBytes,
  });
}

async function reinspectModel(requestId: string, modelId: string): Promise<void> {
  const model = await getModel(modelId);
  if (model === undefined) {
    throw new ModelOperationError({
      code: "input-invalid",
      phase: "inspect",
      message: "The installed model no longer exists.",
      retryable: false,
    });
  }
  const files: ModelFileRecord[] = [];
  for (const file of model.files) {
    const stored = await getStoredFile(file.opfsPath);
    if (stored === undefined || stored.size !== file.size) {
      throw new ModelOperationError({
        code: "storage",
        phase: "inspect",
        message: `The stored bytes for ${file.displayName} are missing or incomplete.`,
        retryable: true,
      });
    }
    const identity = {
      blobId: file.blobId,
      displayName: file.displayName,
      size: file.size,
      sha256: file.sha256,
      opfsPath: file.opfsPath,
    };
    files.push({ ...identity, ...(await inspectBestEffort(stored)) });
  }
  const updated = await updateModelInspections(modelId, files);
  if (updated === undefined) {
    throw new ModelOperationError({
      code: "input-invalid",
      phase: "inspect",
      message: "The installed model was deleted while its metadata was being inspected.",
      retryable: false,
    });
  }
  post({ type: "model/complete", requestId, modelId });
}

scope.addEventListener("message", (message: MessageEvent<unknown>) => {
  const request = message.data as Partial<ModelWorkerRequest>;
  if (
    typeof request.requestId !== "string" ||
    request.requestId.length === 0 ||
    request.requestId.length > 160
  )
    return;
  const requestId = request.requestId;
  if (request.protocolVersion !== modelWorkerProtocolVersion) {
    post({
      type: "model/error",
      requestId,
      failure: {
        code: "protocol",
        phase: "storage",
        message: "The model worker protocol version does not match this page.",
        retryable: false,
      },
    });
    return;
  }
  void (async () => {
    try {
      switch (request.type) {
        case "model/resolve": {
          if (typeof request.input !== "string") throw new Error("invalid request");
          const repository = await resolveHuggingFaceModel(
            request.input,
            fetch,
            ({ attempt, delayMs }) =>
              post({
                type: "model/retry",
                requestId,
                phase: "resolve",
                attempt,
                delayMs,
                message: "Hugging Face rate-limited the metadata request. Retrying automatically.",
              }),
          );
          post({ type: "model/resolved", requestId, repository });
          break;
        }
        case "model/browse": {
          if (
            request.filters === undefined ||
            typeof request.filters !== "object" ||
            typeof request.filters.query !== "string" ||
            request.filters.format !== "gguf"
          )
            throw new Error("invalid request");
          const controller = new AbortController();
          browseOperations.set(requestId, controller);
          try {
            const catalog = await openHuggingFaceCatalog();
            const result = await browseHuggingFaceModels(request.filters, {
              fetcher: fetch,
              signal: controller.signal,
              catalog,
              onRetry: ({ attempt, delayMs }) =>
                post({
                  type: "model/retry",
                  requestId,
                  phase: "browse",
                  attempt,
                  delayMs,
                  message:
                    "Hugging Face rate-limited model discovery. Retrying automatically; stop searching to cancel.",
                }),
              onProgress: ({ inspectedCandidates, inspectedPages }) =>
                post({
                  type: "model/browse-progress",
                  requestId,
                  inspectedCandidates,
                  inspectedPages,
                }),
            });
            post({ type: "model/browse-result", requestId, result });
          } finally {
            if (browseOperations.get(requestId) === controller) browseOperations.delete(requestId);
          }
          break;
        }
        case "model/browse-cancel": {
          if (typeof request.targetRequestId !== "string") throw new Error("invalid request");
          browseOperations.get(request.targetRequestId)?.abort();
          break;
        }
        case "model/lineage": {
          if (
            typeof request.repo !== "string" ||
            typeof request.commit !== "string" ||
            (request.parents !== undefined &&
              (!Array.isArray(request.parents) ||
                request.parents.length > 16 ||
                !request.parents.every(isLineageParent)))
          )
            throw new Error("invalid request");
          const controller = new AbortController();
          lineageOperations.set(requestId, controller);
          try {
            const catalog = await openHuggingFaceCatalog();
            const lineage = await fetchHuggingFaceLineage(
              {
                repo: request.repo,
                commit: request.commit,
                parents: request.parents ?? [],
              },
              {
                fetcher: fetch,
                signal: controller.signal,
                catalog,
                onRetry: ({ attempt, delayMs }) =>
                  post({
                    type: "model/retry",
                    requestId,
                    phase: "lineage",
                    attempt,
                    delayMs,
                    message:
                      "Hugging Face rate-limited the lineage request. Retrying automatically.",
                  }),
                onProgress: (inspectedNodes) =>
                  post({ type: "model/lineage-progress", requestId, inspectedNodes }),
              },
            );
            post({ type: "model/lineage-result", requestId, lineage });
          } finally {
            if (lineageOperations.get(requestId) === controller)
              lineageOperations.delete(requestId);
          }
          break;
        }
        case "model/lineage-cancel": {
          if (typeof request.targetRequestId !== "string") throw new Error("invalid request");
          lineageOperations.get(request.targetRequestId)?.abort();
          break;
        }
        case "model/download": {
          if (request.repository === undefined || request.choice === undefined)
            throw new Error("invalid request");
          if (
            request.repository.metadata.visibility !== "public" ||
            request.repository.metadata.gating !== "open"
          )
            throw new ModelOperationError({
              code: "unsupported",
              phase: "download",
              message: "WebAI supports only public, ungated Hugging Face models.",
              retryable: false,
            });
          const job = createJob(request.repository, request.choice);
          await putJob(job);
          post({ type: "model/job", requestId, job });
          await runJob(requestId, job);
          break;
        }
        case "model/resume": {
          if (typeof request.jobId !== "string") throw new Error("invalid request");
          const job = await getJob(request.jobId);
          if (job === undefined)
            throw new ModelOperationError({
              code: "input-invalid",
              phase: "download",
              message: "The partial download no longer exists.",
              retryable: false,
            });
          if (!isDownloadJob(job))
            if (job.state === "ready-to-install") {
              await withJobLock(
                job.id,
                async () =>
                  await withAcquisitionLock(async () => await attemptFinishImport(requestId, job)),
              );
              break;
            } else {
              throw new ModelOperationError({
                code: "input-invalid",
                phase: "import",
                message:
                  "A local import cannot resume after its browser File objects are gone. Reselect the source files or discard this partial import.",
                retryable: false,
              });
            }
          else {
            if (restrictedSource(job.source))
              throw new ModelOperationError({
                code: "unsupported",
                phase: "download",
                message:
                  "This partial belongs to a restricted repository and cannot be resumed. Discard it to remove the partial data.",
                retryable: false,
              });
            await runJob(requestId, job);
          }
          break;
        }
        case "model/pause": {
          if (typeof request.jobId !== "string") throw new Error("invalid request");
          operations.get(request.jobId)?.abort();
          controlChannel?.postMessage({ type: "pause", jobId: request.jobId });
          break;
        }
        case "model/discard": {
          if (typeof request.jobId !== "string") throw new Error("invalid request");
          const job = await getJob(request.jobId);
          if (job !== undefined)
            await withJobLock(job.id, async () => await discardAcquisitionJob(job));
          post({ type: "model/complete", requestId });
          break;
        }
        case "model/import": {
          if (!Array.isArray(request.files)) throw new Error("invalid request");
          await importFiles(requestId, request.files);
          break;
        }
        case "model/inventory": {
          post({ type: "model/inventory", requestId, inventory: await reconcileModelInventory() });
          break;
        }
        case "model/delete": {
          if (typeof request.modelId !== "string") throw new Error("invalid request");
          await deleteModel(request.modelId);
          post({ type: "model/complete", requestId });
          break;
        }
        case "model/inspect": {
          if (typeof request.modelId !== "string") throw new Error("invalid request");
          await reinspectModel(requestId, request.modelId);
          break;
        }
        case "model/split": {
          if (typeof request.modelId !== "string") throw new Error("invalid request");
          const modelId = request.modelId;
          const controller = new AbortController();
          operations.set(modelId, controller);
          try {
            await withAcquisitionLock(async () => {
              const model = await getModel(modelId);
              if (model === undefined) {
                throw new ModelOperationError({
                  code: "input-invalid",
                  phase: "split",
                  message: "The installed model no longer exists.",
                  retryable: false,
                });
              }
              await splitInstalledModel(requestId, model, controller.signal);
            }, controller.signal);
          } finally {
            if (operations.get(modelId) === controller) operations.delete(modelId);
          }
          post({ type: "model/complete", requestId, modelId });
          break;
        }
        default:
          throw new Error("invalid request");
      }
    } catch (error) {
      post({
        type: "model/error",
        requestId,
        failure: failureFrom(
          error,
          request.type === "model/resolve" || request.type === "model/lineage"
            ? "resolve"
            : request.type === "model/import"
              ? "import"
              : request.type === "model/split"
                ? "split"
                : "storage",
        ),
      });
    }
  })();
});
