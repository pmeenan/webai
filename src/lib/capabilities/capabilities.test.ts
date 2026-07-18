import { describe, expect, test, vi } from "vitest";
import { workerCapabilityIds, type CapabilitySnapshot, type EvidenceFor } from "./evidence";
import { evaluateGate, threadedWasmGate, type GateDefinition } from "./gates";
import { normalizeWebNnContext, normalizeWorkerIsolation } from "./normalize";
import {
  capabilityProtocolVersion,
  parseProbeWorkerEvent,
  type ProbeWorkerRequest,
} from "./protocol";
import { sanitizeThrown } from "./sanitize";
import { runCapabilityWorker } from "./worker-client";

function booleanEvidence<
  K extends "environment.page.cross-origin-isolated" | "environment.worker.cross-origin-isolated",
>(id: K, value: boolean): EvidenceFor<K> {
  return {
    id,
    probeVersion: 1,
    observedAt: "2026-07-18T00:00:00.000Z",
    durationMs: 1,
    context: id.includes("worker") ? "dedicated-worker" : "page",
    stability: "stable-session",
    freshness: "current",
    trigger: "initial",
    outcome: { kind: "value", value },
  };
}

describe("pure capability gates", () => {
  const gate: GateDefinition = {
    id: "isolation",
    core: {
      kind: "all",
      requirements: [
        {
          kind: "boolean",
          id: "environment.page.cross-origin-isolated",
          expected: true,
          reason: "page isolation",
        },
        {
          kind: "boolean",
          id: "environment.worker.cross-origin-isolated",
          expected: true,
          reason: "worker isolation",
        },
      ],
    },
  };
  const isolationRequirements = gate.core.kind === "all" ? gate.core.requirements : [];

  test("distinguishes supported, unsupported, and unknown", () => {
    const supported = {
      "environment.page.cross-origin-isolated": booleanEvidence(
        "environment.page.cross-origin-isolated",
        true,
      ),
      "environment.worker.cross-origin-isolated": booleanEvidence(
        "environment.worker.cross-origin-isolated",
        true,
      ),
    } satisfies CapabilitySnapshot;
    expect(evaluateGate(supported, gate).verdict).toBe("supported");
    expect(
      evaluateGate(
        {
          ...supported,
          "environment.worker.cross-origin-isolated": booleanEvidence(
            "environment.worker.cross-origin-isolated",
            false,
          ),
        },
        gate,
      ).verdict,
    ).toBe("unsupported");
    expect(evaluateGate({}, gate).verdict).toBe("unknown");
  });

  test("implements failure-over-uncertainty for all", () => {
    const result = evaluateGate(
      {
        "environment.page.cross-origin-isolated": booleanEvidence(
          "environment.page.cross-origin-isolated",
          false,
        ),
      },
      gate,
    );
    expect(result.verdict).toBe("unsupported");
    expect(result.requirements).toEqual([
      expect.objectContaining({
        id: "environment.page.cross-origin-isolated",
        state: "fail",
      }),
      expect.objectContaining({
        id: "environment.worker.cross-origin-isolated",
        state: "unknown",
      }),
    ]);
  });

  test("implements success-over-uncertainty for any", () => {
    const anyGate: GateDefinition = {
      id: "either-isolation-surface",
      core: { kind: "any", requirements: isolationRequirements },
    };
    const result = evaluateGate(
      {
        "environment.page.cross-origin-isolated": booleanEvidence(
          "environment.page.cross-origin-isolated",
          true,
        ),
      },
      anyGate,
    );
    expect(result).toEqual({ id: anyGate.id, verdict: "supported", requirements: [] });
    expect(
      evaluateGate(
        {
          "environment.page.cross-origin-isolated": booleanEvidence(
            "environment.page.cross-origin-isolated",
            false,
          ),
        },
        anyGate,
      ).verdict,
    ).toBe("unknown");
    expect(
      evaluateGate(
        {
          "environment.page.cross-origin-isolated": booleanEvidence(
            "environment.page.cross-origin-isolated",
            false,
          ),
          "environment.worker.cross-origin-isolated": booleanEvidence(
            "environment.worker.cross-origin-isolated",
            false,
          ),
        },
        anyGate,
      ).verdict,
    ).toBe("unsupported");
  });

  test("treats stale and indeterminate core evidence as unknown, but absence as unsupported", () => {
    const current = booleanEvidence("environment.page.cross-origin-isolated", true);
    const stale = { ...current, freshness: "stale" } as const;
    const indeterminate = {
      ...booleanEvidence("environment.worker.cross-origin-isolated", true),
      outcome: { kind: "indeterminate", reason: "operation-failed" },
    } as const;
    expect(
      evaluateGate(
        {
          "environment.page.cross-origin-isolated": stale,
          "environment.worker.cross-origin-isolated": booleanEvidence(
            "environment.worker.cross-origin-isolated",
            true,
          ),
        },
        gate,
      ).verdict,
    ).toBe("unknown");
    expect(
      evaluateGate(
        {
          "environment.page.cross-origin-isolated": current,
          "environment.worker.cross-origin-isolated": indeterminate,
        },
        gate,
      ).verdict,
    ).toBe("unknown");
    expect(
      evaluateGate(
        {
          "environment.page.cross-origin-isolated": {
            ...current,
            outcome: { kind: "absent", reason: "api-missing" },
          },
          "environment.worker.cross-origin-isolated": booleanEvidence(
            "environment.worker.cross-origin-isolated",
            true,
          ),
        },
        gate,
      ).verdict,
    ).toBe("unsupported");
  });

  test("degrades a viable gate when an enhancement is missing", () => {
    const enhancementGate: GateDefinition = {
      id: "isolation-with-worker-enhancement",
      core: isolationRequirements[0]!,
      enhancements: [isolationRequirements[1]!],
    };
    const result = evaluateGate(
      {
        "environment.page.cross-origin-isolated": booleanEvidence(
          "environment.page.cross-origin-isolated",
          true,
        ),
      },
      enhancementGate,
    );
    expect(result.verdict).toBe("degraded");
    expect(result.requirements).toEqual([
      expect.objectContaining({
        id: "environment.worker.cross-origin-isolated",
        state: "unknown",
      }),
    ]);
  });

  test("requires a functional shared-memory round trip for threaded wasm", () => {
    const snapshot = {
      "environment.page.cross-origin-isolated": booleanEvidence(
        "environment.page.cross-origin-isolated",
        true,
      ),
      "environment.worker.cross-origin-isolated": booleanEvidence(
        "environment.worker.cross-origin-isolated",
        true,
      ),
      "shared-memory.worker.round-trip": {
        id: "shared-memory.worker.round-trip",
        probeVersion: 1,
        observedAt: "2026-07-18T00:00:00.000Z",
        durationMs: 1,
        context: "dedicated-worker",
        stability: "stable-session",
        freshness: "current",
        trigger: "initial",
        outcome: {
          kind: "value",
          value: { constructorAvailable: true, atomicsRoundTrip: false },
        },
      },
      "wasm.worker.threads": {
        id: "wasm.worker.threads",
        probeVersion: 1,
        observedAt: "2026-07-18T00:00:00.000Z",
        durationMs: 1,
        context: "dedicated-worker",
        stability: "stable-session",
        freshness: "current",
        trigger: "initial",
        outcome: {
          kind: "value",
          value: {
            supported: true,
            detector: "wasm-feature-detect",
            detectorVersion: "1.8.0",
          },
        },
      },
    } satisfies CapabilitySnapshot;
    expect(evaluateGate(snapshot, threadedWasmGate).verdict).toBe("unsupported");
  });
});

