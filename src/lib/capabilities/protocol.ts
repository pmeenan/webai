import {
  webGpuLimitNames,
  workerCapabilityIds,
  type CapabilityValueMap,
  type ProbeOutcome,
  type SafeFailureCode,
  type SanitizedFailure,
  type WorkerCapabilityId,
} from "./evidence";

export const capabilityProtocolVersion = 1 as const;

export interface ProbeWorkerRequest {
  readonly protocolVersion: typeof capabilityProtocolVersion;
  readonly type: "probe/run";
  readonly runId: string;
  readonly sharedBuffer?: SharedArrayBuffer;
}

export type ProbeResultEvent = {
  [K in WorkerCapabilityId]: {
    readonly protocolVersion: typeof capabilityProtocolVersion;
    readonly type: "probe/result";
    readonly runId: string;
    readonly sequence: number;
    readonly id: K;
    readonly durationMs: number;
    readonly outcome: ProbeOutcome<CapabilityValueMap[K]>;
  };
}[WorkerCapabilityId];

export interface ProbeCompleteEvent {
  readonly protocolVersion: typeof capabilityProtocolVersion;
  readonly type: "probe/complete";
  readonly runId: string;
  readonly sequence: number;
}

export type ProbeWorkerEvent = ProbeResultEvent | ProbeCompleteEvent;

const absenceReasons = new Set(["api-missing", "feature-not-supported", "no-adapter"]);
const indeterminateReasons = new Set([
  "operation-failed",
  "permission-blocked",
  "probe-timeout",
  "protocol-error",
  "worker-error",
]);
const failureCategories = new Set([
  "dom-exception",
  "javascript-error",
  "protocol-error",
  "timeout",
  "unknown-thrown",
  "worker-error",
]);
const failureCodes = new Set<SafeFailureCode>([
  "abort",
  "invalid-state",
  "not-supported",
  "operation",
  "permission",
  "protocol",
  "quota",
  "timeout",
  "unknown",
  "worker",
]);
const safeFailureNames = new Set([
  "AbortError",
  "Error",
  "InvalidStateError",
  "NotSupportedError",
  "OperationError",
  "QuotaExceededError",
  "SecurityError",
  "UnknownError",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isSafeNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSanitizedFailure(value: unknown): value is SanitizedFailure {
  if (!isRecord(value) || !failureCategories.has(value.category as string)) return false;
  if (!hasOnlyKeys(value, ["category", "code", "name"])) return false;
  if (!failureCodes.has(value.code as SafeFailureCode)) return false;
  return value.name === undefined || safeFailureNames.has(value.name as string);
}

function isWasmValue(value: unknown): value is CapabilityValueMap["wasm.worker.simd"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["supported", "detector", "detectorVersion"]) &&
    typeof value.supported === "boolean" &&
    value.detector === "wasm-feature-detect" &&
    value.detectorVersion === "1.8.0"
  );
}

function isWebGpuValue(value: unknown): value is CapabilityValueMap["webgpu.worker"] {
  if (!isRecord(value) || !isRecord(value.shaderF16) || !isRecord(value.limits)) return false;
  if (!hasOnlyKeys(value, ["adapter", "device", "features", "limits", "shaderF16"])) {
    return false;
  }
  if (!hasOnlyKeys(value.shaderF16, ["advertised", "acquired"])) return false;
  if (!hasOnlyKeys(value.limits, webGpuLimitNames)) return false;
  if (value.adapter !== "available" && value.adapter !== "unavailable") return false;
  if (value.device !== "usable" && value.device !== "unavailable") return false;
  if (
    !Array.isArray(value.features) ||
    value.features.length > 128 ||
    !value.features.every((feature) => isBoundedString(feature, 64))
  ) {
    return false;
  }
  if (
    typeof value.shaderF16.advertised !== "boolean" ||
    typeof value.shaderF16.acquired !== "boolean"
  ) {
    return false;
  }
  if (value.device === "usable" && value.adapter !== "available") return false;
  if (value.adapter === "unavailable") {
    if (
      value.device !== "unavailable" ||
      value.features.length !== 0 ||
      Object.keys(value.limits).length !== 0 ||
      value.shaderF16.advertised ||
      value.shaderF16.acquired
    ) {
      return false;
    }
  }
  if (value.shaderF16.acquired && !value.shaderF16.advertised) return false;
  if (value.features.includes("shader-f16") !== value.shaderF16.advertised) return false;
  const limits = value.limits as Record<string, unknown>;
  return webGpuLimitNames.every((name) => {
    const limit = limits[name];
    return limit === undefined || isSafeNonnegativeNumber(limit);
  });
}

