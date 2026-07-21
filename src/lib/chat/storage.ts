import { openModelDatabase } from "../models/storage";
import type { ModelFailure, ModelFailureCode } from "../models/types";
import { maximumDeclaredContextTokens } from "../models/types";
import type {
  ChatMessage,
  ExecutionProvenance,
  GenerationControlOutcome,
  GenerationOptions,
  ModelOutputDiagnostics,
  ResponseChannel,
  ResponseMetrics,
  RuntimeId,
  RuntimeWarning,
  TokenizationInspection,
} from "../runtimes/types";
import {
  type ChatConversationRecord,
  type ChatConversationSummary,
  type ChatExportEnvelope,
  type ConversationModelTarget,
  type ConversationReplaySeed,
  chatSchemaVersion,
  type WllamaConversationSession,
} from "./types";

export const maximumChatImportBytes = 8 * 1024 * 1024;
export interface ConversationListResult {
  readonly conversations: readonly ChatConversationSummary[];
  readonly skippedRecords: number;
}
const maximumConversations = 256;
const maximumMessages = 4_096;
export const maximumReplayTurns = 2_048;
export const maximumChatMessageCharacters = 256 * 1024;
const maximumSystemPromptCharacters = 64 * 1024;
const maximumTitleCharacters = 200;
const maximumChannels = 64;
const maximumTokens = 512;
const maximumWarnings = 64;
const maximumStringCharacters = 4_096;
const markdownMarker = "webai-chat-v1";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\u0000"))
    throw new Error(`${label} is missing or exceeds WebAI's import bounds.`);
  return value;
}

