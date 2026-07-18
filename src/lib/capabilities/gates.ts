import type {
  CapabilityId,
  CapabilitySnapshot,
  CapabilityValueMap,
  SharedMemoryResult,
  WasmFeatureResult,
} from "./evidence";

export type RequirementState = "pass" | "fail" | "unknown";
export type CapabilityVerdict = "supported" | "degraded" | "unsupported" | "unknown";

type BooleanCapabilityId = {
  [K in CapabilityId]: CapabilityValueMap[K] extends boolean ? K : never;
}[CapabilityId];

export type RequirementExpression =
  | {
      readonly kind: "boolean";
      readonly id: BooleanCapabilityId;
      readonly expected: boolean;
      readonly reason: string;
      readonly remediation?: string;
    }
  | {
      readonly kind: "shared-memory-round-trip";
      readonly id: "shared-memory.worker.round-trip";
      readonly reason: string;
      readonly remediation?: string;
    }
  | {
      readonly kind: "wasm-supported";
      readonly id:
        | "wasm.worker.simd"
        | "wasm.worker.threads"
        | "wasm.worker.jspi"
        | "wasm.worker.memory64";
      readonly reason: string;
      readonly remediation?: string;
    }
  | { readonly kind: "all"; readonly requirements: readonly RequirementExpression[] }
  | { readonly kind: "any"; readonly requirements: readonly RequirementExpression[] };

export interface RequirementFinding {
  readonly id?: CapabilityId;
  readonly state: Exclude<RequirementState, "pass">;
  readonly reason: string;
  readonly remediation?: string;
}

export interface GateDefinition {
  readonly id: string;
  readonly core: RequirementExpression;
  readonly enhancements?: readonly RequirementExpression[];
}

export interface GateResult {
  readonly id: string;
  readonly verdict: CapabilityVerdict;
  readonly requirements: readonly RequirementFinding[];
}

interface ExpressionResult {
  readonly state: RequirementState;
  readonly findings: readonly RequirementFinding[];
}

function leafState(
  snapshot: CapabilitySnapshot,
  expression: RequirementExpression,
): ExpressionResult {
  if (
    expression.kind !== "boolean" &&
    expression.kind !== "shared-memory-round-trip" &&
    expression.kind !== "wasm-supported"
  ) {
    return { state: "unknown", findings: [] };
  }
  const evidence = snapshot[expression.id];
  const finding = (state: "fail" | "unknown"): RequirementFinding => ({
    id: expression.id,
    state,
    reason: expression.reason,
    ...(expression.remediation === undefined ? {} : { remediation: expression.remediation }),
  });
  if (evidence === undefined || evidence.freshness === "stale") {
    return { state: "unknown", findings: [finding("unknown")] };
  }
  if (evidence.outcome.kind === "indeterminate") {
    return { state: "unknown", findings: [finding("unknown")] };
  }
  if (evidence.outcome.kind === "absent") {
    return { state: "fail", findings: [finding("fail")] };
  }
  const passed =
    expression.kind === "boolean"
      ? evidence.outcome.value === expression.expected
      : expression.kind === "shared-memory-round-trip"
        ? (evidence.outcome.value as SharedMemoryResult).atomicsRoundTrip
        : (evidence.outcome.value as WasmFeatureResult).supported;
  return passed ? { state: "pass", findings: [] } : { state: "fail", findings: [finding("fail")] };
}

function evaluateExpression(
  snapshot: CapabilitySnapshot,
  expression: RequirementExpression,
): ExpressionResult {
  if (
    expression.kind === "boolean" ||
    expression.kind === "shared-memory-round-trip" ||
    expression.kind === "wasm-supported"
  ) {
    return leafState(snapshot, expression);
  }
  const results = expression.requirements.map((requirement) =>
    evaluateExpression(snapshot, requirement),
  );
  const findings = results.flatMap((result) => result.findings);
  if (expression.kind === "all") {
    if (results.some((result) => result.state === "fail")) return { state: "fail", findings };
    if (results.some((result) => result.state === "unknown")) {
      return { state: "unknown", findings };
    }
    return { state: "pass", findings: [] };
  }
  if (results.some((result) => result.state === "pass")) return { state: "pass", findings: [] };
  if (results.some((result) => result.state === "unknown")) {
    return { state: "unknown", findings };
  }
  return { state: "fail", findings };
}

export function evaluateGate(snapshot: CapabilitySnapshot, gate: GateDefinition): GateResult {
  const core = evaluateExpression(snapshot, gate.core);
  if (core.state === "fail") {
    return { id: gate.id, verdict: "unsupported", requirements: core.findings };
  }
  if (core.state === "unknown") {
    return { id: gate.id, verdict: "unknown", requirements: core.findings };
  }
  const enhancements = (gate.enhancements ?? []).map((requirement) =>
    evaluateExpression(snapshot, requirement),
  );
  const findings = enhancements.flatMap((result) => result.findings);
  return {
    id: gate.id,
    verdict: enhancements.some((result) => result.state !== "pass") ? "degraded" : "supported",
    requirements: findings,
  };
}

export const threadedWasmGate: GateDefinition = {
  id: "wasm-threaded-worker",
  core: {
    kind: "all",
    requirements: [
      {
        kind: "boolean",
        id: "environment.page.cross-origin-isolated",
        expected: true,
        reason: "The page is not cross-origin isolated.",
        remediation: "Check the WebAI COOP and COEP response headers.",
      },
      {
        kind: "boolean",
        id: "environment.worker.cross-origin-isolated",
        expected: true,
        reason: "The worker is not cross-origin isolated.",
      },
      {
        kind: "shared-memory-round-trip",
        id: "shared-memory.worker.round-trip",
        reason: "The worker could not use page-created shared memory atomically.",
        remediation: "Check cross-origin isolation and SharedArrayBuffer availability.",
      },
      {
        kind: "wasm-supported",
        id: "wasm.worker.threads",
        reason: "The WebAssembly threads probe did not pass.",
      },
    ],
  },
  enhancements: [
    {
      kind: "wasm-supported",
      id: "wasm.worker.simd",
      reason: "WebAssembly SIMD is unavailable.",
    },
  ],
};
