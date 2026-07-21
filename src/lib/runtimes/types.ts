import type { InstalledModelRecord, ModelFailure } from "../models/types";

export type RuntimeId = "wllama" | "prompt-api";

export interface RuntimeDescriptor {
  readonly id: RuntimeId;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly acquisitionOwnership: "app-file" | "browser-managed";
  readonly executionContext: "adapter-owned-library-worker" | "browser-managed-main-thread";
  readonly generationControls: {
    readonly systemPrompt: boolean;
    readonly temperature: boolean;
    readonly topP: boolean;
    readonly topK: boolean;
    readonly maxTokens: boolean;
    readonly repeatPenalty: boolean;
    readonly seed: boolean;
  };
  readonly contextCaching: {
    readonly supported: boolean;
    readonly kind: "runtime-prefix-kv" | "browser-managed-state" | "none";
    readonly explanation: string;
  };
  readonly tokenizerInspection: {
    readonly kind: "sampled-output" | "context-usage-only";
    readonly explanation: string;
  };
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

export type ExecutionModelTarget =
  | {
      readonly kind: "artifact-set";
      readonly modelId: string;
      readonly displayName: string;
      readonly files: readonly {
        readonly displayName: string;
        readonly size: number;
        readonly sha256: string;
      }[];
      readonly source:
        | { readonly kind: "hugging-face"; readonly repo: string; readonly commit: string }
        | { readonly kind: "local-import"; readonly sha256: readonly string[] };
    }
  | { readonly kind: "unresolved"; readonly runtimeId: RuntimeId; readonly displayName: string }
  | {
      readonly kind: "browser-managed";
      readonly runtimeId: "prompt-api";
      readonly model: "gemini-nano";
    };

export interface WllamaSessionConfiguration {
  readonly threads: number;
  readonly gpuMode: "full" | "partial" | "off";
  readonly gpuLayers: number;
  readonly contextSize: number;
}

export interface ExecutionProvenance {
  readonly runtimeId: RuntimeId;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly modelTarget: ExecutionModelTarget;
  readonly systemPrompt: string;
  readonly wllamaSession?: WllamaSessionConfiguration;
  readonly effectiveWllamaBackend?: EffectiveWllamaBackend;
}

export interface ChatMessage {
  readonly id: string;
  readonly runtimeId: RuntimeId;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly replaySourceTurnId?: string;
  readonly channels?: readonly ResponseChannel[];
  readonly metrics?: ResponseMetrics;
  readonly outputDiagnostics?: ModelOutputDiagnostics;
  readonly tokenization?: TokenizationInspection;
  readonly request?: GenerationOptions;
  readonly controlOutcomes?: readonly GenerationControlOutcome[];
  readonly failure?: ModelFailure;
  readonly warnings?: readonly RuntimeWarning[];
  readonly execution?: ExecutionProvenance;
}

export interface RuntimeWarning {
  readonly code: "context-overflow" | "output-normalized" | "output-truncated";
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
  readonly cachedPromptTokens?: number;
  readonly evaluatedPromptTokens?: number;
  readonly prefillTokensPerSecond?: number;
  readonly decodeTokensPerSecond?: number;
  readonly totalTimeMs: number;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
}

export interface TokenizationToken {
  readonly id: number;
  readonly text: string;
}

export interface TokenizationInspection {
  readonly method: "wllama-sampled-logprobs";
  readonly tokens: readonly TokenizationToken[];
  readonly omittedTokens: number;
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
  | { readonly type: "tokenization"; readonly tokenization: TokenizationInspection }
  | { readonly type: "warning"; readonly warning: RuntimeWarning }
  | { readonly type: "metrics"; readonly metrics: ResponseMetrics };

export interface GenerationOptions {
  /**
   * Ask a model-owned chat template to enable or disable thinking. Omitted means
   * the runtime's default; adapters must not imply support when they cannot pass it.
   */
  readonly thinking?: boolean;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly maxTokens?: number;
  readonly repeatPenalty?: number;
  readonly seed?: number;
}

export interface GenerationControlOutcome {
  readonly control: keyof GenerationOptions;
  readonly requested: boolean | number;
  readonly effective?: boolean | number;
  readonly status: "honored" | "requested-not-verifiable" | "unsupported";
  readonly explanation: string;
}

export interface RuntimeMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface RuntimeAdapter {
  readonly descriptor: RuntimeDescriptor;
  generate(
    messages: readonly RuntimeMessage[],
    options: GenerationOptions,
    signal: AbortSignal,
    onEvent: (event: GenerationEvent) => void,
  ): Promise<void>;
  dispose(): Promise<void>;
}
