import { descriptorById } from "./descriptors";
import { runBoundedOperation } from "../bounded-operation";
import {
  isPromptApiAvailability,
  promptApiProbeTimeoutMs,
  promptApiTextOptions,
} from "../prompt-api-surface";
import {
  absentOutcome,
  indeterminateOutcome,
  valueOutcome,
  type CapabilityId,
  type CapabilityEvidence,
  type CapabilityValueMap,
  type EvidenceFor,
  type ProbeOutcome,
  type StorageApiSurface,
} from "./evidence";
import { sanitizeThrown, timeoutFailure } from "./sanitize";

const storageProbeTimeoutMs = 5_000;

type PageCapabilityId = Exclude<
  CapabilityId,
  | `environment.worker.${string}`
  | `shared-memory.worker.${string}`
  | `wasm.worker.${string}`
  | "webgpu.worker"
  | "webnn.worker.default-context"
  | "opfs.worker.root-access"
>;

type PageNavigator = Navigator & {
  readonly gpu?: unknown;
  readonly ml?: unknown;
};

function evidence<K extends PageCapabilityId>(
  id: K,
  outcome: ProbeOutcome<CapabilityValueMap[K]>,
  startedAt: number,
  trigger: EvidenceFor<K>["trigger"],
): EvidenceFor<K> {
  const descriptor = descriptorById.get(id);
  if (descriptor === undefined) throw new Error(`Missing descriptor for ${id}`);
  return {
    id,
    probeVersion: descriptor.probeVersion,
    observedAt: new Date().toISOString(),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    context: "page",
    stability: descriptor.stability,
    freshness: "current",
    trigger,
    outcome,
  };
}

function storageSurface(): StorageApiSurface {
  const storage = navigator.storage;
  return {
    estimate: storage !== undefined && typeof storage.estimate === "function",
    getDirectory: storage !== undefined && typeof storage.getDirectory === "function",
    persist: storage !== undefined && typeof storage.persist === "function",
    persisted: storage !== undefined && typeof storage.persisted === "function",
  };
}

export function runStablePageProbes(
  trigger: "initial" | "explicit-refresh",
): readonly CapabilityEvidence[] {
  const pageNavigator = navigator as PageNavigator;
  const now = performance.now();
  const sabAvailable = typeof SharedArrayBuffer === "function";
  return [
    evidence("environment.page.secure-context", valueOutcome(isSecureContext), now, trigger),
    evidence(
      "environment.page.cross-origin-isolated",
      valueOutcome(crossOriginIsolated),
      now,
      trigger,
    ),
    evidence("shared-memory.page.constructor", valueOutcome(sabAvailable), now, trigger),
    evidence("webgpu.page.api", valueOutcome(pageNavigator.gpu !== undefined), now, trigger),
    evidence("webnn.page.api", valueOutcome(pageNavigator.ml !== undefined), now, trigger),
    evidence("storage.page.api", valueOutcome(storageSurface()), now, trigger),
  ] as readonly CapabilityEvidence[];
}

async function probeStorageEstimate(
  trigger: EvidenceFor<"storage.estimate">["trigger"],
): Promise<EvidenceFor<"storage.estimate">> {
  const estimateStartedAt = performance.now();
  let estimateOutcome: ProbeOutcome<CapabilityValueMap["storage.estimate"]>;
  if (navigator.storage === undefined || typeof navigator.storage.estimate !== "function") {
    estimateOutcome = absentOutcome("api-missing");
  } else {
    const result = await runBoundedOperation(
      () => navigator.storage.estimate(),
      storageProbeTimeoutMs,
    );
    if (result.kind === "timeout") {
      estimateOutcome = indeterminateOutcome("probe-timeout", timeoutFailure());
    } else if (result.kind === "error") {
      const failure = sanitizeThrown(result.error);
      estimateOutcome = indeterminateOutcome(
        failure.code === "permission" ? "permission-blocked" : "operation-failed",
        failure,
      );
    } else {
      const estimate = result.value;
      const usageBytes = estimate.usage;
      const quotaBytes = estimate.quota;
      if (
        (usageBytes !== undefined && (!Number.isSafeInteger(usageBytes) || usageBytes < 0)) ||
        (quotaBytes !== undefined && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0)) ||
        (usageBytes !== undefined && quotaBytes !== undefined && usageBytes > quotaBytes)
      ) {
        estimateOutcome = indeterminateOutcome("operation-failed");
      } else {
        estimateOutcome = valueOutcome({
          ...(usageBytes === undefined ? {} : { usageBytes }),
          ...(quotaBytes === undefined ? {} : { quotaBytes }),
          scope: "origin",
          confidence: "estimated-origin",
        });
      }
    }
  }
  return evidence("storage.estimate", estimateOutcome, estimateStartedAt, trigger);
}

