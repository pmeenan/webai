export const modelSchemaVersion = 1 as const;
export const maximumDeclaredContextTokens = 1024 * 1024;
export const maximumBrowseCandidates = 1024;
export const maximumBrowsePages = 128;
export const maximumBrowseResultBytes = 32 * 1024 * 1024;
export const maximumArtifactChoiceFiles = 256;
export const maximumQuantizationLength = 128;

export type IntegrityIdentity =
  | { readonly kind: "lfs-sha256"; readonly digest: string }
  | { readonly kind: "git-blob-sha1"; readonly digest: string };

export interface HuggingFaceFile {
  readonly path: string;
  readonly size: number;
  readonly integrity: IntegrityIdentity;
}

export interface HuggingFaceArtifactChoice {
  readonly id: string;
  readonly label: string;
  readonly quantization: string;
  readonly totalSize: number;
  readonly files: readonly HuggingFaceFile[];
  readonly optionalMtp?: HuggingFaceFile;
}

export type HuggingFaceGating = "open" | "automatic" | "manual" | "gated" | "unknown";
export type HuggingFaceVisibility = "public" | "private";

export type HuggingFaceCapability =
  | "thinking"
  | "text-generation"
  | "tool-calling"
  | "image-generation"
  | "image-input"
  | "text-to-speech"
  | "speech-recognition";

export interface HuggingFaceBaseModel {
  readonly repo: string;
  readonly relation?: "adapter" | "finetune" | "merge" | "quantized" | "unknown";
}

export interface HuggingFaceLineageNode {
  readonly repo: string;
  readonly commit?: string;
  readonly parents: readonly HuggingFaceBaseModel[];
  readonly status: "resolved" | "access-required" | "unavailable";
}

export interface HuggingFaceLineage {
  readonly rootRepo: string;
  readonly nodes: readonly HuggingFaceLineageNode[];
  readonly cacheHits: number;
  readonly truncated: boolean;
}

export interface HuggingFaceRepositoryMetadata {
  readonly license?: string;
  readonly gating: HuggingFaceGating;
  readonly visibility?: HuggingFaceVisibility;
  readonly pipelineTask?: string;
  readonly author?: string;
  readonly library?: string;
  readonly tags?: readonly string[];
  readonly architecture?: string;
  readonly contextLength?: number;
  readonly baseModels?: readonly HuggingFaceBaseModel[];
  readonly declaredCapabilities?: readonly HuggingFaceCapability[];
}

export interface ResolvedHuggingFaceRepository {
  readonly repo: string;
  readonly requestedRevision: string;
  readonly commit: string;
  readonly choices: readonly HuggingFaceArtifactChoice[];
  readonly selectedPath?: string;
  readonly metadata: HuggingFaceRepositoryMetadata;
}

export interface HuggingFaceBrowseFilters {
  readonly query: string;
  readonly format: "gguf";
  readonly capabilities?: readonly HuggingFaceCapability[];
  readonly quantizationBits?: readonly (1 | 2 | 3 | 4 | 5 | 6 | 8 | 16 | 32 | "other")[];
  readonly otherQuantization?: string;
  readonly minimumContextTokens?: number;
  readonly maximumBytes?: number;
}

export interface HuggingFaceBrowseItem {
  readonly repo: string;
  readonly commit: string;
  readonly downloads?: number;
  readonly likes?: number;
  readonly lastModified?: string;
  readonly repository: ResolvedHuggingFaceRepository;
  readonly matchingChoices: readonly HuggingFaceArtifactChoice[];
  readonly omittedMatchingChoices: number;
}

export interface HuggingFaceBrowseUnknown {
  readonly repo: string;
  readonly commit?: string;
  readonly metadata: HuggingFaceRepositoryMetadata;
  readonly reason: string;
}

export interface HuggingFaceBrowseResult {
  readonly matches: readonly HuggingFaceBrowseItem[];
  readonly needsVerification: readonly HuggingFaceBrowseItem[];
  readonly unknown: readonly HuggingFaceBrowseUnknown[];
  readonly inspectedCandidates: number;
  readonly excludedCandidates: number;
  readonly inspectedPages: number;
  readonly cacheHits: number;
  readonly catalog: {
    readonly persistent: boolean;
    readonly entries: number;
    readonly bytes: number;
    readonly reason?: string;
  };
  readonly truncated: boolean;
  readonly truncationReason?: "result-budget" | "stopped";
}

export interface GgufMetadataEntry {
  readonly key: string;
  readonly type: string;
  readonly value: string;
}

export interface GgufSpecialToken {
  readonly id: number;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly type: number;
  readonly typeName: string;
}