function isAbsenceReasonForId(id: WorkerCapabilityId, reason: unknown): boolean {
  if (!absenceReasons.has(reason as string)) return false;
  switch (id) {
    case "webgpu.worker":
    case "opfs.worker.root-access":
      return reason === "api-missing";
    case "webnn.worker.default-context":
      return reason === "api-missing" || reason === "feature-not-supported";
    default:
      return false;
  }
}

function isValueForId(id: WorkerCapabilityId, value: unknown): boolean {
  switch (id) {
    case "environment.worker.cross-origin-isolated":
    case "opfs.worker.root-access":
      return typeof value === "boolean";
    case "shared-memory.worker.round-trip":
      return (
        isRecord(value) &&
        hasOnlyKeys(value, ["constructorAvailable", "atomicsRoundTrip"]) &&
        typeof value.constructorAvailable === "boolean" &&
        typeof value.atomicsRoundTrip === "boolean" &&
        (!value.atomicsRoundTrip || value.constructorAvailable)
      );
    case "wasm.worker.simd":
    case "wasm.worker.threads":
    case "wasm.worker.jspi":
    case "wasm.worker.memory64":
      return isWasmValue(value);
    case "webgpu.worker":
      return isWebGpuValue(value);
    case "webnn.worker.default-context":
      return (
        isRecord(value) &&
        hasOnlyKeys(value, ["requested", "accelerated"]) &&
        isRecord(value.requested) &&
        hasOnlyKeys(value.requested, ["powerPreference", "accelerated"]) &&
        value.requested.powerPreference === "default" &&
        value.requested.accelerated === true &&
        typeof value.accelerated === "boolean"
      );
  }
}

function isOutcomeForId(id: WorkerCapabilityId, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "value") {
    return hasOnlyKeys(value, ["kind", "value"]) && isValueForId(id, value.value);
  }
  if (value.kind === "absent") {
    return hasOnlyKeys(value, ["kind", "reason"]) && isAbsenceReasonForId(id, value.reason);
  }
  if (value.kind !== "indeterminate" || !indeterminateReasons.has(value.reason as string)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["kind", "reason", "failure"])) return false;
  return value.failure === undefined || isSanitizedFailure(value.failure);
}

export function parseProbeWorkerEvent(value: unknown): ProbeWorkerEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.protocolVersion !== capabilityProtocolVersion ||
    !isBoundedString(value.runId, 128) ||
    !isSafeNonnegativeNumber(value.sequence)
  ) {
    return undefined;
  }
  if (value.type === "probe/complete") {
    if (!hasOnlyKeys(value, ["protocolVersion", "type", "runId", "sequence"])) {
      return undefined;
    }
    return value as unknown as ProbeCompleteEvent;
  }
  if (
    value.type !== "probe/result" ||
    !workerCapabilityIds.includes(value.id as WorkerCapabilityId) ||
    !isSafeNonnegativeNumber(value.durationMs)
  ) {
    return undefined;
  }
  if (
    !hasOnlyKeys(value, [
      "protocolVersion",
      "type",
      "runId",
      "sequence",
      "id",
      "durationMs",
      "outcome",
    ])
  ) {
    return undefined;
  }
  const id = value.id as WorkerCapabilityId;
  if (!isOutcomeForId(id, value.outcome)) return undefined;
  return value as unknown as ProbeResultEvent;
}
