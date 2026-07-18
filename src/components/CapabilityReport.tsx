import {
  CircleCheck,
  CircleHelp,
  CircleX,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  capabilityDescriptors,
  descriptorById,
  type CapabilityDescriptor,
} from "../lib/capabilities/descriptors";
import type {
  CapabilityEvidence,
  CapabilitySnapshot,
  ProbeOutcome,
  StorageApiSurface,
  StorageEstimateValue,
  WebGpuSnapshot,
  WebNnSnapshot,
} from "../lib/capabilities/evidence";
import { evaluateGate, threadedWasmGate, type CapabilityVerdict } from "../lib/capabilities/gates";
import { CapabilityRegistry } from "../lib/capabilities/registry";
import Button from "./ui/button";

function verdictFor(evidence: CapabilityEvidence | undefined): CapabilityVerdict {
  if (evidence === undefined || evidence.freshness === "stale") return "unknown";
  const outcome = evidence.outcome;
  if (outcome.kind === "indeterminate") return "unknown";
  if (outcome.kind === "absent") return "unsupported";
  const value: unknown = outcome.value;
  if (typeof value === "boolean") {
    if (evidence.id === "storage.persisted" && !value) return "degraded";
    return value ? "supported" : "unsupported";
  }
  if (evidence.id.startsWith("wasm.worker.")) {
    return (value as { readonly supported: boolean }).supported ? "supported" : "unsupported";
  }
  if (evidence.id === "shared-memory.worker.round-trip") {
    return (value as { readonly atomicsRoundTrip: boolean }).atomicsRoundTrip
      ? "supported"
      : "unsupported";
  }
  if (evidence.id === "webgpu.worker") {
    const gpu = value as WebGpuSnapshot;
    if (gpu.adapter !== "available" || gpu.device !== "usable") return "unsupported";
    return gpu.shaderF16.acquired ? "supported" : "degraded";
  }
  if (evidence.id === "webnn.worker.default-context") {
    return (value as WebNnSnapshot).accelerated ? "supported" : "degraded";
  }
  if (evidence.id === "storage.page.api") {
    const storage = value as StorageApiSurface;
    if (!storage.estimate && !storage.getDirectory && !storage.persist && !storage.persisted) {
      return "unsupported";
    }
    return storage.estimate && storage.getDirectory && storage.persist && storage.persisted
      ? "supported"
      : "degraded";
  }
  return "supported";
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "Not reported";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function describeOutcome(evidence: CapabilityEvidence): string {
  const outcome = evidence.outcome as ProbeOutcome<unknown>;
  if (outcome.kind === "absent") return `Unavailable: ${outcome.reason.replaceAll("-", " ")}.`;
  if (outcome.kind === "indeterminate") {
    return `Not determined: ${outcome.reason.replaceAll("-", " ")}.`;
  }
  const value = outcome.value;
  if (evidence.id === "storage.estimate") {
    const estimate = value as StorageEstimateValue;
    return `Usage ${formatBytes(estimate.usageBytes)} · quota ${formatBytes(estimate.quotaBytes)} · origin-wide estimate`;
  }
  if (evidence.id === "webgpu.worker") {
    const gpu = value as WebGpuSnapshot;
    return `Adapter ${gpu.adapter} · device ${gpu.device} · shader-f16 ${gpu.shaderF16.acquired ? "acquired" : gpu.shaderF16.advertised ? "advertised only" : "not advertised"}`;
  }
  if (evidence.id === "webnn.worker.default-context") {
    return `Default context created · accelerated: ${(value as WebNnSnapshot).accelerated ? "yes" : "no"}`;
  }
  if (evidence.id.startsWith("wasm.worker.")) {
    return (value as { readonly supported: boolean }).supported
      ? "Pinned feature probe passed."
      : "Pinned feature probe did not pass.";
  }
  if (evidence.id === "shared-memory.worker.round-trip") {
    const result = value as {
      readonly constructorAvailable: boolean;
      readonly atomicsRoundTrip: boolean;
    };
    return `Worker constructor ${result.constructorAvailable ? "available" : "unavailable"} · atomic sentinel ${result.atomicsRoundTrip ? "verified" : "not verified"}`;
  }
  if (typeof value === "boolean") return value ? "Observed: yes." : "Observed: no.";
  return "Measured successfully.";
}

function safeRawEvidence(evidence: CapabilityEvidence): string {
  return JSON.stringify(
    {
      id: evidence.id,
      probeVersion: evidence.probeVersion,
      observedAt: evidence.observedAt,
      durationMs: evidence.durationMs,
      context: evidence.context,
      stability: evidence.stability,
      freshness: evidence.freshness,
      outcome: evidence.outcome,
    },
    null,
    2,
  );
}

function threadedGateConsequence(verdict: CapabilityVerdict): string | undefined {
  switch (verdict) {
    case "degraded":
      return "Threaded wasm is available, but an optional performance enhancement was not confirmed.";
    case "unsupported":
      return "Threaded wasm runtimes cannot be enabled in this environment.";
    case "unknown":
      return "Threaded wasm remains pending until every required measurement is conclusive.";
    case "supported":
      return undefined;
  }
}

const capabilityGroups = [
  {
    id: "environment",
    label: "Environment and isolation",
    descriptors: capabilityDescriptors.filter((descriptor) =>
      descriptor.id.startsWith("environment."),
    ),
  },
  {
    id: "wasm",
    label: "WebAssembly and shared memory",
    descriptors: capabilityDescriptors.filter(
      (descriptor) =>
        descriptor.id.startsWith("wasm.") || descriptor.id.startsWith("shared-memory."),
    ),
  },
  {
    id: "accelerators",
    label: "Accelerated compute",
    descriptors: capabilityDescriptors.filter(
      (descriptor) => descriptor.id.startsWith("webgpu.") || descriptor.id.startsWith("webnn."),
    ),
  },
  {
    id: "storage",
    label: "Storage",
    descriptors: capabilityDescriptors.filter(
      (descriptor) => descriptor.id.startsWith("storage.") || descriptor.id.startsWith("opfs."),
    ),
  },
] as const;

function VerdictIcon({ verdict }: { readonly verdict: CapabilityVerdict }) {
  if (verdict === "supported") return <CircleCheck aria-hidden="true" />;
  if (verdict === "degraded") return <TriangleAlert aria-hidden="true" />;
  if (verdict === "unsupported") return <CircleX aria-hidden="true" />;
  return <CircleHelp aria-hidden="true" />;
}

export default function CapabilityReport() {
  const [registry] = useState(() => new CapabilityRegistry());
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>(registry.snapshot);
  const [probing, setProbing] = useState(false);
  const [persistenceMessage, setPersistenceMessage] = useState<string>();
  const [requestingPersistence, setRequestingPersistence] = useState(false);

  useEffect(() => {
    const unsubscribe = registry.subscribe((next, nextProbing) => {
      setSnapshot(next);
      setProbing(nextProbing);
    });
    const detachVisibility = registry.attachVisibilityInvalidation();
    void registry.refresh("initial");
    return () => {
      unsubscribe();
      detachVisibility();
    };
  }, [registry]);

  const threadedGate = evaluateGate(snapshot, threadedWasmGate);
  const measurementComplete = capabilityDescriptors.every(
    (descriptor) => snapshot[descriptor.id] !== undefined,
  );
  const measurementStatus = probing
    ? "Measuring browser capabilities."
    : measurementComplete
      ? "Browser capability measurement complete."
      : "Browser capability measurement is waiting to start.";
  const gateConsequence = threadedGateConsequence(threadedGate.verdict);
  const storageSurfaceEvidence = snapshot["storage.page.api"];
  const persistenceApiMeasured =
    storageSurfaceEvidence?.freshness === "current" &&
    storageSurfaceEvidence.outcome.kind === "value";
  const persistenceApiAvailable =
    persistenceApiMeasured && storageSurfaceEvidence.outcome.value.persist;
  const persistenceApiUnavailable =
    storageSurfaceEvidence?.freshness === "current" &&
    (storageSurfaceEvidence.outcome.kind === "absent" ||
      (storageSurfaceEvidence.outcome.kind === "value" &&
        !storageSurfaceEvidence.outcome.value.persist));
  const persistedEvidence = snapshot["storage.persisted"];
  const persistenceAlreadyGranted =
    persistedEvidence?.freshness === "current" &&
    persistedEvidence.outcome.kind === "value" &&
    persistedEvidence.outcome.value;

  const requestPersistence = async () => {
    if (requestingPersistence || !persistenceApiAvailable || persistenceAlreadyGranted) return;
    setRequestingPersistence(true);
    setPersistenceMessage("Requesting origin persistence…");
    try {
      const result = await registry.requestPersistence();
      if (result.kind === "value") {
        setPersistenceMessage(
          result.value
            ? "Persistent storage was granted for this origin."
            : "The browser kept this origin in best-effort storage.",
        );
      } else {
        setPersistenceMessage("The persistence request could not be completed.");
      }
    } catch {
      setPersistenceMessage("The persistence request could not be completed.");
    } finally {
      setRequestingPersistence(false);
    }
  };

  return (
    <div className="capability-report">
      <p className="visually-hidden" role="status">
        {measurementStatus}
      </p>
      <div className="capability-toolbar">
        <div>
          <p className="capability-toolbar-label">Threaded wasm readiness</p>
          <p className={`status-badge status-${threadedGate.verdict}`}>
            <VerdictIcon verdict={threadedGate.verdict} />
            {threadedGate.verdict}
          </p>
          {gateConsequence === undefined ? null : (
            <div className="capability-gate-explanation">
              <p>{gateConsequence}</p>
              {threadedGate.requirements.length === 0 ? null : (
                <ul>
                  {threadedGate.requirements.map((finding, index) => {
                    const label = finding.id
                      ? (descriptorById.get(finding.id)?.label ?? finding.id)
                      : "Required capability";
                    return (
                      <li key={`${finding.id ?? "gate"}-${finding.state}-${index}`}>
                        {finding.state === "unknown"
                          ? `${label} has missing, stale, or inconclusive evidence.`
                          : finding.reason}
                        {finding.remediation === undefined ? null : ` ${finding.remediation}`}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
        <Button
          className="capability-refresh"
          disabled={probing}
          aria-busy={probing}
          onClick={() => void registry.refresh("explicit-refresh")}
        >
          <RefreshCw aria-hidden="true" />
          Refresh diagnostics
        </Button>
      </div>

      <p className="capability-scope-note">
        Storage figures cover this whole origin and are browser estimates—not WebAI-managed usage or
        free disk space.
      </p>

      <div className="capability-groups" data-testid="capability-grid" aria-busy={probing}>
        {capabilityGroups.map((group) => (
          <section
            className="capability-group"
            aria-labelledby={`capability-group-${group.id}`}
            key={group.id}
          >
            <h2 id={`capability-group-${group.id}`} className="capability-group-heading">
              {group.label}
            </h2>
            <div className="capability-grid">
              {group.descriptors.map((item) => {
                const descriptor: CapabilityDescriptor = item;
                const evidence = snapshot[descriptor.id] as CapabilityEvidence | undefined;
                const verdict = verdictFor(evidence);
                return (
                  <article
                    className="capability-card"
                    key={descriptor.id}
                    data-capability-id={descriptor.id}
                  >
                    <div className="capability-card-heading">
                      <h3>{descriptor.label}</h3>
                      <span className={`status-badge status-${verdict}`}>
                        <VerdictIcon verdict={verdict} />
                        {verdict}
                      </span>
                    </div>
                    <p>{descriptor.explanation}</p>
                    {evidence === undefined ? (
                      <p className="capability-observation">Waiting for measurement.</p>
                    ) : (
                      <>
                        <p className="capability-observation">{describeOutcome(evidence)}</p>
                        <p className="capability-meta">
                          {evidence.context} · {evidence.stability} · {evidence.observedAt}
                        </p>
                        {descriptor.remediation !== undefined && verdict === "unsupported" ? (
                          <p className="capability-remediation">Try: {descriptor.remediation}</p>
                        ) : null}
                        <details>
                          <summary>Raw safe evidence</summary>
                          <pre>{safeRawEvidence(evidence)}</pre>
                        </details>
                      </>
                    )}
                    {descriptor.id === "storage.persisted" ? (
                      <div className="persistence-action">
                        <Button
                          disabled={
                            requestingPersistence ||
                            !persistenceApiAvailable ||
                            persistenceAlreadyGranted
                          }
                          aria-busy={requestingPersistence}
                          onClick={() => void requestPersistence()}
                        >
                          <ShieldCheck aria-hidden="true" />
                          {persistenceAlreadyGranted
                            ? "Persistence granted"
                            : persistenceApiAvailable
                              ? "Request persistence"
                              : persistenceApiUnavailable
                                ? "Persistence unavailable"
                                : "Persistence status unknown"}
                        </Button>
                        {persistenceMessage === undefined ? null : (
                          <p role="status">{persistenceMessage}</p>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
