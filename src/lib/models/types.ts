export const modelSchemaVersion = 1 as const;

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
}

export interface ResolvedHuggingFaceRepository {
  readonly repo: string;
  readonly requestedRevision: string;
  readonly commit: string;
  readonly choices: readonly HuggingFaceArtifactChoice[];
  readonly selectedPath?: string;
}

export interface GgufMetadataEntry {
  readonly key: string;
  readonly type: string;
  readonly value: string;
}

export interface GgufInspection {
  readonly format: "gguf";
  readonly version: number;
  readonly tensorCount: number;
  readonly metadataCount: number;
  readonly architecture?: string;
  readonly name?: string;
  readonly quantization?: string;
  readonly entries: readonly GgufMetadataEntry[];
  readonly omittedEntries: number;
}

export interface ModelFileRecord {
  readonly blobId: string;
  readonly displayName: string;
  readonly size: number;
  readonly sha256: string;
  readonly opfsPath: string;
  readonly inspection: GgufInspection;
}

export type ModelSource =
  | {
      readonly kind: "hugging-face";
      readonly repo: string;
      readonly requestedRevision: string;
      readonly commit: string;
      readonly files: readonly HuggingFaceFile[];
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
  readonly phase: "resolve" | "download" | "verify" | "import" | "inspect" | "storage";
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