function runtimeId(value: unknown): RuntimeId {
  if (value === "wllama" || value === "prompt-api") return value;
  throw new Error("The conversation has an unsupported runtime identifier.");
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a finite non-negative number.`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
}

function parseGeneration(value: unknown): GenerationOptions {
  const input = object(value);
  if (input === undefined) throw new Error("The conversation generation settings are invalid.");
  const number = (key: keyof GenerationOptions): number | undefined => {
    const candidate = input[key];
    return candidate === undefined ? undefined : finiteNumber(candidate, `Generation ${key}`);
  };
  const thinking = input.thinking;
  if (thinking !== undefined && typeof thinking !== "boolean")
    throw new Error("The conversation thinking setting is invalid.");
  const temperature = number("temperature");
  const topP = number("topP");
  const topK = number("topK");
  const maxTokens = number("maxTokens");
  const repeatPenalty = number("repeatPenalty");
  const seed = number("seed");
  if (
    (temperature !== undefined && temperature > 2) ||
    (topP !== undefined && topP > 1) ||
    (topK !== undefined && (!Number.isSafeInteger(topK) || topK > 10_000)) ||
    (maxTokens !== undefined &&
      (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_048_576)) ||
    (repeatPenalty !== undefined && repeatPenalty > 2) ||
    (seed !== undefined && (!Number.isSafeInteger(seed) || seed > 4_294_967_294))
  )
    throw new Error("One or more saved generation settings exceed WebAI's bounds.");
  const result: GenerationOptions = {
    ...(thinking === undefined ? {} : { thinking }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(topK === undefined ? {} : { topK }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(repeatPenalty === undefined ? {} : { repeatPenalty }),
    ...(seed === undefined ? {} : { seed }),
  };
  return result;
}

function parseMetrics(value: unknown): ResponseMetrics | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (input === undefined) throw new Error("A response metric record is invalid.");
  return {
    loadTimeMs: finiteNumber(input.loadTimeMs, "Load time"),
    totalTimeMs: finiteNumber(input.totalTimeMs, "Total time"),
    ...Object.fromEntries(
      [
        "timeToFirstTokenMs",
        "timeToFirstOutputMs",
        "promptTokens",
        "completionTokens",
        "cachedPromptTokens",
        "evaluatedPromptTokens",
        "prefillTokensPerSecond",
        "decodeTokensPerSecond",
        "contextUsage",
        "contextWindow",
      ].flatMap((key) => {
        const parsed = optionalNumber(input[key], key);
        return parsed === undefined ? [] : [[key, parsed]];
      }),
    ),
  };
}

function parseChannels(value: unknown): readonly ResponseChannel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumChannels)
    throw new Error("A response channel list exceeds WebAI's import bounds.");
  return value.map((entry) => {
    const input = object(entry);
    if (
      input === undefined ||
      typeof input.complete !== "boolean" ||
      typeof input.final !== "boolean"
    )
      throw new Error("A response channel is invalid.");
    return {
      id: boundedString(input.id, 200, "Channel ID"),
      name: boundedString(input.name, 200, "Channel name"),
      content: boundedString(input.content, maximumChatMessageCharacters, "Channel content"),
      complete: input.complete,
      final: input.final,
    };
  });
}

function parseWarnings(value: unknown): readonly RuntimeWarning[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumWarnings)
    throw new Error("A response warning list exceeds WebAI's import bounds.");
  return value.map((entry) => {
    const input = object(entry);
    if (
      input?.code !== "context-overflow" &&
      input?.code !== "output-normalized" &&
      input?.code !== "output-truncated"
    )
      throw new Error("A response warning is invalid.");
    return {
      code: input.code,
      message: boundedString(input.message, maximumStringCharacters, "Warning message"),
    };
  });
}

function parseTokenization(value: unknown): TokenizationInspection | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (
    input?.method !== "wllama-sampled-logprobs" ||
    !Array.isArray(input.tokens) ||
    input.tokens.length > maximumTokens
  )
    throw new Error("A tokenizer inspection is invalid or too large.");
  return {
    method: input.method,
    tokens: input.tokens.map((entry) => {
      const token = object(entry);
      if (token === undefined || !Number.isSafeInteger(token.id) || (token.id as number) < 0)
        throw new Error("A tokenizer inspection token is invalid.");
      return {
        id: token.id as number,
        text: boundedString(token.text, 256, "Tokenizer piece"),
      };
    }),
    omittedTokens: finiteNumber(input.omittedTokens, "Omitted tokenizer pieces"),
  };
}

function parseControlOutcomes(value: unknown): readonly GenerationControlOutcome[] | undefined {
  if (value === undefined) return undefined;
  const controls = new Set<keyof GenerationOptions>([
    "thinking",
    "temperature",
    "topP",
    "topK",
    "maxTokens",
    "repeatPenalty",
    "seed",
  ]);
  const statuses = new Set<GenerationControlOutcome["status"]>([
    "honored",
    "requested-not-verifiable",
    "unsupported",
  ]);
  if (!Array.isArray(value) || value.length > controls.size)
    throw new Error("A generation-control result list is invalid.");
  const seen = new Set<string>();
  return value.map((entry) => {
    const input = object(entry);
    const control = input?.control as keyof GenerationOptions;
    const status = input?.status as GenerationControlOutcome["status"];
    if (
      input === undefined ||
      !controls.has(control) ||
      seen.has(control) ||
      !statuses.has(status) ||
      (typeof input.requested !== "number" && typeof input.requested !== "boolean") ||
      (input.effective !== undefined &&
        typeof input.effective !== "number" &&
        typeof input.effective !== "boolean")
    )
      throw new Error("A generation-control result is invalid.");
    if (
      (typeof input.requested === "number" && !Number.isFinite(input.requested)) ||
      (typeof input.effective === "number" && !Number.isFinite(input.effective))
    )
      throw new Error("A generation-control result contains a non-finite value.");
    seen.add(control);
    return {
      control,
      requested: input.requested,
      ...(input.effective === undefined ? {} : { effective: input.effective }),
      status,
      explanation: boundedString(input.explanation, maximumStringCharacters, "Control explanation"),
    };
  });
}

function parseDiagnostics(value: unknown): ModelOutputDiagnostics | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (
    input === undefined ||
    !Array.isArray(input.unrecognizedSpecialTokens) ||
    input.unrecognizedSpecialTokens.length > 32
  )
    throw new Error("A model-output diagnostic is invalid or too large.");
  return {
    unrecognizedSpecialTokens: input.unrecognizedSpecialTokens.map((entry) => {
      const token = object(entry);
      if (
        token === undefined ||
        !Number.isSafeInteger(token.id) ||
        !Number.isSafeInteger(token.type) ||
        !Number.isSafeInteger(token.occurrences)
      )
        throw new Error("A model-output diagnostic token is invalid.");
      return {
        id: token.id as number,
        text: boundedString(token.text, 256, "Diagnostic token"),
        type: token.type as number,
        typeName: boundedString(token.typeName, 100, "Diagnostic token type"),
        occurrences: token.occurrences as number,
      };
    }),
    omittedOccurrences: finiteNumber(input.omittedOccurrences, "Omitted diagnostics"),
  };
}

function parseMessage(value: unknown, ids: Set<string>): ChatMessage {
  const input = object(value);
  if (input === undefined || (input.role !== "user" && input.role !== "assistant"))
    throw new Error("A conversation message has an unsupported role.");
  const id = boundedString(input.id, 200, "Message ID");
  if (ids.has(id)) throw new Error("Conversation message IDs must be unique.");
  ids.add(id);
  const messageRuntime = runtimeId(input.runtimeId);
  const failure = object(input.failure);
  const failureCodes = new Set<ModelFailureCode>([
    "input-invalid",
    "metadata-invalid",
    "network",
    "range-invalid",
    "integrity-mismatch",
    "storage",
    "quota",
    "gguf-invalid",
    "aborted",
    "protocol",
    "unsupported",
  ]);
  const failurePhases = new Set<ModelFailure["phase"]>([
    "resolve",
    "download",
    "verify",
    "import",
    "inspect",
    "split",
    "load",
    "generate",
    "storage",
  ]);
  const parsedFailure: ModelFailure | undefined =
    failure === undefined
      ? undefined
      : (() => {
          const code = boundedString(failure.code, 100, "Failure code") as ModelFailureCode;
          const phase = boundedString(failure.phase, 100, "Failure phase") as ModelFailure["phase"];
          if (
            !failureCodes.has(code) ||
            !failurePhases.has(phase) ||
            typeof failure.retryable !== "boolean"
          )
            throw new Error("A response failure is invalid.");
          return {
            code,
            phase,
            message: boundedString(failure.message, maximumStringCharacters, "Failure message"),
            retryable: failure.retryable,
          };
        })();
  const channels = parseChannels(input.channels);
  const metrics = parseMetrics(input.metrics);
  const diagnostics = parseDiagnostics(input.outputDiagnostics);
  const tokenization = parseTokenization(input.tokenization);
  const warnings = parseWarnings(input.warnings);
  const controlOutcomes = parseControlOutcomes(input.controlOutcomes);
  const execution = parseExecution(input.execution, messageRuntime);
  const replaySourceTurnId =
    input.replaySourceTurnId === undefined
      ? undefined
      : boundedString(input.replaySourceTurnId, 200, "Replay source turn ID");
  return {
    id,
    runtimeId: messageRuntime,
    role: input.role,
    content: boundedString(input.content, maximumChatMessageCharacters, "Message content"),
    ...(replaySourceTurnId === undefined ? {} : { replaySourceTurnId }),
    ...(channels === undefined ? {} : { channels }),
    ...(metrics === undefined ? {} : { metrics }),
    ...(diagnostics === undefined ? {} : { outputDiagnostics: diagnostics }),
    ...(tokenization === undefined ? {} : { tokenization }),
    ...(controlOutcomes === undefined ? {} : { controlOutcomes }),
    ...(input.request === undefined ? {} : { request: parseGeneration(input.request) }),
    ...(parsedFailure === undefined ? {} : { failure: parsedFailure }),
    ...(warnings === undefined ? {} : { warnings }),
    ...(execution === undefined ? {} : { execution }),
  };
}

function parseReplaySeed(value: unknown): ConversationReplaySeed | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (input === undefined || !Array.isArray(input.turns) || input.turns.length > maximumReplayTurns)
    throw new Error("The conversation replay seed is invalid or too large.");
  const turnIds = new Set<string>();
  const messageIds = new Set<string>();
  const turns = input.turns.map((entry) => {
    const turn = object(entry);
    if (turn === undefined) throw new Error("A replay seed turn is invalid.");
    const id = boundedString(turn.id, 200, "Replay seed turn ID");
    if (turnIds.has(id)) throw new Error("Replay seed turn IDs must be unique.");
    turnIds.add(id);
    const user = parseMessage(turn.user, messageIds);
    const assistant =
      turn.assistant === undefined ? undefined : parseMessage(turn.assistant, messageIds);
    if (
      user.role !== "user" ||
      assistant?.role === "user" ||
      user.replaySourceTurnId !== undefined ||
      assistant?.replaySourceTurnId !== undefined
    )
      throw new Error("A replay seed turn has invalid message roles or nested replay data.");
    return { id, user, ...(assistant === undefined ? {} : { assistant }) };
  });
  return {
    sourceConversationId: boundedString(
      input.sourceConversationId,
      200,
      "Replay source conversation ID",
    ),
    sourceTitle: boundedString(input.sourceTitle, maximumTitleCharacters, "Replay source title"),
    capturedAt: boundedString(input.capturedAt, 100, "Replay capture timestamp"),
    systemPrompt: boundedString(
      input.systemPrompt,
      maximumSystemPromptCharacters,
      "Replay source system prompt",
    ),
    turns,
  };
}

function parseWllamaSession(value: unknown): WllamaConversationSession | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (
    input === undefined ||
    (input.gpuMode !== "full" && input.gpuMode !== "partial" && input.gpuMode !== "off")
  )
    throw new Error("The saved wllama session configuration is invalid.");
  if (
    !Number.isSafeInteger(input.threads) ||
    (input.threads as number) < 1 ||
    (input.threads as number) > 1_024 ||
    !Number.isSafeInteger(input.gpuLayers) ||
    (input.gpuLayers as number) < 0 ||
    (input.gpuLayers as number) > 10_000 ||
    !Number.isSafeInteger(input.contextSize) ||
    (input.contextSize as number) < 256 ||
    (input.contextSize as number) > maximumDeclaredContextTokens
  )
    throw new Error("The saved wllama session configuration is invalid.");
  return {
    threads: input.threads as number,
    gpuMode: input.gpuMode,
    gpuLayers: input.gpuLayers as number,
    contextSize: input.contextSize as number,
  };
}

function parseModelTarget(value: unknown): ConversationModelTarget {
  const input = object(value);
  if (input?.kind === "unresolved")
    return {
      kind: "unresolved",
      runtimeId: runtimeId(input.runtimeId),
      displayName: boundedString(input.displayName, 500, "Unresolved target name"),
    };
  if (
    input?.kind === "browser-managed" &&
    input.runtimeId === "prompt-api" &&
    input.model === "gemini-nano"
  )
    return { kind: "browser-managed", runtimeId: "prompt-api", model: "gemini-nano" };
  if (
    input?.kind !== "artifact-set" ||
    !Array.isArray(input.files) ||
    input.files.length === 0 ||
    input.files.length > 256
  )
    throw new Error("The conversation model-target identity is invalid.");
  const source = object(input.source);
  let parsedSource: Extract<ConversationModelTarget, { kind: "artifact-set" }>["source"];
  if (source?.kind === "hugging-face") {
    const commit = boundedString(source.commit, 64, "Model commit");
    if (!/^[a-f0-9]{40}$/u.test(commit))
      throw new Error("The conversation model commit is invalid.");
    parsedSource = {
      kind: "hugging-face",
      repo: boundedString(source.repo, 500, "Model repository"),
      commit,
    };
  } else if (
    source?.kind === "local-import" &&
    Array.isArray(source.sha256) &&
    source.sha256.length > 0 &&
    source.sha256.length <= 256
  ) {
    const sha256 = source.sha256.map((digest) => boundedString(digest, 64, "Model digest"));
    if (sha256.some((digest) => !/^[a-f0-9]{64}$/u.test(digest)))
      throw new Error("The conversation model digest is invalid.");
    parsedSource = {
      kind: "local-import",
      sha256,
    };
  } else throw new Error("The conversation model provenance is invalid.");
  return {
    kind: "artifact-set",
    modelId: boundedString(input.modelId, 500, "Target model ID"),
    displayName: boundedString(input.displayName, 500, "Target model name"),
    files: input.files.map((entry) => {
      const file = object(entry);
      if (file === undefined) throw new Error("A target model file identity is invalid.");
      const sha256 = boundedString(file.sha256, 64, "Target file digest");
      if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("A target file digest is invalid.");
      const size = finiteNumber(file.size, "Target file size");
      if (!Number.isSafeInteger(size)) throw new Error("A target model file size is invalid.");
      return {
        displayName: boundedString(file.displayName, 500, "Target file name"),
        size,
        sha256,
      };
    }),
    source: parsedSource,
  };
}

function parseEffectiveWllamaBackend(value: unknown) {
  if (value === undefined) return undefined;
  const input = object(value);
  if (
    input === undefined ||
    (input.build !== "default" && input.build !== "compat") ||
    typeof input.webgpuRequested !== "boolean" ||
    typeof input.webgpuAvailable !== "boolean"
  )
    throw new Error("The effective wllama backend record is invalid.");
  if (
    !Number.isSafeInteger(input.threads) ||
    (input.threads as number) < 1 ||
    (input.threads as number) > 1_024 ||
    !Number.isSafeInteger(input.gpuLayers) ||
    (input.gpuLayers as number) < 0 ||
    (input.gpuLayers as number) > 10_000 ||
    !Number.isSafeInteger(input.contextSize) ||
    (input.contextSize as number) < 256 ||
    (input.contextSize as number) > maximumDeclaredContextTokens
  )
    throw new Error("The effective wllama backend record is invalid.");
  const build: "default" | "compat" = input.build;
  return {
    threads: input.threads as number,
    gpuLayers: input.gpuLayers as number,
    contextSize: input.contextSize as number,
    build,
    webgpuRequested: input.webgpuRequested,
    webgpuAvailable: input.webgpuAvailable,
  };
}

function parseExecution(
  value: unknown,
  messageRuntime: RuntimeId,
): ExecutionProvenance | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (input === undefined) throw new Error("A response execution record is invalid.");
  const executionRuntime = runtimeId(input.runtimeId);
  const modelTarget = parseModelTarget(input.modelTarget);
  const wllamaSession = parseWllamaSession(input.wllamaSession);
  const effectiveWllamaBackend = parseEffectiveWllamaBackend(input.effectiveWllamaBackend);
  if (
    executionRuntime !== messageRuntime ||
    (executionRuntime === "prompt-api" &&
      (modelTarget.kind !== "browser-managed" ||
        wllamaSession !== undefined ||
        effectiveWllamaBackend !== undefined)) ||
    (executionRuntime === "wllama" && modelTarget.kind === "browser-managed")
  )
    throw new Error("A response execution record does not match its runtime.");
  return {
    runtimeId: executionRuntime,
    adapterVersion: boundedString(input.adapterVersion, 100, "Execution adapter version"),
    engineVersion: boundedString(input.engineVersion, 500, "Execution engine version"),
    modelTarget,
    systemPrompt: boundedString(
      input.systemPrompt,
      maximumSystemPromptCharacters,
      "Execution system prompt",
    ),
    ...(wllamaSession === undefined ? {} : { wllamaSession }),
    ...(effectiveWllamaBackend === undefined ? {} : { effectiveWllamaBackend }),
  };
}

export function parseConversation(value: unknown): ChatConversationRecord {
  const input = object(value);
  if (input?.schemaVersion !== chatSchemaVersion)
    throw new Error("This conversation uses an unsupported WebAI chat schema version.");
  if (!Array.isArray(input.messages) || input.messages.length > maximumMessages)
    throw new Error("The conversation has too many messages.");
  const ids = new Set<string>();
  const parsedRuntime = runtimeId(input.runtimeId);
  const modelId = input.modelId;
  if (modelId !== undefined && typeof modelId !== "string")
    throw new Error("The conversation model identifier is invalid.");
  const wllamaSession = parseWllamaSession(input.wllamaSession);
  const effectiveWllamaBackend = parseEffectiveWllamaBackend(input.effectiveWllamaBackend);
  const modelTarget = parseModelTarget(input.modelTarget);
  if (
    (parsedRuntime === "prompt-api" && modelTarget.kind !== "browser-managed") ||
    (parsedRuntime === "wllama" && modelTarget.kind === "browser-managed")
  )
    throw new Error("The conversation runtime and model target do not match.");
  const messages = input.messages.map((message) => parseMessage(message, ids));
  const replaySeed = parseReplaySeed(input.replaySeed);
  const replayTurns = new Map(replaySeed?.turns.map((turn) => [turn.id, turn]) ?? []);
  const referencedRoles = new Set<string>();
  for (const [index, message] of messages.entries()) {
    const turnId = message.replaySourceTurnId;
    if (turnId === undefined) continue;
    const replayTurn = replayTurns.get(turnId);
    if (replayTurn === undefined)
      throw new Error("A replayed message refers to a missing source turn.");
    const roleKey = `${turnId}:${message.role}`;
    if (referencedRoles.has(roleKey))
      throw new Error("A replay source turn may have only one active user and assistant message.");
    referencedRoles.add(roleKey);
    if (
      message.role === "assistant" &&
      (messages[index - 1]?.role !== "user" || messages[index - 1]?.replaySourceTurnId !== turnId)
    )
      throw new Error("A replayed assistant response must follow its replayed user prompt.");
    if (
      message.role === "user" &&
      (messages[index + 1]?.role !== "assistant" ||
        messages[index + 1]?.replaySourceTurnId !== turnId)
    )
      throw new Error("A replayed user prompt must be followed by its associated response.");
  }
  return {
    schemaVersion: chatSchemaVersion,
    id: boundedString(input.id, 200, "Conversation ID"),
    title: boundedString(input.title, maximumTitleCharacters, "Conversation title"),
    createdAt: boundedString(input.createdAt, 100, "Creation timestamp"),
    updatedAt: boundedString(input.updatedAt, 100, "Update timestamp"),
    runtimeId: parsedRuntime,
    adapterVersion: boundedString(input.adapterVersion, 100, "Runtime adapter version"),
    engineVersion: boundedString(input.engineVersion, 500, "Runtime engine version"),
    ...(modelId === undefined ? {} : { modelId: boundedString(modelId, 500, "Model ID") }),
    modelName: boundedString(input.modelName, 500, "Model name"),
    modelTarget,
    systemPrompt: boundedString(input.systemPrompt, maximumSystemPromptCharacters, "System prompt"),
    generation: parseGeneration(input.generation),
    ...(wllamaSession === undefined ? {} : { wllamaSession }),
    ...(effectiveWllamaBackend === undefined ? {} : { effectiveWllamaBackend }),
    messages,
    ...(replaySeed === undefined ? {} : { replaySeed }),
  };
}

function parseSummary(value: unknown): ChatConversationSummary {
  const input = object(value);
  if (
    input === undefined ||
    input.schemaVersion !== chatSchemaVersion ||
    !Array.isArray(input.messages) ||
    input.messages.length > maximumMessages
  )
    throw new Error("A saved conversation summary is invalid.");
  return {
    id: boundedString(input.id, 200, "Conversation ID"),
    title: boundedString(input.title, maximumTitleCharacters, "Conversation title"),
    updatedAt: boundedString(input.updatedAt, 100, "Update timestamp"),
    runtimeId: runtimeId(input.runtimeId),
    modelName: boundedString(input.modelName, 500, "Model name"),
    messageCount: input.messages.length,
  };
}

export async function listConversations(): Promise<ConversationListResult> {
  const database = await openModelDatabase();
  const transaction = database.transaction("chats", "readonly");
  const done = transactionDone(transaction);
  const summaries: ChatConversationSummary[] = [];
  let inspectedRecords = 0;
  let skippedRecords = 0;
  const cursorRequest = transaction.objectStore("chats").openCursor();
  try {
    await new Promise<void>((resolve, reject) => {
      cursorRequest.addEventListener("error", () => reject(cursorRequest.error), { once: true });
      cursorRequest.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (cursor === null) {
          resolve();
          return;
        }
        if (inspectedRecords >= maximumConversations) {
          ++skippedRecords;
          resolve();
          return;
        }
        ++inspectedRecords;
        try {
          summaries.push(parseSummary(cursor.value));
        } catch {
          ++skippedRecords;
        }
        cursor.continue();
      });
    });
    await done;
  } catch (failure) {
    await done.catch(() => undefined);
    throw failure;
  }
  return {
    conversations: summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    skippedRecords,
  };
}

export async function getConversation(id: string): Promise<ChatConversationRecord | undefined> {
  const database = await openModelDatabase();
  const transaction = database.transaction("chats", "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore("chats").get(id));
  await done;
  return value === undefined ? undefined : parseConversation(value);
}

export async function putConversation(record: ChatConversationRecord): Promise<void> {
  const parsed = parseConversation(record);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maximumChatImportBytes)
    throw new Error("The conversation exceeds WebAI's 8 MiB storage limit.");
  const database = await openModelDatabase();
  const transaction = database.transaction("chats", "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore("chats");
  const [count, existing] = await Promise.all([
    requestResult(store.count()),
    requestResult(store.get(parsed.id)),
  ]);
  if (count >= maximumConversations && existing === undefined) {
    transaction.abort();
    await done.catch(() => undefined);
    throw new Error(`WebAI keeps at most ${maximumConversations} conversations. Delete one first.`);
  }
  store.put(parsed);
  await done;
}

export async function deleteConversation(id: string): Promise<void> {
  const database = await openModelDatabase();
  const transaction = database.transaction("chats", "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("chats").delete(id);
  await done;
}

export function exportConversationJson(record: ChatConversationRecord): string {
  const envelope: ChatExportEnvelope = {
    format: "webai-chat",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    conversation: parseConversation(record),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function exportConversationMarkdown(record: ChatConversationRecord): string {
  const parsed = parseConversation(record);
  const json = exportConversationJson(parsed).trimEnd();
  const transcript = parsed.messages
    .map((message) => `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.content}`)
    .join("\n\n");
  return `# ${parsed.title}\n\n> WebAI conversation export. The fenced payload is the canonical, importable record.\n\n\`\`\`${markdownMarker}\n${json}\n\`\`\`\n\n${transcript}\n`;
}

