import {
  CircleCheck,
  Database,
  Download,
  FileArchive,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { ggufSplitMaxShardBytes } from "../lib/models/gguf-split-profile";
import type { ModelWorkerEvent } from "../lib/models/protocol";
import { requestStoragePersistence } from "../lib/models/storage";
import type {
  AcquisitionJobRecord,
  HuggingFaceArtifactChoice,
  InstalledModelRecord,
  ModelFailure,
  ModelInventory,
  ResolvedHuggingFaceRepository,
} from "../lib/models/types";
import { ModelWorkerClient } from "../lib/models/worker-client";
import {
  wllamaModelCompatibility,
  wllamaModelContextLength,
  wllamaPrimaryFiles,
} from "../lib/runtimes/wllama-compatibility";
import Button from "./ui/button";

interface LiveProgress {
  readonly jobId: string;
  readonly phase: "downloading" | "verifying" | "importing" | "splitting";
  readonly splitStage?: "planning" | "hashing" | "copying" | "finalizing";
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly currentFile: string;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "Not reported";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function progressPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (completed / total) * 100));
}

function failureMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The model operation could not be completed. Retry it from the durable state shown below.";
}

function sourceDescription(model: InstalledModelRecord): string {
  if (model.source.kind === "local-import")
    return `Local import · ${model.source.filenames.length} file${model.source.filenames.length === 1 ? "" : "s"}`;
  return `${model.source.repo} · ${model.source.commit.slice(0, 12)} · ${model.files.length} file${model.files.length === 1 ? "" : "s"}`;
}

function managedFileRole(displayName: string): string {
  const filename = displayName.slice(displayName.lastIndexOf("/") + 1).toLowerCase();
  if (filename.includes("mtp-")) return "MTP speculative-decoding companion";
  if (filename.includes("mmproj")) return "Multimodal projector companion";
  return "Primary model weights";
}

function progressStatus(progress: LiveProgress): string {
  if (progress.phase === "splitting") {
    if (progress.splitStage === "planning") {
      return `Reading GGUF metadata and planning shard boundaries for ${progress.currentFile}.`;
    }
    const action =
      progress.splitStage === "hashing"
        ? "Checking source integrity"
        : progress.splitStage === "finalizing"
          ? "Finalizing shards and inspecting metadata"
          : "Writing shards";
    return `${action} for ${progress.currentFile}.`;
  }
  const action =
    progress.phase === "verifying"
      ? "Verifying"
      : progress.phase === "importing"
        ? "Importing"
        : "Downloading";
  return `${action} ${progress.currentFile}: ${formatBytes(progress.completedBytes)} of ${formatBytes(progress.totalBytes)}.`;
}

