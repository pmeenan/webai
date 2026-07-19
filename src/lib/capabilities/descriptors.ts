import type { CapabilityId, EvidenceContext, EvidenceStability } from "./evidence";

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly label: string;
  readonly explanation: string;
  readonly context: EvidenceContext;
  readonly stability: EvidenceStability;
  readonly probeVersion: number;
  readonly remediation?: string;
}

export const capabilityDescriptors = [
  {
    id: "environment.page.secure-context",
    label: "Secure context",
    explanation: "Whether this page is running in a trustworthy HTTPS or local context.",
    context: "page",
    stability: "stable-session",
    probeVersion: 1,
    remediation: "Open WebAI over HTTPS.",
  },
  {
    id: "environment.page.cross-origin-isolated",
    label: "Page isolation",
    explanation: "Runtime cross-origin isolation required by shared-memory wasm.",
    context: "page",
    stability: "stable-session",
    probeVersion: 1,
    remediation: "Serve every WebAI response with COOP same-origin and COEP require-corp.",
  },
  {
    id: "environment.worker.cross-origin-isolated",
    label: "Worker isolation",
    explanation: "Cross-origin isolation observed inside a dedicated worker.",
    context: "dedicated-worker",
    stability: "stable-session",
    probeVersion: 1,
  },
  {
    id: "shared-memory.page.constructor",
    label: "SharedArrayBuffer surface",
    explanation: "Whether the page can construct shared memory.",
    context: "page",
    stability: "stable-session",
    probeVersion: 1,
  },
  {
    id: "shared-memory.worker.round-trip",
    label: "Shared memory worker use",
    explanation: "A worker atomically changed a sentinel in page-created shared memory.",
    context: "dedicated-worker",
    stability: "stable-session",
    probeVersion: 1,
  },
  ...(["simd", "threads", "jspi", "memory64"] as const).map((feature) => ({
    id: `wasm.worker.${feature}` as const,
    label: `WebAssembly ${
      feature === "memory64"
        ? "Memory64"
        : feature === "simd" || feature === "jspi"
          ? feature.toUpperCase()
          : feature
    }`,
    explanation:
      feature === "memory64"
        ? "The Memory64 feature probe passed; this does not promise a model can allocate over 4 GiB."
        : `The pinned wasm-feature-detect ${feature} probe executed in a worker.`,
    context: "dedicated-worker" as const,
    stability: "stable-session" as const,
    probeVersion: 1,
  })),
  {
    id: "webgpu.page.api",
    label: "WebGPU surface",
    explanation: "Whether navigator.gpu is exposed on the page.",
    context: "page",
    stability: "stable-session",
    probeVersion: 1,
  },
  {
    id: "webgpu.worker",
    label: "WebGPU worker device",
    explanation: "Worker adapter, device, optional features, and selected compute limits.",
    context: "dedicated-worker",
    stability: "stable-session",
    probeVersion: 1,
  },
  {
    id: "webnn.page.api",
    label: "WebNN surface",
    explanation: "Whether the current navigator.ml entry point is exposed on the page.",
    context: "page",
    stability: "stable-session",
    probeVersion: 2,
  },
  {
    id: "webnn.worker.default-context",
    label: "WebNN default context",
    explanation:
      "A worker requested the current default context with accelerated inference preferred.",
    context: "dedicated-worker",
    stability: "stable-session",
    probeVersion: 2,
  },
  {
    id: "storage.page.api",
    label: "Storage API surface",
    explanation: "Origin storage methods exposed to this page.",
    context: "page",
    stability: "stable-session",
    probeVersion: 1,
  },
  {
    id: "opfs.worker.root-access",
    label: "OPFS worker access",
    explanation: "A worker opened the origin-private file-system root without writing.",
    context: "dedicated-worker",
    stability: "stable-session",
    probeVersion: 1,
  },
  {
    id: "storage.estimate",
    label: "Origin storage estimate",
    explanation:
      "Browser-estimated usage and quota for this origin, not WebAI-managed bytes or free disk.",
    context: "page",
    stability: "volatile",
    probeVersion: 1,
  },
  {
    id: "storage.persisted",
    label: "Persistent storage",
    explanation: "Whether this origin is currently protected from best-effort eviction.",
    context: "page",
    stability: "volatile",
    probeVersion: 1,
  },
  {
    id: "prompt-api.page.availability",
    label: "Prompt API · Gemini Nano",
    explanation:
      "The window-only LanguageModel API's current English text availability for this browser-managed model.",
    context: "page",
    stability: "volatile",
    probeVersion: 1,
  },
] as const satisfies readonly CapabilityDescriptor[];

export const descriptorById = new Map(
  capabilityDescriptors.map((descriptor) => [descriptor.id, descriptor]),
);
