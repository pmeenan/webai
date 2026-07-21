import {
  Bot,
  Brain,
  CircleCheck,
  CircleHelp,
  CircleX,
  Download,
  Gauge,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Send,
  Settings2,
  Square,
  Trash2,
  TriangleAlert,
  Upload,
  User,
} from "lucide-react";
import {
  type ChangeEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deleteConversation,
  exportConversationJson,
  exportConversationMarkdown,
  getConversation,
  importConversationText,
  listConversations,
  maximumChatImportBytes,
  maximumChatMessageCharacters,
  maximumReplayTurns,
  putConversation,
} from "../lib/chat/storage";
import {
  type ChatConversationRecord,
  type ChatConversationSummary,
  type ConversationModelTarget,
  type ConversationReplaySeed,
  type ConversationReplayTurn,
  chatSchemaVersion,
} from "../lib/chat/types";
import type { ModelWorkerEvent } from "../lib/models/protocol";
import {
  type InstalledModelRecord,
  type ModelFailure,
  type ModelInventory,
  ModelOperationError,
  maximumDeclaredContextTokens,
} from "../lib/models/types";
import { ModelWorkerClient } from "../lib/models/worker-client";
import { finalResponseText } from "../lib/runtimes/channel-parser";
import { RuntimeController, type SessionHandle } from "../lib/runtimes/controller";
import {
  type PromptApiProbe,
  PromptApiRuntimeAdapter,
  promptApiDescriptor,
} from "../lib/runtimes/prompt-api";
import type {
  ChatMessage,
  ExecutionProvenance,
  GenerationOptions,
  ModelOutputDiagnostics,
  ResponseChannel,
  ResponseMetrics,
  RuntimeDescriptor,
  RuntimeId,
  RuntimeLoadEvent,
  RuntimeSession,
} from "../lib/runtimes/types";
import {
  WllamaRuntimeAdapter,
  wllamaDescriptor,
  wllamaGenerationDefaults,
} from "../lib/runtimes/wllama";
import {
  wllamaModelCompatibility,
  wllamaModelContextLength,
} from "../lib/runtimes/wllama-compatibility";
import Button from "./ui/button";

function makeId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function failureMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "The runtime session could not complete this operation.";
}

function isAbortedFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "AbortError") return true;
  if ("code" in error && error.code === "aborted") return true;
  return (
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "code" in error.failure &&
    error.failure.code === "aborted"
  );
}

