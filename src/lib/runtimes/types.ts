import type { InstalledModelRecord, ModelFailure } from "../models/types";

export type RuntimeId = "wllama" | "prompt-api";

export interface RuntimeDescriptor {
  readonly id: RuntimeId;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly acquisitionOwnership: "app-file" | "browser-managed";
  readonly executionContext: "adapter-owned-library-worker" | "browser-managed-main-thread";
}

export interface WllamaRuntimeDescriptor extends RuntimeDescriptor {
  readonly id: "wllama";
  readonly acquisitionOwnership: "app-file";
  readonly executionContext: "adapter-owned-library-worker";
  readonly mtp: {
    readonly verdict: "unsupported";
    readonly reasonCode: "companion-mount-not-exposed";
    readonly explanation: string;
  };
}

export interface PromptApiRuntimeDescriptor extends RuntimeDescriptor {
  readonly id: "prompt-api";
  readonly acquisitionOwnership: "browser-managed";
  readonly executionContext: "browser-managed-main-thread";
}

export interface WllamaBackend {
  readonly threads: number;
  readonly gpuLayers: number;
  readonly contextSize: number;
}

export interface EffectiveWllamaBackend extends WllamaBackend {
  readonly build: "default" | "compat";
  readonly webgpuRequested: boolean;
  readonly webgpuAvailable: boolean;
}

export interface ChatMessage {
  readonly id: string;
  readonly runtimeId: RuntimeId;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly channels?: readonly ResponseChannel[];
  readonly metrics?: ResponseMetrics;
  readonly outputDiagnostics?: ModelOutputDiagnostics;
  readonly failure?: ModelFailure;
  readonly warnings?: readonly RuntimeWarning[];
}

export interface RuntimeWarning {
  readonly code: "context-overflow";
  readonly message: string;
}

export interface UnrecognizedSpecialToken {
  readonly id: number;
  readonly text: string;
  readonly type: number;
  readonly typeName: string;
  readonly occurrences: number;
}

export interface ModelOutputDiagnostics {
  readonly unrecognizedSpecialTokens: readonly UnrecognizedSpecialToken[];
  readonly omittedOccurrences: number;
}

export interface ResponseChannel {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly complete: boolean;
  readonly final: boolean;
}

export interface ResponseMetrics {
  readonly loadTimeMs: number;
  readonly timeToFirstTokenMs?: number;
  readonly timeToFirstOutputMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly prefillTokensPerSecond?: number;
  readonly decodeTokensPerSecond?: number;
  readonly totalTimeMs: number;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
}

export interface WllamaRuntimeSession {
  readonly runtimeId: "wllama";
  readonly modelTarget: ArtifactSetModelTarget;
  readonly backend: EffectiveWllamaBackend;
  readonly loadTimeMs: number;
}

export interface PromptApiRuntimeSession {
  readonly runtimeId: "prompt-api";
  readonly modelTarget: BrowserManagedModelTarget;
  readonly contextWindow: number;
  readonly contextUsage: number;
  readonly loadTimeMs: number;
}

export type RuntimeSession = WllamaRuntimeSession | PromptApiRuntimeSession;

export interface ArtifactSetModelTarget {
  readonly kind: "artifact-set";
  readonly model: InstalledModelRecord;
}

export interface BrowserManagedModelTarget {
  readonly kind: "browser-managed";
  readonly runtimeId: "prompt-api";
  readonly model: "gemini-nano";
}

export type ModelTarget = ArtifactSetModelTarget | BrowserManagedModelTarget;

export type RuntimeLoadEvent =
  | {
      readonly phase: "opening-files";
      readonly completedFiles: number;
      readonly totalFiles: number;
    }
  | { readonly phase: "loading-assets" }
  | { readonly phase: "loading-model" }
  | {
      readonly phase: "browser-model-download";
      readonly loaded: number;
      readonly total: 1;
    }
  | { readonly phase: "browser-model-loading" };

export type GenerationEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "channels"; readonly channels: readonly ResponseChannel[] }
  | { readonly type: "output-diagnostics"; readonly diagnostics: ModelOutputDiagnostics }
  | { readonly type: "warning"; readonly warning: RuntimeWarning }
  | { readonly type: "metrics"; readonly metrics: ResponseMetrics };

export interface GenerationOptions {
  /**
   * Ask a model-owned chat template to enable or disable thinking. Omitted means
   * the runtime's default; adapters must not imply support when they cannot pass it.
   */
  readonly thinking?: boolean;
}

export interface RuntimeAdapter {
  readonly descriptor: RuntimeDescriptor;
  generate(
    messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
    options: GenerationOptions,
    signal: AbortSignal,
    onEvent: (event: GenerationEvent) => void,
  ): Promise<void>;
  dispose(): Promise<void>;
}
