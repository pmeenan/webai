export type EvidenceContext = "page" | "dedicated-worker";
export type EvidenceStability = "stable-session" | "volatile";
export type EvidenceFreshness = "current" | "stale";

export type ConclusiveAbsenceReason = "api-missing" | "feature-not-supported" | "no-adapter";

export type IndeterminateReason =
  | "operation-failed"
  | "permission-blocked"
  | "probe-timeout"
  | "protocol-error"
  | "worker-error";

export type SafeFailureCode =
  | "abort"
  | "invalid-state"
  | "not-supported"
  | "operation"
  | "permission"
  | "protocol"
  | "quota"
  | "timeout"
  | "unknown"
  | "worker";

export interface SanitizedFailure {
  readonly category:
    | "dom-exception"
    | "javascript-error"
    | "protocol-error"
    | "timeout"
    | "unknown-thrown"
    | "worker-error";
  readonly code: SafeFailureCode;
  readonly name?: string;
}

export type ProbeOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "absent"; readonly reason: ConclusiveAbsenceReason }
  | {
      readonly kind: "indeterminate";
      readonly reason: IndeterminateReason;
      readonly failure?: SanitizedFailure;
    };

export interface SharedMemoryResult {
  readonly constructorAvailable: boolean;
  readonly atomicsRoundTrip: boolean;
}

export interface WasmFeatureResult {
  readonly supported: boolean;
  readonly detector: "wasm-feature-detect";
  readonly detectorVersion: "1.8.0";
}

export const webGpuLimitNames = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxStorageBuffersPerShaderStage",
  "maxComputeWorkgroupsPerDimension",
] as const;

export type WebGpuLimitName = (typeof webGpuLimitNames)[number];

export interface WebGpuSnapshot {
  readonly adapter: "available" | "unavailable";
  readonly device: "usable" | "unavailable";
  readonly features: readonly string[];
  readonly limits: Readonly<Partial<Record<WebGpuLimitName, number>>>;
  readonly shaderF16: {
    readonly advertised: boolean;
    readonly acquired: boolean;
  };
}

export interface WebNnSnapshot {
  readonly requested: {
    readonly powerPreference: "default";
    readonly accelerated: true;
  };
  readonly accelerated: boolean;
}

export interface StorageApiSurface {
  readonly estimate: boolean;
  readonly getDirectory: boolean;
  readonly persist: boolean;
  readonly persisted: boolean;
}

export interface StorageEstimateValue {
  readonly usageBytes?: number;
  readonly quotaBytes?: number;
  readonly scope: "origin";
  readonly confidence: "estimated-origin";
}

export type PromptApiAvailabilityValue = PromptApiAvailability;

export interface CapabilityValueMap {
  readonly "environment.page.secure-context": boolean;
  readonly "environment.page.cross-origin-isolated": boolean;
  readonly "environment.worker.cross-origin-isolated": boolean;
  readonly "shared-memory.page.constructor": boolean;
  readonly "shared-memory.worker.round-trip": SharedMemoryResult;
  readonly "wasm.worker.simd": WasmFeatureResult;
  readonly "wasm.worker.threads": WasmFeatureResult;
  readonly "wasm.worker.jspi": WasmFeatureResult;
  readonly "wasm.worker.memory64": WasmFeatureResult;
  readonly "webgpu.page.api": boolean;
  readonly "webgpu.worker": WebGpuSnapshot;
  readonly "webnn.page.api": boolean;
  readonly "webnn.worker.default-context": WebNnSnapshot;
  readonly "storage.page.api": StorageApiSurface;
  readonly "opfs.worker.root-access": boolean;
  readonly "storage.estimate": StorageEstimateValue;
  readonly "storage.persisted": boolean;
  readonly "prompt-api.page.availability": PromptApiAvailabilityValue;
}

export type CapabilityId = keyof CapabilityValueMap;

export const workerCapabilityIds = [
  "environment.worker.cross-origin-isolated",
  "shared-memory.worker.round-trip",
  "wasm.worker.simd",
  "wasm.worker.threads",
  "wasm.worker.jspi",
  "wasm.worker.memory64",
  "webgpu.worker",
  "webnn.worker.default-context",
  "opfs.worker.root-access",
] as const satisfies readonly CapabilityId[];

export type WorkerCapabilityId = (typeof workerCapabilityIds)[number];

export interface EvidenceFor<K extends CapabilityId> {
  readonly id: K;
  readonly probeVersion: number;
  readonly observedAt: string;
  readonly durationMs: number;
  readonly context: EvidenceContext;
  readonly stability: EvidenceStability;
  readonly freshness: EvidenceFreshness;
  readonly trigger:
    | "initial"
    | "explicit-refresh"
    | "storage-invalidation"
    | "browser-model-invalidation";
  readonly outcome: ProbeOutcome<CapabilityValueMap[K]>;
}

export type CapabilityEvidence = {
  [K in CapabilityId]: EvidenceFor<K>;
}[CapabilityId];

export type CapabilitySnapshot = Readonly<Partial<{ [K in CapabilityId]: EvidenceFor<K> }>>;

export function valueOutcome<T>(value: T): ProbeOutcome<T> {
  return { kind: "value", value };
}

export function absentOutcome<T>(reason: ConclusiveAbsenceReason): ProbeOutcome<T> {
  return { kind: "absent", reason };
}

export function indeterminateOutcome<T>(
  reason: IndeterminateReason,
  failure?: SanitizedFailure,
): ProbeOutcome<T> {
  return failure === undefined
    ? { kind: "indeterminate", reason }
    : { kind: "indeterminate", reason, failure };
}
import type { PromptApiAvailability } from "../prompt-api-surface";
