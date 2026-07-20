import type {
  AcquisitionJobRecord,
  HuggingFaceArtifactChoice,
  HuggingFaceBrowseFilters,
  HuggingFaceBrowseResult,
  HuggingFaceFile,
  HuggingFaceLineage,
  ModelFailure,
  ModelInventory,
  ResolvedHuggingFaceRepository,
} from "./types";
import {
  maximumArtifactChoiceFiles,
  maximumBrowseCandidates,
  maximumBrowsePages,
  maximumBrowseResultBytes,
  maximumDeclaredContextTokens,
  maximumQuantizationLength,
} from "./types";

export const modelWorkerProtocolVersion = 5 as const;

export type ModelWorkerRequest =
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/resolve";
      readonly requestId: string;
      readonly input: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/browse";
      readonly requestId: string;
      readonly filters: HuggingFaceBrowseFilters;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/browse-cancel";
      readonly requestId: string;
      readonly targetRequestId: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/lineage";
      readonly requestId: string;
      readonly repo: string;
      readonly commit: string;
      readonly parents: ResolvedHuggingFaceRepository["metadata"]["baseModels"];
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/lineage-cancel";
      readonly requestId: string;
      readonly targetRequestId: string;
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
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/inspect";
      readonly requestId: string;
      readonly modelId: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/split";
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
      readonly type: "model/browse-result";
      readonly requestId: string;
      readonly result: HuggingFaceBrowseResult;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/browse-progress";
      readonly requestId: string;
      readonly inspectedCandidates: number;
      readonly inspectedPages: number;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/lineage-result";
      readonly requestId: string;
      readonly lineage: HuggingFaceLineage;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/lineage-progress";
      readonly requestId: string;
      readonly inspectedNodes: number;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/progress";
      readonly requestId: string;
      readonly jobId: string;
      readonly phase: "downloading" | "verifying" | "importing" | "splitting";
      readonly splitStage?: "planning" | "hashing" | "copying" | "finalizing";
      readonly completedBytes: number;
      readonly totalBytes: number;
      readonly currentFile: string;
    }
  | {
      readonly protocolVersion: typeof modelWorkerProtocolVersion;
      readonly type: "model/retry";
      readonly requestId: string;
      readonly phase: "resolve" | "browse" | "lineage" | "download";
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

function isHuggingFaceRepo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value)
  );
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

function isHuggingFaceGating(value: unknown): boolean {
  return (
    value === "open" ||
    value === "automatic" ||
    value === "manual" ||
    value === "gated" ||
    value === "unknown"
  );
}

const huggingFaceCapabilities = new Set([
  "thinking",
  "text-generation",
  "tool-calling",
  "image-generation",
  "image-input",
  "text-to-speech",
  "speech-recognition",
]);

function isRepositoryMetadata(metadata: unknown): boolean {
  return (
    isRecord(metadata) &&
    (metadata.license === undefined || boundedText(metadata.license, 160)) &&
    (metadata.pipelineTask === undefined || boundedText(metadata.pipelineTask, 160)) &&
    (metadata.author === undefined || boundedText(metadata.author, 160)) &&
    (metadata.library === undefined || boundedText(metadata.library, 160)) &&
    (metadata.architecture === undefined || boundedText(metadata.architecture, 160)) &&
    (metadata.contextLength === undefined ||
      (nonnegativeInteger(metadata.contextLength) &&
        metadata.contextLength >= 256 &&
        metadata.contextLength <= 1024 * 1024)) &&
    (metadata.visibility === undefined ||
      metadata.visibility === "public" ||
      metadata.visibility === "private") &&
    (metadata.tags === undefined ||
      (Array.isArray(metadata.tags) &&
        metadata.tags.length <= 256 &&
        metadata.tags.every((tag) => boundedText(tag, 160)))) &&
    (metadata.declaredCapabilities === undefined ||
      (Array.isArray(metadata.declaredCapabilities) &&
        metadata.declaredCapabilities.length <= huggingFaceCapabilities.size &&
        new Set(metadata.declaredCapabilities).size === metadata.declaredCapabilities.length &&
        metadata.declaredCapabilities.every((capability) =>
          huggingFaceCapabilities.has(capability as string),
        ))) &&
    (metadata.baseModels === undefined ||
      (Array.isArray(metadata.baseModels) &&
        metadata.baseModels.length <= 16 &&
        metadata.baseModels.every(
          (base) =>
            isRecord(base) &&
            boundedText(base.repo, 200) &&
            (base.relation === undefined ||
              base.relation === "adapter" ||
              base.relation === "finetune" ||
              base.relation === "merge" ||
              base.relation === "quantized" ||
              base.relation === "unknown"),
        ))) &&
    isHuggingFaceGating(metadata.gating)
  );
}