describe("safe worker boundary", () => {
  test("normalizes unstable platform values before posting worker evidence", () => {
    expect(normalizeWorkerIsolation(undefined)).toEqual({ kind: "value", value: false });
    expect(normalizeWebNnContext({ powerPreference: "default", accelerated: true }, "yes")).toEqual(
      {
        kind: "indeterminate",
        reason: "protocol-error",
        failure: { category: "protocol-error", code: "protocol" },
      },
    );
    expect(normalizeWebNnContext({ powerPreference: "default", accelerated: true }, true)).toEqual({
      kind: "value",
      value: {
        requested: { powerPreference: "default", accelerated: true },
        accelerated: true,
      },
    });
  });

  test("sanitizes native messages and arbitrary thrown values", () => {
    const failure = sanitizeThrown(new DOMException("local path details", "SecurityError"));
    expect(failure).toEqual({
      category: "dom-exception",
      code: "permission",
      name: "SecurityError",
    });
    expect(JSON.stringify(failure)).not.toContain("local path details");
    expect(sanitizeThrown({ message: "untrusted" })).toEqual({
      category: "unknown-thrown",
      code: "unknown",
    });
  });

  test("rejects malformed, out-of-schema evidence", () => {
    expect(parseProbeWorkerEvent({ protocolVersion: 99 })).toBeUndefined();
    expect(
      parseProbeWorkerEvent({
        protocolVersion: 1,
        type: "probe/result",
        runId: "test",
        sequence: 0,
        id: "opfs.worker.root-access",
        durationMs: 1,
        outcome: { kind: "value", value: "yes" },
      }),
    ).toBeUndefined();
    expect(
      parseProbeWorkerEvent({
        protocolVersion: 1,
        type: "probe/complete",
        runId: "test",
        sequence: 0,
        unexpected: true,
      }),
    ).toBeUndefined();

    const inherited = Object.assign(Object.create({ protocolVersion: 1 }), {
      type: "probe/complete",
      runId: "test",
      sequence: 0,
    });
    expect(parseProbeWorkerEvent(inherited)).toBeUndefined();

    expect(
      parseProbeWorkerEvent({
        protocolVersion: 1,
        type: "probe/result",
        runId: "test",
        sequence: 0,
        id: "shared-memory.worker.round-trip",
        durationMs: 1,
        outcome: {
          kind: "value",
          value: { constructorAvailable: false, atomicsRoundTrip: true },
        },
      }),
    ).toBeUndefined();
    expect(
      parseProbeWorkerEvent({
        protocolVersion: 1,
        type: "probe/result",
        runId: "test",
        sequence: 0,
        id: "webgpu.worker",
        durationMs: 1,
        outcome: {
          kind: "value",
          value: {
            adapter: "available",
            device: "usable",
            features: [],
            limits: {},
            shaderF16: { advertised: false, acquired: true },
          },
        },
      }),
    ).toBeUndefined();
    expect(
      parseProbeWorkerEvent({
        protocolVersion: 1,
        type: "probe/result",
        runId: "test",
        sequence: 0,
        id: "wasm.worker.simd",
        durationMs: 1,
        outcome: { kind: "absent", reason: "no-adapter" },
      }),
    ).toBeUndefined();
  });

  test("turns worker-construction failures into terminal unknown evidence", async () => {
    const nativeWorker = globalThis.Worker;
    class ThrowingWorker {
      constructor() {
        throw new DOMException("local details", "SecurityError");
      }
    }
    globalThis.Worker = ThrowingWorker as unknown as typeof Worker;
    try {
      const snapshot = await runCapabilityWorker("initial");
      for (const id of workerCapabilityIds) {
        expect(snapshot[id]?.outcome).toEqual({
          kind: "indeterminate",
          reason: "worker-error",
          failure: { category: "worker-error", code: "worker" },
        });
      }
    } finally {
      globalThis.Worker = nativeWorker;
    }
  });

  test("falls back to a local run ID when randomUUID is unavailable", async () => {
    const nativeWorker = globalThis.Worker;
    const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new DOMException("secure context required", "SecurityError");
    });
    let constructionCount = 0;
    class ThrowingWorker {
      constructor() {
        constructionCount += 1;
        throw new DOMException("local details", "SecurityError");
      }
    }
    globalThis.Worker = ThrowingWorker as unknown as typeof Worker;
    try {
      await runCapabilityWorker("initial");
      expect(constructionCount).toBe(1);
    } finally {
      globalThis.Worker = nativeWorker;
      randomUuid.mockRestore();
    }
  });

  test("rejects an early completion as a protocol error for the whole run", async () => {
    const nativeWorker = globalThis.Worker;
    class EarlyCompleteWorker extends EventTarget {
      postMessage(message: unknown): void {
        const request = message as ProbeWorkerRequest;
        this.dispatchEvent(
          new MessageEvent("message", {
            data: {
              protocolVersion: capabilityProtocolVersion,
              type: "probe/complete",
              runId: request.runId,
              sequence: 0,
            },
          }),
        );
      }

      terminate(): void {}
    }
    globalThis.Worker = EarlyCompleteWorker as unknown as typeof Worker;
    try {
      const snapshot = await runCapabilityWorker("initial");
      for (const id of workerCapabilityIds) {
        expect(snapshot[id]?.outcome).toEqual({
          kind: "indeterminate",
          reason: "protocol-error",
          failure: { category: "protocol-error", code: "protocol" },
        });
      }
    } finally {
      globalThis.Worker = nativeWorker;
    }
  });
});

describe("real isolated worker probes", () => {
  test("measures isolation, shared memory, OPFS, and wasm without writes", async () => {
    expect(crossOriginIsolated).toBe(true);
    const snapshot = await runCapabilityWorker("initial");
    expect(snapshot["environment.worker.cross-origin-isolated"]?.outcome).toEqual({
      kind: "value",
      value: true,
    });
    expect(snapshot["shared-memory.worker.round-trip"]?.outcome).toMatchObject({
      kind: "value",
      value: { atomicsRoundTrip: true },
    });
    expect(snapshot["opfs.worker.root-access"]?.outcome).toEqual({
      kind: "value",
      value: true,
    });
    for (const id of [
      "wasm.worker.simd",
      "wasm.worker.threads",
      "wasm.worker.jspi",
      "wasm.worker.memory64",
    ] as const) {
      expect(snapshot[id]?.outcome.kind).toBe("value");
    }
  }, 25_000);
});