function generationFailure(error: unknown, aborted: boolean): ModelFailure {
  if (aborted) {
    return {
      code: "aborted",
      phase: "generate",
      message: "Generation was stopped.",
      retryable: true,
    };
  }
  if (error instanceof ModelOperationError && error.failure.phase === "generate") {
    return error.failure;
  }
  return {
    code: "unsupported",
    phase: "generate",
    message: "The runtime did not complete this response.",
    retryable: true,
  };
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "Not observed";
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(2)} s`
    : `${milliseconds.toFixed(0)} ms`;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "Not exposed" : `${value.toFixed(2)} tok/s`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

interface ChatLoadProgress {
  readonly label: string;
  readonly detail: string;
  readonly completed?: number;
  readonly total?: number;
}

function runtimeLoadProgress(event: RuntimeLoadEvent): ChatLoadProgress {
  switch (event.phase) {
    case "opening-files":
      return {
        label: "Opening verified model files",
        detail: `${event.completedFiles} of ${event.totalFiles} managed files ready.`,
        completed: event.completedFiles,
        total: event.totalFiles,
      };
    case "loading-assets":
      return {
        label: "Loading bundled wllama code",
        detail: "Loading the wllama module and compatibility worker.",
      };
    case "loading-model":
      return {
        label: "Initializing wllama and loading model weights",
        detail:
          "This can take a while. wllama does not expose a percentage for loading stored browser files.",
      };
    case "browser-model-download":
      return {
        label: "Downloading browser-managed Gemini Nano",
        detail:
          "Chrome reports one combined fraction for the model and customizations; exact bytes are not exposed.",
        completed: event.loaded,
        total: event.total,
      };
    case "browser-model-loading":
      return {
        label: "Initializing browser-managed Gemini Nano",
        detail: "The download is complete. Chrome is extracting and loading the model.",
      };
  }
}

interface RuntimeView {
  readonly descriptor: RuntimeDescriptor;
  readonly selectedStatus: string;
  readonly generatingStatus: string;
  readonly loadingHelp: string;
  readonly readyHelp: string;
  readonly emptyResponse: string;
  readonly firstOutputLabel: string;
  readonly firstOutputMetric: (metrics: ResponseMetrics) => number | undefined;
  readonly showsTokenMetrics: boolean;
  readonly composerPlaceholder: string;
  readonly metricsHelp: string;
}

const runtimeViews = {
  wllama: {
    descriptor: wllamaDescriptor,
    selectedStatus: "wllama selected. Choose an installed GGUF and load a session.",
    generatingStatus: "wllama is generating a measured response.",
    loadingHelp: "The session will become ready after wllama finishes loading the local weights.",
    readyHelp: "Each assistant response reports load time, TTFT, prefill, and decode throughput.",
    emptyResponse: "wllama completed without returning visible text.",
    firstOutputLabel: "TTFT",
    firstOutputMetric: (metrics) => metrics.timeToFirstTokenMs,
    showsTokenMetrics: true,
    composerPlaceholder: "Ask the local model…",
    metricsHelp: "Metrics use wllama timings and page-observed TTFT.",
  },
  "prompt-api": {
    descriptor: promptApiDescriptor,
    selectedStatus: "Chrome Prompt API selected. Load the browser-managed Gemini Nano model.",
    generatingStatus: "Gemini Nano is generating a measured response.",
    loadingHelp:
      "The session will become ready after Chrome downloads, extracts, and loads Gemini Nano.",
    readyHelp:
      "Each assistant response reports observable load time, first output, end-to-end time, and browser-reported context usage.",
    emptyResponse: "Gemini Nano completed without returning text.",
    firstOutputLabel: "First output",
    firstOutputMetric: (metrics) => metrics.timeToFirstOutputMs,
    showsTokenMetrics: false,
    composerPlaceholder: "Ask Gemini Nano…",
    metricsHelp:
      "Prompt API metrics are page-observed; Chrome exposes no token rates or backend identity.",
  },
} satisfies Record<RuntimeId, RuntimeView>;

function splitLoadProgress(
  event: Extract<ModelWorkerEvent, { type: "model/progress" }>,
): ChatLoadProgress {
  if (event.splitStage === "planning") {
    return {
      label: "Planning wllama-compatible GGUF shards",
      detail: `Reading metadata and calculating shard boundaries for ${event.currentFile}.`,
    };
  }
  if (event.splitStage === "finalizing") {
    return {
      label: "Finalizing prepared GGUF shards",
      detail: "Promoting verified shards and inspecting their metadata.",
    };
  }
  return {
    label: event.splitStage === "hashing" ? "Checking source integrity" : "Writing GGUF shards",
    detail: `${formatBytes(event.completedBytes)} of ${formatBytes(event.totalBytes)} read/write work.`,
    completed: event.completedBytes,
    total: event.totalBytes,
  };
}

function modelLabel(model: InstalledModelRecord): string {
  const architecture = model.files.find((file) => file.inspection?.architecture !== undefined)
    ?.inspection?.architecture;
  return architecture === undefined ? model.displayName : `${model.displayName} · ${architecture}`;
}

function boundedInteger(value: string, minimum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function boundedNumber(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boundedContextSize(value: number, maximum: number | undefined): number {
  const boundedMaximum = maximum ?? maximumDeclaredContextTokens;
  const finite = Number.isFinite(value) ? Math.floor(value) : 2_048;
  return Math.min(boundedMaximum, Math.max(256, finite));
}

function contextSizeFromK(value: string, maximum: number | undefined, fallback: number): number {
  const parsedK = Number(value);
  if (!Number.isFinite(parsedK) || parsedK <= 0) return boundedContextSize(fallback, maximum);
  return boundedContextSize(Math.ceil(parsedK) * 1024, maximum);
}

function contextKValue(tokens: number): string {
  return String(tokens / 1024);
}

function contextKLabel(tokens: number): string {
  return (tokens / 1024).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function channelLabel(name: string): string {
  if (name.toLowerCase() === "thought") return "Thinking";
  return name.replaceAll(/[-_]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
}

function ResponseChannelDetails({ channel }: { readonly channel: ResponseChannel }) {
  const [open, setOpen] = useState(!channel.complete);
  const wasComplete = useRef(channel.complete);

  useEffect(() => {
    if (!wasComplete.current && channel.complete) setOpen(false);
    if (wasComplete.current && !channel.complete) setOpen(true);
    wasComplete.current = channel.complete;
  }, [channel.complete]);

  return (
    <details
      className="response-channel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{channelLabel(channel.name)}</span>
        <span>{channel.complete ? "Complete" : "Streaming"}</span>
      </summary>
      <p>{channel.content || "Waiting for channel output…"}</p>
    </details>
  );
}

function OutputDiagnosticsDetails({
  diagnostics,
}: {
  readonly diagnostics: ModelOutputDiagnostics;
}) {
  const occurrences = diagnostics.unrecognizedSpecialTokens.reduce(
    (total, token) => total + token.occurrences,
    diagnostics.omittedOccurrences,
  );
  return (
    <details className="response-output-diagnostics">
      <summary>
        <span>Unrecognized model output</span>
        <span>
          {occurrences} occurrence{occurrences === 1 ? "" : "s"}
        </span>
      </summary>
      <div>
        <p>
          The model declares these as unknown, control, user-defined, or unused tokenizer items, but
          the active response parser does not recognize them. Copy these records when reporting
          parser feedback.
        </p>
        <ul>
          {diagnostics.unrecognizedSpecialTokens.map((token) => (
            <li key={token.id}>
              <code>
                {JSON.stringify({
                  id: token.id,
                  token: token.text,
                  type: token.type,
                  typeName: token.typeName,
                  occurrences: token.occurrences,
                })}
              </code>
            </li>
          ))}
        </ul>
        {diagnostics.omittedOccurrences === 0 ? null : (
          <p>{diagnostics.omittedOccurrences} additional occurrences were omitted.</p>
        )}
      </div>
    </details>
  );
}

const defaultSystemPrompt = "You are a helpful assistant.";
const idleAutosaveDelayMs = 350;
const replayPageSize = 25;
function conversationTitle(messages: readonly ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user")?.content.trim();
  if (first === undefined || first.length === 0) return "New conversation";
  return first.length <= 64 ? first : `${first.slice(0, 61)}…`;
}

function skippedConversationNote(count: number): string {
  if (count === 0) return "";
  return ` ${count.toLocaleString()} malformed saved record${count === 1 ? " was" : "s were"} skipped.`;
}

function boundedResponseChannels(channels: readonly ResponseChannel[]): {
  readonly channels: readonly ResponseChannel[];
  readonly normalized: boolean;
  readonly truncated: boolean;
} {
  let remaining = maximumChatMessageCharacters;
  let normalized = false;
  let truncated = false;
  const normalizedChannels = channels.map((channel) => {
    const clean = channel.content.replaceAll("\u0000", "\uFFFD");
    if (clean !== channel.content) normalized = true;
    return { ...channel, content: clean };
  });
  const contents = new Map<number, string>();
  const allocationOrder = normalizedChannels
    .map((channel, index) => ({ channel, index }))
    .sort((left, right) => Number(right.channel.final) - Number(left.channel.final));
  for (const { channel, index } of allocationOrder) {
    const clean = channel.content;
    const content = clean.slice(0, remaining);
    if (content.length < clean.length) truncated = true;
    remaining -= content.length;
    contents.set(index, content);
  }
  const bounded = normalizedChannels.map((channel, index) => ({
    ...channel,
    content: contents.get(index) ?? "",
  }));
  return { channels: bounded, normalized, truncated };
}

function runtimeMessages(
  systemPrompt: string,
  messages: readonly ChatMessage[],
): { readonly role: "system" | "user" | "assistant"; readonly content: string }[] {
  const result: { role: "system" | "user" | "assistant"; content: string }[] = [];
  const system = systemPrompt.trim();
  if (system.length > 0) result.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "assistant" && message.failure !== undefined) continue;
    if (message.content.length === 0) continue;
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function hasPromptContextOverflow(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) =>
    message.warnings?.some((warning) => warning.code === "context-overflow"),
  );
}

function downloadText(filename: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

function safeFilename(title: string): string {
  const value = title
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80);
  return value.length === 0 ? "webai-chat" : value;
}

function replaySnapshotMessage(message: ChatMessage): ChatMessage {
  const { replaySourceTurnId, ...snapshot } = message;
  void replaySourceTurnId;
  return snapshot;
}

function replaySeedTurns(messages: readonly ChatMessage[]): readonly ConversationReplayTurn[] {
  const turns: ConversationReplayTurn[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || message.content.trim().length === 0) continue;
    const next = messages[index + 1];
    turns.push({
      id: makeId("replay-turn"),
      user: replaySnapshotMessage(message),
      ...(next?.role === "assistant" ? { assistant: replaySnapshotMessage(next) } : {}),
    });
  }
  return turns;
}

export default function ChatWorkbench() {
  const wllamaAdapter = useRef<WllamaRuntimeAdapter | undefined>(undefined);
  const promptApiAdapter = useRef<PromptApiRuntimeAdapter | undefined>(undefined);
  const runtimeController = useRef<RuntimeController | undefined>(undefined);
  const sessionHandle = useRef<SessionHandle | undefined>(undefined);
  const activeRequestId = useRef<string | undefined>(undefined);
  const modelClient = useRef<ModelWorkerClient | undefined>(undefined);
  const loadingModelId = useRef<string | undefined>(undefined);
  const contextModelId = useRef<string | undefined>(undefined);
  const contextEdited = useRef(false);
  const restoredModelId = useRef<string | undefined>(undefined);
  const restoredConversationTarget = useRef(false);
  const historyLoadGeneration = useRef(0);
  const assistantFrame = useRef<number | undefined>(undefined);
  const runtimeIdRef = useRef<RuntimeId>("wllama");
  const promptProbeGeneration = useRef(0);
  const [inventory, setInventory] = useState<ModelInventory | undefined>();
  const [runtimeId, setRuntimeIdState] = useState<RuntimeId>("wllama");
  const [promptApiProbe, setPromptApiProbe] = useState<PromptApiProbe>();
  const [promptProbing, setPromptProbing] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [hardwareThreadLimit, setHardwareThreadLimit] = useState(1);
  const [threads, setThreads] = useState(1);
  const [gpuMode, setGpuMode] = useState<"full" | "partial" | "off">("full");
  const [gpuLayers, setGpuLayers] = useState(8);
  const [contextSize, setContextSize] = useState(2048);
  const [contextKInput, setContextKInput] = useState("2");
  const [session, setSession] = useState<RuntimeSession | undefined>();
  const [loading, setLoading] = useState(false);
  const [splittingModel, setSplittingModel] = useState(false);
  const [loadProgress, setLoadProgress] = useState<ChatLoadProgress | undefined>();
  const [loadElapsedMs, setLoadElapsedMs] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [temperature, setTemperature] = useState<number>(wllamaGenerationDefaults.temperature);
  const [topP, setTopP] = useState<number>(wllamaGenerationDefaults.topP);
  const [topK, setTopK] = useState<number>(wllamaGenerationDefaults.topK);
  const [repeatPenalty, setRepeatPenalty] = useState<number>(
    wllamaGenerationDefaults.repeatPenalty,
  );
  const [seedInput, setSeedInput] = useState("42");
  const [maxTokensInput, setMaxTokensInput] = useState("");
  const [conversationId, setConversationId] = useState(() => makeId("chat"));
  const [conversationCreatedAt, setConversationCreatedAt] = useState(() =>
    new Date().toISOString(),
  );
  const [conversationName, setConversationName] = useState("New conversation");
  const [replaySeed, setReplaySeed] = useState<ConversationReplaySeed>();
  const [replayPage, setReplayPage] = useState(0);
  const [replayDrafts, setReplayDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [conversationModelName, setConversationModelName] = useState("No model selected");
  const [restoredConfiguration, setRestoredConfiguration] = useState<
    ChatConversationRecord | undefined
  >();
  const [conversationSummaries, setConversationSummaries] = useState<
    readonly ChatConversationSummary[]
  >([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyStatus, setHistoryStatus] = useState("Loading saved conversations.");
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [editDraft, setEditDraft] = useState("");
  const importInput = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const saveVersion = useRef(0);
  const replayTransitionPending = useRef(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState("Loading the managed-model inventory.");

  const setRuntimeId = (nextRuntimeId: RuntimeId) => {
    runtimeIdRef.current = nextRuntimeId;
    setRuntimeIdState(nextRuntimeId);
  };

  const refreshPromptApiProbe = useCallback((runtime?: PromptApiRuntimeAdapter) => {
    const activeRuntime = runtime ?? promptApiAdapter.current;
    if (activeRuntime === undefined) return;
    const generation = ++promptProbeGeneration.current;
    setPromptProbing(true);
    void activeRuntime
      .probe()
      .then((probe) => {
        if (generation === promptProbeGeneration.current) setPromptApiProbe(probe);
      })
      .finally(() => {
        if (generation === promptProbeGeneration.current) setPromptProbing(false);
      });
  }, []);

  useEffect(() => {
    const historyGeneration = ++historyLoadGeneration.current;
    const reportedThreads = navigator.hardwareConcurrency;
    const availableThreads =
      Number.isSafeInteger(reportedThreads) && reportedThreads > 0 ? reportedThreads : 1;
    setHardwareThreadLimit(availableThreads);
    setThreads(Math.max(1, Math.floor(availableThreads / 2)));
    const runtime = new WllamaRuntimeAdapter();
    const browserRuntime = new PromptApiRuntimeAdapter();
    const controller = new RuntimeController(runtime, browserRuntime);
    const client = new ModelWorkerClient();
    wllamaAdapter.current = runtime;
    promptApiAdapter.current = browserRuntime;
    runtimeController.current = controller;
    modelClient.current = client;
    const unsubscribe = client.subscribe((event: ModelWorkerEvent) => {
      if (event.type === "model/inventory") setInventory(event.inventory);
      if (
        event.type === "model/progress" &&
        event.phase === "splitting" &&
        event.jobId === loadingModelId.current
      ) {
        const next = splitLoadProgress(event);
        setLoadProgress(next);
        setStatus(next.label);
      }
    });
    void client
      .inventory()
      .then((next) => {
        setInventory(next);
        const restored = restoredModelId.current;
        const first = next.models.find((model) => model.state === "installed");
        if (restoredConversationTarget.current) {
          setSelectedModelId(
            restored !== undefined && next.models.some((model) => model.id === restored)
              ? restored
              : "",
          );
        } else if (restored !== undefined && next.models.some((model) => model.id === restored)) {
          setSelectedModelId(restored);
        } else if (first !== undefined) setSelectedModelId(first.id);
        if (runtimeIdRef.current === "wllama") {
          setStatus("Choose a model and load a wllama session.");
        }
      })
      .catch((failure) => {
        if (runtimeIdRef.current === "wllama") {
          setError(failureMessage(failure));
          setStatus("Managed models are unavailable.");
        }
      });
    refreshPromptApiProbe(browserRuntime);
    void listConversations()
      .then(async ({ conversations: summaries, skippedRecords }) => {
        if (historyGeneration !== historyLoadGeneration.current) return;
        setConversationSummaries(summaries);
        const latest = summaries[0];
        if (latest === undefined) {
          setHistoryReady(true);
          setHistoryStatus(
            `New conversation ready. Changes are saved locally.${skippedConversationNote(skippedRecords)}`,
          );
          return;
        }
        const saved = await getConversation(latest.id);
        if (historyGeneration !== historyLoadGeneration.current) return;
        if (saved === undefined) throw new Error("The latest saved conversation is missing.");
        restoredModelId.current = saved.modelId;
        restoredConversationTarget.current = true;
        setConversationId(saved.id);
        setConversationCreatedAt(saved.createdAt);
        setConversationName(saved.title);
        setConversationModelName(saved.modelName);
        setRestoredConfiguration(saved);
        setRuntimeId(saved.runtimeId);
        setSelectedModelId(saved.modelId ?? "");
        setSystemPrompt(saved.systemPrompt);
        setThinkingEnabled(saved.generation.thinking ?? true);
        setTemperature(saved.generation.temperature ?? wllamaGenerationDefaults.temperature);
        setTopP(saved.generation.topP ?? wllamaGenerationDefaults.topP);
        setTopK(saved.generation.topK ?? wllamaGenerationDefaults.topK);
        setRepeatPenalty(saved.generation.repeatPenalty ?? wllamaGenerationDefaults.repeatPenalty);
        setSeedInput(saved.generation.seed === undefined ? "" : String(saved.generation.seed));
        setMaxTokensInput(
          saved.generation.maxTokens === undefined ? "" : String(saved.generation.maxTokens),
        );
        if (saved.wllamaSession !== undefined) {
          setThreads(saved.wllamaSession.threads);
          setGpuMode(saved.wllamaSession.gpuMode);
          setGpuLayers(saved.wllamaSession.gpuLayers);
          setContextSize(saved.wllamaSession.contextSize);
          setContextKInput(contextKValue(saved.wllamaSession.contextSize));
          contextEdited.current = true;
          contextModelId.current = saved.modelId;
        }
        setMessages(saved.messages);
        setReplaySeed(saved.replaySeed);
        setHistoryReady(true);
        setHistoryStatus(
          `Restored ${saved.title}. Load its model session to continue.${skippedConversationNote(skippedRecords)}`,
        );
      })
      .catch((failure) => {
        if (historyGeneration !== historyLoadGeneration.current) return;
        setHistoryReady(true);
        setHistoryStatus("Saved conversations are unavailable in this browser session.");
        setError(failureMessage(failure));
      });
    return () => {
      if (historyLoadGeneration.current === historyGeneration) ++historyLoadGeneration.current;
      if (sessionHandle.current !== undefined && activeRequestId.current !== undefined)
        controller.abort(sessionHandle.current, activeRequestId.current);
      if (assistantFrame.current !== undefined) {
        window.cancelAnimationFrame(assistantFrame.current);
        assistantFrame.current = undefined;
      }
      unsubscribe();
      client.dispose();
      void controller.dispose();
      modelClient.current = undefined;
      wllamaAdapter.current = undefined;
      promptApiAdapter.current = undefined;
      runtimeController.current = undefined;
    };
  }, [refreshPromptApiProbe]);

  useEffect(() => {
    let wasHidden = false;
    const refreshAfterVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        refreshPromptApiProbe();
      }
    };
    document.addEventListener("visibilitychange", refreshAfterVisibility);
    return () => document.removeEventListener("visibilitychange", refreshAfterVisibility);
  }, [refreshPromptApiProbe]);

  useEffect(() => {
    if (!loading) return;
    const started = performance.now();
    setLoadElapsedMs(0);
    const timer = window.setInterval(() => setLoadElapsedMs(performance.now() - started), 250);
    return () => window.clearInterval(timer);
  }, [loading]);

  const models = useMemo(
    () => inventory?.models.filter((model) => model.state === "installed") ?? [],
    [inventory],
  );
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedCompatibility =
    selectedModel === undefined ? undefined : wllamaModelCompatibility(selectedModel);
  const selectedContextLimit =
    selectedModel === undefined ? undefined : wllamaModelContextLength(selectedModel);

  const selectedContextModelId = selectedModel?.id;
  useEffect(() => {
    if (runtimeId !== "wllama") return;
    if (selectedContextModelId === undefined) return;
    if (contextModelId.current === selectedContextModelId && contextEdited.current) return;
    if (contextModelId.current !== selectedContextModelId) {
      contextModelId.current = selectedContextModelId;
      contextEdited.current = false;
    }
    const nextContextSize = boundedContextSize(selectedContextLimit ?? 2_048, selectedContextLimit);
    setContextSize(nextContextSize);
    setContextKInput(contextKValue(nextContextSize));
  }, [runtimeId, selectedContextLimit, selectedContextModelId]);

  const generationOptions = useMemo<GenerationOptions>(
    () => ({
      temperature,
      topP,
      topK,
      repeatPenalty,
      thinking: thinkingEnabled,
      ...(seedInput === ""
        ? {}
        : { seed: Math.min(4_294_967_294, boundedInteger(seedInput, 0, 42)) }),
      ...(maxTokensInput === ""
        ? {}
        : { maxTokens: Math.min(1_048_576, boundedInteger(maxTokensInput, 1, 1_024)) }),
    }),
    [maxTokensInput, repeatPenalty, seedInput, temperature, thinkingEnabled, topK, topP],
  );

  const modelTarget = useMemo<ConversationModelTarget>(() => {
    if (runtimeId === "prompt-api")
      return restoredConfiguration?.runtimeId === "prompt-api"
        ? restoredConfiguration.modelTarget
        : { kind: "browser-managed", runtimeId: "prompt-api", model: "gemini-nano" };
    if (
      restoredConfiguration?.runtimeId === "wllama" &&
      ((selectedModel === undefined &&
        (selectedModelId === "" || selectedModelId === restoredConfiguration.modelId)) ||
        selectedModel?.id === restoredConfiguration.modelId)
    )
      return restoredConfiguration.modelTarget;
    if (selectedModel === undefined)
      return { kind: "unresolved", runtimeId: "wllama", displayName: conversationModelName };
    return {
      kind: "artifact-set",
      modelId: selectedModel.id,
      displayName: selectedModel.displayName,
      files: selectedModel.files.map((file) => ({
        displayName: file.displayName,
        size: file.size,
        sha256: file.sha256,
      })),
      source:
        selectedModel.source.kind === "hugging-face"
          ? {
              kind: "hugging-face",
              repo: selectedModel.source.repo,
              commit: selectedModel.source.commit,
            }
          : { kind: "local-import", sha256: selectedModel.source.sha256 },
    };
  }, [conversationModelName, restoredConfiguration, runtimeId, selectedModel, selectedModelId]);
  const retainingRestoredConfiguration = modelTarget === restoredConfiguration?.modelTarget;
  const activeModelId =
    selectedModelId ||
    (retainingRestoredConfiguration ? restoredConfiguration?.modelId : undefined);

  const conversationRecord = useMemo<ChatConversationRecord>(
    () => ({
      schemaVersion: chatSchemaVersion,
      id: conversationId,
      title:
        conversationName === "New conversation" && messages.length > 0
          ? conversationTitle(messages)
          : conversationName,
      createdAt: conversationCreatedAt,
      updatedAt: new Date().toISOString(),
      runtimeId,
      adapterVersion: retainingRestoredConfiguration
        ? restoredConfiguration.adapterVersion
        : runtimeViews[runtimeId].descriptor.adapterVersion,
      engineVersion: retainingRestoredConfiguration
        ? restoredConfiguration.engineVersion
        : runtimeViews[runtimeId].descriptor.engineVersion,
      ...(runtimeId === "wllama" && activeModelId !== undefined && activeModelId !== ""
        ? { modelId: activeModelId }
        : {}),
      modelName:
        runtimeId === "wllama"
          ? (selectedModel?.displayName ?? conversationModelName)
          : "Gemini Nano",
      modelTarget,
      systemPrompt,
      generation: runtimeId === "wllama" ? generationOptions : {},
      ...(runtimeId === "wllama"
        ? { wllamaSession: { threads, gpuMode, gpuLayers, contextSize } }
        : {}),
      ...(session?.runtimeId === "wllama"
        ? { effectiveWllamaBackend: session.backend }
        : retainingRestoredConfiguration &&
            restoredConfiguration.effectiveWllamaBackend !== undefined
          ? { effectiveWllamaBackend: restoredConfiguration.effectiveWllamaBackend }
          : {}),
      messages,
      ...(replaySeed === undefined ? {} : { replaySeed }),
    }),
    [
      contextSize,
      activeModelId,
      conversationCreatedAt,
      conversationId,
      conversationModelName,
      conversationName,
      generationOptions,
      gpuLayers,
      gpuMode,
      messages,
      modelTarget,
      replaySeed,
      retainingRestoredConfiguration,
      restoredConfiguration,
      runtimeId,
      selectedModel?.displayName,
      selectedModelId,
      session,
      systemPrompt,
      threads,
    ],
  );

  const replayMessagesByTurn = useMemo(() => {
    const result = new Map<
      string,
      { readonly user?: ChatMessage; readonly assistant?: ChatMessage }
    >();
    for (const message of messages) {
      const turnId = message.replaySourceTurnId;
      if (turnId === undefined) continue;
      const existing = result.get(turnId) ?? {};
      result.set(
        turnId,
        message.role === "user"
          ? { ...existing, user: message }
          : { ...existing, assistant: message },
      );
    }
    return result;
  }, [messages]);

  useEffect(() => {
    if (!historyReady) return;
    const version = ++saveVersion.current;
    setHistoryStatus("Saving locally…");
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(
      () => {
        const snapshot = conversationRecord;
        saveTail.current = saveTail.current
          .catch(() => undefined)
          .then(async () => {
            await putConversation(snapshot);
            const { conversations: summaries, skippedRecords } = await listConversations();
            if (version === saveVersion.current) {
              setConversationName(snapshot.title);
              setHistoryStatus(
                `Saved locally in this browser.${skippedConversationNote(skippedRecords)}`,
              );
              setConversationSummaries(summaries);
            }
          })
          .catch((failure) => {
            if (version === saveVersion.current) {
              setHistoryStatus("This conversation is still in memory but could not be saved.");
              setError(failureMessage(failure));
            }
          });
      },
      generating ? 500 : idleAutosaveDelayMs,
    );
    return () => {
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    };
  }, [conversationRecord, generating, historyReady]);

  const invalidateSession = () => {
    const handle = sessionHandle.current;
    sessionHandle.current = undefined;
    activeRequestId.current = undefined;
    setSession(undefined);
    if (handle !== undefined) void runtimeController.current?.disposeSession(handle);
  };

  const invalidateWllamaConfiguration = () => {
    if (session?.runtimeId !== "wllama") return;
    invalidateSession();
    setStatus("Session configuration changed. Reload the model before generating again.");
  };

  const changeModel = (modelId: string) => {
    if (!historyReady || replayTransitionPending.current) return;
    if (loading) void wllamaAdapter.current?.dispose();
    setSelectedModelId(modelId);
    setRestoredConfiguration(undefined);
    const model = models.find((candidate) => candidate.id === modelId);
    if (model !== undefined) setConversationModelName(model.displayName);
    contextModelId.current = undefined;
    contextEdited.current = false;
    invalidateSession();
    setError(undefined);
    setLoadProgress(undefined);
    setStatus("Model selection changed. Load a new wllama session to continue.");
  };

  const changeRuntime = (nextRuntimeId: RuntimeId) => {
    if (
      !historyReady ||
      replayTransitionPending.current ||
      nextRuntimeId === runtimeId ||
      loading ||
      generating
    )
      return;
    setRuntimeId(nextRuntimeId);
    setRestoredConfiguration(undefined);
    invalidateSession();
    setError(undefined);
    setLoadProgress(undefined);
    setStatus(runtimeViews[nextRuntimeId].selectedStatus);
  };

  const load = async () => {
    if (!historyReady || replayTransitionPending.current) return;
    if (runtimeId === "prompt-api") {
      if (hasPromptContextOverflow(messages)) {
        setError(
          "Chrome previously evicted an unknown number of older turns. WebAI cannot safely rebuild that hidden boundary as non-evictable initial prompts; start a new conversation to continue.",
        );
        setStatus(
          "This overflowed Gemini Nano transcript remains readable but cannot be replayed.",
        );
        return;
      }
      const runtime = promptApiAdapter.current;
      const controller = runtimeController.current;
      if (runtime === undefined || controller === undefined) return;
      setLoadElapsedMs(0);
      setLoading(true);
      setError(undefined);
      invalidateSession();
      setStatus("Chrome is creating a browser-managed Gemini Nano session.");
      setLoadProgress(
        promptApiProbe?.availability === "downloadable" ||
          promptApiProbe?.availability === "downloading"
          ? {
              label: "Waiting for browser-managed Gemini Nano download",
              detail:
                "Chrome will report combined fractional progress; exact bytes are not exposed.",
              completed: 0,
              total: 1,
            }
          : {
              label: "Initializing browser-managed Gemini Nano",
              detail: "Chrome reports the model ready; session creation can still take time.",
            },
      );
      try {
        const availabilityBeforeLoad = promptApiProbe?.availability;
        const created = await controller.createPromptApiSession(
          runtimeMessages(systemPrompt, messages),
          (event) => {
            if (
              event.phase === "browser-model-download" &&
              availabilityBeforeLoad === "available" &&
              (event.loaded === 0 || event.loaded === 1)
            ) {
              return;
            }
            const next = runtimeLoadProgress(event);
            setLoadProgress(next);
            setStatus(next.label);
          },
        );
        const loaded = created.session;
        sessionHandle.current = created.handle;
        setSession(loaded);
        setRestoredConfiguration(undefined);
        setStatus(`Gemini Nano is ready after ${formatDuration(loaded.loadTimeMs)}.`);
        refreshPromptApiProbe(runtime);
      } catch (failure) {
        if (isAbortedFailure(failure)) {
          setStatus("Gemini Nano session loading was stopped.");
        } else {
          setError(failureMessage(failure));
          setStatus("The Prompt API session load failed.");
        }
        refreshPromptApiProbe(runtime);
      } finally {
        setLoadProgress(undefined);
        setLoading(false);
      }
      return;
    }
    const controller = runtimeController.current;
    const client = modelClient.current;
    if (controller === undefined || client === undefined || selectedModel === undefined) return;
    setLoadElapsedMs(0);
    setLoading(true);
    loadingModelId.current = selectedModel.id;
    setError(undefined);
    invalidateSession();
    setStatus(`Loading ${selectedModel.displayName} in wllama.`);
    setLoadProgress({
      label: "Preparing the selected model",
      detail: "Checking the installed GGUF layout for wllama compatibility.",
    });
    try {
      let modelToLoad = selectedModel;
      const compatibility = wllamaModelCompatibility(modelToLoad);
      if (compatibility.status === "incompatible") {
        throw new Error(compatibility.explanation);
      }
      if (compatibility.status === "needs-split") {
        setLoadProgress({
          label: "Preparing GGUF shards for wllama",
          detail: "The original remains installed until every derived shard is verified.",
        });
        setStatus("Preparing GGUF shards required by wllama.");
        setSplittingModel(true);
        try {
          await client.split(modelToLoad.id);
        } finally {
          setSplittingModel(false);
        }
        const nextInventory = await client.inventory();
        setInventory(nextInventory);
        const prepared = nextInventory.models.find((model) => model.id === modelToLoad.id);
        if (prepared === undefined || wllamaModelCompatibility(prepared).status !== "ready") {
          throw new Error("The prepared wllama model could not be found in managed storage.");
        }
        modelToLoad = prepared;
      }
      if (
        !modelToLoad.files.some((file) => file.inspection?.specialTokenInventoryInspected === true)
      ) {
        setLoadProgress({
          label: "Refreshing tokenizer metadata",
          detail: "Building a bounded model-declared special-token index in the model worker.",
        });
        setStatus("Refreshing tokenizer metadata for output diagnostics.");
        await client.inspect(modelToLoad.id);
        const nextInventory = await client.inventory();
        setInventory(nextInventory);
        const refreshed = nextInventory.models.find((model) => model.id === modelToLoad.id);
        if (refreshed === undefined) {
          throw new Error("The re-inspected wllama model could not be found in managed storage.");
        }
        modelToLoad = refreshed;
      }
      const modelContextLimit = wllamaModelContextLength(modelToLoad);
      const effectiveContextSize = contextEdited.current
        ? contextSizeFromK(contextKInput, modelContextLimit, contextSize)
        : boundedContextSize(modelContextLimit ?? 2_048, modelContextLimit);
      if (effectiveContextSize !== contextSize) setContextSize(effectiveContextSize);
      setContextKInput(contextKValue(effectiveContextSize));
      const created = await controller.createWllamaSession(
        modelToLoad,
        {
          threads,
          gpuLayers: gpuMode === "off" ? 0 : gpuMode === "full" ? 99_999 : gpuLayers,
          contextSize: effectiveContextSize,
        },
        (event) => {
          const next = runtimeLoadProgress(event);
          setLoadProgress(next);
          setStatus(next.label);
        },
      );
      const loaded = created.session;
      sessionHandle.current = created.handle;
      setSession(loaded);
      setRestoredConfiguration(undefined);
      setStatus(`wllama loaded the model in ${formatDuration(loaded.loadTimeMs)}.`);
    } catch (failure) {
      if (isAbortedFailure(failure)) {
        setStatus("Model preparation stopped. The original installed model is unchanged.");
      } else {
        setError(failureMessage(failure));
        setStatus("The wllama model load failed.");
      }
      void client
        .inventory()
        .then(setInventory)
        .catch(() => undefined);
    } finally {
      loadingModelId.current = undefined;
      setLoadProgress(undefined);
      setLoading(false);
    }
  };

  const runGeneration = async (
    history: readonly ChatMessage[],
    requestOptions: GenerationOptions,
    rebuildPromptSession: boolean,
    replaySourceTurnId?: string,
  ) => {
    const controller = runtimeController.current;
    if (controller === undefined || generating) return;
    let handle = sessionHandle.current;
    if (runtimeId === "prompt-api" && rebuildPromptSession) {
      if (hasPromptContextOverflow(messages)) {
        setError(
          "Chrome previously evicted an unknown number of older turns, so this transcript cannot be regenerated exactly.",
        );
        setStatus("Start a new conversation before continuing with Gemini Nano.");
        return;
      }
      setStatus("Rebuilding Gemini Nano context from the retained conversation prefix.");
      try {
        const created = await controller.createPromptApiSession(
          runtimeMessages(systemPrompt, history.slice(0, -1)),
        );
        handle = created.handle;
        sessionHandle.current = handle;
        setSession(created.session);
      } catch (failure) {
        setError(failureMessage(failure));
        setStatus("Gemini Nano could not rebuild the edited conversation context.");
        return;
      }
    }
    if (handle === undefined || session === undefined) return;
    const assistantId = makeId("assistant");
    const descriptor = runtimeViews[runtimeId].descriptor;
    const execution: ExecutionProvenance = {
      runtimeId,
      adapterVersion: descriptor.adapterVersion,
      engineVersion: descriptor.engineVersion,
      modelTarget,
      systemPrompt,
      ...(runtimeId === "wllama"
        ? { wllamaSession: { threads, gpuMode, gpuLayers, contextSize } }
        : {}),
      ...(session.runtimeId === "wllama" ? { effectiveWllamaBackend: session.backend } : {}),
    };
    setMessages([
      ...history,
      {
        id: assistantId,
        runtimeId,
        role: "assistant",
        content: "",
        ...(replaySourceTurnId === undefined ? {} : { replaySourceTurnId }),
        request: requestOptions,
        execution,
      },
    ]);
    setGenerating(true);
    setError(undefined);
    setStatus(runtimeViews[runtimeId].generatingStatus);
    let pendingText = "";
    let pendingChannels: ChatMessage["channels"];
    let pendingMetrics: ChatMessage["metrics"];
    let pendingOutputDiagnostics: ChatMessage["outputDiagnostics"];
    let pendingTokenization: ChatMessage["tokenization"];
    let pendingControlOutcomes: ChatMessage["controlOutcomes"];
    let pendingWarnings: ChatMessage["warnings"];
    let acceptedTextCharacters = 0;
    let outputNormalizedWarningQueued = false;
    let outputTruncatedWarningQueued = false;
    let scheduledFrame: number | undefined;
    const queueOutputWarning = (kind: "normalized" | "truncated") => {
      if (kind === "normalized") {
        if (outputNormalizedWarningQueued) return;
        outputNormalizedWarningQueued = true;
        pendingWarnings = [
          ...(pendingWarnings ?? []),
          {
            code: "output-normalized",
            message:
              "Model output contained a null character; WebAI replaced it before displaying and saving the response.",
          },
        ];
        return;
      }
      if (outputTruncatedWarningQueued) return;
      outputTruncatedWarningQueued = true;
      pendingWarnings = [
        ...(pendingWarnings ?? []),
        {
          code: "output-truncated",
          message:
            "Model output exceeded WebAI's 256 Ki-character per-response bound and was truncated for safe display and persistence.",
        },
      ];
    };
    const flushAssistantUpdate = () => {
      scheduledFrame = undefined;
      assistantFrame.current = undefined;
      if (
        pendingText.length === 0 &&
        pendingChannels === undefined &&
        pendingMetrics === undefined &&
        pendingOutputDiagnostics === undefined &&
        pendingTokenization === undefined &&
        pendingControlOutcomes === undefined &&
        pendingWarnings === undefined
      )
        return;
      const textUpdate = pendingText;
      const channelsUpdate = pendingChannels;
      const metricsUpdate = pendingMetrics;
      const diagnosticsUpdate = pendingOutputDiagnostics;
      const tokenizationUpdate = pendingTokenization;
      const controlsUpdate = pendingControlOutcomes;
      const warningsUpdate = pendingWarnings;
      pendingText = "";
      pendingChannels = undefined;
      pendingMetrics = undefined;
      pendingOutputDiagnostics = undefined;
      pendingTokenization = undefined;
      pendingControlOutcomes = undefined;
      pendingWarnings = undefined;
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== assistantId) return message;
          let updated = message;
          if (textUpdate.length > 0) {
            updated = { ...updated, content: updated.content + textUpdate };
          }
          if (channelsUpdate !== undefined) {
            updated = {
              ...updated,
              channels: channelsUpdate,
              content: finalResponseText(channelsUpdate),
            };
          }
          if (metricsUpdate !== undefined) updated = { ...updated, metrics: metricsUpdate };
          if (diagnosticsUpdate !== undefined) {
            updated = { ...updated, outputDiagnostics: diagnosticsUpdate };
          }
          if (tokenizationUpdate !== undefined) {
            updated = { ...updated, tokenization: tokenizationUpdate };
          }
          if (controlsUpdate !== undefined) {
            updated = { ...updated, controlOutcomes: controlsUpdate };
          }
          if (warningsUpdate !== undefined) {
            updated = {
              ...updated,
              warnings: [...(updated.warnings ?? []), ...warningsUpdate],
            };
          }
          return updated;
        }),
      );
    };
    const scheduleAssistantUpdate = () => {
      if (scheduledFrame !== undefined) return;
      scheduledFrame = window.requestAnimationFrame(flushAssistantUpdate);
      assistantFrame.current = scheduledFrame;
    };
    try {
      const generation = controller.generate(
        handle,
        runtimeMessages(systemPrompt, history),
        requestOptions,
        ({ event: runtimeEvent }) => {
          if (runtimeEvent.type === "text") {
            const normalized = runtimeEvent.text.replaceAll("\u0000", "\uFFFD");
            if (normalized !== runtimeEvent.text) queueOutputWarning("normalized");
            const remaining = maximumChatMessageCharacters - acceptedTextCharacters;
            const accepted = normalized.slice(0, Math.max(0, remaining));
            if (accepted.length < normalized.length) queueOutputWarning("truncated");
            acceptedTextCharacters += accepted.length;
            pendingText += accepted;
          }
          if (runtimeEvent.type === "channels") {
            const bounded = boundedResponseChannels(runtimeEvent.channels);
            pendingChannels = bounded.channels;
            if (bounded.normalized) queueOutputWarning("normalized");
            if (bounded.truncated) queueOutputWarning("truncated");
          }
          if (runtimeEvent.type === "metrics") {
            pendingMetrics = runtimeEvent.metrics;
            const contextUsage = runtimeEvent.metrics.contextUsage;
            if (runtimeId === "prompt-api" && contextUsage !== undefined) {
              setSession((current) =>
                current?.runtimeId === "prompt-api" ? { ...current, contextUsage } : current,
              );
            }
          }
          if (runtimeEvent.type === "output-diagnostics") {
            const unrecognizedSpecialTokens =
              runtimeEvent.diagnostics.unrecognizedSpecialTokens.map((token) => {
                const text = token.text.replaceAll("\u0000", "\uFFFD");
                const typeName = token.typeName.replaceAll("\u0000", "\uFFFD");
                if (text !== token.text || typeName !== token.typeName)
                  queueOutputWarning("normalized");
                return { ...token, text, typeName };
              });
            pendingOutputDiagnostics = {
              ...runtimeEvent.diagnostics,
              unrecognizedSpecialTokens,
            };
          }
          if (runtimeEvent.type === "tokenization") {
            const tokens = runtimeEvent.tokenization.tokens.map((token) => {
              const text = token.text.replaceAll("\u0000", "\uFFFD");
              if (text !== token.text) queueOutputWarning("normalized");
              return { ...token, text };
            });
            pendingTokenization = { ...runtimeEvent.tokenization, tokens };
          }
          if (runtimeEvent.type === "complete") {
            pendingControlOutcomes = runtimeEvent.controls;
          }
          if (runtimeEvent.type === "warning") {
            pendingWarnings = [...(pendingWarnings ?? []), runtimeEvent.warning];
          }
          scheduleAssistantUpdate();
        },
      );
      activeRequestId.current = generation.requestId;
      await generation.completion;
      if (scheduledFrame !== undefined) window.cancelAnimationFrame(scheduledFrame);
      assistantFrame.current = undefined;
      flushAssistantUpdate();
      setStatus("Response complete. Metrics are attached to the response.");
    } catch (failure) {
      if (scheduledFrame !== undefined) window.cancelAnimationFrame(scheduledFrame);
      assistantFrame.current = undefined;
      flushAssistantUpdate();
      const aborted = isAbortedFailure(failure);
      if (runtimeId === "prompt-api" || aborted) {
        await controller.disposeSession(handle);
        sessionHandle.current = undefined;
        setSession(undefined);
      }
      if (aborted) {
        setStatus(
          "Generation stopped. Review the partial response before reloading the model to continue.",
        );
      } else {
        setError(failureMessage(failure));
        setStatus(
          runtimeId === "prompt-api"
            ? "Gemini Nano generation failed. Reload it before continuing from the canonical transcript."
            : `${runtimeViews[runtimeId].descriptor.displayName} generation failed.`,
        );
      }
      const failureDetails = generationFailure(failure, aborted);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, failure: failureDetails } : message,
        ),
      );
    } finally {
      activeRequestId.current = undefined;
      setGenerating(false);
    }
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = prompt.trim();
    if (
      !historyReady ||
      replayTransitionPending.current ||
      session === undefined ||
      text.length === 0 ||
      generating
    )
      return;
    const user: ChatMessage = { id: makeId("user"), runtimeId, role: "user", content: text };
    const history = [...messages, user];
    setPrompt("");
    await runGeneration(history, runtimeId === "wllama" ? generationOptions : {}, false);
  };

  const sendReplayTurn = async (turn: ConversationReplayTurn, draft: string) => {
    const text = draft.trim();
    if (
      !historyReady ||
      replayTransitionPending.current ||
      session === undefined ||
      generating ||
      text.length === 0 ||
      messages.some((message) => message.replaySourceTurnId === turn.id)
    )
      return;
    const user: ChatMessage = {
      id: makeId("user"),
      runtimeId,
      role: "user",
      content: text,
      replaySourceTurnId: turn.id,
    };
    await runGeneration(
      [...messages, user],
      runtimeId === "wllama" ? generationOptions : {},
      false,
      turn.id,
    );
  };

  const regenerate = async (assistantIndex: number) => {
    if (replayTransitionPending.current || generating || session === undefined) return;
    const assistant = messages[assistantIndex];
    const user = messages[assistantIndex - 1];
    if (assistant?.role !== "assistant" || user?.role !== "user") return;
    const history = messages.slice(0, assistantIndex);
    await runGeneration(
      history,
      runtimeId === "wllama" ? (assistant.request ?? generationOptions) : {},
      runtimeId === "prompt-api",
      user.replaySourceTurnId,
    );
  };

  const resendEdit = async (messageIndex: number) => {
    const original = messages[messageIndex];
    const text = editDraft.trim();
    if (
      replayTransitionPending.current ||
      original?.role !== "user" ||
      text.length === 0 ||
      session === undefined
    )
      return;
    if (text.length > maximumChatMessageCharacters) {
      setError("Edited messages are limited to 256 Ki characters.");
      return;
    }
    if (
      messageIndex < messages.length - 2 &&
      !window.confirm("Edit this turn and remove every later turn from this conversation?")
    )
      return;
    const replaySourceTurnId = text === original.content ? original.replaySourceTurnId : undefined;
    const replacement: ChatMessage = {
      ...replaySnapshotMessage(original),
      id: makeId("user"),
      content: text,
      ...(replaySourceTurnId === undefined ? {} : { replaySourceTurnId }),
    };
    const history = [...messages.slice(0, messageIndex), replacement];
    setEditingMessageId(undefined);
    setEditDraft("");
    await runGeneration(
      history,
      runtimeId === "wllama" ? generationOptions : {},
      runtimeId === "prompt-api",
      replacement.replaySourceTurnId,
    );
  };

  const stopGeneration = () => {
    const handle = sessionHandle.current;
    const requestId = activeRequestId.current;
    if (handle !== undefined && requestId !== undefined)
      runtimeController.current?.abort(handle, requestId);
  };

  const applyConversation = (record: ChatConversationRecord) => {
    ++saveVersion.current;
    invalidateSession();
    setConversationId(record.id);
    setConversationCreatedAt(record.createdAt);
    setConversationName(record.title);
    setConversationModelName(record.modelName);
    setRestoredConfiguration(record);
    restoredModelId.current = record.modelId;
    restoredConversationTarget.current = true;
    setRuntimeId(record.runtimeId);
    setSelectedModelId(record.modelId ?? "");
    setSystemPrompt(record.systemPrompt);
    setThinkingEnabled(record.generation.thinking ?? true);
    setTemperature(record.generation.temperature ?? wllamaGenerationDefaults.temperature);
    setTopP(record.generation.topP ?? wllamaGenerationDefaults.topP);
    setTopK(record.generation.topK ?? wllamaGenerationDefaults.topK);
    setRepeatPenalty(record.generation.repeatPenalty ?? wllamaGenerationDefaults.repeatPenalty);
    setSeedInput(record.generation.seed === undefined ? "" : String(record.generation.seed));
    setMaxTokensInput(
      record.generation.maxTokens === undefined ? "" : String(record.generation.maxTokens),
    );
    if (record.wllamaSession !== undefined) {
      setThreads(record.wllamaSession.threads);
      setGpuMode(record.wllamaSession.gpuMode);
      setGpuLayers(record.wllamaSession.gpuLayers);
      setContextSize(record.wllamaSession.contextSize);
      setContextKInput(contextKValue(record.wllamaSession.contextSize));
      contextEdited.current = true;
      contextModelId.current = record.modelId;
    } else {
      contextEdited.current = false;
      contextModelId.current = undefined;
    }
    setMessages(record.messages);
    setReplaySeed(record.replaySeed);
    setReplayPage(0);
    setReplayDrafts(new Map());
    setEditingMessageId(undefined);
    setPrompt("");
    setError(undefined);
    setHistoryStatus(`Loaded ${record.title}. Load its model session to continue.`);
  };

  const selectConversation = async (id: string) => {
    if (replayTransitionPending.current || id === conversationId || loading || generating) return;
    try {
      const record = await getConversation(id);
      if (record === undefined) throw new Error("The selected conversation no longer exists.");
      applyConversation(record);
    } catch (failure) {
      setError(failureMessage(failure));
    }
  };

  const newConversation = () => {
    if (!historyReady || replayTransitionPending.current) return;
    ++saveVersion.current;
    invalidateSession();
    restoredConversationTarget.current = false;
    restoredModelId.current = undefined;
    setRestoredConfiguration(undefined);
    const now = new Date().toISOString();
    setConversationId(makeId("chat"));
    setConversationCreatedAt(now);
    setConversationName("New conversation");
    setMessages([]);
    setReplaySeed(undefined);
    setReplayPage(0);
    setReplayDrafts(new Map());
    setEditingMessageId(undefined);
    setPrompt("");
    setError(undefined);
    setHistoryStatus("New conversation ready. Changes are saved locally.");
  };

  const startManualReplay = async () => {
    const turns = replaySeedTurns(messages);
    if (loading || generating || !historyReady || replayTransitionPending.current) return;
    if (turns.length === 0) {
      setError("This conversation has no non-empty user prompts to replay.");
      setHistoryStatus("A manual replay seed needs at least one non-empty user prompt.");
      return;
    }
    if (turns.length > maximumReplayTurns) {
      setError(
        `Manual replay seeds support at most ${maximumReplayTurns.toLocaleString()} source prompts.`,
      );
      setHistoryStatus("This conversation has too many user prompts to seed a manual replay.");
      return;
    }
    const source = conversationRecord;
    replayTransitionPending.current = true;
    ++saveVersion.current;
    invalidateSession();
    setHistoryReady(false);
    setStatus("Saving the source conversation before creating its manual replay seed.");
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    try {
      await saveTail.current.catch(() => undefined);
      await putConversation(source);
      const { conversations: summaries, skippedRecords } = await listConversations();
      const now = new Date().toISOString();
      const seed: ConversationReplaySeed = {
        sourceConversationId: source.id,
        sourceTitle: source.title,
        capturedAt: now,
        systemPrompt: source.systemPrompt,
        turns,
      };
      setConversationSummaries(summaries);
      setConversationId(makeId("chat"));
      setConversationCreatedAt(now);
      setConversationName(`${source.title} replay`.slice(0, 200));
      setConversationModelName(source.modelName);
      setRestoredConfiguration(source);
      restoredModelId.current = source.modelId;
      restoredConversationTarget.current = true;
      setSystemPrompt(source.systemPrompt);
      setMessages([]);
      setReplaySeed(seed);
      setReplayPage(0);
      setReplayDrafts(new Map());
      setEditingMessageId(undefined);
      setPrompt("");
      setError(undefined);
      setStatus("Manual replay seed ready. Load the model, then choose source prompts to send.");
      setHistoryStatus(
        `Created a replay seed from ${source.title}. Original prompts will run only when you choose them.${skippedConversationNote(skippedRecords)}`,
      );
    } catch (failure) {
      setError(failureMessage(failure));
      setHistoryStatus("The source conversation could not be saved as a replay seed.");
    } finally {
      replayTransitionPending.current = false;
      setHistoryReady(true);
    }
  };

  const removeConversation = async () => {
    if (!historyReady || replayTransitionPending.current) return;
    if (!window.confirm(`Delete “${conversationName}” from this browser?`)) return;
    ++saveVersion.current;
    setHistoryReady(false);
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    try {
      await saveTail.current.catch(() => undefined);
      await deleteConversation(conversationId);
      const { conversations: remaining, skippedRecords } = await listConversations();
      setConversationSummaries(remaining);
      const next = remaining[0];
      if (next === undefined) {
        newConversation();
      } else {
        const record = await getConversation(next.id);
        if (record !== undefined) applyConversation(record);
      }
      if (skippedRecords > 0)
        setHistoryStatus(`Conversation deleted.${skippedConversationNote(skippedRecords)}`);
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setHistoryReady(true);
    }
  };

  const importConversation = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined || !historyReady || replayTransitionPending.current) return;
    try {
      if (file.size > maximumChatImportBytes)
        throw new Error("The conversation file exceeds WebAI's 8 MiB import limit.");
      const record = importConversationText(await file.text());
      await putConversation(record);
      const { conversations: summaries, skippedRecords } = await listConversations();
      setConversationSummaries(summaries);
      applyConversation(record);
      setHistoryStatus(
        `Imported safely. No model was loaded and no prompt was run.${skippedConversationNote(skippedRecords)}`,
      );
    } catch (failure) {
      setError(failureMessage(failure));
      setHistoryStatus("The conversation import was rejected.");
    }
  };

  const promptApiSelectable =
    promptApiProbe?.verdict === "supported" || promptApiProbe?.verdict === "degraded";
  const activeView = runtimeViews[runtimeId];
  const activeDescriptor = activeView.descriptor;
  const activeModelName =
    runtimeId === "wllama" ? (selectedModel?.displayName ?? "model") : "Gemini Nano";
  const replayPageCount = Math.max(1, Math.ceil((replaySeed?.turns.length ?? 0) / replayPageSize));
  const boundedReplayPage = Math.min(replayPage, replayPageCount - 1);
  const replayPageStart = boundedReplayPage * replayPageSize;
  const visibleReplayTurns =
    replaySeed?.turns.slice(replayPageStart, replayPageStart + replayPageSize) ?? [];

  return (
    <div className="chat-workbench">
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      {error === undefined ? null : (
        <div className="model-alert" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>{activeDescriptor.displayName} operation failed</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      <div className="chat-layout">
        <aside className="chat-settings" aria-labelledby="runtime-settings-title">
          <div className="section-icon">
            <Settings2 aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">Runtime adapter</p>
            <h2 id="runtime-settings-title">{activeDescriptor.displayName} session</h2>
            <p className="field-help">{activeDescriptor.engineVersion}</p>
          </div>

          <section className="chat-history-controls" aria-labelledby="chat-history-title">
            <div className="chat-history-heading">
              <History aria-hidden="true" />
              <h3 id="chat-history-title">Conversations</h3>
            </div>
            <label htmlFor="chat-history-select">Saved conversation</label>
            <select
              id="chat-history-select"
              value={conversationId}
              onChange={(event) => void selectConversation(event.target.value)}
              disabled={!historyReady || loading || generating}
            >
              {!conversationSummaries.some((item) => item.id === conversationId) ? (
                <option value={conversationId}>{conversationName}</option>
              ) : null}
              {conversationSummaries.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.messageCount} messages
                </option>
              ))}
            </select>
            <label htmlFor="chat-conversation-name">Conversation name</label>
            <input
              id="chat-conversation-name"
              type="text"
              maxLength={200}
              value={conversationName}
              onChange={(event) => setConversationName(event.target.value)}
              disabled={!historyReady || loading || generating}
            />
            <div className="chat-history-actions">
              <Button onClick={newConversation} disabled={!historyReady || loading || generating}>
                <Plus aria-hidden="true" /> New
              </Button>
              <Button
                onClick={() => void startManualReplay()}
                disabled={
                  !historyReady ||
                  loading ||
                  generating ||
                  !messages.some(
                    (message) => message.role === "user" && message.content.trim().length > 0,
                  )
                }
              >
                <RotateCcw aria-hidden="true" /> Manual replay
              </Button>
              <Button
                onClick={() => void removeConversation()}
                disabled={!historyReady || loading || generating}
              >
                <Trash2 aria-hidden="true" /> Delete
              </Button>
              <Button
                onClick={() =>
                  downloadText(
                    `${safeFilename(conversationRecord.title)}.json`,
                    "application/json",
                    exportConversationJson(conversationRecord),
                  )
                }
              >
                <Download aria-hidden="true" /> JSON
              </Button>
              <Button
                onClick={() =>
                  downloadText(
                    `${safeFilename(conversationRecord.title)}.md`,
                    "text/markdown",
                    exportConversationMarkdown(conversationRecord),
                  )
                }
              >
                <Download aria-hidden="true" /> Markdown
              </Button>
              <Button
                onClick={() => importInput.current?.click()}
                disabled={!historyReady || loading || generating}
              >
                <Upload aria-hidden="true" /> Import
              </Button>
              <input
                ref={importInput}
                className="visually-hidden"
                type="file"
                accept="application/json,text/markdown,.json,.md"
                aria-label="Import conversation"
                onChange={(event) => void importConversation(event)}
              />
            </div>
            <p className="field-help" role="status">
              {historyStatus}
            </p>
          </section>

          <label htmlFor="chat-system-prompt">System prompt</label>
          <textarea
            id="chat-system-prompt"
            rows={4}
            maxLength={64 * 1024}
            value={systemPrompt}
            onChange={(event) => {
              setSystemPrompt(event.target.value);
              if (runtimeId === "prompt-api" && session !== undefined) {
                invalidateSession();
                setStatus("System prompt changed. Reload Gemini Nano to apply it.");
              }
            }}
            disabled={!historyReady || loading || generating}
          />

          <fieldset
            className="runtime-choice-grid"
            disabled={!historyReady || loading || generating}
          >
            <legend>Runtime</legend>
            <label>
              <input
                type="radio"
                name="chat-runtime"
                checked={runtimeId === "wllama"}
                onChange={() => changeRuntime("wllama")}
              />
              wllama · managed GGUF
            </label>
            <label>
              <input
                type="radio"
                name="chat-runtime"
                aria-describedby="prompt-api-gate-reason"
                checked={runtimeId === "prompt-api"}
                disabled={!promptApiSelectable}
                onChange={() => changeRuntime("prompt-api")}
              />
              Chrome Prompt API · Gemini Nano
            </label>
          </fieldset>

          <div
            id="prompt-api-gate-reason"
            className={`runtime-capability status-${promptApiProbe?.verdict ?? "unknown"}`}
          >
            {promptApiProbe?.verdict === "supported" ? (
              <CircleCheck aria-hidden="true" />
            ) : promptApiProbe?.verdict === "degraded" ? (
              <TriangleAlert aria-hidden="true" />
            ) : promptApiProbe?.verdict === "unsupported" ? (
              <CircleX aria-hidden="true" />
            ) : (
              <CircleHelp aria-hidden="true" />
            )}
            <div>
              <strong>
                {promptApiProbe === undefined
                  ? "Checking Gemini Nano"
                  : promptApiProbe.verdict === "unknown"
                    ? "Gemini Nano status unknown"
                    : promptApiProbe.availability === "available"
                      ? "Gemini Nano ready"
                      : promptApiProbe.availability === "downloadable"
                        ? "Gemini Nano download required"
                        : promptApiProbe.availability === "downloading"
                          ? "Gemini Nano downloading"
                          : "Gemini Nano unavailable"}
              </strong>
              <p>
                {promptApiProbe?.explanation ??
                  "Checking this browser's window-only LanguageModel surface and model availability."}
              </p>
              {promptApiProbe !== undefined && !promptApiSelectable ? (
                <Button
                  onClick={() => refreshPromptApiProbe()}
                  disabled={promptProbing}
                  aria-busy={promptProbing}
                >
                  {promptApiProbe.verdict === "unknown"
                    ? "Retry availability check"
                    : "Refresh availability"}
                </Button>
              ) : null}
            </div>
          </div>

          {runtimeId === "wllama" ? (
            <>
              <label htmlFor="chat-model">Managed GGUF model</label>
              <select
                id="chat-model"
                value={selectedModelId}
                onChange={(event) => changeModel(event.target.value)}
                disabled={!historyReady || loading || generating}
              >
                {models.length === 0 ? <option value="">No installed models</option> : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>

              {selectedCompatibility?.status === "needs-split" ? (
                <div className="chat-model-compatibility status-degraded">
                  <Scissors aria-hidden="true" />
                  <div>
                    <strong>Preparation required</strong>
                    <p>{selectedCompatibility.explanation}</p>
                  </div>
                </div>
              ) : selectedCompatibility?.status === "incompatible" ? (
                <div className="chat-model-compatibility status-unsupported">
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>Not compatible with wllama</strong>
                    <p>{selectedCompatibility.explanation}</p>
                  </div>
                </div>
              ) : null}

              <div className="runtime-axis-grid">
                <label>
                  WASM threads
                  <input
                    type="number"
                    min="1"
                    max={hardwareThreadLimit}
                    value={threads}
                    onChange={(event) => {
                      const next = boundedInteger(event.target.value, 1, 1);
                      if (next !== threads) invalidateWllamaConfiguration();
                      setThreads(next);
                    }}
                    disabled={!historyReady || selectedModel === undefined || loading || generating}
                  />
                </label>
                <label>
                  Context (K tokens)
                  <input
                    type="number"
                    min={Math.min(1, (selectedContextLimit ?? maximumDeclaredContextTokens) / 1024)}
                    step="any"
                    max={(selectedContextLimit ?? maximumDeclaredContextTokens) / 1024}
                    value={contextKInput}
                    onChange={(event) => {
                      contextModelId.current = selectedContextModelId;
                      contextEdited.current = true;
                      setContextKInput(event.target.value);
                    }}
                    onBlur={() => {
                      const nextContextSize = contextSizeFromK(
                        contextKInput,
                        selectedContextLimit,
                        contextSize,
                      );
                      if (nextContextSize !== contextSize) invalidateWllamaConfiguration();
                      setContextSize(nextContextSize);
                      setContextKInput(contextKValue(nextContextSize));
                    }}
                    disabled={!historyReady || selectedModel === undefined || loading || generating}
                  />
                  <span className="field-help">
                    {selectedContextLimit === undefined
                      ? "No model-declared maximum; using a 2 K-token fallback. 1 K = 1,024 tokens. Manual values round up to the next whole K."
                      : `Model-declared maximum: ${contextKLabel(selectedContextLimit)} K tokens. 1 K = 1,024 tokens. Manual values round up to the next whole K. Large contexts can require substantial browser memory.`}
                  </span>
                </label>
              </div>

              <fieldset disabled={!historyReady || loading || generating}>
                <legend>WebGPU layer offload</legend>
                <label>
                  <input
                    type="radio"
                    name="gpu-offload"
                    checked={gpuMode === "full"}
                    onChange={() => {
                      if (gpuMode !== "full") invalidateWllamaConfiguration();
                      setGpuMode("full");
                    }}
                  />
                  Full (wllama default)
                </label>
                <label>
                  <input
                    type="radio"
                    name="gpu-offload"
                    checked={gpuMode === "partial"}
                    onChange={() => {
                      if (gpuMode !== "partial") invalidateWllamaConfiguration();
                      setGpuMode("partial");
                    }}
                  />
                  Partial
                </label>
                {gpuMode === "partial" ? (
                  <label>
                    GPU layers
                    <input
                      type="number"
                      min="1"
                      value={gpuLayers}
                      onChange={(event) => {
                        const next = boundedInteger(event.target.value, 1, 1);
                        if (next !== gpuLayers) invalidateWllamaConfiguration();
                        setGpuLayers(next);
                      }}
                    />
                  </label>
                ) : null}
                <label>
                  <input
                    type="radio"
                    name="gpu-offload"
                    checked={gpuMode === "off"}
                    onChange={() => {
                      if (gpuMode !== "off") invalidateWllamaConfiguration();
                      setGpuMode("off");
                    }}
                  />
                  CPU only
                </label>
              </fieldset>
            </>
          ) : (
            <>
              <label htmlFor="chat-browser-model">Browser-managed model</label>
              <select id="chat-browser-model" value="gemini-nano" disabled>
                <option value="gemini-nano">Gemini Nano · managed by Chrome</option>
              </select>
              <div className="runtime-capability status-degraded">
                <TriangleAlert aria-hidden="true" />
                <div>
                  <strong>Browser-managed session parameters</strong>
                  <p>
                    Stable web pages do not expose sampling controls or backend selection. Chrome
                    chooses them; the session reports only its effective context usage and window.
                  </p>
                </div>
              </div>
            </>
          )}

          <fieldset
            className="generation-controls"
            disabled={!historyReady || runtimeId !== "wllama" || generating}
          >
            <legend>Generation parameters</legend>
            <div className="runtime-axis-grid">
              <label>
                Temperature
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.05"
                  value={temperature}
                  onChange={(event) =>
                    setTemperature(
                      boundedNumber(event.target.value, 0, 2, wllamaGenerationDefaults.temperature),
                    )
                  }
                />
              </label>
              <label>
                Top P
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={topP}
                  onChange={(event) =>
                    setTopP(boundedNumber(event.target.value, 0, 1, wllamaGenerationDefaults.topP))
                  }
                />
              </label>
              <label>
                Top K
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={topK}
                  onChange={(event) =>
                    setTopK(
                      Math.min(
                        10_000,
                        boundedInteger(event.target.value, 0, wllamaGenerationDefaults.topK),
                      ),
                    )
                  }
                />
              </label>
              <label>
                Repeat penalty
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.05"
                  value={repeatPenalty}
                  onChange={(event) =>
                    setRepeatPenalty(
                      boundedNumber(
                        event.target.value,
                        0,
                        2,
                        wllamaGenerationDefaults.repeatPenalty,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Seed
                <input
                  type="number"
                  min="0"
                  max="4294967294"
                  step="1"
                  placeholder="Random"
                  value={seedInput}
                  onChange={(event) => setSeedInput(event.target.value)}
                />
              </label>
              <label>
                Max output tokens
                <input
                  type="number"
                  min="1"
                  max="1048576"
                  step="1"
                  placeholder="EOS / context"
                  value={maxTokensInput}
                  onChange={(event) => setMaxTokensInput(event.target.value)}
                />
              </label>
            </div>
            <p className="field-help">
              {runtimeId === "wllama"
                ? "Blank seed uses runtime randomness; blank max output continues until EOS or the configured context. Values are snapshotted per response."
                : "Chrome's stable web Prompt API does not expose sampling, seed, repeat penalty, or output-token limits."}
            </p>
          </fieldset>

          <div className="runtime-capability status-supported">
            <CircleCheck aria-hidden="true" />
            <div>
              <strong>
                {activeDescriptor.contextCaching.kind === "runtime-prefix-kv"
                  ? "Prefix-cache evidence"
                  : "Browser-managed conversation state"}
              </strong>
              <p>{activeDescriptor.contextCaching.explanation}</p>
            </div>
          </div>

          <Button
            variant="primary"
            onClick={() => void load()}
            disabled={
              !historyReady ||
              (runtimeId === "wllama" &&
                (selectedModel === undefined ||
                  selectedCompatibility?.status === "incompatible")) ||
              (runtimeId === "prompt-api" && !promptApiSelectable) ||
              loading ||
              generating
            }
            aria-busy={loading}
          >
            <Play aria-hidden="true" />
            {loading
              ? "Loading model"
              : runtimeId === "prompt-api"
                ? session === undefined
                  ? promptApiProbe?.availability === "downloadable" ||
                    promptApiProbe?.availability === "downloading"
                    ? "Download and load Gemini Nano"
                    : "Load Gemini Nano"
                  : "Reload Gemini Nano session"
                : selectedCompatibility?.status === "needs-split"
                  ? "Prepare and load model"
                  : session === undefined
                    ? "Load model"
                    : "Reload session"}
          </Button>

          {!splittingModel || selectedModel === undefined ? null : (
            <Button onClick={() => modelClient.current?.pause(selectedModel.id)}>
              <Pause aria-hidden="true" />
              Stop model preparation
            </Button>
          )}

          {runtimeId !== "prompt-api" || !loading ? null : (
            <Button onClick={() => void promptApiAdapter.current?.dispose()}>
              <Square aria-hidden="true" />
              Stop Gemini Nano loading
            </Button>
          )}

          {!loading || loadProgress === undefined ? null : (
            <div className="chat-load-progress" aria-busy="true">
              <strong>{loadProgress.label}</strong>
              <p>
                {loadProgress.detail} · {formatDuration(loadElapsedMs)} elapsed
              </p>
              {loadProgress.completed === undefined || loadProgress.total === undefined ? (
                <progress aria-label={`${loadProgress.label} for ${activeModelName}`} />
              ) : (
                <progress
                  aria-label={`${loadProgress.label} for ${activeModelName}`}
                  max={loadProgress.total}
                  value={loadProgress.completed}
                />
              )}
            </div>
          )}

          {session === undefined ? null : session.runtimeId === "wllama" ? (
            <dl className="session-metrics">
              <div>
                <dt>Model load</dt>
                <dd>{formatDuration(session.loadTimeMs)}</dd>
              </div>
              <div>
                <dt>Effective threads</dt>
                <dd>{session.backend.threads}</dd>
              </div>
              <div>
                <dt>GPU layers</dt>
                <dd>{session.backend.gpuLayers === 99_999 ? "All" : session.backend.gpuLayers}</dd>
              </div>
            </dl>
          ) : (
            <dl className="session-metrics">
              <div>
                <dt>Session load</dt>
                <dd>{formatDuration(session.loadTimeMs)}</dd>
              </div>
              <div>
                <dt>Context used</dt>
                <dd>{session.contextUsage.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Context window</dt>
                <dd>{session.contextWindow.toLocaleString()}</dd>
              </div>
            </dl>
          )}

          {runtimeId === "wllama" ? (
            <div className="runtime-capability status-unsupported">
              <TriangleAlert aria-hidden="true" />
              <div>
                <strong>MTP unavailable</strong>
                <p>{wllamaDescriptor.mtp.explanation}</p>
              </div>
            </div>
          ) : null}
        </aside>

        <section className="chat-panel" aria-labelledby="chat-stream-title" aria-busy={loading}>
          <div className="chat-panel-heading">
            <div>
              <p className="eyebrow">Measured conversation</p>
              <h2 id="chat-stream-title">Chat stream</h2>
            </div>
            <span
              className={`status-badge ${loading ? "status-degraded" : session === undefined ? "status-unknown" : "status-supported"}`}
            >
              <Bot aria-hidden="true" />
              {loading
                ? "Loading"
                : session === undefined
                  ? "No session"
                  : generating
                    ? "Streaming"
                    : "Ready"}
            </span>
          </div>

          {replaySeed === undefined ? null : (
            <section className="replay-comparison" aria-labelledby="replay-comparison-title">
              <div className="replay-comparison-heading">
                <div>
                  <p className="eyebrow">Manual replay seed</p>
                  <h3 id="replay-comparison-title">Compare with “{replaySeed.sourceTitle}”</h3>
                </div>
                <span>{replaySeed.turns.length} source prompts</span>
              </div>
              <p className="field-help">
                Edit and send any source prompt in the order you choose. Original prompts and
                answers are reference-only and are never injected into this conversation.
              </p>
              {systemPrompt === replaySeed.systemPrompt ? null : (
                <p className="chat-message-warning">
                  <TriangleAlert aria-hidden="true" /> The system prompt has changed since this
                  replay seed was captured.
                </p>
              )}
              {replayPageCount === 1 ? null : (
                <nav className="replay-pagination" aria-label="Replay source prompts">
                  <Button
                    onClick={() => setReplayPage(Math.max(0, boundedReplayPage - 1))}
                    disabled={boundedReplayPage === 0 || generating}
                  >
                    Previous prompts
                  </Button>
                  <span>
                    Page {boundedReplayPage + 1} of {replayPageCount}
                  </span>
                  <Button
                    onClick={() =>
                      setReplayPage(Math.min(replayPageCount - 1, boundedReplayPage + 1))
                    }
                    disabled={boundedReplayPage === replayPageCount - 1 || generating}
                  >
                    Next prompts
                  </Button>
                </nav>
              )}
              <ol className="replay-turn-list">
                {visibleReplayTurns.map((turn, index) => {
                  const sourceOrdinal = replayPageStart + index + 1;
                  const replayed = replayMessagesByTurn.get(turn.id);
                  const replayedUser = replayed?.user;
                  const replayedAssistant = replayed?.assistant;
                  const generatingThisResponse =
                    generating && messages.at(-1)?.id === replayedAssistant?.id;
                  const replayPrompt =
                    replayedUser?.content ?? replayDrafts.get(turn.id) ?? turn.user.content;
                  const emptyReplayPrompt = replayPrompt.trim().length === 0;
                  const originalSystemPromptDiffers =
                    turn.assistant?.execution?.systemPrompt !== undefined &&
                    turn.assistant.execution.systemPrompt !== replaySeed.systemPrompt;
                  return (
                    <li key={turn.id} className="replay-turn">
                      <div className="replay-prompt-heading">
                        <strong>Prompt {sourceOrdinal}</strong>
                        <Button
                          onClick={() => void sendReplayTurn(turn, replayPrompt)}
                          disabled={
                            session === undefined ||
                            generating ||
                            replayedUser !== undefined ||
                            emptyReplayPrompt
                          }
                          aria-label={
                            emptyReplayPrompt
                              ? `Prompt ${sourceOrdinal} to send is empty`
                              : replayedUser === undefined
                                ? `Send source prompt ${sourceOrdinal}`
                                : `Source prompt ${sourceOrdinal} sent`
                          }
                        >
                          <Send aria-hidden="true" />
                          {emptyReplayPrompt
                            ? "Enter a prompt"
                            : replayedUser === undefined
                              ? "Send prompt"
                              : "Sent"}
                        </Button>
                      </div>
                      <div className="replay-prompt-grid">
                        <article>
                          <strong>Original prompt</strong>
                          <p>{turn.user.content || "The source prompt was empty."}</p>
                        </article>
                        <label>
                          <strong>Prompt to send</strong>
                          <textarea
                            rows={3}
                            maxLength={maximumChatMessageCharacters}
                            aria-label={`Prompt ${sourceOrdinal} to send`}
                            value={replayPrompt}
                            onChange={(event) => {
                              const value = event.target.value;
                              setReplayDrafts((current) => {
                                const next = new Map(current);
                                next.set(turn.id, value);
                                return next;
                              });
                            }}
                            disabled={!historyReady || generating || replayedUser !== undefined}
                          />
                        </label>
                      </div>
                      {originalSystemPromptDiffers ? (
                        <p className="chat-message-warning">
                          <TriangleAlert aria-hidden="true" /> The original response used a
                          different system prompt than this replay seed.
                        </p>
                      ) : null}
                      <div className="replay-response-grid">
                        <article>
                          <strong>Original response</strong>
                          <p>
                            {turn.assistant?.content ||
                              (turn.assistant === undefined
                                ? "No original response was saved."
                                : turn.assistant.failure === undefined
                                  ? "The runtime returned no visible text."
                                  : "The original response failed without returning text.")}
                          </p>
                          {turn.assistant?.failure !== undefined &&
                          turn.assistant.content.length > 0 ? (
                            <span className="replay-response-failure">
                              {turn.assistant.failure.code === "aborted" ? "Stopped" : "Failed"};
                              partial output shown.
                            </span>
                          ) : null}
                        </article>
                        <article>
                          <strong>New response</strong>
                          <p>
                            {replayedAssistant?.content ||
                              (replayedAssistant === undefined
                                ? replayedUser === undefined
                                  ? "Not sent yet."
                                  : "Waiting for the new response."
                                : replayedAssistant.failure === undefined
                                  ? generatingThisResponse
                                    ? "Generating…"
                                    : "The runtime returned no visible text."
                                  : "The new response failed without returning text.")}
                          </p>
                          {replayedAssistant?.failure !== undefined &&
                          replayedAssistant.content.length > 0 ? (
                            <span className="replay-response-failure">
                              {replayedAssistant.failure.code === "aborted" ? "Stopped" : "Failed"};
                              partial output shown.
                            </span>
                          ) : null}
                        </article>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          <div className="chat-stream" aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <Bot aria-hidden="true" />
                <h3>
                  {loading
                    ? "Loading the selected model"
                    : session === undefined
                      ? "Load a model to begin"
                      : "Send the first measured prompt"}
                </h3>
                <p>{loading ? activeView.loadingHelp : activeView.readyHelp}</p>
              </div>
            ) : (
              messages.map((message, messageIndex) => {
                const messageView = runtimeViews[message.runtimeId];
                const intermediateChannels =
                  message.channels?.filter((channel) => !channel.final) ?? [];
                const missingFinalResponse =
                  message.role === "assistant" &&
                  !generating &&
                  message.metrics !== undefined &&
                  message.content.length === 0;
                return (
                  <article key={message.id} className={`chat-message chat-message-${message.role}`}>
                    <div className="chat-message-role">
                      {message.role === "user" ? (
                        <User aria-hidden="true" />
                      ) : (
                        <Bot aria-hidden="true" />
                      )}
                      <strong>
                        {message.role === "user" ? "You" : messageView.descriptor.displayName}
                      </strong>
                    </div>
                    {intermediateChannels.length === 0 ? null : (
                      <div className="response-channels">
                        {intermediateChannels.map((channel) => (
                          <ResponseChannelDetails key={channel.id} channel={channel} />
                        ))}
                      </div>
                    )}
                    {message.role === "user" && editingMessageId === message.id ? (
                      <div className="chat-message-editor">
                        <label htmlFor={`edit-${message.id}`}>Edit message</label>
                        <textarea
                          id={`edit-${message.id}`}
                          rows={4}
                          maxLength={maximumChatMessageCharacters}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                        />
                        <div className="chat-message-actions">
                          <Button onClick={() => void resendEdit(messageIndex)}>
                            <Send aria-hidden="true" /> Resend and replace later turns
                          </Button>
                          <Button onClick={() => setEditingMessageId(undefined)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <p className="chat-message-content">
                        {message.content ||
                          (message.role === "assistant" && generating
                            ? intermediateChannels.length === 0
                              ? "Generating…"
                              : ""
                            : missingFinalResponse
                              ? messageView.emptyResponse
                              : message.failure?.code === "aborted"
                                ? "Generation stopped before the runtime returned text."
                                : message.failure !== undefined
                                  ? "The runtime stopped without returning text."
                                  : "")}
                      </p>
                    )}
                    <div className="chat-message-actions">
                      {message.role === "user" &&
                      message.replaySourceTurnId === undefined &&
                      editingMessageId !== message.id ? (
                        <Button
                          onClick={() => {
                            setEditingMessageId(message.id);
                            setEditDraft(message.content);
                          }}
                          disabled={session === undefined || generating}
                          aria-label={`Edit user turn ${messageIndex + 1}`}
                        >
                          <Pencil aria-hidden="true" /> Edit and resend
                        </Button>
                      ) : null}
                      {message.role === "assistant" && messageIndex === messages.length - 1 ? (
                        <Button
                          onClick={() => void regenerate(messageIndex)}
                          disabled={session === undefined || generating}
                        >
                          <RotateCcw aria-hidden="true" /> Regenerate
                        </Button>
                      ) : null}
                    </div>
                    {message.warnings?.map((warning, index) => (
                      <p key={`${warning.code}-${index}`} className="chat-message-warning">
                        <TriangleAlert aria-hidden="true" /> {warning.message}
                      </p>
                    ))}
                    {message.failure === undefined ? null : (
                      <p className="chat-message-failure">
                        {message.failure.code === "aborted"
                          ? "Stopped response"
                          : "Response failed"}
                        {message.content.length > 0 ? ". Partial output remains visible." : "."}
                      </p>
                    )}
                    {message.outputDiagnostics === undefined ? null : (
                      <OutputDiagnosticsDetails diagnostics={message.outputDiagnostics} />
                    )}
                    {message.metrics === undefined ? null : (
                      <dl className="response-metrics">
                        <div>
                          <dt>Load</dt>
                          <dd>{formatDuration(message.metrics.loadTimeMs)}</dd>
                        </div>
                        <div>
                          <dt>{messageView.firstOutputLabel}</dt>
                          <dd>{formatDuration(messageView.firstOutputMetric(message.metrics))}</dd>
                        </div>
                        {messageView.showsTokenMetrics ? (
                          <>
                            <div>
                              <dt>Prefill</dt>
                              <dd>{formatRate(message.metrics.prefillTokensPerSecond)}</dd>
                            </div>
                            <div>
                              <dt>Decode</dt>
                              <dd>{formatRate(message.metrics.decodeTokensPerSecond)}</dd>
                            </div>
                          </>
                        ) : null}
                        <div>
                          <dt>End to end</dt>
                          <dd>{formatDuration(message.metrics.totalTimeMs)}</dd>
                        </div>
                        {messageView.showsTokenMetrics ? (
                          <div>
                            <dt>Tokens</dt>
                            <dd>
                              {message.metrics.promptTokens ?? "?"} in ·{" "}
                              {message.metrics.completionTokens ?? "?"} out
                              {message.metrics.evaluatedPromptTokens === undefined
                                ? ""
                                : ` · ${message.metrics.evaluatedPromptTokens} evaluated`}
                            </dd>
                          </div>
                        ) : (
                          <div>
                            <dt>Context</dt>
                            <dd>
                              {message.metrics.contextUsage?.toLocaleString() ?? "?"} /{" "}
                              {message.metrics.contextWindow?.toLocaleString() ?? "?"}
                            </dd>
                          </div>
                        )}
                        {message.metrics.cachedPromptTokens === undefined ? null : (
                          <div>
                            <dt>Cached prefix</dt>
                            <dd>{message.metrics.cachedPromptTokens.toLocaleString()} tokens</dd>
                          </div>
                        )}
                        {messageView.showsTokenMetrics &&
                        message.metrics.promptTokens !== undefined &&
                        message.metrics.completionTokens !== undefined ? (
                          <div>
                            <dt>Context</dt>
                            <dd>
                              {(
                                message.metrics.promptTokens + message.metrics.completionTokens
                              ).toLocaleString()}{" "}
                              / {(message.metrics.contextWindow ?? contextSize).toLocaleString()}{" "}
                              tokens
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    )}
                    {message.controlOutcomes === undefined ? null : (
                      <details className="response-token-inspector">
                        <summary>
                          Generation request · {message.controlOutcomes.length} controls
                        </summary>
                        <ul>
                          {message.controlOutcomes.map((outcome) => (
                            <li key={outcome.control}>
                              <code>{outcome.control}</code>: {String(outcome.requested)} ·{" "}
                              {outcome.status}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {message.tokenization === undefined ? null : (
                      <details className="response-token-inspector">
                        <summary>
                          Tokenizer inspector · {message.tokenization.tokens.length} sampled output
                          pieces
                        </summary>
                        <p>{messageView.descriptor.tokenizerInspection.explanation}</p>
                        <ol>
                          {message.tokenization.tokens.map((token, index) => (
                            <li key={`${token.id}-${index}`}>
                              <code>{token.id}</code> <code>{JSON.stringify(token.text)}</code>
                            </li>
                          ))}
                        </ol>
                        {message.tokenization.omittedTokens === 0 ? null : (
                          <p>
                            {message.tokenization.omittedTokens} additional token records omitted.
                          </p>
                        )}
                      </details>
                    )}
                  </article>
                );
              })
            )}
          </div>

          {session === undefined ? null : (
            <div className="chat-context-usage">
              <strong>Context usage</strong>
              {session.runtimeId === "prompt-api" ? (
                <>
                  <span>
                    {session.contextUsage.toLocaleString()} /{" "}
                    {session.contextWindow.toLocaleString()} browser context units
                  </span>
                  <progress
                    aria-label="Gemini Nano context usage"
                    max={Number.isFinite(session.contextWindow) ? session.contextWindow : 1}
                    value={Number.isFinite(session.contextWindow) ? session.contextUsage : 0}
                  />
                </>
              ) : (
                (() => {
                  const metrics = [...messages]
                    .reverse()
                    .find((message) => message.metrics !== undefined)?.metrics;
                  const used =
                    metrics?.promptTokens === undefined || metrics.completionTokens === undefined
                      ? 0
                      : metrics.promptTokens + metrics.completionTokens;
                  return (
                    <>
                      <span>
                        {used === 0 ? "Not measured yet" : used.toLocaleString()} /{" "}
                        {session.backend.contextSize.toLocaleString()} tokens
                      </span>
                      <progress
                        aria-label="wllama context usage"
                        max={session.backend.contextSize}
                        value={used}
                      />
                    </>
                  );
                })()
              )}
            </div>
          )}

          <form className="chat-composer" onSubmit={(event) => void submit(event)}>
            <label htmlFor="chat-prompt">Message</label>
            <textarea
              id="chat-prompt"
              rows={3}
              maxLength={maximumChatMessageCharacters}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                session === undefined ? "Load a model first" : activeView.composerPlaceholder
              }
              disabled={!historyReady || session === undefined || generating}
            />
            <div className="chat-composer-actions">
              <div className="chat-composer-context">
                <label className="chat-thinking-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Thinking"
                    aria-describedby="chat-thinking-help"
                    aria-checked={runtimeId === "wllama" && thinkingEnabled}
                    checked={runtimeId === "wllama" && thinkingEnabled}
                    onChange={(event) => setThinkingEnabled(event.target.checked)}
                    disabled={!historyReady || runtimeId !== "wllama" || generating}
                  />
                  <Brain aria-hidden="true" />
                  <span>Thinking</span>
                  <strong>
                    {runtimeId === "wllama" ? (thinkingEnabled ? "On" : "Off") : "Unavailable"}
                  </strong>
                </label>
                <p id="chat-thinking-help">
                  {runtimeId === "wllama"
                    ? "Sent with each prompt. Compatible model chat templates honor the request; others may ignore it."
                    : "Chrome's Prompt API does not expose a thinking control."}
                </p>
                <p>
                  <Gauge aria-hidden="true" /> {activeView.metricsHelp}
                </p>
              </div>
              <Button
                variant="primary"
                type={generating ? "button" : "submit"}
                {...(generating ? { onClick: stopGeneration } : {})}
                disabled={
                  !historyReady || session === undefined || (!generating && prompt.trim() === "")
                }
              >
                {generating ? <Square aria-hidden="true" /> : <Send aria-hidden="true" />}
                {generating ? "Stop" : "Send"}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