function isOptionalSourceMetadata(value: Record<string, unknown>): boolean {
  return (
    (value.license === undefined || boundedText(value.license, 160)) &&
    (value.pipelineTask === undefined || boundedText(value.pipelineTask, 160)) &&
    (value.gating === undefined || isHuggingFaceGating(value.gating)) &&
    (value.visibility === undefined ||
      value.visibility === "public" ||
      value.visibility === "private")
  );
}

function isSpecialTokenInventory(value: Record<string, unknown>): boolean {
  const inspected = value.specialTokenInventoryInspected;
  const tokens = value.specialTokens;
  const count = value.specialTokenCount;
  const truncated = value.specialTokensTruncated;
  if (inspected !== undefined && inspected !== true) return false;
  if (tokens === undefined && count === undefined && truncated === undefined) return true;
  if (
    inspected !== true ||
    !Array.isArray(tokens) ||
    tokens.length > 1_024 ||
    !nonnegativeInteger(count) ||
    count > 1_000_000 ||
    typeof truncated !== "boolean" ||
    count < tokens.length ||
    truncated !== count > tokens.length
  )
    return false;
  const ids = new Set<number>();
  return tokens.every((token) => {
    if (
      !isRecord(token) ||
      !nonnegativeInteger(token.id) ||
      ids.has(token.id) ||
      !boundedText(token.text, 2_049) ||
      typeof token.textTruncated !== "boolean" ||
      ![2, 3, 4, 5].includes(token.type as number) ||
      !boundedText(token.typeName, 64)
    )
      return false;
    ids.add(token.id);
    return true;
  });
}

