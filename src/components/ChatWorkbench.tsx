import {
  Bot,
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
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ModelWorkerEvent } from "../lib/models/protocol";
import {
  type InstalledModelRecord,
  type ModelInventory,
  maximumDeclaredContextTokens,
} from "../lib/models/types";
import { ModelWorkerClient } from "../lib/models/worker-client";
import { finalResponseText } from "../lib/runtimes/channel-parser";
import type {
  ChatMessage,
  ModelOutputDiagnostics,
  ResponseChannel,
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
  return "The wllama session could not complete this operation.";
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
  }
}

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
  const adapter = useRef<WllamaRuntimeAdapter | undefined>(undefined);
  const modelClient = useRef<ModelWorkerClient | undefined>(undefined);
  const loadingModelId = useRef<string | undefined>(undefined);
  const contextModelId = useRef<string | undefined>(undefined);
  const contextEdited = useRef(false);
  const generationController = useRef<AbortController | undefined>(undefined);
  const assistantFrame = useRef<number | undefined>(undefined);
  const [inventory, setInventory] = useState<ModelInventory | undefined>();
  const [selectedModelId, setSelectedModelId] = useState("");
  const [hardwareThreadLimit, setHardwareThreadLimit] = useState(1);
  const [threads, setThreads] = useState(1);
  const [gpuMode, setGpuMode] = useState<"full" | "partial" | "off">("full");
  const [gpuLayers, setGpuLayers] = useState(8);
  const [contextSize, setContextSize] = useState(2048);
  const [session, setSession] = useState<RuntimeSession | undefined>();
  const [loading, setLoading] = useState(false);
  const [splittingModel, setSplittingModel] = useState(false);
  const [loadProgress, setLoadProgress] = useState<ChatLoadProgress | undefined>();
  const [loadElapsedMs, setLoadElapsedMs] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState("Loading the managed-model inventory.");

  useEffect(() => {
    const reportedThreads = navigator.hardwareConcurrency;
    const availableThreads =
      Number.isSafeInteger(reportedThreads) && reportedThreads > 0 ? reportedThreads : 1;
    setHardwareThreadLimit(availableThreads);
    setThreads(Math.max(1, Math.floor(availableThreads / 2)));
    const runtime = new WllamaRuntimeAdapter();
    const client = new ModelWorkerClient();
    adapter.current = runtime;
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
        setStatus("Choose a model and load a wllama session.");
      })
      .catch((failure) => {
        setError(failureMessage(failure));
        setStatus("Managed models are unavailable.");
      });
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
      modelClient.current = undefined;
      adapter.current = undefined;
    };
  }, []);

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
    setContextSize(boundedContextSize(selectedContextLimit ?? 2_048, selectedContextLimit));
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
    void adapter.current?.dispose();
  };

  const load = async () => {
    const runtime = adapter.current;
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
      const effectiveContextSize = boundedContextSize(
        contextSize,
        wllamaModelContextLength(modelToLoad),
      );
      if (effectiveContextSize !== contextSize) setContextSize(effectiveContextSize);
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
    const runtime = adapter.current;
    const text = prompt.trim();
    if (runtime === undefined || session === undefined || text.length === 0 || generating) return;
    const user: ChatMessage = { id: makeId("user"), role: "user", content: text };
    const assistantId = makeId("assistant");
    const history = [...messages, user];
    setMessages([...history, { id: assistantId, role: "assistant", content: "" }]);
    setPrompt("");
    setGenerating(true);
    setError(undefined);
    setStatus("wllama is generating a measured response.");
    const controller = new AbortController();
    generationController.current = controller;
    let pendingText = "";
    let pendingChannels: ChatMessage["channels"];
    let pendingMetrics: ChatMessage["metrics"];
    let pendingOutputDiagnostics: ChatMessage["outputDiagnostics"];
    let scheduledFrame: number | undefined;
    const flushAssistantUpdate = () => {
      scheduledFrame = undefined;
      assistantFrame.current = undefined;
      if (
        pendingText.length === 0 &&
        pendingChannels === undefined &&
        pendingMetrics === undefined &&
        pendingOutputDiagnostics === undefined
      )
        return;
      const textUpdate = pendingText;
      const channelsUpdate = pendingChannels;
      const metricsUpdate = pendingMetrics;
      const diagnosticsUpdate = pendingOutputDiagnostics;
      pendingText = "";
      pendingChannels = undefined;
      pendingMetrics = undefined;
      pendingOutputDiagnostics = undefined;
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
        controller.signal,
        (runtimeEvent) => {
          if (runtimeEvent.type === "text") pendingText += runtimeEvent.text;
          if (runtimeEvent.type === "channels") pendingChannels = runtimeEvent.channels;
          if (runtimeEvent.type === "metrics") pendingMetrics = runtimeEvent.metrics;
          if (runtimeEvent.type === "output-diagnostics") {
            pendingOutputDiagnostics = runtimeEvent.diagnostics;
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
        setStatus("Generation stopped. The partial response remains visible.");
      } else {
        setError(failureMessage(failure));
        setStatus("wllama generation failed.");
      }
    } finally {
      if (generationController.current === controller) generationController.current = undefined;
      setGenerating(false);
    }
  };

  return (
    <div className="chat-workbench">
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      {error === undefined ? null : (
        <div className="model-alert" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>wllama operation failed</strong>
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
            <h2 id="runtime-settings-title">wllama session</h2>
            <p className="field-help">{wllamaDescriptor.engineVersion}</p>
          </div>

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
              Context tokens
              <input
                type="number"
                min="256"
                step="256"
                max={selectedContextLimit ?? maximumDeclaredContextTokens}
                value={contextSize}
                onChange={(event) => {
                  contextModelId.current = selectedContextModelId;
                  contextEdited.current = true;
                  setContextSize(
                    Math.min(
                      selectedContextLimit ?? maximumDeclaredContextTokens,
                      boundedInteger(event.target.value, 256, selectedContextLimit ?? 2048),
                    ),
                  );
                }}
                disabled={selectedModel === undefined || loading || generating}
              />
              <span className="field-help">
                {selectedContextLimit === undefined
                  ? "No model-declared maximum; using a 2,048-token fallback. Type an exact value or use 256-token steps."
                  : `Model-declared maximum: ${selectedContextLimit.toLocaleString()}. Type an exact value or use 256-token steps. Large contexts can require substantial browser memory.`}
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

          <Button
            variant="primary"
            onClick={() => void load()}
            disabled={
              selectedModel === undefined ||
              selectedCompatibility?.status === "incompatible" ||
              loading ||
              generating
            }
            aria-busy={loading}
          >
            <Play aria-hidden="true" />
            {loading
              ? "Loading model"
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

          {!loading || loadProgress === undefined ? null : (
            <div className="chat-load-progress" aria-busy="true">
              <strong>{loadProgress.label}</strong>
              <p>
                {loadProgress.detail} · {formatDuration(loadElapsedMs)} elapsed
              </p>
              {loadProgress.completed === undefined || loadProgress.total === undefined ? (
                <progress
                  aria-label={`${loadProgress.label} for ${selectedModel?.displayName ?? "model"}`}
                />
              ) : (
                <progress
                  aria-label={`${loadProgress.label} for ${selectedModel?.displayName ?? "model"}`}
                  max={loadProgress.total}
                  value={loadProgress.completed}
                />
              )}
            </div>
          )}

          {session === undefined ? null : (
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
          )}

          <div className="runtime-capability status-unsupported">
            <TriangleAlert aria-hidden="true" />
            <div>
              <strong>MTP unavailable</strong>
              <p>{wllamaDescriptor.mtp.explanation}</p>
            </div>
          </div>
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
                <p>
                  {loading
                    ? "The session will become ready after wllama finishes loading the local weights."
                    : "Each assistant response reports load time, TTFT, prefill, and decode throughput."}
                </p>
              </div>
            ) : (
              messages.map((message) => {
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
                      <strong>{message.role === "user" ? "You" : "wllama"}</strong>
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
                            ? "The model stopped without producing a final channel. Expand the completed channels above to inspect its output."
                            : "")}
                    </p>
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
                          <dt>TTFT</dt>
                          <dd>{formatDuration(message.metrics.timeToFirstTokenMs)}</dd>
                        </div>
                        <div>
                          <dt>Prefill</dt>
                          <dd>{formatRate(message.metrics.prefillTokensPerSecond)}</dd>
                        </div>
                        <div>
                          <dt>Decode</dt>
                          <dd>{formatRate(message.metrics.decodeTokensPerSecond)}</dd>
                        </div>
                        <div>
                          <dt>End to end</dt>
                          <dd>{formatDuration(message.metrics.totalTimeMs)}</dd>
                        </div>
                        <div>
                          <dt>Tokens</dt>
                          <dd>
                            {message.metrics.promptTokens ?? "?"} in ·{" "}
                            {message.metrics.completionTokens ?? "?"} out
                          </dd>
                        </div>
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
              placeholder={session === undefined ? "Load a model first" : "Ask the local model…"}
              disabled={session === undefined || generating}
            />
            <div className="chat-composer-actions">
              <p>
                <Gauge aria-hidden="true" /> Metrics use wllama timings and page-observed TTFT.
              </p>
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
