import type { SanitizedFailure, SafeFailureCode } from "./evidence";

const safeDomNames = new Set([
  "AbortError",
  "InvalidStateError",
  "NotSupportedError",
  "OperationError",
  "QuotaExceededError",
  "SecurityError",
  "UnknownError",
]);

function codeForName(name: string): SafeFailureCode {
  switch (name) {
    case "AbortError":
      return "abort";
    case "InvalidStateError":
      return "invalid-state";
    case "NotSupportedError":
      return "not-supported";
    case "OperationError":
      return "operation";
    case "QuotaExceededError":
      return "quota";
    case "SecurityError":
      return "permission";
    default:
      return "unknown";
  }
}

export function sanitizeThrown(thrown: unknown): SanitizedFailure {
  try {
    if (typeof DOMException !== "undefined" && thrown instanceof DOMException) {
      const name = safeDomNames.has(thrown.name) ? thrown.name : "UnknownError";
      return { category: "dom-exception", code: codeForName(name), name };
    }
    if (thrown instanceof Error) {
      return { category: "javascript-error", code: "unknown", name: "Error" };
    }
  } catch {
    return { category: "unknown-thrown", code: "unknown" };
  }
  return { category: "unknown-thrown", code: "unknown" };
}

export function timeoutFailure(): SanitizedFailure {
  return { category: "timeout", code: "timeout" };
}

export function protocolFailure(): SanitizedFailure {
  return { category: "protocol-error", code: "protocol" };
}

export function workerFailure(): SanitizedFailure {
  return { category: "worker-error", code: "worker" };
}