function isInspection(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.format === "gguf" &&
    nonnegativeInteger(value.version) &&
    nonnegativeInteger(value.tensorCount) &&
    nonnegativeInteger(value.metadataCount) &&
    (value.architecture === undefined || boundedText(value.architecture, 512)) &&
    (value.contextLength === undefined ||
      (nonnegativeInteger(value.contextLength) &&
        value.contextLength >= 256 &&
        value.contextLength <= maximumDeclaredContextTokens)) &&
    (value.name === undefined || boundedText(value.name, 1_024)) &&
    (value.quantization === undefined ||
      boundedText(value.quantization, maximumQuantizationLength)) &&
    isSpecialTokenInventory(value) &&
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
    (remote
      ? boundedText(value.source.repo, 200) &&
        boundedText(value.source.requestedRevision, 200) &&
        typeof value.source.commit === "string" &&
        /^[a-f0-9]{40}$/u.test(value.source.commit) &&
        isOptionalSourceMetadata(value.source)
      : true) &&
    value.files.every((file) => {
      if (
        !isRecord(file) ||
        !isRecord(file.source) ||
        !boundedText(file.partialPath, 1_024) ||
        !nonnegativeInteger(file.durableBytes) ||
        !nonnegativeInteger(file.source.size) ||
        (file.inspection !== undefined && !isInspection(file.inspection)) ||
        (file.inspectionError !== undefined && !isFailure(file.inspectionError)) ||
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
        boundedText(value.source.requestedRevision, 200) &&
        isOptionalSourceMetadata(value.source)
      : Array.isArray(value.source.filenames) &&
        value.source.filenames.every((name) => boundedText(name, 512)) &&
        Array.isArray(value.source.lastModified) &&
        value.source.lastModified.every(nonnegativeInteger) &&
        Array.isArray(value.source.sha256) &&
        value.source.sha256.every(
          (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
        );
  const validDerivation =
    value.derivation === undefined ||
    (isRecord(value.derivation) &&
      value.derivation.kind === "gguf-split" &&
      boundedText(value.derivation.sourceBlobId, 80) &&
      typeof value.derivation.sourceSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.derivation.sourceSha256) &&
      boundedText(value.derivation.toolVersion, 128) &&
      nonnegativeInteger(value.derivation.maxShardBytes));
  const validRuntimeIssues =
    value.runtimeIssues === undefined ||
    (Array.isArray(value.runtimeIssues) &&
      value.runtimeIssues.length <= 8 &&
      value.runtimeIssues.every(
        (issue) =>
          isRecord(issue) &&
          issue.runtimeId === "wllama" &&
          issue.reasonCode === "minimum-shard-size" &&
          boundedText(issue.message, 1_024) &&
          boundedText(issue.measuredAt, 64) &&
          nonnegativeInteger(issue.limitBytes) &&
          nonnegativeInteger(issue.requiredShardBytes) &&
          issue.requiredShardBytes >= issue.limitBytes &&
          boundedText(issue.splitterVersion, 128),
      ));
  return (
    isSafeId(value.id) &&
    boundedText(value.displayName) &&
    boundedText(value.createdAt, 64) &&
    nonnegativeInteger(value.totalSize) &&
    (value.state === "installed" || value.state === "missing") &&
    validSource &&
    validDerivation &&
    validRuntimeIssues &&
    Array.isArray(value.files) &&
    value.files.length <= maximumArtifactChoiceFiles &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        boundedText(file.blobId, 80) &&
        boundedText(file.displayName, 1_024) &&
        nonnegativeInteger(file.size) &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(file.sha256) &&
        boundedText(file.opfsPath, 1_024) &&
        (file.inspection === undefined || isInspection(file.inspection)) &&
        (file.inspectionError === undefined || isFailure(file.inspectionError)) &&
        (file.inspection !== undefined) !== (file.inspectionError !== undefined),
    )
  );
}

function isRepository(value: unknown): boolean {
  return (
    isRecord(value) &&
    isHuggingFaceRepo(value.repo) &&
    boundedText(value.requestedRevision, 200) &&
    typeof value.commit === "string" &&
    /^[a-f0-9]{40}$/u.test(value.commit) &&
    (value.selectedPath === undefined || boundedText(value.selectedPath, 1_024)) &&
    isRecord(value.metadata) &&
    (value.metadata.license === undefined || boundedText(value.metadata.license, 160)) &&
    isRepositoryMetadata(value.metadata) &&
    Array.isArray(value.choices) &&
    value.choices.length <= 50_000 &&
    value.choices.every(isArtifactChoice)
  );
}

function isArtifactChoice(choice: unknown): choice is HuggingFaceArtifactChoice {
  return (
    isRecord(choice) &&
    boundedText(choice.id, 2_048) &&
    boundedText(choice.label, 2_048) &&
    boundedText(choice.quantization, maximumQuantizationLength) &&
    nonnegativeInteger(choice.totalSize) &&
    (choice.optionalMtp === undefined || isRepositoryFile(choice.optionalMtp)) &&
    Array.isArray(choice.files) &&
    choice.files.length <= maximumArtifactChoiceFiles &&
    choice.files.every(isRepositoryFile)
  );
}

function repositoryFileEqual(left: unknown, right: unknown): boolean {
  if (!isRepositoryFile(left) || !isRepositoryFile(right)) return false;
  return (
    left.path === right.path &&
    left.size === right.size &&
    left.integrity.kind === right.integrity.kind &&
    left.integrity.digest === right.integrity.digest
  );
}

function artifactChoiceEqual(left: unknown, right: unknown): boolean {
  if (!isArtifactChoice(left) || !isArtifactChoice(right)) return false;
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.quantization === right.quantization &&
    left.totalSize === right.totalSize &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => repositoryFileEqual(file, right.files[index])) &&
    ((left.optionalMtp === undefined && right.optionalMtp === undefined) ||
      repositoryFileEqual(left.optionalMtp, right.optionalMtp))
  );
}

