import { descriptorById } from "./descriptors";
import {
  indeterminateOutcome,
  workerCapabilityIds,
  type CapabilitySnapshot,
  type EvidenceFor,
  type WorkerCapabilityId,
} from "./evidence";
import {
  capabilityProtocolVersion,
  parseProbeWorkerEvent,
  type ProbeWorkerRequest,
} from "./protocol";
import { protocolFailure, timeoutFailure, workerFailure } from "./sanitize";

const workerTimeoutMs = 15_000;
let fallbackRunSequence = 0;

function makeRunId(): string {
  try {
    if (typeof crypto.randomUUID === "function") {
      return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    }
  } catch {
    // The run ID is only a same-page correlation token, so a monotonic fallback is sufficient.
  }
  fallbackRunSequence += 1;
  return `${Date.now().toString(36)}-fallback-${fallbackRunSequence.toString(36)}`;
}

function failedEvidence(
  id: WorkerCapabilityId,
  reason: "probe-timeout" | "protocol-error" | "worker-error",
  trigger: EvidenceFor<WorkerCapabilityId>["trigger"],
  durationMs: number,
): EvidenceFor<WorkerCapabilityId> {
  const descriptor = descriptorById.get(id);
  if (descriptor === undefined) throw new Error(`Missing descriptor for ${id}`);
  const failure =
    reason === "probe-timeout"
      ? timeoutFailure()
      : reason === "protocol-error"
        ? protocolFailure()
        : workerFailure();
  return {
    id,
    probeVersion: descriptor.probeVersion,
    observedAt: new Date().toISOString(),
    durationMs,
    context: "dedicated-worker",
    stability: descriptor.stability,
    freshness: "current",
    trigger,
    outcome: indeterminateOutcome(reason, failure),
  };
}

function failedSnapshot(
  reason: "probe-timeout" | "protocol-error" | "worker-error",
  trigger: EvidenceFor<WorkerCapabilityId>["trigger"],
  durationMs: number,
): CapabilitySnapshot {
  return Object.freeze(
    Object.fromEntries(
      workerCapabilityIds.map((id) => [id, failedEvidence(id, reason, trigger, durationMs)]),
    ),
  ) as CapabilitySnapshot;
}

export async function runCapabilityWorker(
  trigger: "initial" | "explicit-refresh",
): Promise<CapabilitySnapshot> {
  const runStartedAt = performance.now();
  let runId: string;
  let sharedBuffer: SharedArrayBuffer | undefined;
  let worker: Worker;
  try {
    runId = makeRunId();
    if (globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === "function") {
      sharedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      Atomics.store(new Int32Array(sharedBuffer), 0, 41);
    }
    worker = new Worker(new URL("./probe.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return failedSnapshot(
      "worker-error",
      trigger,
      Math.max(0, Math.round(performance.now() - runStartedAt)),
    );
  }
  const request: ProbeWorkerRequest = {
    protocolVersion: capabilityProtocolVersion,
    type: "probe/run",
    runId,
    ...(sharedBuffer === undefined ? {} : { sharedBuffer }),
  };
  return await new Promise<CapabilitySnapshot>((resolve) => {
    const results: Partial<Record<WorkerCapabilityId, EvidenceFor<WorkerCapabilityId>>> = {};
    let expectedSequence = 0;
    let settled = false;

    const finish = (reason?: "probe-timeout" | "protocol-error" | "worker-error") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      const durationMs = Math.max(0, Math.round(performance.now() - runStartedAt));
      for (const id of workerCapabilityIds) {
        if (reason === "protocol-error" || results[id] === undefined) {
          results[id] = failedEvidence(id, reason ?? "worker-error", trigger, durationMs);
        }
      }
      resolve(Object.freeze({ ...results }) as CapabilitySnapshot);
    };

    const timeout = window.setTimeout(() => finish("probe-timeout"), workerTimeoutMs);
    worker.addEventListener("error", () => finish("worker-error"), { once: true });
    worker.addEventListener("messageerror", () => finish("protocol-error"), { once: true });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const parsed = parseProbeWorkerEvent(event.data);
      if (parsed === undefined || parsed.runId !== runId || parsed.sequence !== expectedSequence) {
        finish("protocol-error");
        return;
      }
      expectedSequence += 1;
      if (parsed.type === "probe/complete") {
        finish(
          workerCapabilityIds.every((id) => results[id] !== undefined)
            ? undefined
            : "protocol-error",
        );
        return;
      }
      if (results[parsed.id] !== undefined) {
        finish("protocol-error");
        return;
      }
      const descriptor = descriptorById.get(parsed.id);
      if (descriptor === undefined) {
        finish("protocol-error");
        return;
      }
      results[parsed.id] = {
        id: parsed.id,
        probeVersion: descriptor.probeVersion,
        observedAt: new Date().toISOString(),
        durationMs: parsed.durationMs,
        context: "dedicated-worker",
        stability: descriptor.stability,
        freshness: "current",
        trigger,
        outcome: parsed.outcome,
      } as EvidenceFor<WorkerCapabilityId>;
    });

    try {
      worker.postMessage(request);
    } catch {
      finish("worker-error");
    }
  });
}
