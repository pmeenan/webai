import type {
  AcquisitionJobRecord,
  HuggingFaceArtifactChoice,
  ModelFailure,
  ModelInventory,
  ResolvedHuggingFaceRepository,
} from "./types";

export const modelWorkerProtocolVersion = 1 as const;

export type ModelWorkerRequest =
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/resolve";
      readonly requestId: string;
      readonly input: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/download";
      readonly requestId: string;
      readonly repository: ResolvedHuggingFaceRepository;
      readonly choice: HuggingFaceArtifactChoice;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/resume";
      readonly requestId: string;
      readonly jobId: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/pause";
      readonly requestId: string;
      readonly jobId: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/discard";
      readonly requestId: string;
      readonly jobId: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/import";
      readonly requestId: string;
      readonly files: readonly File[];
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/inventory";
      readonly requestId: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/delete";
      readonly requestId: string;
      readonly modelId: string;
    };

export type ModelWorkerEvent =
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/resolved";
      readonly requestId: string;
      readonly repository: ResolvedHuggingFaceRepository;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/progress";
      readonly requestId: string;
      readonly jobId: string;
      readonly phase: "downloading" | "verifying" | "importing";
      readonly completedBytes: number;
      readonly totalBytes: number;
      readonly currentFile: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/retry";
      readonly requestId: string;
      readonly phase: "resolve" | "download";
      readonly attempt: number;
      readonly delayMs: number;
      readonly message: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/job";
      readonly requestId: string;
      readonly job: AcquisitionJobRecord;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/inventory";
      readonly requestId: string;
      readonly inventory: ModelInventory;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/complete";
      readonly requestId: string;
      readonly modelId?: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/error";
      readonly requestId: string;
      readonly failure: ModelFailure;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

function boundedText(value: unknown, maximum = 2_048): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    boundedText(value.code, 64) &&
    boundedText(value.phase, 64) &&
    boundedText(value.message, 2_048) &&
    typeof value.retryable === "boolean"
  );
}

function isInspection(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.format === "gguf" &&
    nonnegativeInteger(value.version) &&
    nonnegativeInteger(value.tensorCount) &&
    nonnegativeInteger(value.metadataCount) &&
    (value.architecture === undefined || boundedText(value.architecture, 512)) &&
    (value.name === undefined || boundedText(value.name, 1_024)) &&
    (value.quantization === undefined || boundedText(value.quantization, 128)) &&
    Array.isArray(value.entries) &&
    value.entries.length <= 128 &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        boundedText(entry.key, 1_024) &&
        boundedText(entry.type, 128) &&
        boundedText(entry.value, 2_048),
    ) &&
    nonnegativeInteger(value.omittedEntries)
  );
}

function isJob(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isSafeId(value.id) ||
    !boundedText(value.displayName) ||
    !boundedText(value.createdAt, 64) ||
    !boundedText(value.updatedAt, 64) ||
    !isRecord(value.source) ||
    !Array.isArray(value.files) ||
    value.files.length > 256 ||
    (value.error !== undefined && !isFailure(value.error))
  )
    return false;
  const remote = value.source.kind === "hugging-face";
  if (!remote && value.source.kind !== "local-import") return false;
  const validState = remote
    ? value.state === "queued" ||
      value.state === "downloading" ||
      value.state === "paused" ||
      value.state === "verifying" ||
      value.state === "failed"
    : value.state === "importing" ||
      value.state === "ready-to-install" ||
      value.state === "needs-source" ||
      value.state === "failed";
  return (
    validState &&
    value.files.every((file) => {
      if (
        !isRecord(file) ||
        !isRecord(file.source) ||
        !boundedText(file.partialPath, 1_024) ||
        !nonnegativeInteger(file.durableBytes) ||
        !nonnegativeInteger(file.source.size) ||
        (file.inspection !== undefined && !isInspection(file.inspection)) ||
        (file.verifiedSha256 !== undefined &&
          (typeof file.verifiedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.verifiedSha256)))
      )
        return false;
      return remote
        ? boundedText(file.source.path, 1_024) &&
            (file.phase === "pending" ||
              file.phase === "downloading" ||
              file.phase === "verifying" ||
              file.phase === "verified")
        : boundedText(file.source.name, 512) &&
            (file.phase === "pending" || file.phase === "importing" || file.phase === "verified");
    })
  );
}