function isBrowseResult(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.matches) ||
    value.matches.length > maximumBrowseCandidates ||
    !Array.isArray(value.needsVerification) ||
    value.needsVerification.length > maximumBrowseCandidates ||
    value.matches.length + value.needsVerification.length > maximumBrowseCandidates ||
    !Array.isArray(value.unknown) ||
    value.unknown.length > maximumBrowseCandidates ||
    value.matches.length + value.needsVerification.length + value.unknown.length >
      maximumBrowseCandidates ||
    !nonnegativeInteger(value.inspectedCandidates) ||
    value.inspectedCandidates > maximumBrowseCandidates ||
    !nonnegativeInteger(value.excludedCandidates) ||
    value.excludedCandidates > maximumBrowseCandidates ||
    !nonnegativeInteger(value.inspectedPages) ||
    value.inspectedPages > maximumBrowsePages ||
    !nonnegativeInteger(value.cacheHits) ||
    value.cacheHits > value.inspectedCandidates ||
    !isRecord(value.catalog) ||
    typeof value.catalog.persistent !== "boolean" ||
    !nonnegativeInteger(value.catalog.entries) ||
    value.catalog.entries > 512 ||
    !nonnegativeInteger(value.catalog.bytes) ||
    value.catalog.bytes > 64 * 1024 * 1024 ||
    (value.catalog.reason !== undefined && !boundedText(value.catalog.reason, 512)) ||
    typeof value.truncated !== "boolean" ||
    (value.truncationReason !== undefined &&
      value.truncationReason !== "result-budget" &&
      value.truncationReason !== "stopped") ||
    (value.truncationReason !== undefined && !value.truncated)
  )
    return false;
  const metadataValid = isRepositoryMetadata;
  const matchValid = (item: unknown): boolean => {
    if (
      !isRecord(item) ||
      !boundedText(item.repo, 200) ||
      typeof item.commit !== "string" ||
      !/^[a-f0-9]{40}$/u.test(item.commit) ||
      (item.downloads !== undefined && !nonnegativeInteger(item.downloads)) ||
      (item.likes !== undefined && !nonnegativeInteger(item.likes)) ||
      (item.lastModified !== undefined && !boundedText(item.lastModified, 64)) ||
      !nonnegativeInteger(item.omittedMatchingChoices) ||
      !isRepository(item.repository) ||
      !Array.isArray(item.matchingChoices) ||
      item.matchingChoices.length === 0 ||
      item.matchingChoices.length > 64
    )
      return false;
    const repositoryChoices = (item.repository as { readonly choices: readonly unknown[] }).choices;
    const repository = item.repository as {
      readonly repo: string;
      readonly requestedRevision: string;
      readonly commit: string;
    };
    if (
      item.repo !== repository.repo ||
      item.commit !== repository.commit ||
      item.commit !== repository.requestedRevision.toLowerCase()
    )
      return false;
    if (repositoryChoices.length !== item.matchingChoices.length) return false;
    let referencedFiles = 0;
    for (let index = 0; index < item.matchingChoices.length; index += 1) {
      const choice = item.matchingChoices[index];
      if (!isArtifactChoice(choice) || !artifactChoiceEqual(choice, repositoryChoices[index]))
        return false;
      referencedFiles += choice.files.length + (choice.optionalMtp === undefined ? 0 : 1);
      if (referencedFiles > maximumArtifactChoiceFiles) return false;
    }
    return true;
  };
  if (!value.matches.every(matchValid) || !value.needsVerification.every(matchValid)) return false;
  const identities = new Set<string>();
  for (const item of [...value.matches, ...value.needsVerification]) {
    const match = item as { readonly repo: string; readonly commit: string };
    const identity = `${match.repo}@${match.commit}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  for (const item of value.unknown) {
    if (
      !isRecord(item) ||
      !boundedText(item.repo, 200) ||
      (item.commit !== undefined &&
        (typeof item.commit !== "string" || !/^[a-f0-9]{40}$/u.test(item.commit))) ||
      !metadataValid(item.metadata) ||
      !boundedText(item.reason, 1_024)
    )
      return false;
    const identity = `${item.repo}@${item.commit ?? "unknown"}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  let retainedBytes = 0;
  try {
    for (const item of [...value.matches, ...value.needsVerification, ...value.unknown]) {
      const serialized = JSON.stringify(item);
      if (serialized === undefined) return false;
      retainedBytes += new TextEncoder().encode(serialized).byteLength;
      if (retainedBytes > maximumBrowseResultBytes) return false;
    }
  } catch {
    return false;
  }
  return (
    value.matches.length +
      value.needsVerification.length +
      value.unknown.length +
      value.excludedCandidates ===
    value.inspectedCandidates
  );
}