function JobCard({
  job,
  progress,
  busy,
  onPause,
  onResume,
  onDiscard,
}: {
  readonly job: AcquisitionJobRecord;
  readonly progress?: LiveProgress;
  readonly busy: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDiscard: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const completed =
    progress?.completedBytes ?? job.files.reduce((total, file) => total + file.durableBytes, 0);
  const total = progress?.totalBytes ?? job.files.reduce((sum, file) => sum + file.source.size, 0);
  const remote = job.source.kind === "hugging-face";
  const active =
    job.state === "queued" ||
    job.state === "downloading" ||
    job.state === "verifying" ||
    job.state === "importing" ||
    progress !== undefined;
  const canResume =
    (!remote && job.state === "ready-to-install") ||
    (remote &&
      (job.state === "paused" || (job.state === "failed" && job.error?.retryable === true)));
  const currentSource = job.files.find((file) => file.phase !== "verified")?.source;
  const currentFile =
    currentSource === undefined
      ? "Ready to verify"
      : "path" in currentSource
        ? currentSource.path
        : currentSource.name;
  const splitPlanning = progress?.phase === "splitting" && progress.splitStage === "planning";
  const splitFinalizing = progress?.phase === "splitting" && progress.splitStage === "finalizing";
  const progressCopy =
    progress?.phase === "splitting"
      ? progress.splitStage === "planning"
        ? `Reading GGUF metadata and planning shard boundaries for ${progress.currentFile}. Copying starts when the layout is ready.`
        : progress.splitStage === "finalizing"
          ? `Finalizing shards and inspecting metadata for ${progress.currentFile}.`
          : `${progress.splitStage === "hashing" ? "Checking source integrity" : "Writing GGUF shards"}: ${formatBytes(completed)} of ${formatBytes(total)} read/write work · ${progress.currentFile}`
      : `${formatBytes(completed)} of ${formatBytes(total)} durable · ${progress?.currentFile ?? currentFile}`;
  return (
    <article className="model-card model-job-card" data-job-id={job.id}>
      <div className="model-card-heading">
        <div>
          <p className="model-kicker">{remote ? "Partial download" : "Partial local import"}</p>
          <h3>{job.displayName}</h3>
        </div>
        <span
          className={`status-badge ${job.state === "failed" ? "status-unsupported" : active ? "status-degraded" : "status-unknown"}`}
        >
          {job.state === "failed" ? (
            <TriangleAlert aria-hidden="true" />
          ) : active ? (
            <Download aria-hidden="true" />
          ) : (
            <Pause aria-hidden="true" />
          )}
          {active ? (progress?.phase ?? job.state) : job.state}
        </span>
      </div>
      <p className="model-progress-copy">{progressCopy}</p>
      {splitPlanning || splitFinalizing ? (
        <progress
          aria-label={
            splitPlanning
              ? `Planning GGUF shards for ${job.displayName}`
              : `Finalizing GGUF shards for ${job.displayName}`
          }
        />
      ) : (
        <progress
          max={total}
          value={completed}
          aria-label={`Acquisition progress for ${job.displayName}`}
        />
      )}
      <p className="model-progress-percent">
        {splitPlanning || splitFinalizing
          ? splitPlanning
            ? "Planning shard layout…"
            : "Finalizing and inspecting…"
          : `${progressPercent(completed, total).toFixed(1)}%`}
      </p>
      {job.error === undefined ? null : (
        <p className="inline-error">
          <TriangleAlert aria-hidden="true" />
          {job.error.message}
        </p>
      )}
      <div className="model-actions">
        {active && (remote || job.state === "importing") ? (
          <Button onClick={onPause} disabled={busy}>
            <Pause aria-hidden="true" />
            {remote ? "Pause" : "Stop import"}
          </Button>
        ) : canResume ? (
          <Button onClick={onResume} disabled={busy} aria-busy={busy}>
            <Play aria-hidden="true" />
            {remote ? "Resume and verify" : "Finish verified import"}
          </Button>
        ) : null}
        {!active &&
          (confirmDiscard ? (
            <>
              <Button className="danger-button" onClick={onDiscard} disabled={busy}>
                <Trash2 aria-hidden="true" />
                Confirm discard
              </Button>
              <Button onClick={() => setConfirmDiscard(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirmDiscard(true)} disabled={busy}>
              <Trash2 aria-hidden="true" />
              Discard partial
            </Button>
          ))}
      </div>
    </article>
  );
}

function ModelCard({
  model,
  deleting,
  inspecting,
  splitting,
  splitProgress,
  blocked,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onInspect,
  onSplit,
  onStopSplit,
}: {
  readonly model: InstalledModelRecord;
  readonly deleting: boolean;
  readonly inspecting: boolean;
  readonly splitting: boolean;
  readonly splitProgress?: LiveProgress | undefined;
  readonly blocked: boolean;
  readonly confirmDelete: boolean;
  readonly onAskDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onDelete: () => void;
  readonly onInspect: () => void;
  readonly onSplit: () => void;
  readonly onStopSplit: () => void;
}) {
  const inspection = model.files[0]?.inspection;
  const primaryFiles = wllamaPrimaryFiles(model);
  const contextLength = wllamaModelContextLength(model);
  const compatibility = wllamaModelCompatibility(model);
  const canSplit =
    model.state === "installed" &&
    compatibility.status !== "incompatible" &&
    model.derivation === undefined &&
    primaryFiles.length === 1 &&
    (primaryFiles[0]?.size ?? 0) > ggufSplitMaxShardBytes &&
    !/-\d{5}-of-\d{5}\.gguf$/iu.test(primaryFiles[0]?.displayName ?? "");
  return (
    <article className="model-card" data-model-id={model.id}>
      <div className="model-card-heading">
        <div>
          <p className="model-kicker">
            {formatBytes(model.totalSize)} · {model.files.length} file
            {model.files.length === 1 ? "" : "s"}
          </p>
          <h3>{model.displayName}</h3>
        </div>
        <span
          className={`status-badge ${model.state === "installed" ? "status-supported" : "status-unsupported"}`}
        >
          {model.state === "installed" ? (
            <CircleCheck aria-hidden="true" />
          ) : (
            <TriangleAlert aria-hidden="true" />
          )}
          {model.state}
        </span>
      </div>
      <p className="model-source">{sourceDescription(model)}</p>
      {model.derivation?.kind === "gguf-split" ? (
        <p className="model-file-role">
          Split in-browser into {model.files.length} managed files with{" "}
          {model.derivation.toolVersion}.
        </p>
      ) : null}
      {compatibility.status === "needs-split" ? (
        <div className="model-compatibility status-degraded">
          <Scissors aria-hidden="true" />
          <div>
            <strong>Preparation required for wllama</strong>
            <p>{compatibility.explanation}</p>
          </div>
        </div>
      ) : compatibility.status === "incompatible" ? (
        <div className="model-compatibility status-unsupported">
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>Not compatible with wllama</strong>
            <p>{compatibility.explanation}</p>
          </div>
        </div>
      ) : null}
      {splitProgress === undefined ? null : (
        <div className="model-split-progress">
          {splitProgress.splitStage === "planning" || splitProgress.splitStage === "finalizing" ? (
            <>
              <p>
                {splitProgress.splitStage === "planning"
                  ? `Reading GGUF metadata and planning shard boundaries for ${splitProgress.currentFile}. Copying starts when the layout is ready.`
                  : `Finalizing shards and inspecting metadata for ${splitProgress.currentFile}.`}
              </p>
              <progress
                aria-label={
                  splitProgress.splitStage === "planning"
                    ? `Planning GGUF shards for ${model.displayName}`
                    : `Finalizing GGUF shards for ${model.displayName}`
                }
              />
            </>
          ) : (
            <>
              <p>
                {splitProgress.splitStage === "hashing"
                  ? "Checking source integrity before writing shards"
                  : "Writing GGUF shards"}
                : {formatBytes(splitProgress.completedBytes)} of{" "}
                {formatBytes(splitProgress.totalBytes)} read/write work
              </p>
              <progress
                max={splitProgress.totalBytes}
                value={splitProgress.completedBytes}
                aria-label={`Split progress for ${model.displayName}`}
              />
            </>
          )}
        </div>
      )}
      <dl className="model-summary-list">
        <div>
          <dt>Format</dt>
          <dd>
            {inspection === undefined ? "Metadata unavailable" : `GGUF v${inspection.version}`}
          </dd>
        </div>
        <div>
          <dt>Architecture</dt>
          <dd>{inspection?.architecture ?? "Not declared"}</dd>
        </div>
        <div>
          <dt>Quantization</dt>
          <dd>{inspection?.quantization ?? "Not declared"}</dd>
        </div>
        <div>
          <dt>Tensors</dt>
          <dd>{inspection?.tensorCount.toLocaleString() ?? "Not reported"}</dd>
        </div>
        <div>
          <dt>Trained context</dt>
          <dd>
            {contextLength === undefined
              ? "Not declared"
              : `${contextLength.toLocaleString()} tokens`}
          </dd>
        </div>
      </dl>
      <details className="model-inspector">
        <summary>Inspect files and metadata</summary>
        {model.files.map((file) => (
          <details key={file.blobId} className="model-file-inspection">
            <summary>
              <span className="model-file-summary-name">{file.displayName}</span>
              <span className="model-file-summary-facts">
                <span>{formatBytes(file.size)}</span>
                <span>
                  {file.inspection === undefined
                    ? "Metadata unavailable"
                    : `${file.inspection.metadataCount.toLocaleString()} entries`}
                </span>
                <span>Name: {file.inspection?.name ?? "Not declared"}</span>
              </span>
            </summary>
            <div className="model-file-details">
              <p className="model-file-role">Role: {managedFileRole(file.displayName)}</p>
              <p className="model-hash">SHA-256 {file.sha256}</p>
              {file.inspectionError === undefined ? null : (
                <div className="model-alert metadata-warning">
                  <TriangleAlert aria-hidden="true" />
                  <p>
                    Metadata inspection unavailable: {file.inspectionError.message} The verified
                    model bytes remain installed.
                  </p>
                </div>
              )}
              {file.inspection === undefined ? null : (
                <>
                  <div className="metadata-table-wrap">
                    <table className="metadata-table">
                      <thead>
                        <tr>
                          <th scope="col">Key</th>
                          <th scope="col">Type</th>
                          <th scope="col">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {file.inspection.entries.map((entry) => (
                          <tr key={entry.key}>
                            <th scope="row">{entry.key}</th>
                            <td>{entry.type}</td>
                            <td>{entry.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {file.inspection.omittedEntries > 0 ? (
                    <p>
                      {file.inspection.omittedEntries} additional entries omitted from the bounded
                      inspector.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </details>
        ))}
      </details>
      <div className="model-actions destructive-actions">
        {canSplit ? (
          <Button
            onClick={splitting ? onStopSplit : onSplit}
            disabled={deleting || (!splitting && blocked)}
            aria-busy={splitting}
          >
            {splitting ? <Pause aria-hidden="true" /> : <Scissors aria-hidden="true" />}
            {splitting
              ? "Stop splitting"
              : compatibility.status === "needs-split"
                ? "Prepare for wllama"
                : "Split for wllama (optional)"}
          </Button>
        ) : null}
        <Button onClick={onInspect} disabled={inspecting || deleting} aria-busy={inspecting}>
          <RefreshCw aria-hidden="true" />
          {inspecting ? "Inspecting metadata" : "Re-run metadata inspection"}
        </Button>
        {confirmDelete ? (
          <>
            <p>This removes the managed bytes from this browser.</p>
            <Button
              className="danger-button"
              onClick={onDelete}
              disabled={deleting || blocked}
              aria-busy={deleting}
            >
              <Trash2 aria-hidden="true" />
              Confirm delete
            </Button>
            <Button onClick={onCancelDelete} disabled={deleting}>
              Cancel
            </Button>
          </>
        ) : (
          <Button onClick={onAskDelete} disabled={blocked}>
            <Trash2 aria-hidden="true" />
            Delete model
          </Button>
        )}
      </div>
    </article>
  );
}

export default function ModelManager() {
  const client = useRef<ModelWorkerClient | undefined>(undefined);
  const refreshCount = useRef(0);
  const progressRequestJobs = useRef(new Map<string, string>());
  const [inventory, setInventory] = useState<ModelInventory | undefined>(undefined);
  const [resolved, setResolved] = useState<ResolvedHuggingFaceRepository | undefined>(undefined);
  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<ReadonlyMap<string, LiveProgress>>(new Map());
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("Loading managed models and partial downloads.");
  const [dragging, setDragging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);
  const [requestingPersistence, setRequestingPersistence] = useState(false);
  const [workerAvailable, setWorkerAvailable] = useState<boolean | undefined>(undefined);
  const [sourceError, setSourceError] = useState<string | undefined>(undefined);
  const [retryNotice, setRetryNotice] = useState<string | undefined>(undefined);
  const [crossTabCoordination, setCrossTabCoordination] = useState<boolean | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    const worker = client.current;
    if (worker === undefined) return;
    refreshCount.current += 1;
    setRefreshing(true);
    try {
      setInventory(await worker.inventory());
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      refreshCount.current -= 1;
      if (refreshCount.current === 0) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setCrossTabCoordination(navigator.locks !== undefined);
    let worker: ModelWorkerClient;
    try {
      worker = new ModelWorkerClient();
      client.current = worker;
      setWorkerAvailable(true);
    } catch {
      setWorkerAvailable(false);
      setError("A model worker could not be started in this browser.");
      setStatus("Model storage is unavailable.");
      return;
    }
    const unsubscribe = worker.subscribe((event: ModelWorkerEvent) => {
      if (event.type === "model/retry") {
        const notice = `${event.message} Retry ${event.attempt} begins in ${(event.delayMs / 1_000).toFixed(1)} seconds.`;
        setRetryNotice(notice);
        setStatus(notice);
      }
      if (event.type === "model/resolved" || event.type === "model/error") {
        setRetryNotice(undefined);
      }
      if (event.type === "model/progress") {
        setRetryNotice(undefined);
        progressRequestJobs.current.set(event.requestId, event.jobId);
        setProgress((current) =>
          new Map(current).set(event.jobId, {
            jobId: event.jobId,
            phase: event.phase,
            completedBytes: event.completedBytes,
            totalBytes: event.totalBytes,
            currentFile: event.currentFile,
            ...(event.splitStage === undefined ? {} : { splitStage: event.splitStage }),
          }),
        );
        setStatus(progressStatus(event));
      }
      if (event.type === "model/error") {
        const jobId = progressRequestJobs.current.get(event.requestId);
        progressRequestJobs.current.delete(event.requestId);
        if (jobId !== undefined)
          setProgress((current) => {
            const next = new Map(current);
            next.delete(jobId);
            return next;
          });
      }
      if (event.type === "model/job") {
        setInventory((current) =>
          current === undefined
            ? current
            : {
                ...current,
                jobs: [...current.jobs.filter((job) => job.id !== event.job.id), event.job],
              },
        );
        if (
          event.job.state !== "queued" &&
          event.job.state !== "downloading" &&
          event.job.state !== "verifying" &&
          event.job.state !== "importing"
        ) {
          setProgress((current) => {
            const next = new Map(current);
            next.delete(event.job.id);
            return next;
          });
        }
      }
      if (event.type === "model/complete") {
        setRetryNotice(undefined);
        const progressJobId = progressRequestJobs.current.get(event.requestId);
        progressRequestJobs.current.delete(event.requestId);
        if (progressJobId !== undefined)
          setProgress((current) => {
            const next = new Map(current);
            next.delete(progressJobId);
            return next;
          });
        void refresh();
      }
    });
    const unsubscribeTerminal = worker.subscribeTerminal((failure) => {
      if (client.current === worker) client.current = undefined;
      setWorkerAvailable(false);
      setError(failure.message);
      setStatus("Model storage is unavailable because its background worker stopped.");
    });
    void refresh().then(() => {
      if (client.current === worker) setStatus("Model inventory ready.");
    });
    return () => {
      unsubscribe();
      unsubscribeTerminal();
      worker.dispose();
      client.current = undefined;
    };
  }, [refresh]);

  const withBusy = async (id: string, operation: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(id));
    setError(undefined);
    setRetryNotice(undefined);
    setSourceError(undefined);
    try {
      await operation();
      await refresh();
      setStatus("Model inventory updated.");
    } catch (failure) {
      const modelFailure = failure as Partial<ModelFailure>;
      setError(modelFailure.message ?? failureMessage(failure));
      setStatus("The model operation failed. The error includes the next safe action.");
      await refresh();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const resolve = async () => {
    const worker = client.current;
    if (worker === undefined) return;
    setResolving(true);
    setError(undefined);
    setResolved(undefined);
    setStatus("Resolving the repository to an immutable commit and checking GGUF identities.");
    try {
      setResolved(await worker.resolve(input));
      setStatus("Repository resolved. Choose a GGUF artifact to download.");
    } catch (failure) {
      const message = failureMessage(failure);
      setError(message);
      setSourceError(message);
      setStatus("Repository resolution failed.");
    } finally {
      setResolving(false);
    }
  };

  const startDownload = (choice: HuggingFaceArtifactChoice, includeMtp = false) => {
    const worker = client.current;
    if (worker === undefined || resolved === undefined) return;
    void withBusy(choice.id, async () => {
      const mtp = includeMtp ? choice.optionalMtp : undefined;
      const selectedChoice: HuggingFaceArtifactChoice =
        mtp === undefined
          ? choice
          : {
              ...choice,
              id: `${choice.id}::mtp:${mtp.path}`,
              label: `${choice.label} + ${mtp.path}`,
              totalSize: choice.totalSize + mtp.size,
              files: [...choice.files, mtp],
            };
      setStatus(`Starting ${selectedChoice.label}.`);
      await worker.download(resolved, selectedChoice);
    });
  };

  const importFiles = (files: readonly File[]) => {
    const worker = client.current;
    if (worker === undefined || files.length === 0 || acquisitionBusy) return;
    void withBusy("import", async () => {
      setStatus(`Importing ${files.length} local GGUF file${files.length === 1 ? "" : "s"}.`);
      await worker.import(files);
    });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (acquisitionBusy || workerAvailable !== true) return;
    importFiles([...event.dataTransfer.files]);
  };

  const persist = () => {
    void withBusy("persist", async () => {
      setRequestingPersistence(true);
      try {
        const granted = await requestStoragePersistence();
        setStatus(
          granted
            ? "Persistent origin storage is granted."
            : "The browser kept this origin in best-effort storage; downloaded models may be evicted.",
        );
      } finally {
        setRequestingPersistence(false);
      }
    });
  };

  const acquisitionBusy =
    inventory === undefined ||
    busyIds.has("import") ||
    (resolved?.choices.some((choice) => busyIds.has(choice.id)) ?? false) ||
    (inventory?.jobs.some(
      (job) =>
        busyIds.has(job.id) ||
        job.state === "queued" ||
        job.state === "downloading" ||
        job.state === "verifying" ||
        job.state === "importing",
    ) ??
      false);
  const modelTransformationBusy =
    inventory?.models.some((model) => busyIds.has(`split:${model.id}`)) ?? false;

  return (
    <div className="model-manager">
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      {error === undefined ? null : (
        <div className="model-alert" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>Model operation failed</strong>
            <p>{error}</p>
          </div>
        </div>
      )}
      {retryNotice === undefined ? null : (
        <div className="model-alert retry-alert" role="status">
          <RefreshCw aria-hidden="true" />
          <div>
            <strong>Waiting to retry</strong>
            <p>{retryNotice}</p>
          </div>
        </div>
      )}
      {crossTabCoordination === false ? (
        <div className="model-alert retry-alert" role="status">
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>Single-tab model management</strong>
            <p>
              This browser lacks Web Locks. WebAI serializes work in this tab, but do not open the
              model manager in another tab during acquisition or deletion.
            </p>
          </div>
        </div>
      ) : null}

      <div className="model-acquisition-grid">
        <section className="acquisition-card" aria-labelledby="hf-acquisition-title">
          <div className="section-icon">
            <Download aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">Hugging Face</p>
            <h2 id="hf-acquisition-title">Resolve a GGUF repository</h2>
            <p>
              Enter <span className="mono">owner/model</span>, add{" "}
              <span className="mono">@revision</span>, or paste a Hugging Face model/file URL. WebAI
              pins the result to a commit before listing files.
            </p>
          </div>
          <form
            className="model-resolve-form"
            onSubmit={(event) => {
              event.preventDefault();
              void resolve();
            }}
          >
            <label htmlFor="model-source">Model ID or URL</label>
            <div className="input-action-row">
              <input
                id="model-source"
                name="model-source"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setSourceError(undefined);
                }}
                placeholder="unsloth/Qwen3-0.6B-GGUF"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={
                  sourceError === undefined
                    ? "model-source-help"
                    : "model-source-help model-source-error"
                }
                aria-invalid={sourceError === undefined ? undefined : true}
              />
              <Button
                variant="primary"
                type="submit"
                disabled={workerAvailable !== true || resolving || input.trim() === ""}
                aria-busy={resolving}
              >
                <RefreshCw aria-hidden="true" />
                {resolving ? "Resolving" : "List files"}
              </Button>
            </div>
            <p id="model-source-help" className="field-help">
              Only the metadata request runs now. No model bytes download until you choose an
              artifact.
            </p>
            {sourceError === undefined ? null : (
              <p id="model-source-error" className="field-error">
                {sourceError}
              </p>
            )}
          </form>
          {resolved === undefined ? null : (
            <div className="resolved-repository" data-testid="resolved-repository">
              <div className="resolved-heading">
                <div>
                  <h3>{resolved.repo}</h3>
                  <p>
                    Commit <span className="mono">{resolved.commit}</span>
                  </p>
                </div>
                <span className="status-badge status-supported">
                  <ShieldCheck aria-hidden="true" />
                  Pinned
                </span>
              </div>
              <ul className="quant-list">
                {resolved.choices.map((choice) => (
                  <li
                    key={choice.id}
                    className={
                      resolved.selectedPath !== undefined &&
                      choice.files.some((file) => file.path === resolved.selectedPath)
                        ? "preselected"
                        : undefined
                    }
                  >
                    <div>
                      {resolved.selectedPath !== undefined &&
                      choice.files.some((file) => file.path === resolved.selectedPath) ? (
                        <span className="choice-origin">From pasted file URL</span>
                      ) : null}
                      <strong>{choice.quantization}</strong>
                      <p>{choice.label}</p>
                      <p>
                        {formatBytes(choice.totalSize)} · {choice.files.length} file
                        {choice.files.length === 1 ? "" : "s"} · LFS SHA-256
                      </p>
                    </div>
                    <div className="choice-actions">
                      {choice.optionalMtp === undefined ? null : (
                        <p className="companion-copy">
                          Optional llama.cpp MTP companion: {choice.optionalMtp.path} ·{" "}
                          {formatBytes(choice.optionalMtp.size)}
                        </p>
                      )}
                      {choice.optionalMtp === undefined ? null : (
                        <Button
                          onClick={() => startDownload(choice, true)}
                          disabled={workerAvailable !== true || acquisitionBusy}
                          aria-busy={busyIds.has(choice.id)}
                        >
                          <Download aria-hidden="true" />
                          Download model + MTP
                        </Button>
                      )}
                      <Button
                        onClick={() => startDownload(choice)}
                        disabled={workerAvailable !== true || acquisitionBusy}
                        aria-busy={busyIds.has(choice.id)}
                      >
                        <Download aria-hidden="true" />
                        {choice.optionalMtp === undefined ? "Download" : "Download model only"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="field-help companion-help">
                MTP suggestions follow llama.cpp's filename and same-directory convention; the
                Hugging Face API does not declare companion relationships. See the{" "}
                <a
                  href={`https://huggingface.co/${resolved.repo
                    .split("/")
                    .map(encodeURIComponent)
                    .join("/")}/tree/${resolved.commit}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  pinned repository
                </a>{" "}
                for alternate companion precisions and usage notes.
              </p>
            </div>
          )}
        </section>

        <section className="acquisition-card" aria-labelledby="local-import-title">
          <div className="section-icon">
            <Upload aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">Local files</p>
            <h2 id="local-import-title">Import GGUF files</h2>
            <p>
              Select one GGUF or an entire existing shard set. Stored-copy verification and
              best-effort metadata inspection stay in the model worker.
            </p>
          </div>
          <div
            className={`model-drop-zone${dragging ? " is-dragging" : ""}`}
            aria-disabled={workerAvailable !== true || acquisitionBusy}
            onDragEnter={(event) => {
              event.preventDefault();
              if (workerAvailable === true && !acquisitionBusy) setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false);
            }}
            onDrop={handleDrop}
          >
            <FileArchive aria-hidden="true" />
            <p>
              <strong>Drop GGUF files here</strong>
              <br />
              or choose them from this device.
            </p>
            <label
              className="button-secondary file-picker-button"
              htmlFor="model-file-picker"
              aria-disabled={workerAvailable !== true || acquisitionBusy}
            >
              <Upload aria-hidden="true" />
              Choose GGUF files
            </label>
            <input
              id="model-file-picker"
              className="visually-hidden"
              type="file"
              accept=".gguf,application/octet-stream"
              multiple
              onChange={(event) => {
                importFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
              disabled={workerAvailable !== true || acquisitionBusy}
            />
          </div>
        </section>
      </div>

      <section className="storage-panel" aria-labelledby="storage-title">
        <div className="storage-heading">
          <div>
            <p className="eyebrow">Browser storage</p>
            <h2 id="storage-title">Managed model inventory</h2>
          </div>
          <Button
            onClick={() => void refresh()}
            disabled={workerAvailable !== true || refreshing}
            aria-busy={refreshing}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </div>
        {workerAvailable === false ? (
          <p className="inventory-loading">
            <TriangleAlert aria-hidden="true" />
            Model storage is unavailable because the background worker could not start.
          </p>
        ) : inventory === undefined ? (
          <p className="inventory-loading">
            <Database aria-hidden="true" />
            Reconciling manifests with browser files…
          </p>
        ) : (
          <>
            <dl className="storage-metrics">
              <div>
                <dt>Verified model bytes</dt>
                <dd>{formatBytes(inventory.storage.modelBytes)}</dd>
                <p>Exact WebAI-managed files</p>
              </div>
              <div>
                <dt>Durable partial bytes</dt>
                <dd>{formatBytes(inventory.storage.partialBytes)}</dd>
                <p>Safe resume prefix</p>
              </div>
              <div>
                <dt>Origin usage</dt>
                <dd>{formatBytes(inventory.storage.originUsage)}</dd>
                <p>Browser estimate, all origin data</p>
              </div>
              <div>
                <dt>Origin quota</dt>
                <dd>{formatBytes(inventory.storage.originQuota)}</dd>
                <p>Browser estimate</p>
              </div>
            </dl>
            <div className="persistence-strip">
              <HardDrive aria-hidden="true" />
              <div>
                <strong>
                  {inventory.storage.persisted
                    ? "Persistent storage granted"
                    : "Best-effort storage"}
                </strong>
                <p>
                  {inventory.storage.persisted
                    ? "The browser reports this origin as protected from ordinary eviction."
                    : "The browser may evict model bytes under storage pressure. Persistence is a browser decision."}
                </p>
              </div>
              <Button
                onClick={persist}
                disabled={inventory.storage.persisted === true || requestingPersistence}
                aria-busy={requestingPersistence}
              >
                <ShieldCheck aria-hidden="true" />
                {inventory.storage.persisted ? "Persistence granted" : "Request persistence"}
              </Button>
            </div>

            {inventory.jobs.length === 0 && inventory.models.length === 0 ? (
              <div className="model-empty">
                <Database aria-hidden="true" />
                <h3>No managed models yet</h3>
                <p>
                  Resolve a Hugging Face repository or import local GGUF files. Verified files
                  appear here.
                </p>
              </div>
            ) : null}
            {inventory.jobs.length === 0 ? null : (
              <div className="model-list" aria-labelledby="partials-title">
                <h3 id="partials-title" className="model-list-title">
                  Incomplete acquisitions
                </h3>
                {inventory.jobs.map((job) => {
                  const liveProgress = progress.get(job.id);
                  return (
                    <JobCard
                      key={job.id}
                      job={job}
                      {...(liveProgress === undefined ? {} : { progress: liveProgress })}
                      busy={busyIds.has(job.id)}
                      onPause={() => {
                        client.current?.pause(job.id);
                      }}
                      onResume={() => {
                        const worker = client.current;
                        if (worker !== undefined)
                          void withBusy(job.id, () => worker.resume(job.id));
                      }}
                      onDiscard={() => {
                        const worker = client.current;
                        if (worker !== undefined)
                          void withBusy(job.id, () => worker.discard(job.id));
                      }}
                    />
                  );
                })}
              </div>
            )}
            {inventory.models.length === 0 ? null : (
              <div className="model-list" aria-labelledby="installed-title">
                <h3 id="installed-title" className="model-list-title">
                  Installed models
                </h3>
                {inventory.models.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    deleting={busyIds.has(model.id)}
                    inspecting={busyIds.has(`inspect:${model.id}`)}
                    blocked={acquisitionBusy || modelTransformationBusy}
                    splitting={busyIds.has(`split:${model.id}`)}
                    {...(progress.get(model.id)?.phase === "splitting"
                      ? { splitProgress: progress.get(model.id) }
                      : {})}
                    confirmDelete={confirmDelete === model.id}
                    onAskDelete={() => setConfirmDelete(model.id)}
                    onCancelDelete={() => setConfirmDelete(undefined)}
                    onDelete={() => {
                      const worker = client.current;
                      if (worker !== undefined)
                        void withBusy(model.id, async () => {
                          await worker.delete(model.id);
                          setConfirmDelete(undefined);
                        });
                    }}
                    onInspect={() => {
                      const worker = client.current;
                      if (worker !== undefined)
                        void withBusy(`inspect:${model.id}`, () => worker.inspect(model.id));
                    }}
                    onSplit={() => {
                      const worker = client.current;
                      if (worker !== undefined)
                        void withBusy(`split:${model.id}`, () => worker.split(model.id));
                    }}
                    onStopSplit={() => client.current?.pause(model.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
