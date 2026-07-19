import type { InstalledModelRecord, ModelFailure } from "../models/types";

export interface RuntimeDescriptor {
  readonly id: "wllama";
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly executionContext: "adapter-owned-library-worker";
  readonly mtp: {
    readonly verdict: "unsupported";
    readonly reasonCode: "companion-mount-not-exposed";
    readonly explanation: string;
  };
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
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly channels?: readonly ResponseChannel[];
  readonly metrics?: ResponseMetrics;
  readonly outputDiagnostics?: ModelOutputDiagnostics;
  readonly failure?: ModelFailure;
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
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly prefillTokensPerSecond?: number;
  readonly decodeTokensPerSecond?: number;
  readonly totalTimeMs: number;
}

export interface RuntimeSession {
  readonly model: InstalledModelRecord;
  readonly backend: EffectiveWllamaBackend;
  readonly loadTimeMs: number;
}

export type RuntimeLoadEvent =
  | {
      readonly phase: "opening-files";
      readonly completedFiles: number;
      readonly totalFiles: number;
    }
  | { readonly phase: "loading-assets" }
  | { readonly phase: "loading-model" };

export type GenerationEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "channels"; readonly channels: readonly ResponseChannel[] }
  | { readonly type: "output-diagnostics"; readonly diagnostics: ModelOutputDiagnostics }
  | { readonly type: "metrics"; readonly metrics: ResponseMetrics };