export interface GgufInspection {
  readonly format: "gguf";
  readonly version: number;
  readonly tensorCount: number;
  readonly metadataCount: number;
  readonly architecture?: string;
  readonly contextLength?: number;
  readonly name?: string;
  readonly quantization?: string;
  readonly specialTokenInventoryInspected?: true;
  readonly specialTokens?: readonly GgufSpecialToken[];
  readonly specialTokenCount?: number;
  readonly specialTokensTruncated?: boolean;
  readonly entries: readonly GgufMetadataEntry[];
  readonly omittedEntries: number;
}

export interface ModelFileRecord {
  readonly blobId: string;
  readonly displayName: string;
  readonly size: number;
  readonly sha256: string;
  readonly opfsPath: string;
  readonly inspection?: GgufInspection;
  readonly inspectionError?: ModelFailure;
}

export type ModelSource =
  | {
      readonly kind: "hugging-face";
      readonly repo: string;
      readonly requestedRevision: string;
      readonly commit: string;
      readonly files: readonly HuggingFaceFile[];
      readonly license?: string;
      readonly gating?: HuggingFaceGating;
      readonly visibility?: HuggingFaceVisibility;
      readonly pipelineTask?: string;
    }
  | {
      readonly kind: "local-import";
      readonly filenames: readonly string[];
      readonly lastModified: readonly number[];
      readonly sha256: readonly string[];
    };

export interface InstalledModelRecord {
  readonly schemaVersion: typeof modelSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly totalSize: number;
  readonly state: "installed" | "missing";
  readonly source: ModelSource;
  readonly files: readonly ModelFileRecord[];
  readonly derivation?: {
    readonly kind: "gguf-split";
    readonly sourceBlobId: string;
    readonly sourceSha256: string;
    readonly toolVersion: string;
    readonly maxShardBytes: number;
  };
  readonly runtimeIssues?: readonly {
    readonly runtimeId: "wllama";
    readonly reasonCode: "minimum-shard-size";
    readonly message: string;
    readonly measuredAt: string;
    readonly limitBytes: number;
    readonly requiredShardBytes: number;
    readonly splitterVersion: string;
  }[];
}

export interface BlobRecord {
  readonly schemaVersion: typeof modelSchemaVersion;
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly opfsPath: string;
  readonly verification: "sha256";
  readonly referenceCount: number;
  readonly state: "verified" | "garbage";
}

export interface DownloadJobFile {
  readonly source: HuggingFaceFile;
  readonly partialPath: string;
  readonly durableBytes: number;
  readonly phase: "pending" | "downloading" | "verifying" | "verified";
  readonly verifiedSha256?: string;
  readonly inspection?: GgufInspection;
  readonly inspectionError?: ModelFailure;
}

export interface DownloadJobRecord {
  readonly schemaVersion: typeof modelSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: "queued" | "downloading" | "paused" | "verifying" | "failed";
  readonly source: Extract<ModelSource, { readonly kind: "hugging-face" }>;
  readonly files: readonly DownloadJobFile[];
  readonly error?: ModelFailure;
}

export interface LocalImportJobFile {
  readonly source: {
    readonly name: string;
    readonly size: number;
    readonly lastModified: number;
  };
  readonly partialPath: string;
  readonly durableBytes: number;
  readonly phase: "pending" | "importing" | "verified";
  readonly verifiedSha256?: string;
  readonly inspection?: GgufInspection;
  readonly inspectionError?: ModelFailure;
}

export interface LocalImportJobRecord {
  readonly schemaVersion: typeof modelSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: "importing" | "ready-to-install" | "needs-source" | "failed";
  readonly source: {
    readonly kind: "local-import";
    readonly filenames: readonly string[];
    readonly lastModified: readonly number[];
  };
  readonly files: readonly LocalImportJobFile[];
  readonly error?: ModelFailure;
}

export type AcquisitionJobRecord = DownloadJobRecord | LocalImportJobRecord;

export type ModelFailureCode =
  | "input-invalid"
  | "metadata-invalid"
  | "network"
  | "range-invalid"
  | "integrity-mismatch"
  | "storage"
  | "quota"
  | "gguf-invalid"
  | "aborted"
  | "protocol"
  | "unsupported";

export interface ModelFailure {
  readonly code: ModelFailureCode;
  readonly phase:
    | "resolve"
    | "download"
    | "verify"
    | "import"
    | "inspect"
    | "split"
    | "load"
    | "generate"
    | "storage";
  readonly message: string;
  readonly retryable: boolean;
}

export interface StorageSummary {
  readonly modelBytes: number;
  readonly partialBytes: number;
  readonly originUsage?: number;
  readonly originQuota?: number;
  readonly persisted?: boolean;
}

export interface ModelInventory {
  readonly models: readonly InstalledModelRecord[];
  readonly jobs: readonly AcquisitionJobRecord[];
  readonly storage: StorageSummary;
}

export class ModelOperationError extends Error {
  readonly failure: ModelFailure;

  constructor(failure: ModelFailure) {
    super(failure.message);
    this.name = "ModelOperationError";
    this.failure = failure;
  }
}