async function probeStoragePersistenceState(
  trigger: EvidenceFor<"storage.persisted">["trigger"],
): Promise<EvidenceFor<"storage.persisted">> {
  const persistedStartedAt = performance.now();
  let persistedOutcome: ProbeOutcome<boolean>;
  if (navigator.storage === undefined || typeof navigator.storage.persisted !== "function") {
    persistedOutcome = absentOutcome("api-missing");
  } else {
    const result = await runBoundedOperation(
      () => navigator.storage.persisted(),
      storageProbeTimeoutMs,
    );
    if (result.kind === "timeout") {
      persistedOutcome = indeterminateOutcome("probe-timeout", timeoutFailure());
    } else if (result.kind === "error") {
      const failure = sanitizeThrown(result.error);
      persistedOutcome = indeterminateOutcome(
        failure.code === "permission" ? "permission-blocked" : "operation-failed",
        failure,
      );
    } else {
      persistedOutcome = valueOutcome(result.value);
    }
  }
  return evidence("storage.persisted", persistedOutcome, persistedStartedAt, trigger);
}

export async function runVolatileStorageProbes(
  trigger: EvidenceFor<"storage.estimate">["trigger"],
): Promise<readonly [EvidenceFor<"storage.estimate">, EvidenceFor<"storage.persisted">]> {
  return await Promise.all([probeStorageEstimate(trigger), probeStoragePersistenceState(trigger)]);
}

export async function runVolatilePromptApiProbe(
  trigger: EvidenceFor<"prompt-api.page.availability">["trigger"],
): Promise<EvidenceFor<"prompt-api.page.availability">> {
  const startedAt = performance.now();
  let candidate: unknown;
  try {
    candidate = (globalThis as typeof globalThis & { readonly LanguageModel?: unknown })
      .LanguageModel;
  } catch (error) {
    return evidence(
      "prompt-api.page.availability",
      indeterminateOutcome("operation-failed", sanitizeThrown(error)),
      startedAt,
      trigger,
    );
  }
  if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
    return evidence(
      "prompt-api.page.availability",
      absentOutcome("api-missing"),
      startedAt,
      trigger,
    );
  }
  let availability: unknown;
  try {
    availability = "availability" in candidate ? candidate.availability : undefined;
  } catch (error) {
    return evidence(
      "prompt-api.page.availability",
      indeterminateOutcome("operation-failed", sanitizeThrown(error)),
      startedAt,
      trigger,
    );
  }
  if (typeof availability !== "function") {
    return evidence(
      "prompt-api.page.availability",
      absentOutcome("api-missing"),
      startedAt,
      trigger,
    );
  }
  const result = await runBoundedOperation(
    () => Promise.resolve(availability.call(candidate, promptApiTextOptions)),
    promptApiProbeTimeoutMs,
  );
  if (result.kind === "timeout") {
    return evidence(
      "prompt-api.page.availability",
      indeterminateOutcome("probe-timeout", timeoutFailure()),
      startedAt,
      trigger,
    );
  }
  if (result.kind === "error") {
    const failure = sanitizeThrown(result.error);
    return evidence(
      "prompt-api.page.availability",
      indeterminateOutcome(
        failure.code === "permission" ? "permission-blocked" : "operation-failed",
        failure,
      ),
      startedAt,
      trigger,
    );
  }
  if (!isPromptApiAvailability(result.value)) {
    return evidence(
      "prompt-api.page.availability",
      indeterminateOutcome("protocol-error", {
        category: "protocol-error",
        code: "protocol",
      }),
      startedAt,
      trigger,
    );
  }
  return evidence("prompt-api.page.availability", valueOutcome(result.value), startedAt, trigger);
}

export async function requestStoragePersistence(): Promise<ProbeOutcome<boolean>> {
  if (navigator.storage === undefined || typeof navigator.storage.persist !== "function") {
    return absentOutcome("api-missing");
  }
  const result = await runBoundedOperation(
    () => navigator.storage.persist(),
    storageProbeTimeoutMs,
  );
  if (result.kind === "timeout") {
    return indeterminateOutcome("probe-timeout", timeoutFailure());
  }
  if (result.kind === "error") {
    const failure = sanitizeThrown(result.error);
    return indeterminateOutcome(
      failure.code === "permission" ? "permission-blocked" : "operation-failed",
      failure,
    );
  }
  return valueOutcome(result.value);
}