function isBaseModel(value: unknown): boolean {
  return (
    isRecord(value) &&
    isHuggingFaceRepo(value.repo) &&
    (value.relation === undefined ||
      value.relation === "adapter" ||
      value.relation === "finetune" ||
      value.relation === "merge" ||
      value.relation === "quantized" ||
      value.relation === "unknown")
  );
}

function isLineage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isHuggingFaceRepo(value.rootRepo) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    value.nodes.length > 32 ||
    !nonnegativeInteger(value.cacheHits) ||
    value.cacheHits > value.nodes.length - 1 ||
    typeof value.truncated !== "boolean"
  )
    return false;
  const repos = new Set<string>();
  for (const node of value.nodes) {
    if (
      !isRecord(node) ||
      !isHuggingFaceRepo(node.repo) ||
      repos.has(node.repo) ||
      (node.commit !== undefined &&
        (typeof node.commit !== "string" || !/^[a-f0-9]{40}$/u.test(node.commit))) ||
      !Array.isArray(node.parents) ||
      node.parents.length > 16 ||
      !node.parents.every(isBaseModel) ||
      (node.status !== "resolved" &&
        node.status !== "access-required" &&
        node.status !== "unavailable")
    )
      return false;
    repos.add(node.repo);
  }
  return repos.has(value.rootRepo);
}

function isRepositoryFile(file: unknown): file is HuggingFaceFile {
  return (
    isRecord(file) &&
    boundedText(file.path, 1_024) &&
    nonnegativeInteger(file.size) &&
    isRecord(file.integrity) &&
    ((file.integrity.kind === "lfs-sha256" &&
      typeof file.integrity.digest === "string" &&
      /^[a-f0-9]{64}$/u.test(file.integrity.digest)) ||
      (file.integrity.kind === "git-blob-sha1" &&
        typeof file.integrity.digest === "string" &&
        /^[a-f0-9]{40}$/u.test(file.integrity.digest)))
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
    case "model/browse-result":
      return isBrowseResult(value.result) ? (value as unknown as ModelWorkerEvent) : undefined;
    case "model/browse-progress":
      return nonnegativeInteger(value.inspectedCandidates) &&
        value.inspectedCandidates <= maximumBrowseCandidates &&
        nonnegativeInteger(value.inspectedPages) &&
        value.inspectedPages > 0 &&
        value.inspectedPages <= maximumBrowsePages
        ? (value as unknown as ModelWorkerEvent)
        : undefined;
    case "model/lineage-result":
      return isLineage(value.lineage) ? (value as unknown as ModelWorkerEvent) : undefined;
    case "model/lineage-progress":
      return nonnegativeInteger(value.inspectedNodes) &&
        value.inspectedNodes > 0 &&
        value.inspectedNodes <= 32
        ? (value as unknown as ModelWorkerEvent)
        : undefined;
    case "model/progress":
      return isSafeId(value.jobId) &&
        (value.phase === "downloading" ||
          value.phase === "verifying" ||
          value.phase === "importing" ||
          value.phase === "splitting") &&
        (value.phase === "splitting"
          ? value.splitStage === "planning" ||
            value.splitStage === "hashing" ||
            value.splitStage === "copying" ||
            value.splitStage === "finalizing"
          : value.splitStage === undefined) &&
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
      return (value.phase === "resolve" ||
        value.phase === "browse" ||
        value.phase === "lineage" ||
        value.phase === "download") &&
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
