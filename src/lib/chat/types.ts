import type {
  ChatMessage,
  EffectiveWllamaBackend,
  ExecutionModelTarget,
  GenerationOptions,
  RuntimeId,
  WllamaSessionConfiguration,
} from "../runtimes/types";

export const chatSchemaVersion = 1 as const;

export type WllamaConversationSession = WllamaSessionConfiguration;
export type ConversationModelTarget = ExecutionModelTarget;

export interface ConversationReplayTurn {
  readonly id: string;
  readonly user: ChatMessage;
  readonly assistant?: ChatMessage;
}

export interface ConversationReplaySeed {
  readonly sourceConversationId: string;
  readonly sourceTitle: string;
  readonly capturedAt: string;
  readonly systemPrompt: string;
  readonly turns: readonly ConversationReplayTurn[];
}

export interface ChatConversationRecord {
  readonly schemaVersion: typeof chatSchemaVersion;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runtimeId: RuntimeId;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly modelId?: string;
  readonly modelName: string;
  readonly modelTarget: ConversationModelTarget;
  readonly systemPrompt: string;
  readonly generation: GenerationOptions;
  readonly wllamaSession?: WllamaConversationSession;
  readonly effectiveWllamaBackend?: EffectiveWllamaBackend;
  readonly messages: readonly ChatMessage[];
  readonly replaySeed?: ConversationReplaySeed;
}

export interface ChatConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly runtimeId: RuntimeId;
  readonly modelName: string;
  readonly messageCount: number;
}

export interface ChatExportEnvelope {
  readonly format: "webai-chat";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly conversation: ChatConversationRecord;
}