export function importConversationText(text: string): ChatConversationRecord {
  if (new TextEncoder().encode(text).byteLength > maximumChatImportBytes)
    throw new Error("The conversation file exceeds WebAI's 8 MiB import limit.");
  let payload = text.trim();
  if (!payload.startsWith("{")) {
    const match = payload.match(
      new RegExp(
        `(?:^|\\r?\\n)\`\`\`${markdownMarker}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`(?:\\r?\\n|$)`,
        "u",
      ),
    );
    if (match?.[1] === undefined)
      throw new Error("Markdown imports must contain a WebAI chat payload.");
    payload = match[1];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("The conversation file is not valid JSON.");
  }
  const envelope = object(decoded);
  if (envelope?.format !== "webai-chat" || envelope.formatVersion !== 1)
    throw new Error("The file is not a supported WebAI chat export.");
  const imported = parseConversation(envelope.conversation);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const replayTurnIds = new Map<string, string>();
  const replaySeed =
    imported.replaySeed === undefined
      ? undefined
      : {
          ...imported.replaySeed,
          turns: imported.replaySeed.turns.map((turn) => {
            const nextTurnId = `replay-turn-${crypto.randomUUID()}`;
            replayTurnIds.set(turn.id, nextTurnId);
            return {
              ...turn,
              id: nextTurnId,
              user: { ...turn.user, id: `user-${crypto.randomUUID()}` },
              ...(turn.assistant === undefined
                ? {}
                : {
                    assistant: {
                      ...turn.assistant,
                      id: `assistant-${crypto.randomUUID()}`,
                    },
                  }),
            };
          }),
        };
  return {
    ...imported,
    id: `chat-${id}`,
    title: `${imported.title} (imported)`.slice(0, maximumTitleCharacters),
    createdAt: now,
    updatedAt: now,
    messages: imported.messages.map((message) => {
      const nextId = `${message.role}-${crypto.randomUUID()}`;
      const replaySourceTurnId =
        message.replaySourceTurnId === undefined
          ? undefined
          : replayTurnIds.get(message.replaySourceTurnId);
      if (message.replaySourceTurnId !== undefined && replaySourceTurnId === undefined)
        throw new Error("The imported replay association is invalid.");
      return {
        ...message,
        id: nextId,
        ...(replaySourceTurnId === undefined ? {} : { replaySourceTurnId }),
      };
    }),
    ...(replaySeed === undefined ? {} : { replaySeed }),
  };
}
