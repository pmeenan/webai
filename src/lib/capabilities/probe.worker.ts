/// <reference lib="webworker" />

import { jspi, memory64, simd, threads } from "wasm-feature-detect";
import {
  absentOutcome,
  indeterminateOutcome,
  valueOutcome,
  webGpuLimitNames,
  type CapabilityValueMap,
  type ProbeOutcome,
  type WebGpuLimitName,
  type WorkerCapabilityId,
} from "./evidence";
import { normalizeWebNnContext, normalizeWorkerIsolation } from "./normalize";
import {
  capabilityProtocolVersion,
  type ProbeResultEvent,
  type ProbeWorkerRequest,
} from "./protocol";
import { sanitizeThrown, timeoutFailure } from "./sanitize";

const operationProbeTimeoutMs = 5_000;

type BoundedOperationResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

function runBoundedWorkerOperation<T>(
  operation: () => Promise<T>,
): Promise<BoundedOperationResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedOperationResult<T>) => {
      if (settled) return;
      settled = true;
      scope.clearTimeout(timeout);
      resolve(result);
    };
    const timeout = scope.setTimeout(() => finish({ kind: "timeout" }), operationProbeTimeoutMs);
    try {
      void operation().then(
        (value) => finish({ kind: "value", value }),
        (error: unknown) => finish({ kind: "error", error }),
      );
    } catch (error: unknown) {
      finish({ kind: "error", error });
    }
  });
}

interface NarrowGpuFeatures extends Iterable<string> {
  has(feature: string): boolean;
}

interface NarrowGpuLimits {
  readonly maxBufferSize?: number;
  readonly maxStorageBufferBindingSize?: number;
  readonly maxComputeWorkgroupStorageSize?: number;
  readonly maxComputeInvocationsPerWorkgroup?: number;
  readonly maxStorageBuffersPerShaderStage?: number;
  readonly maxComputeWorkgroupsPerDimension?: number;
}

interface NarrowGpuDevice {
  readonly features: NarrowGpuFeatures;
  destroy(): void;
}

interface NarrowGpuAdapter {
  readonly features: NarrowGpuFeatures;
  readonly limits: NarrowGpuLimits;
  requestDevice(descriptor?: {
    readonly requiredFeatures?: readonly string[];
  }): Promise<NarrowGpuDevice>;
}

interface NarrowGpu {
  requestAdapter(): Promise<NarrowGpuAdapter | null>;
}

interface NarrowMlContext {
  readonly accelerated: unknown;
  destroy(): void;
}

interface NarrowMl {
  createContext(options: {
    readonly powerPreference: "default";
    readonly accelerated: true;
  }): Promise<NarrowMlContext>;
}

type ProbeNavigator = WorkerNavigator & {
  readonly gpu?: NarrowGpu;
  readonly ml?: NarrowMl;
  readonly storage?: StorageManager;
};

const scope = self as DedicatedWorkerGlobalScope;
let sequence = 0;

function postResult<K extends WorkerCapabilityId>(
  runId: string,
  id: K,
  startedAt: number,
  outcome: ProbeOutcome<CapabilityValueMap[K]>,
): void {
  const event: ProbeResultEvent = {
    protocolVersion: capabilityProtocolVersion,
    type: "probe/result",
    runId,
    sequence,
    id,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    outcome,
  } as ProbeResultEvent;
  sequence += 1;
  scope.postMessage(event);
}

function safeIndeterminate<T>(thrown: unknown): ProbeOutcome<T> {
  const failure = sanitizeThrown(thrown);
  return indeterminateOutcome(
    failure.code === "permission" ? "permission-blocked" : "operation-failed",
    failure,
  );
}

async function probeWasm(
  runId: string,
  id: "wasm.worker.simd" | "wasm.worker.threads" | "wasm.worker.jspi" | "wasm.worker.memory64",
  detector: () => Promise<boolean>,
): Promise<void> {
  const startedAt = performance.now();
  try {
    postResult(
      runId,
      id,
      startedAt,
      valueOutcome({
        supported: await detector(),
        detector: "wasm-feature-detect",
        detectorVersion: "1.8.0",
      }),
    );
  } catch (error: unknown) {
    postResult(runId, id, startedAt, safeIndeterminate(error));
  }
}