function isInstalledModel(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    (value.source.kind !== "hugging-face" && value.source.kind !== "local-import")
  )
    return false;
  const validSource =
    value.source.kind === "hugging-face"
      ? boundedText(value.source.repo, 200) &&
        boundedText(value.source.commit, 40) &&
        boundedText(value.source.requestedRevision, 200)
      : Array.isArray(value.source.filenames) &&
        value.source.filenames.every((name) => boundedText(name, 512)) &&
        Array.isArray(value.source.lastModified) &&
        value.source.lastModified.every(nonnegativeInteger) &&
        Array.isArray(value.source.sha256) &&
        value.source.sha256.every(
          (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
        );
  return (
    isSafeId(value.id) &&
    boundedText(value.displayName) &&
    boundedText(value.createdAt, 64) &&
    nonnegativeInteger(value.totalSize) &&
    (value.state === "installed" || value.state === "missing") &&
    validSource &&
    Array.isArray(value.files) &&
    value.files.length <= 256 &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        boundedText(file.blobId, 80) &&
        boundedText(file.displayName, 1_024) &&
        nonnegativeInteger(file.size) &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(file.sha256) &&
        boundedText(file.opfsPath, 1_024) &&
        isInspection(file.inspection),
    )
  );
}

function isRepository(value: unknown): boolean {
  return (
    isRecord(value) &&
    boundedText(value.repo, 200) &&
    boundedText(value.requestedRevision, 200) &&
    typeof value.commit === "string" &&
    /^[a-f0-9]{40}$/u.test(value.commit) &&
    (value.selectedPath === undefined || boundedText(value.selectedPath, 1_024)) &&
    Array.isArray(value.choices) &&
    value.choices.length <= 50_000 &&
    value.choices.every(
      (choice) =>
        isRecord(choice) &&
        boundedText(choice.id, 2_048) &&
        boundedText(choice.label, 2_048) &&
        boundedText(choice.quantization, 128) &&
        nonnegativeInteger(choice.totalSize) &&
        Array.isArray(choice.files) &&
        choice.files.length <= 256 &&
        choice.files.every(
          (file) =>
            isRecord(file) &&
            boundedText(file.path, 1_024) &&
            nonnegativeInteger(file.size) &&
            isRecord(file.integrity) &&
            ((file.integrity.kind === "lfs-sha256" &&
              typeof file.integrity.digest === "string" &&
              /^[a-f0-9]{64}$/u.test(file.integrity.digest)) ||
              (file.integrity.kind === "git-blob-sha1" &&
                typeof file.integrity.digest === "string" &&
                /^[a-f0-9]{40}$/u.test(file.integrity.digest))),
        ),
    )
  );
}

function isInventory(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.every(isInstalledModel) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJob) &&
    isRecord(value.storage) &&
    nonnegativeInteger(value.storage.modelBytes) &&
    nonnegativeInteger(value.storage.partialBytes) &&
    (value.storage.originUsage === undefined || nonnegativeInteger(value.storage.originUsage)) &&
    (value.storage.originQuota === undefined || nonnegativeInteger(value.storage.originQuota)) &&
    (value.storage.persisted === undefined || typeof value.storage.persisted === "boolean")
  );
}

export function parseModelWorkerEvent(value: unknown): ModelWorkerEvent | undefined {
  if (
    !isRecord(value) ||
    value.protocolVersion !== modelWorkerProtocolVersion ||
    !isSafeId(value.requestId)
  )
    return undefined;
  switch (value.type) {
    case "model/resolved":
      return isRepository(value.repository) ? (value as unknown as ModelWorkerEvent) : undefined;
    case "model/progress":
      return isSafeId(value.jobId) &&
        (value.phase === "downloading" ||
          value.phase === "verifying" ||
          value.phase === "importing") &&
        Number.isSafeInteger(value.completedBytes) &&
        (value.completedBytes as number) >= 0 &&
        Number.isSafeInteger(value.totalBytes) &&
        (value.totalBytes as number) >= 0 &&
        typeof value.currentFile === "string" &&
        value.currentFile.length <= 1_024
        ? (value as unknown as ModelWorkerEvent)
        : undefined;
    case "model/job":
      return isJob(value.job) ? (value as unknown as ModelWorkerEvent) : undefined;
    case "model/retry":
      return (value.phase === "resolve" || value.phase === "download") &&
        Number.isSafeInteger(value.attempt) &&
        (value.attempt as number) > 0 &&
        Number.isSafeInteger(value.delayMs) &&
        (value.delayMs as number) >= 0 &&
        typeof value.message === "string" &&
        value.message.length <= 1_024
        ? (value as unknown as ModelWorkerEvent)
        : undefined;
    case "model/inventory":
      return isInventory(value.inventory) ? (value as unknown as ModelWorkerEvent) : undefined;
    case "model/complete":
      return value.modelId === undefined || isSafeId(value.modelId)
        ? (value as unknown as ModelWorkerEvent)
        : undefined;
    case "model/error":
      return isFailure(value.failure) ? (value as unknown as ModelWorkerEvent) : undefined;
    default:
      return undefined;
  }
}
