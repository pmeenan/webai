import {
  Bot,
  Brain,
  CircleCheck,
  CircleHelp,
  CircleX,
  Gauge,
  Pause,
  Play,
  Scissors,
  Send,
  Settings2,
  Square,
  TriangleAlert,
  User,
} from "lucide-react";
import { type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  type PromptApiProbe,
  PromptApiRuntimeAdapter,
  promptApiDescriptor,
} from "../lib/runtimes/prompt-api";
import type {
  ChatMessage,
  ModelOutputDiagnostics,
  ResponseChannel,
  ResponseMetrics,
  RuntimeAdapter,
  RuntimeDescriptor,
  RuntimeId,
  RuntimeLoadEvent,
  RuntimeSession,
} from "../lib/runtimes/types";
import { WllamaRuntimeAdapter, wllamaDescriptor } from "../lib/runtimes/wllama";
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

export default function ChatWorkbench() {
  const wllamaAdapter = useRef<WllamaRuntimeAdapter | undefined>(undefined);
  const promptApiAdapter = useRef<PromptApiRuntimeAdapter | undefined>(undefined);
  const modelClient = useRef<ModelWorkerClient | undefined>(undefined);
  const loadingModelId = useRef<string | undefined>(undefined);
  const contextModelId = useRef<string | undefined>(undefined);
  const contextEdited = useRef(false);
  const generationController = useRef<AbortController | undefined>(undefined);
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
    const reportedThreads = navigator.hardwareConcurrency;
    const availableThreads =
      Number.isSafeInteger(reportedThreads) && reportedThreads > 0 ? reportedThreads : 1;
    setHardwareThreadLimit(availableThreads);
    setThreads(Math.max(1, Math.floor(availableThreads / 2)));
    const runtime = new WllamaRuntimeAdapter();
    const browserRuntime = new PromptApiRuntimeAdapter();
    const client = new ModelWorkerClient();
    wllamaAdapter.current = runtime;
    promptApiAdapter.current = browserRuntime;
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
        const first = next.models.find((model) => model.state === "installed");
        if (first !== undefined) setSelectedModelId(first.id);
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
    return () => {
      generationController.current?.abort();
      generationController.current = undefined;
      if (assistantFrame.current !== undefined) {
        window.cancelAnimationFrame(assistantFrame.current);
        assistantFrame.current = undefined;
      }
      unsubscribe();
      client.dispose();
      void runtime.dispose();
      void browserRuntime.dispose();
      modelClient.current = undefined;
      wllamaAdapter.current = undefined;
      promptApiAdapter.current = undefined;
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
    if (selectedContextModelId === undefined) return;
    if (contextModelId.current === selectedContextModelId && contextEdited.current) return;
    if (contextModelId.current !== selectedContextModelId) {
      contextModelId.current = selectedContextModelId;
      contextEdited.current = false;
    }
    const nextContextSize = boundedContextSize(selectedContextLimit ?? 2_048, selectedContextLimit);
    setContextSize(nextContextSize);
    setContextKInput(contextKValue(nextContextSize));
  }, [selectedContextLimit, selectedContextModelId]);

  const changeModel = (modelId: string) => {
    setSelectedModelId(modelId);
    contextModelId.current = undefined;
    contextEdited.current = false;
    setSession(undefined);
    setMessages([]);
    setError(undefined);
    setLoadProgress(undefined);
    setStatus("Model selection changed. Load a new wllama session to continue.");
    void wllamaAdapter.current?.dispose();
  };

  const changeRuntime = (nextRuntimeId: RuntimeId) => {
    if (nextRuntimeId === runtimeId || loading || generating) return;
    generationController.current?.abort();
    generationController.current = undefined;
    setRuntimeId(nextRuntimeId);
    setSession(undefined);
    setMessages([]);
    setError(undefined);
    setLoadProgress(undefined);
    setStatus(runtimeViews[nextRuntimeId].selectedStatus);
    void wllamaAdapter.current?.dispose();
    void promptApiAdapter.current?.dispose();
  };

  const load = async () => {
    if (runtimeId === "prompt-api") {
      const runtime = promptApiAdapter.current;
      if (runtime === undefined) return;
      setLoadElapsedMs(0);
      setLoading(true);
      setError(undefined);
      setSession(undefined);
      setMessages([]);
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
        const loaded = await runtime.createSession((event) => {
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
        });
        setSession(loaded);
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
    const runtime = wllamaAdapter.current;
    const client = modelClient.current;
    if (runtime === undefined || client === undefined || selectedModel === undefined) return;
    setLoadElapsedMs(0);
    setLoading(true);
    loadingModelId.current = selectedModel.id;
    setError(undefined);
    setSession(undefined);
    setMessages([]);
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
      const loaded = await runtime.createSession(
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
      setSession(loaded);
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

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const runtime: RuntimeAdapter | undefined =
      runtimeId === "wllama" ? wllamaAdapter.current : promptApiAdapter.current;
    const text = prompt.trim();
    if (runtime === undefined || session === undefined || text.length === 0 || generating) return;
    const user: ChatMessage = { id: makeId("user"), runtimeId, role: "user", content: text };
    const assistantId = makeId("assistant");
    const history = [...messages, user];
    setMessages([...history, { id: assistantId, runtimeId, role: "assistant", content: "" }]);
    setPrompt("");
    setGenerating(true);
    setError(undefined);
    setStatus(runtimeViews[runtimeId].generatingStatus);
    const controller = new AbortController();
    generationController.current = controller;
    let pendingText = "";
    let pendingChannels: ChatMessage["channels"];
    let pendingMetrics: ChatMessage["metrics"];
    let pendingOutputDiagnostics: ChatMessage["outputDiagnostics"];
    let pendingWarnings: ChatMessage["warnings"];
    let scheduledFrame: number | undefined;
    const flushAssistantUpdate = () => {
      scheduledFrame = undefined;
      assistantFrame.current = undefined;
      if (
        pendingText.length === 0 &&
        pendingChannels === undefined &&
        pendingMetrics === undefined &&
        pendingOutputDiagnostics === undefined &&
        pendingWarnings === undefined
      )
        return;
      const textUpdate = pendingText;
      const channelsUpdate = pendingChannels;
      const metricsUpdate = pendingMetrics;
      const diagnosticsUpdate = pendingOutputDiagnostics;
      const warningsUpdate = pendingWarnings;
      pendingText = "";
      pendingChannels = undefined;
      pendingMetrics = undefined;
      pendingOutputDiagnostics = undefined;
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
      await runtime.generate(
        history.map((message) => ({ role: message.role, content: message.content })),
        runtimeId === "wllama" ? { thinking: thinkingEnabled } : {},
        controller.signal,
        (runtimeEvent) => {
          if (runtimeEvent.type === "text") pendingText += runtimeEvent.text;
          if (runtimeEvent.type === "channels") pendingChannels = runtimeEvent.channels;
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
            pendingOutputDiagnostics = runtimeEvent.diagnostics;
          }
          if (runtimeEvent.type === "warning") {
            pendingWarnings = [...(pendingWarnings ?? []), runtimeEvent.warning];
          }
          scheduleAssistantUpdate();
        },
      );
      if (scheduledFrame !== undefined) window.cancelAnimationFrame(scheduledFrame);
      assistantFrame.current = undefined;
      flushAssistantUpdate();
      setStatus("Response complete. Metrics are attached to the response.");
    } catch (failure) {
      if (scheduledFrame !== undefined) window.cancelAnimationFrame(scheduledFrame);
      assistantFrame.current = undefined;
      flushAssistantUpdate();
      if (controller.signal.aborted) {
        if (runtimeId === "wllama") {
          setSession(undefined);
          setStatus(
            "Generation stopped. Review the partial response before reloading the model to continue.",
          );
        } else {
          setStatus("Generation stopped. Review the partial response before reloading the model.");
        }
      } else {
        setError(failureMessage(failure));
        setStatus(`${runtime.descriptor.displayName} generation failed.`);
      }
      const failureDetails = generationFailure(failure, controller.signal.aborted);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, failure: failureDetails } : message,
        ),
      );
    } finally {
      if (generationController.current === controller) generationController.current = undefined;
      setGenerating(false);
    }
  };

  const promptApiSelectable =
    promptApiProbe?.verdict === "supported" || promptApiProbe?.verdict === "degraded";
  const activeView = runtimeViews[runtimeId];
  const activeDescriptor = activeView.descriptor;
  const activeModelName =
    runtimeId === "wllama" ? (selectedModel?.displayName ?? "model") : "Gemini Nano";

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

          <fieldset className="runtime-choice-grid" disabled={loading || generating}>
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
                disabled={loading || generating}
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
                    onChange={(event) => setThreads(boundedInteger(event.target.value, 1, 1))}
                    disabled={selectedModel === undefined || loading || generating}
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
                      setContextSize(nextContextSize);
                      setContextKInput(contextKValue(nextContextSize));
                    }}
                    disabled={selectedModel === undefined || loading || generating}
                  />
                  <span className="field-help">
                    {selectedContextLimit === undefined
                      ? "No model-declared maximum; using a 2 K-token fallback. 1 K = 1,024 tokens. Manual values round up to the next whole K."
                      : `Model-declared maximum: ${contextKLabel(selectedContextLimit)} K tokens. 1 K = 1,024 tokens. Manual values round up to the next whole K. Large contexts can require substantial browser memory.`}
                  </span>
                </label>
              </div>

              <fieldset disabled={loading || generating}>
                <legend>WebGPU layer offload</legend>
                <label>
                  <input
                    type="radio"
                    name="gpu-offload"
                    checked={gpuMode === "full"}
                    onChange={() => setGpuMode("full")}
                  />
                  Full (wllama default)
                </label>
                <label>
                  <input
                    type="radio"
                    name="gpu-offload"
                    checked={gpuMode === "partial"}
                    onChange={() => setGpuMode("partial")}
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
                      onChange={(event) => setGpuLayers(boundedInteger(event.target.value, 1, 1))}
                    />
                  </label>
                ) : null}
                <label>
                  <input
                    type="radio"
                    name="gpu-offload"
                    checked={gpuMode === "off"}
                    onChange={() => setGpuMode("off")}
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

          <Button
            variant="primary"
            onClick={() => void load()}
            disabled={
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
              messages.map((message) => {
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
                      </dl>
                    )}
                  </article>
                );
              })
            )}
          </div>

          <form className="chat-composer" onSubmit={(event) => void submit(event)}>
            <label htmlFor="chat-prompt">Message</label>
            <textarea
              id="chat-prompt"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                session === undefined ? "Load a model first" : activeView.composerPlaceholder
              }
              disabled={session === undefined || generating}
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
                    disabled={runtimeId !== "wllama" || generating}
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
                {...(generating ? { onClick: () => generationController.current?.abort() } : {})}
                disabled={session === undefined || (!generating && prompt.trim() === "")}
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