async function probeWebGpu(runId: string): Promise<void> {
  const startedAt = performance.now();
  const gpu = (scope.navigator as ProbeNavigator).gpu;
  if (gpu === undefined) {
    postResult(runId, "webgpu.worker", startedAt, absentOutcome("api-missing"));
    return;
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      postResult(
        runId,
        "webgpu.worker",
        startedAt,
        valueOutcome({
          adapter: "unavailable",
          device: "unavailable",
          features: [],
          limits: {},
          shaderF16: { advertised: false, acquired: false },
        }),
      );
      return;
    }
    const features = Array.from(adapter.features)
      .filter((feature) => feature.length > 0 && feature.length <= 64)
      .slice(0, 128)
      .sort();
    const limits: Partial<Record<WebGpuLimitName, number>> = {};
    for (const name of webGpuLimitNames) {
      const value = adapter.limits[name];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        limits[name] = value;
      }
    }
    const advertised = adapter.features.has("shader-f16");
    const device = await adapter.requestDevice(
      advertised ? { requiredFeatures: ["shader-f16"] } : undefined,
    );
    const acquired = advertised && device.features.has("shader-f16");
    device.destroy();
    postResult(
      runId,
      "webgpu.worker",
      startedAt,
      valueOutcome({
        adapter: "available",
        device: "usable",
        features,
        limits,
        shaderF16: { advertised, acquired },
      }),
    );
  } catch (error: unknown) {
    postResult(runId, "webgpu.worker", startedAt, safeIndeterminate(error));
  }
}

async function probeWebNn(runId: string): Promise<void> {
  const startedAt = performance.now();
  const ml = (scope.navigator as ProbeNavigator).ml;
  if (ml === undefined) {
    postResult(runId, "webnn.worker.default-context", startedAt, absentOutcome("api-missing"));
    return;
  }
  try {
    const requested = { powerPreference: "default", accelerated: true } as const;
    const context = await ml.createContext(requested);
    const accelerated = context.accelerated;
    context.destroy();
    postResult(
      runId,
      "webnn.worker.default-context",
      startedAt,
      normalizeWebNnContext(requested, accelerated),
    );
  } catch (error: unknown) {
    const failure = sanitizeThrown(error);
    if (failure.code === "not-supported") {
      postResult(
        runId,
        "webnn.worker.default-context",
        startedAt,
        absentOutcome("feature-not-supported"),
      );
      return;
    }
    postResult(runId, "webnn.worker.default-context", startedAt, safeIndeterminate(error));
  }
}

async function probeOpfs(runId: string): Promise<void> {
  const startedAt = performance.now();
  const storage = (scope.navigator as ProbeNavigator).storage;
  if (storage === undefined || typeof storage.getDirectory !== "function") {
    postResult(runId, "opfs.worker.root-access", startedAt, absentOutcome("api-missing"));
    return;
  }
  const result = await runBoundedWorkerOperation(() => storage.getDirectory());
  if (result.kind === "timeout") {
    postResult(
      runId,
      "opfs.worker.root-access",
      startedAt,
      indeterminateOutcome("probe-timeout", timeoutFailure()),
    );
  } else if (result.kind === "error") {
    postResult(runId, "opfs.worker.root-access", startedAt, safeIndeterminate(result.error));
  } else {
    postResult(runId, "opfs.worker.root-access", startedAt, valueOutcome(true));
  }
}

function probeSharedMemory(runId: string, sharedBuffer: SharedArrayBuffer | undefined): void {
  const startedAt = performance.now();
  const constructorAvailable = typeof SharedArrayBuffer === "function";
  try {
    let atomicsRoundTrip = false;
    if (constructorAvailable && sharedBuffer !== undefined) {
      const view = new Int32Array(sharedBuffer);
      atomicsRoundTrip =
        Atomics.compareExchange(view, 0, 41, 42) === 41 && Atomics.load(view, 0) === 42;
    }
    postResult(
      runId,
      "shared-memory.worker.round-trip",
      startedAt,
      valueOutcome({ constructorAvailable, atomicsRoundTrip }),
    );
  } catch (error: unknown) {
    postResult(runId, "shared-memory.worker.round-trip", startedAt, safeIndeterminate(error));
  }
}

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data as Partial<ProbeWorkerRequest>;
  if (
    request.protocolVersion !== capabilityProtocolVersion ||
    request.type !== "probe/run" ||
    typeof request.runId !== "string"
  ) {
    return;
  }
  sequence = 0;
  void (async () => {
    const startedAt = performance.now();
    postResult(
      request.runId as string,
      "environment.worker.cross-origin-isolated",
      startedAt,
      normalizeWorkerIsolation(scope.crossOriginIsolated),
    );
    probeSharedMemory(request.runId as string, request.sharedBuffer);
    await probeWasm(request.runId as string, "wasm.worker.simd", simd);
    await probeWasm(request.runId as string, "wasm.worker.threads", threads);
    await probeWasm(request.runId as string, "wasm.worker.jspi", jspi);
    await probeWasm(request.runId as string, "wasm.worker.memory64", memory64);
    await probeOpfs(request.runId as string);
    await probeWebGpu(request.runId as string);
    await probeWebNn(request.runId as string);
    scope.postMessage({
      protocolVersion: capabilityProtocolVersion,
      type: "probe/complete",
      runId: request.runId,
      sequence,
    });
  })();
});
