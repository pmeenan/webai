import {
  ChevronDown,
  CircleCheck,
  Database,
  Download,
  FileArchive,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ggufSplitMaxShardBytes } from "../lib/models/gguf-split-profile";
import type { ModelWorkerEvent } from "../lib/models/protocol";
import { requestStoragePersistence } from "../lib/models/storage";
import type {
  AcquisitionJobRecord,
  HuggingFaceArtifactChoice,
  HuggingFaceBrowseFilters,
  HuggingFaceBrowseResult,
  HuggingFaceCapability,
  HuggingFaceFile,
  HuggingFaceLineage,
  InstalledModelRecord,
  ModelFailure,
  ModelInventory,
  ResolvedHuggingFaceRepository,
} from "../lib/models/types";
import { maximumArtifactChoiceFiles } from "../lib/models/types";
import { ModelWorkerClient } from "../lib/models/worker-client";
import {
  wllamaModelCompatibility,
  wllamaModelContextLength,
  wllamaPrimaryFiles,
} from "../lib/runtimes/wllama-compatibility";
import Button from "./ui/button";

const capabilityOptions: readonly {
  readonly value: HuggingFaceCapability;
  readonly label: string;
}[] = [
  { value: "thinking", label: "Thinking" },
  { value: "text-generation", label: "Text generation" },
  { value: "tool-calling", label: "Tool calling" },
  { value: "image-generation", label: "Image generation" },
  { value: "image-input", label: "Image input" },
  { value: "text-to-speech", label: "Text to speech" },
  { value: "speech-recognition", label: "Speech recognition" },
];
const quantizationOptions = [1, 2, 3, 4, 5, 6, 8, 16, 32, "other"] as const;

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

function accessLabel(metadata: ResolvedHuggingFaceRepository["metadata"]): string {
  if (metadata.visibility === "private") return "Private model";
  if (metadata.visibility === "public" && metadata.gating === "open") return "Public model";
  if (metadata.gating === "automatic") return "Gated · automatic approval";
  if (metadata.gating === "manual") return "Gated · manual approval";
  if (metadata.gating === "gated") return "Gated model";
  return "Gating status unknown";
}

function restrictedAccess(metadata: ResolvedHuggingFaceRepository["metadata"]): boolean {
  return metadata.visibility !== "public" || metadata.gating !== "open";
}

type BrowseResultEntry = {
  readonly item: HuggingFaceBrowseResult["matches"][number];
  readonly needsVerification: boolean;
};

type BrowseModelGroup = {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly downloads: bigint;
  readonly downloadReports: number;
  readonly confirmedVariants: number;
  readonly variants: readonly BrowseResultEntry[];
};

type BrowseFamilyGroup = {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly downloads: bigint;
  readonly downloadReports: number;
  readonly confirmedVariants: number;
  readonly models: readonly BrowseModelGroup[];
};

function architectureFamily(architecture: string | undefined): {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
} {
  const declared = architecture?.trim();
  if (declared === undefined || declared === "")
    return {
      key: "architecture:missing",
      label: "Architecture not declared",
      detail: "Grouped here without guessing from repository names.",
    };
  const normalized = declared.toLowerCase();
  const versioned = normalized.match(/^(gemma|qwen|llama|phi)[-_]?(\d+)(?:[._-](\d+))?$/u);
  const brand =
    versioned?.[1] === "gemma"
      ? "Gemma"
      : versioned?.[1] === "qwen"
        ? "Qwen"
        : versioned?.[1] === "llama"
          ? "Llama"
          : versioned?.[1] === "phi"
            ? "Phi"
            : undefined;
  const label =
    brand === undefined || versioned?.[2] === undefined
      ? declared
          .replace(/[_\s-]+/gu, " ")
          .replace(
            /(^|\s)(\p{L})/gu,
            (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`,
          )
      : `${brand} ${versioned[2]}${versioned[3] === undefined ? "" : `.${versioned[3]}`}`;
  const key =
    brand === undefined || versioned?.[2] === undefined
      ? normalized.replace(/[_\s-]+/gu, " ")
      : `${versioned[1]}:${versioned[2]}${versioned[3] === undefined ? "" : `.${versioned[3]}`}`;
  return {
    key: `architecture:declared:${key}`,
    label,
    detail: `Declared architecture: ${declared}`,
  };
}

function browseModelGroup(item: HuggingFaceBrowseResult["matches"][number]): {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
} {
  const parents = item.repository.metadata.baseModels ?? [];
  if (parents.length === 1 && parents[0] !== undefined) {
    const [owner, model = parents[0].repo] = parents[0].repo.split("/");
    return {
      key: `base:${parents[0].repo}`,
      label: model,
      detail: `${owner} · declared base model`,
    };
  }
  if (parents.length > 1) {
    const repos = parents.map((parent) => parent.repo).sort();
    return {
      key: `bases:${repos.join("+")}`,
      label: "Multiple base models",
      detail: `Declared bases: ${repos.join(" + ")}`,
    };
  }
  const [owner, model = item.repo] = item.repo.split("/");
  return {
    key: `self:${item.repo}`,
    label: model,
    detail: `${owner} · no consistent declared base model`,
  };
}

function baseRelationship(item: HuggingFaceBrowseResult["matches"][number]): string {
  const parents = item.repository.metadata.baseModels ?? [];
  if (parents.length === 0) return "No consistent declared base model";
  if (parents.length > 1)
    return `Declared base models: ${parents.map((parent) => parent.repo).join(" + ")}`;
  const parent = parents[0];
  if (parent === undefined) return "No consistent declared base model";
  if (parent.relation === "adapter") return `Adapter of ${parent.repo}`;
  if (parent.relation === "finetune") return `Fine-tune of ${parent.repo}`;
  if (parent.relation === "merge") return `Merge based on ${parent.repo}`;
  if (parent.relation === "quantized") return `Quantized from ${parent.repo}`;
  return `Declared base model: ${parent.repo}`;
}

function variantIdentity(repo: string, commit: string): string {
  return `${repo}@${commit.toLowerCase()}`;
}

function fileIdentity(file: HuggingFaceFile): string {
  return `${file.path}\u0000${file.size}\u0000${file.integrity.kind}\u0000${file.integrity.digest}`;
}

function sameSourceFiles(
  left: readonly HuggingFaceFile[],
  right: readonly HuggingFaceFile[],
): boolean {
  if (left.length !== right.length) return false;
  const leftIdentities = left.map(fileIdentity).sort();
  const rightIdentities = right.map(fileIdentity).sort();
  return leftIdentities.every((identity, index) => identity === rightIdentities[index]);
}

function huggingFaceModelUrl(repo: string): string {
  return `https://huggingface.co/${repo.split("/").map(encodeURIComponent).join("/")}`;
}

function LineageTree({ lineage }: { readonly lineage: HuggingFaceLineage }) {
  const nodes = new Map(lineage.nodes.map((node) => [node.repo, node]));
  const children = new Map<string, Set<string>>();
  const repositories = new Set(lineage.nodes.map((node) => node.repo));
  for (const node of lineage.nodes) {
    for (const parent of node.parents) {
      if (!nodes.has(parent.repo)) continue;
      const descendants = children.get(parent.repo) ?? new Set<string>();
      descendants.add(node.repo);
      children.set(parent.repo, descendants);
    }
  }
  const topLevel = [...repositories]
    .filter((repo) => nodes.get(repo)?.parents.every((parent) => !nodes.has(parent.repo)))
    .sort((left, right) => left.localeCompare(right));
  const roots = topLevel.length === 0 ? [lineage.rootRepo] : topLevel;
  const incomplete = lineage.nodes.filter((node) => node.status !== "resolved");
  const expanded = new Set<string>();
  const renderNode = (repo: string, path: ReadonlySet<string>): ReactNode => {
    const cycle = path.has(repo);
    const alreadyExpanded = expanded.has(repo);
    if (!cycle && !alreadyExpanded) expanded.add(repo);
    const nextPath = new Set(path).add(repo);
    const descendants = [...(children.get(repo) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    );
    return (
      <li key={`${[...path].join(">")}::${repo}`}>
        <div className="lineage-node">
          <a href={huggingFaceModelUrl(repo)} target="_blank" rel="noreferrer">
            {repo}
          </a>
        </div>
        {cycle || alreadyExpanded || descendants.length === 0 ? null : (
          <ul>{descendants.map((descendant) => renderNode(descendant, nextPath))}</ul>
        )}
      </li>
    );
  };
  return (
    <div className="lineage-tree">
      <ul>{roots.map((repo) => renderNode(repo, new Set()))}</ul>
      {incomplete.length === 0 && !lineage.truncated ? null : (
        <div className="lineage-warnings" role="status">
          {incomplete.map((node) => (
            <p key={node.repo}>
              Ancestry for {node.repo} could not be inspected:{" "}
              {node.status === "access-required" ? "access is required" : "metadata is unavailable"}
              .
            </p>
          ))}
          {lineage.truncated ? (
            <p>Some ancestry was not inspected at the safety boundary.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function browseFilterSignature(filters: HuggingFaceBrowseFilters): string {
  return JSON.stringify({
    query: filters.query.trim(),
    format: filters.format,
    capabilities: [...(filters.capabilities ?? [])].sort(),
    quantizationBits: [...(filters.quantizationBits ?? [])].map(String).sort(),
    otherQuantization: filters.otherQuantization?.trim() ?? "",
    minimumContextTokens: filters.minimumContextTokens,
    maximumBytes: filters.maximumBytes,
  });
}

type ParsedMinimumContext =
  | { readonly valid: true; readonly enteredK?: number; readonly roundedK?: number }
  | { readonly valid: false };

function parseMinimumContext(value: string): ParsedMinimumContext {
  const text = value.trim();
  if (text === "") return { valid: true };
  const enteredK = Number(text);
  const roundedK = Math.ceil(enteredK);
  return Number.isFinite(enteredK) && enteredK >= 1 && roundedK <= 1024
    ? { valid: true, enteredK, roundedK }
    : { valid: false };
}

function compareDownloadTotals(left: bigint, right: bigint): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function downloadSummary(downloads: bigint, reports: number, variants: number): string {
  if (reports === 0) return "Hub downloads not reported";
  const missing = variants - reports;
  return `${downloads.toLocaleString()} Hub downloads (last 30 days)${missing === 0 ? "" : ` · ${missing} variant${missing === 1 ? "" : "s"} unreported`}`;
}

function variantDownloadSummary(downloads: number | undefined): string {
  if (downloads === undefined) return "Hub downloads (last 30 days): Not reported";
  return `${downloads.toLocaleString()} Hub download${downloads === 1 ? "" : "s"} (last 30 days)`;
}

function groupBrowseItems(result: HuggingFaceBrowseResult): readonly BrowseFamilyGroup[] {
  const families = new Map<
    string,
    {
      key: string;
      label: string;
      detail: string;
      models: Map<
        string,
        {
          key: string;
          label: string;
          detail: string;
          variants: BrowseResultEntry[];
        }
      >;
    }
  >();
  for (const entry of [
    ...result.matches.map((item) => ({ item, needsVerification: false })),
    ...result.needsVerification.map((item) => ({ item, needsVerification: true })),
  ]) {
    const familyIdentity = architectureFamily(entry.item.repository.metadata.architecture);
    const family = families.get(familyIdentity.key) ?? {
      ...familyIdentity,
      models: new Map(),
    };
    const modelIdentity = browseModelGroup(entry.item);
    const model = family.models.get(modelIdentity.key) ?? { ...modelIdentity, variants: [] };
    model.variants.push(entry);
    family.models.set(model.key, model);
    families.set(family.key, family);
  }
  return [...families.values()]
    .map((family) => {
      const models = [...family.models.values()]
        .map((model) => {
          const variants = model.variants.sort(
            (left, right) =>
              Number(left.needsVerification) - Number(right.needsVerification) ||
              (right.item.downloads ?? -1) - (left.item.downloads ?? -1) ||
              left.item.repo.localeCompare(right.item.repo),
          );
          return {
            ...model,
            downloads: variants.reduce(
              (total, entry) => total + BigInt(entry.item.downloads ?? 0),
              0n,
            ),
            downloadReports: variants.filter((entry) => entry.item.downloads !== undefined).length,
            confirmedVariants: variants.filter((entry) => !entry.needsVerification).length,
            variants,
          };
        })
        .sort(
          (left, right) =>
            Number(left.confirmedVariants === 0) - Number(right.confirmedVariants === 0) ||
            compareDownloadTotals(left.downloads, right.downloads) ||
            left.label.localeCompare(right.label),
        );
      return {
        key: family.key,
        label: family.label,
        detail: family.detail,
        downloads: models.reduce((total, model) => total + model.downloads, 0n),
        downloadReports: models.reduce((total, model) => total + model.downloadReports, 0),
        confirmedVariants: models.reduce((total, model) => total + model.confirmedVariants, 0),
        models,
      };
    })
    .sort(
      (left, right) =>
        Number(left.confirmedVariants === 0) - Number(right.confirmedVariants === 0) ||
        compareDownloadTotals(left.downloads, right.downloads) ||
        left.label.localeCompare(right.label),
    );
}

function storageHint(
  choice: HuggingFaceArtifactChoice,
  inventory: ModelInventory | undefined,
): string {
  const quota = inventory?.storage.originQuota;
  const usage = inventory?.storage.originUsage;
  if (quota === undefined || usage === undefined) {
    return "Storage fit unknown because this browser did not report an origin quota estimate.";
  }
  const remaining = Math.max(0, quota - usage);
  return choice.totalSize <= remaining
    ? `Within the browser's ${formatBytes(remaining)} estimated remaining origin quota.`
    : `Exceeds the browser's ${formatBytes(remaining)} estimated remaining origin quota; the download may fail.`;
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

const defaultBrowseMinimumContextK = 32;
const defaultBrowseMaximumGiB = 4;
const maximumBrowseGiB = 16 * 1024;

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
  const restrictedDownload =
    job.source.kind === "hugging-face" &&
    (job.source.visibility === "private" ||
      job.source.gating === "automatic" ||
      job.source.gating === "manual" ||
      job.source.gating === "gated");
  const restrictedBlocksResume = canResume && restrictedDownload;
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
      {restrictedBlocksResume ? (
        <p className="field-help" id={`job-restricted-${job.id}`}>
          WebAI supports only public, ungated models. Discard this legacy restricted partial.
        </p>
      ) : null}
      <div className="model-actions">
        {active && (remote || job.state === "importing") ? (
          <Button onClick={onPause} disabled={busy}>
            <Pause aria-hidden="true" />
            {remote ? "Pause" : "Stop import"}
          </Button>
        ) : canResume ? (
          <Button
            onClick={onResume}
            disabled={busy || restrictedBlocksResume}
            aria-busy={busy}
            {...(restrictedBlocksResume ? { "aria-describedby": `job-restricted-${job.id}` } : {})}
          >
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
  const browseSequence = useRef(0);
  const resolveSequence = useRef(0);
  const lineageSequence = useRef(0);
  const lineageCache = useRef(new Map<string, HuggingFaceLineage>());
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
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseCapabilities, setBrowseCapabilities] = useState<readonly HuggingFaceCapability[]>(
    [],
  );
  const [browseQuantizationBits, setBrowseQuantizationBits] = useState<
    readonly (1 | 2 | 3 | 4 | 5 | 6 | 8 | 16 | 32 | "other")[]
  >([]);
  const [browseOtherQuantization, setBrowseOtherQuantization] = useState("");
  const [browseMinimumContextK, setBrowseMinimumContextK] = useState(
    String(defaultBrowseMinimumContextK),
  );
  const [browseMaximumGiB, setBrowseMaximumGiB] = useState(String(defaultBrowseMaximumGiB));
  const [browseFiltersOpen, setBrowseFiltersOpen] = useState(true);
  const [browseResult, setBrowseResult] = useState<HuggingFaceBrowseResult | undefined>(undefined);
  const [browseProgress, setBrowseProgress] = useState<
    { readonly inspectedCandidates: number; readonly inspectedPages: number } | undefined
  >(undefined);
  const [selectedBrowseFamilyKey, setSelectedBrowseFamilyKey] = useState<string | undefined>(
    undefined,
  );
  const [selectedBrowseModelKey, setSelectedBrowseModelKey] = useState<string | undefined>(
    undefined,
  );
  const [selectedBrowseVariantKey, setSelectedBrowseVariantKey] = useState<string | undefined>(
    undefined,
  );
  const [activeBrowseFilters, setActiveBrowseFilters] = useState<
    HuggingFaceBrowseFilters | undefined
  >(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [showBrowseProgressBar, setShowBrowseProgressBar] = useState(false);
  const [browseError, setBrowseError] = useState<string | undefined>(undefined);
  const [lineage, setLineage] = useState<HuggingFaceLineage | undefined>(undefined);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageProgress, setLineageProgress] = useState(0);
  const [lineageError, setLineageError] = useState<string | undefined>(undefined);

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
    if (!browsing) return;
    const timer = window.setTimeout(() => setShowBrowseProgressBar(true), 1_000);
    return () => window.clearTimeout(timer);
  }, [browsing]);

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
      if (
        event.type === "model/resolved" ||
        event.type === "model/browse-result" ||
        event.type === "model/error"
      ) {
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
      if (event.type === "model/browse-progress") {
        setRetryNotice(undefined);
        const next = {
          inspectedCandidates: event.inspectedCandidates,
          inspectedPages: event.inspectedPages,
        };
        setBrowseProgress(next);
        setStatus(
          `Inspected ${next.inspectedCandidates} candidate${next.inspectedCandidates === 1 ? "" : "s"} across ${next.inspectedPages} page${next.inspectedPages === 1 ? "" : "s"}.`,
        );
      }
      if (event.type === "model/browse-result") setBrowseProgress(undefined);
      if (event.type === "model/lineage-progress") {
        setLineageProgress(event.inspectedNodes);
        setStatus(
          `Inspecting reported model ancestry: ${event.inspectedNodes} repositor${event.inspectedNodes === 1 ? "y" : "ies"} checked.`,
        );
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
        setInventory((current) => {
          if (current === undefined) return current;
          const index = current.jobs.findIndex((job) => job.id === event.job.id);
          return {
            ...current,
            jobs:
              index < 0
                ? [...current.jobs, event.job]
                : current.jobs.map((job, jobIndex) => (jobIndex === index ? event.job : job)),
          };
        });
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
    void refresh()
      .then(() => {
        if (client.current === worker) setStatus("Model inventory ready.");
      })
      .catch((failure: unknown) => {
        if (client.current === worker) {
          setError(failureMessage(failure));
          setStatus("Model storage initialization failed.");
        }
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
    const sequence = resolveSequence.current + 1;
    resolveSequence.current = sequence;
    setResolving(true);
    setError(undefined);
    setResolved(undefined);
    setStatus("Resolving the repository to an immutable commit and checking GGUF identities.");
    try {
      const repository = await worker.resolve(input);
      if (resolveSequence.current !== sequence) return;
      setResolved(repository);
      setStatus("Repository resolved. Choose a GGUF artifact to download.");
    } catch (failure) {
      if (resolveSequence.current !== sequence) return;
      const message = failureMessage(failure);
      setError(message);
      setSourceError(message);
      setStatus("Repository resolution failed.");
    } finally {
      if (resolveSequence.current === sequence) setResolving(false);
    }
  };

  const startDownload = (
    repository: ResolvedHuggingFaceRepository,
    choice: HuggingFaceArtifactChoice,
    includeMtp = false,
  ) => {
    const worker = client.current;
    if (worker === undefined) return;
    const busyId = `download:${repository.repo}:${repository.commit}:${choice.id}`;
    void withBusy(busyId, async () => {
      const mtp =
        includeMtp && choice.files.length < maximumArtifactChoiceFiles
          ? choice.optionalMtp
          : undefined;
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
      await worker.download(repository, selectedChoice);
    });
  };

  const browse = async () => {
    const worker = client.current;
    if (worker === undefined) return;
    const sequence = browseSequence.current + 1;
    browseSequence.current = sequence;
    const enteredMaximumText = browseMaximumGiB.trim();
    const maximumText = enteredMaximumText || String(defaultBrowseMaximumGiB);
    const maximum = Number(maximumText);
    const maximumBytes = Math.floor(maximum * 1024 ** 3);
    const enteredContextText = browseMinimumContextK.trim();
    const contextText = enteredContextText || String(defaultBrowseMinimumContextK);
    const parsedMinimumContext = parseMinimumContext(contextText);
    if (
      maximumText !== "" &&
      (!Number.isFinite(maximum) ||
        maximum <= 0 ||
        maximum > maximumBrowseGiB ||
        !Number.isSafeInteger(maximumBytes))
    ) {
      setBrowseError(`Enter a maximum download size from 0.01 to ${maximumBrowseGiB} GiB.`);
      setStatus("Model discovery filters need correction.");
      return;
    }
    if (!parsedMinimumContext.valid) {
      setBrowseError("Enter a minimum declared context from 1 to 1,024 K tokens.");
      setStatus("Model discovery filters need correction.");
      return;
    }
    const filters: HuggingFaceBrowseFilters = {
      query: browseQuery.trim(),
      format: "gguf",
      ...(browseCapabilities.length === 0 ? {} : { capabilities: browseCapabilities }),
      ...(browseQuantizationBits.length === 0 ? {} : { quantizationBits: browseQuantizationBits }),
      ...(browseQuantizationBits.includes("other") && browseOtherQuantization.trim() !== ""
        ? { otherQuantization: browseOtherQuantization.trim() }
        : {}),
      ...(parsedMinimumContext.roundedK === undefined
        ? {}
        : { minimumContextTokens: parsedMinimumContext.roundedK * 1024 }),
      ...(maximumText === "" ? {} : { maximumBytes }),
    };
    if (
      parsedMinimumContext.roundedK !== undefined &&
      parsedMinimumContext.roundedK !== parsedMinimumContext.enteredK
    )
      setBrowseMinimumContextK(String(parsedMinimumContext.roundedK));
    else if (enteredContextText === "")
      setBrowseMinimumContextK(String(defaultBrowseMinimumContextK));
    if (enteredMaximumText === "") setBrowseMaximumGiB(String(defaultBrowseMaximumGiB));
    setActiveBrowseFilters(filters);
    setBrowseResult(undefined);
    setSelectedBrowseFamilyKey(undefined);
    setSelectedBrowseModelKey(undefined);
    setSelectedBrowseVariantKey(undefined);
    setBrowseFiltersOpen(false);
    setBrowseProgress({ inspectedCandidates: 0, inspectedPages: 0 });
    setShowBrowseProgressBar(false);
    setBrowsing(true);
    setBrowseError(undefined);
    setRetryNotice(undefined);
    setStatus("Searching all bounded Hugging Face pages and inspecting immutable model details.");
    try {
      const result = await worker.browse(filters);
      if (browseSequence.current !== sequence) return;
      setBrowseResult(result);
      setStatus(
        result.truncationReason === "stopped"
          ? `Model discovery stopped after inspecting ${result.inspectedCandidates} candidate${result.inspectedCandidates === 1 ? "" : "s"}. Collected results are shown.`
          : `This discovery pass inspected ${result.inspectedCandidates} candidate${result.inspectedCandidates === 1 ? "" : "s"} across ${result.inspectedPages} page${result.inspectedPages === 1 ? "" : "s"}.`,
      );
    } catch (failure) {
      if (browseSequence.current !== sequence) return;
      const modelFailure = failure as Partial<ModelFailure>;
      if (modelFailure.code !== "aborted") {
        const message = failureMessage(failure);
        setBrowseError(message);
        setStatus("Model discovery failed with a retryable explanation.");
      }
    } finally {
      if (browseSequence.current === sequence) {
        setBrowsing(false);
        setBrowseProgress(undefined);
        setShowBrowseProgressBar(false);
      }
    }
  };

  const stopBrowse = () => {
    client.current?.cancelBrowse();
    setBrowsing(false);
    setBrowseProgress(undefined);
    setShowBrowseProgressBar(false);
    setRetryNotice(undefined);
    setStatus("Stopping model discovery. Already collected results will be shown.");
  };

  const stopLineage = () => {
    lineageSequence.current += 1;
    client.current?.cancelLineage();
    setLineageLoading(false);
    setLineageError("Ancestry inspection was stopped.");
    setStatus("Reported ancestry inspection stopped.");
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
    [...busyIds].some((id) => id.startsWith("download:")) ||
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
  const browseFamilies = useMemo(
    () => (browseResult === undefined ? [] : groupBrowseItems(browseResult)),
    [browseResult],
  );
  const installedByVariant = useMemo(() => {
    const index = new Map<string, InstalledModelRecord[]>();
    for (const model of inventory?.models ?? []) {
      if (model.state !== "installed" || model.source.kind !== "hugging-face") continue;
      const key = variantIdentity(model.source.repo, model.source.commit);
      index.set(key, [...(index.get(key) ?? []), model]);
    }
    return index;
  }, [inventory]);
  const selectedBrowseFamily =
    browseFamilies.find((family) => family.key === selectedBrowseFamilyKey) ?? browseFamilies[0];
  const selectedBrowseModel =
    selectedBrowseFamily?.models.find((model) => model.key === selectedBrowseModelKey) ??
    selectedBrowseFamily?.models[0];
  const selectedBrowseVariant =
    selectedBrowseModel?.variants.find(
      ({ item }) => `${item.repo}@${item.commit}` === selectedBrowseVariantKey,
    ) ?? selectedBrowseModel?.variants[0];
  const selectedBrowseVariantIdentity =
    selectedBrowseVariant === undefined
      ? undefined
      : `${selectedBrowseVariant.item.repo}@${selectedBrowseVariant.item.commit}`;
  useEffect(() => {
    if (selectedBrowseFamilyKey !== selectedBrowseFamily?.key)
      setSelectedBrowseFamilyKey(selectedBrowseFamily?.key);
    if (selectedBrowseModelKey !== selectedBrowseModel?.key)
      setSelectedBrowseModelKey(selectedBrowseModel?.key);
    if (selectedBrowseVariantKey !== selectedBrowseVariantIdentity)
      setSelectedBrowseVariantKey(selectedBrowseVariantIdentity);
  }, [
    selectedBrowseFamily?.key,
    selectedBrowseFamilyKey,
    selectedBrowseModel?.key,
    selectedBrowseModelKey,
    selectedBrowseVariantIdentity,
    selectedBrowseVariantKey,
  ]);
  useEffect(() => {
    const worker = client.current;
    const selected = selectedBrowseVariant?.item;
    lineageSequence.current += 1;
    const sequence = lineageSequence.current;
    if (worker === undefined || selected === undefined) {
      setLineage(undefined);
      setLineageLoading(false);
      setLineageError(undefined);
      return;
    }
    const identity = variantIdentity(selected.repo, selected.commit);
    const cached = lineageCache.current.get(identity);
    if (cached !== undefined) {
      setLineage(cached);
      setLineageLoading(false);
      setLineageError(undefined);
      return;
    }
    const parents = selected.repository.metadata.baseModels ?? [];
    if (parents.length === 0) {
      const leaf: HuggingFaceLineage = {
        rootRepo: selected.repo,
        nodes: [
          {
            repo: selected.repo,
            commit: selected.commit,
            parents: [],
            status: "resolved",
          },
        ],
        cacheHits: 0,
        truncated: false,
      };
      lineageCache.current.set(identity, leaf);
      setLineage(leaf);
      setLineageLoading(false);
      setLineageError(undefined);
      return;
    }
    if (browseResult?.truncationReason === "stopped") {
      setLineage(undefined);
      setLineageLoading(false);
      setLineageError(undefined);
      return;
    }
    setLineage(undefined);
    setLineageLoading(true);
    setLineageProgress(1);
    setLineageError(undefined);
    void worker
      .lineage(selected.repo, selected.commit, parents)
      .then((result) => {
        if (lineageSequence.current !== sequence) return;
        lineageCache.current.set(identity, result);
        setLineage(result);
        setLineageLoading(false);
        setStatus(
          `Reported ancestry ready: ${result.nodes.length} repositor${result.nodes.length === 1 ? "y" : "ies"} inspected.`,
        );
      })
      .catch((failure: unknown) => {
        if (lineageSequence.current !== sequence) return;
        if ((failure as Partial<ModelFailure>).code === "aborted") return;
        const message = failureMessage(failure);
        setLineageLoading(false);
        setLineageError(message);
      });
    return () => {
      if (lineageSequence.current === sequence) lineageSequence.current += 1;
      worker.cancelLineage();
    };
  }, [browseResult?.truncationReason, selectedBrowseVariant, selectedBrowseVariantIdentity]);
  const selectedInstalledRecords =
    selectedBrowseVariant === undefined
      ? []
      : (installedByVariant.get(
          variantIdentity(selectedBrowseVariant.item.repo, selectedBrowseVariant.item.commit),
        ) ?? []);
  const draftContextText = browseMinimumContextK.trim() || String(defaultBrowseMinimumContextK);
  const draftMinimumContext = parseMinimumContext(draftContextText);
  const draftMaximumText = browseMaximumGiB.trim() || String(defaultBrowseMaximumGiB);
  const draftMaximumBytes = Math.floor(Number(draftMaximumText) * 1024 ** 3);
  const draftFiltersValid =
    draftMinimumContext.valid &&
    (draftMaximumText === "" ||
      (Number.isFinite(draftMaximumBytes) &&
        draftMaximumBytes > 0 &&
        draftMaximumBytes <= maximumBrowseGiB * 1024 ** 3 &&
        Number.isSafeInteger(draftMaximumBytes)));
  const draftBrowseFilterSignature = draftFiltersValid
    ? browseFilterSignature({
        query: browseQuery.trim(),
        format: "gguf",
        ...(browseCapabilities.length === 0 ? {} : { capabilities: browseCapabilities }),
        ...(browseQuantizationBits.length === 0
          ? {}
          : { quantizationBits: browseQuantizationBits }),
        ...(browseQuantizationBits.includes("other") && browseOtherQuantization.trim() !== ""
          ? { otherQuantization: browseOtherQuantization.trim() }
          : {}),
        ...(draftMinimumContext.roundedK === undefined
          ? {}
          : { minimumContextTokens: draftMinimumContext.roundedK * 1024 }),
        ...(draftMaximumText === "" ? {} : { maximumBytes: draftMaximumBytes }),
      })
    : `invalid:${draftContextText}:${draftMaximumText}`;
  const browseFiltersDirty =
    browseResult !== undefined &&
    (activeBrowseFilters === undefined ||
      browseFilterSignature(activeBrowseFilters) !== draftBrowseFilterSignature);
  const activeBrowseFilterCount = browseCapabilities.length + browseQuantizationBits.length + 2;

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

      <section
        className="model-browser"
        aria-labelledby="model-browser-title"
        data-testid="model-browser"
      >
        <div className="storage-heading">
          <div>
            <p className="eyebrow">Discovery</p>
            <h2 id="model-browser-title">Browse Hugging Face models</h2>
            <p>
              Search server-filtered GGUF candidates, then let WebAI inspect bounded pages at
              immutable commits to confirm public, ungated artifacts, quantizations, and exact
              download sizes.
            </p>
          </div>
          <Search aria-hidden="true" />
        </div>

        <details
          className="browse-filter-panel"
          data-testid="browse-filter-disclosure"
          open={browseFiltersOpen}
          onToggle={(event) => setBrowseFiltersOpen(event.currentTarget.open)}
        >
          <summary className="browse-filter-summary">
            <Search aria-hidden="true" />
            <span>
              <strong>Search and filters</strong>
              <span>
                {browseQuery.trim() === "" ? "All GGUF models" : `“${browseQuery.trim()}”`} ·{" "}
                {activeBrowseFilterCount} active filter
                {activeBrowseFilterCount === 1 ? "" : "s"}
              </span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <form
            className="model-browse-form"
            role="search"
            aria-label="Search Hugging Face models"
            onSubmit={(event) => {
              event.preventDefault();
              void browse();
            }}
          >
            <label>
              Search models
              <input
                value={browseQuery}
                onChange={(event) => setBrowseQuery(event.target.value)}
                placeholder="Qwen, Gemma, Llama…"
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                disabled={workerAvailable !== true || browsing}
              />
            </label>
            <fieldset className="browse-check-group browse-capabilities">
              <legend>Declared capabilities</legend>
              <label>
                <input
                  type="checkbox"
                  checked={browseCapabilities.length === 0}
                  onChange={() => setBrowseCapabilities([])}
                  disabled={workerAvailable !== true || browsing}
                />
                All
              </label>
              {capabilityOptions.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={browseCapabilities.includes(option.value)}
                    onChange={(event) => {
                      setBrowseCapabilities((current) =>
                        event.target.checked
                          ? [...current, option.value]
                          : current.filter((value) => value !== option.value),
                      );
                    }}
                    disabled={workerAvailable !== true || browsing}
                  />
                  {option.label}
                </label>
              ))}
              <p className="field-help">Every checked capability is required (AND).</p>
            </fieldset>
            <fieldset className="browse-check-group">
              <legend>Runtime</legend>
              <label>
                <input type="checkbox" checked readOnly disabled />
                wllama
              </label>
              <p className="field-help">
                Current download target; architecture support is verified when the model loads.
              </p>
            </fieldset>
            <fieldset className="browse-check-group" aria-describedby="browse-format-help">
              <legend>Artifact format</legend>
              <label>
                <input type="checkbox" checked readOnly disabled />
                GGUF
              </label>
            </fieldset>
            <fieldset className="browse-check-group browse-quantization">
              <legend>Nominal quantization bits</legend>
              {quantizationOptions.map((bits) => (
                <label key={bits}>
                  <input
                    type="checkbox"
                    checked={browseQuantizationBits.includes(bits)}
                    onChange={(event) => {
                      setBrowseQuantizationBits((current) =>
                        event.target.checked
                          ? [...current, bits]
                          : current.filter((value) => value !== bits),
                      );
                    }}
                    disabled={workerAvailable !== true || browsing}
                  />
                  {bits === "other" ? "Other" : `${bits}-bit`}
                </label>
              ))}
              {browseQuantizationBits.includes("other") ? (
                <label className="browse-other-quantization">
                  Other label contains
                  <input
                    value={browseOtherQuantization}
                    onChange={(event) => setBrowseOtherQuantization(event.target.value)}
                    placeholder="e.g. ternary"
                    maxLength={128}
                    spellCheck={false}
                    disabled={workerAvailable !== true || browsing}
                  />
                </label>
              ) : null}
            </fieldset>
            <label>
              Minimum declared context (K tokens)
              <input
                type="number"
                min="1"
                max="1024"
                step="any"
                value={browseMinimumContextK}
                onChange={(event) => setBrowseMinimumContextK(event.target.value)}
                onBlur={() => {
                  const text = browseMinimumContextK.trim();
                  if (text === "") {
                    setBrowseMinimumContextK(String(defaultBrowseMinimumContextK));
                    return;
                  }
                  const entered = Number(text);
                  if (Number.isFinite(entered) && entered >= 1 && entered <= 1024)
                    setBrowseMinimumContextK(String(Math.ceil(entered)));
                }}
                disabled={workerAvailable !== true || browsing}
              />
              <span className="field-help">
                1 K = 1,024 tokens. Manual values round up to the next whole K.
              </span>
            </label>
            <label>
              Maximum download size (GiB)
              <input
                type="number"
                min="0.01"
                max={maximumBrowseGiB}
                step="0.01"
                value={browseMaximumGiB}
                onChange={(event) => setBrowseMaximumGiB(event.target.value)}
                onBlur={() => {
                  if (browseMaximumGiB.trim() === "")
                    setBrowseMaximumGiB(String(defaultBrowseMaximumGiB));
                }}
                disabled={workerAvailable !== true || browsing}
              />
            </label>
            <div className="browse-actions">
              {browsing ? (
                <Button type="button" onClick={stopBrowse}>
                  <Pause aria-hidden="true" />
                  Stop searching
                </Button>
              ) : (
                <Button variant="primary" type="submit" disabled={workerAvailable !== true}>
                  <Search aria-hidden="true" />
                  Browse models
                </Button>
              )}
            </div>
            <p id="browse-format-help" className="field-help browse-filter-help">
              Hugging Face narrows GGUF candidates first. WebAI then caches bounded, revision-pinned
              model details locally and applies capability, context, quantization, and size filters.
              Capability labels are declared metadata, not proof that the current runtime can use
              them. Quantization is a nominal filename class, not average bits per weight. Future
              runtimes will add their formats here when their acquisition paths land.
            </p>
          </form>
        </details>

        {browsing ? (
          <div className="browse-pending" data-enrichment-state="pending">
            <RefreshCw aria-hidden="true" />
            <div role="status">
              <strong>Inspecting candidate files</strong>
              <p>
                {browseProgress === undefined || browseProgress.inspectedPages === 0
                  ? "Fetching the first bounded candidate page."
                  : `${browseProgress.inspectedCandidates.toLocaleString()} candidate${browseProgress.inspectedCandidates === 1 ? "" : "s"} inspected across ${browseProgress.inspectedPages.toLocaleString()} page${browseProgress.inspectedPages === 1 ? "" : "s"}.`}{" "}
                Unknown candidates remain pending, not incompatible.
              </p>
              {showBrowseProgressBar ? (
                <progress aria-label="Collecting and filtering Hugging Face model details" />
              ) : null}
            </div>
            <Button type="button" onClick={stopBrowse}>
              <Pause aria-hidden="true" />
              Stop searching
            </Button>
          </div>
        ) : null}
        {browseError === undefined ? null : (
          <div className="model-alert" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div>
              <strong>Model discovery failed</strong>
              <p>{browseError}</p>
            </div>
          </div>
        )}

        {browseResult === undefined ? null : (
          <div className="model-search-results" data-testid="model-search-results">
            <div className="resolved-heading">
              <div>
                <h3>Inspected results</h3>
                <p>
                  {browseResult.matches.length} matching repo
                  {browseResult.matches.length === 1 ? "" : "s"} ·{" "}
                  {browseResult.needsVerification.length} need
                  {browseResult.needsVerification.length === 1 ? "s" : ""} metadata verification ·{" "}
                  {browseResult.inspectedCandidates} candidate
                  {browseResult.inspectedCandidates === 1 ? "" : "s"} across{" "}
                  {browseResult.inspectedPages} page
                  {browseResult.inspectedPages === 1 ? "" : "s"} · {browseResult.excludedCandidates}{" "}
                  excluded by confirmed metadata or artifact filters
                </p>
                <p>
                  Local catalog: {browseResult.catalog.entries.toLocaleString()} revision-pinned
                  model detail snapshot{browseResult.catalog.entries === 1 ? "" : "s"} ·{" "}
                  {formatBytes(browseResult.catalog.bytes)} · {browseResult.cacheHits} cache hit
                  {browseResult.cacheHits === 1 ? "" : "s"} this pass ·{" "}
                  {browseResult.catalog.persistent
                    ? "persistent SQLite in OPFS"
                    : `memory fallback (${browseResult.catalog.reason ?? "persistent storage unavailable"})`}
                </p>
              </div>
            </div>
            {browseFiltersDirty ? (
              <div className="browse-filter-stale" role="status">
                <RefreshCw aria-hidden="true" />
                <p>Filters changed. These are the previous results; run the search to refresh.</p>
              </div>
            ) : null}
            {browseResult.truncated ? (
              <div className="browse-filter-stale" role="status">
                <TriangleAlert aria-hidden="true" />
                {browseResult.truncationReason === "stopped" ? (
                  <p>
                    Search stopped after {browseResult.inspectedCandidates.toLocaleString()}{" "}
                    inspected candidate{browseResult.inspectedCandidates === 1 ? "" : "s"}. These
                    are the results collected before cancellation; run the search again to continue.
                  </p>
                ) : browseResult.truncationReason === "result-budget" ? (
                  <p>
                    This broad search retained {browseResult.inspectedCandidates.toLocaleString()}{" "}
                    candidates and reached the 32 MiB result safety budget. Refine the filters to
                    narrow the next automatic Hub pass.
                  </p>
                ) : (
                  <p>
                    This broad search inspected {browseResult.inspectedCandidates.toLocaleString()}{" "}
                    candidates and reached the bounded page/candidate safety boundary. Refine the
                    filters to narrow the next automatic Hub pass.
                  </p>
                )}
              </div>
            ) : null}
            {browseResult.matches.length === 0 &&
            browseResult.needsVerification.length === 0 &&
            browseResult.unknown.length === 0 ? (
              <div className="model-empty">
                <Search aria-hidden="true" />
                <h3>No confirmed matches yet</h3>
                <p>Adjust the filters and run the search again.</p>
              </div>
            ) : null}
            {browseFamilies.length === 0 ? null : (
              <div className="browse-hierarchy" data-testid="browse-hierarchy">
                <section className="browse-hierarchy-column" aria-labelledby="browse-family-title">
                  <div className="browse-column-heading">
                    <p className="eyebrow">1</p>
                    <h4 id="browse-family-title">Family / architecture</h4>
                    <p>Broad facet from declared architecture metadata, not proof of lineage.</p>
                  </div>
                  <div className="browse-choice-list">
                    {browseFamilies.map((family) => {
                      const variants = family.models.reduce(
                        (total, model) => total + model.variants.length,
                        0,
                      );
                      const installedVariants = family.models.reduce(
                        (total, model) =>
                          total +
                          model.variants.filter(({ item }) =>
                            installedByVariant.has(variantIdentity(item.repo, item.commit)),
                          ).length,
                        0,
                      );
                      return (
                        <button
                          type="button"
                          key={family.key}
                          className="browse-hierarchy-choice"
                          aria-pressed={selectedBrowseFamily?.key === family.key}
                          onClick={() => {
                            setSelectedBrowseFamilyKey(family.key);
                            setSelectedBrowseModelKey(undefined);
                            setSelectedBrowseVariantKey(undefined);
                          }}
                        >
                          <strong>{family.label}</strong>
                          <span>{family.detail}</span>
                          <small>
                            {family.models.length} model{family.models.length === 1 ? "" : "s"} ·{" "}
                            {variants} variant{variants === 1 ? "" : "s"} ·{" "}
                            {downloadSummary(family.downloads, family.downloadReports, variants)}
                          </small>
                          {inventory === undefined ? null : (
                            <span
                              className={`browse-installed-indicator ${installedVariants === 0 ? "browse-none-downloaded" : ""}`}
                            >
                              {installedVariants === 0 ? (
                                <HardDrive aria-hidden="true" />
                              ) : (
                                <CircleCheck aria-hidden="true" />
                              )}
                              {installedVariants} of {variants} visible variant
                              {variants === 1 ? "" : "s"} downloaded
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="browse-hierarchy-column" aria-labelledby="browse-model-title">
                  <div className="browse-column-heading">
                    <p className="eyebrow">2</p>
                    <h4 id="browse-model-title">Model</h4>
                    <p>
                      Declared parent model, or the repository itself when no consistent parent is
                      declared.
                    </p>
                  </div>
                  <div className="browse-choice-list">
                    {selectedBrowseFamily?.models.map((model) => {
                      const installedVariants = model.variants.filter(({ item }) =>
                        installedByVariant.has(variantIdentity(item.repo, item.commit)),
                      ).length;
                      return (
                        <button
                          type="button"
                          key={model.key}
                          className="browse-hierarchy-choice"
                          aria-pressed={selectedBrowseModel?.key === model.key}
                          onClick={() => {
                            setSelectedBrowseModelKey(model.key);
                            setSelectedBrowseVariantKey(undefined);
                          }}
                        >
                          <strong>{model.label}</strong>
                          <span>{model.detail}</span>
                          <small>
                            {model.variants.length} variant{model.variants.length === 1 ? "" : "s"}{" "}
                            ·{" "}
                            {downloadSummary(
                              model.downloads,
                              model.downloadReports,
                              model.variants.length,
                            )}
                          </small>
                          {inventory === undefined ? null : (
                            <span
                              className={`browse-installed-indicator ${installedVariants === 0 ? "browse-none-downloaded" : ""}`}
                            >
                              {installedVariants === 0 ? (
                                <HardDrive aria-hidden="true" />
                              ) : (
                                <CircleCheck aria-hidden="true" />
                              )}
                              {installedVariants} of {model.variants.length} visible variant
                              {model.variants.length === 1 ? "" : "s"} downloaded
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="browse-hierarchy-column" aria-labelledby="browse-variant-title">
                  <div className="browse-column-heading">
                    <p className="eyebrow">3</p>
                    <h4 id="browse-variant-title">Repository variant</h4>
                    <p>Publisher conversions, quantizations, fine-tunes, and merges.</p>
                  </div>
                  <div className="browse-choice-list">
                    {selectedBrowseModel?.variants.map(({ item, needsVerification }) => {
                      const installed = installedByVariant.has(
                        variantIdentity(item.repo, item.commit),
                      );
                      return (
                        <button
                          type="button"
                          key={`${item.repo}@${item.commit}`}
                          className="browse-hierarchy-choice"
                          data-repo-id={item.repo}
                          data-enrichment-state={needsVerification ? "needs-verification" : "ready"}
                          aria-pressed={
                            selectedBrowseVariant?.item.repo === item.repo &&
                            selectedBrowseVariant.item.commit === item.commit
                          }
                          onClick={() => setSelectedBrowseVariantKey(`${item.repo}@${item.commit}`)}
                        >
                          <strong>{item.repo}</strong>
                          <span>{baseRelationship(item)}</span>
                          <small>
                            {item.matchingChoices.length} matching artifact
                            {item.matchingChoices.length === 1 ? "" : "s"}
                          </small>
                          <small>{variantDownloadSummary(item.downloads)}</small>
                          {installed ? (
                            <span className="browse-installed-indicator">
                              <CircleCheck aria-hidden="true" /> Downloaded
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="browse-detail-panel" aria-labelledby="browse-detail-title">
                  <div className="browse-column-heading">
                    <p className="eyebrow">4 · Selected instance</p>
                    <h4 id="browse-detail-title">Model details</h4>
                  </div>
                  {selectedBrowseVariant === undefined ? (
                    <p>Select a family, model, and repository variant to inspect it.</p>
                  ) : (
                    <article
                      className="browse-result-card"
                      data-testid="browse-selected-detail"
                      data-repo-id={selectedBrowseVariant.item.repo}
                      data-enrichment-state={
                        selectedBrowseVariant.needsVerification ? "needs-verification" : "ready"
                      }
                      aria-label={selectedBrowseVariant.item.repo}
                    >
                      <div className="resolved-heading">
                        <div>
                          <h4>{selectedBrowseVariant.item.repo}</h4>
                          <p className="mono">{selectedBrowseVariant.item.commit}</p>
                        </div>
                        <div className="browse-detail-statuses">
                          {selectedInstalledRecords.length === 0 ? null : (
                            <span className="status-badge status-supported">
                              <CircleCheck aria-hidden="true" />
                              Downloaded
                              {selectedInstalledRecords.length === 1
                                ? ""
                                : ` · ${selectedInstalledRecords.length} managed entries`}
                            </span>
                          )}
                          <span
                            className={`status-badge ${selectedBrowseVariant.needsVerification ? "status-unknown" : "status-supported"}`}
                          >
                            {selectedBrowseVariant.needsVerification ? (
                              <TriangleAlert aria-hidden="true" />
                            ) : (
                              <ShieldCheck aria-hidden="true" />
                            )}
                            {selectedBrowseVariant.needsVerification
                              ? "Needs metadata verification"
                              : "Search filters matched"}
                          </span>
                        </div>
                      </div>
                      <div className="browse-model-links">
                        <a
                          href={`https://huggingface.co/${selectedBrowseVariant.item.repo
                            .split("/")
                            .map(encodeURIComponent)
                            .join(
                              "/",
                            )}/blob/${encodeURIComponent(selectedBrowseVariant.item.commit)}/README.md`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open pinned model card
                        </a>
                        <a
                          href={`https://huggingface.co/${selectedBrowseVariant.item.repo
                            .split("/")
                            .map(encodeURIComponent)
                            .join("/")}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open current model page
                        </a>
                        <a
                          href={`https://huggingface.co/${selectedBrowseVariant.item.repo
                            .split("/")
                            .map(encodeURIComponent)
                            .join(
                              "/",
                            )}/tree/${encodeURIComponent(selectedBrowseVariant.item.commit)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View pinned files
                        </a>
                      </div>
                      <dl className="browse-repo-facts">
                        <div>
                          <dt>License</dt>
                          <dd>
                            {selectedBrowseVariant.item.repository.metadata.license ??
                              "Not declared"}
                          </dd>
                        </div>
                        <div>
                          <dt>Access</dt>
                          <dd>{accessLabel(selectedBrowseVariant.item.repository.metadata)}</dd>
                        </div>
                        <div>
                          <dt>Task</dt>
                          <dd>
                            {selectedBrowseVariant.item.repository.metadata.pipelineTask ??
                              "Not declared"}
                          </dd>
                        </div>
                        <div>
                          <dt>Context</dt>
                          <dd>
                            {selectedBrowseVariant.item.repository.metadata.contextLength?.toLocaleString() ??
                              "Not declared"}
                            {selectedBrowseVariant.item.repository.metadata.contextLength ===
                            undefined
                              ? ""
                              : " tokens"}
                          </dd>
                        </div>
                        <div>
                          <dt>Architecture</dt>
                          <dd>
                            {selectedBrowseVariant.item.repository.metadata.architecture ??
                              "Not declared"}
                          </dd>
                        </div>
                        <div>
                          <dt>Base relationship</dt>
                          <dd>
                            {lineageLoading ? (
                              <span className="lineage-loading">
                                <span>
                                  Loading full reported ancestry… {lineageProgress} repositor
                                  {lineageProgress === 1 ? "y" : "ies"} checked
                                </span>
                                <Button type="button" onClick={stopLineage}>
                                  Stop
                                </Button>
                              </span>
                            ) : lineageError !== undefined ? (
                              <span>Full ancestry could not be loaded: {lineageError}</span>
                            ) : browseResult.truncationReason === "stopped" &&
                              (selectedBrowseVariant.item.repository.metadata.baseModels?.length ??
                                0) > 0 ? (
                              <span>
                                Full ancestry was not fetched because this search was stopped.
                                Reported immediate parent
                                {(selectedBrowseVariant.item.repository.metadata.baseModels
                                  ?.length ?? 0) === 1
                                  ? ""
                                  : "s"}
                                :{" "}
                                {selectedBrowseVariant.item.repository.metadata.baseModels?.map(
                                  (parent, parentIndex) => (
                                    <span key={parent.repo}>
                                      {parentIndex === 0 ? null : ", "}
                                      <a
                                        href={`https://huggingface.co/${parent.repo
                                          .split("/")
                                          .map(encodeURIComponent)
                                          .join("/")}`}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {parent.repo}
                                      </a>
                                    </span>
                                  ),
                                )}
                              </span>
                            ) : lineage === undefined ? (
                              "No reported ancestry"
                            ) : (
                              <LineageTree lineage={lineage} />
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Declared capabilities</dt>
                          <dd>
                            {selectedBrowseVariant.item.repository.metadata.declaredCapabilities?.join(
                              ", ",
                            ) ?? "Not declared"}
                          </dd>
                        </div>
                        <div>
                          <dt>Hub downloads (last 30 days)</dt>
                          <dd>
                            {selectedBrowseVariant.item.downloads?.toLocaleString() ??
                              "Not reported"}
                          </dd>
                        </div>
                      </dl>
                      {!restrictedAccess(selectedBrowseVariant.item.repository.metadata) ? null : (
                        <p className="field-help">
                          WebAI supports only public, ungated Hugging Face models.
                        </p>
                      )}
                      <ul className="quant-list">
                        {selectedBrowseVariant.item.matchingChoices.map((choice) => {
                          const item = selectedBrowseVariant.item;
                          const busyId = `download:${item.repository.repo}:${item.repository.commit}:${choice.id}`;
                          const choiceDownloaded = selectedInstalledRecords.some(
                            (model) =>
                              model.source.kind === "hugging-face" &&
                              sameSourceFiles(model.source.files, choice.files),
                          );
                          return (
                            <li key={choice.id}>
                              <div>
                                <strong>{choice.quantization}</strong>
                                <p>{choice.label}</p>
                                <p>
                                  {formatBytes(choice.totalSize)} · {choice.files.length} file
                                  {choice.files.length === 1 ? "" : "s"} · LFS SHA-256
                                </p>
                                <p>{storageHint(choice, inventory)}</p>
                                <p>
                                  Runtime memory fit unknown · download size is not runtime memory.
                                </p>
                              </div>
                              <Button
                                onClick={() => startDownload(item.repository, choice)}
                                disabled={
                                  workerAvailable !== true ||
                                  acquisitionBusy ||
                                  choiceDownloaded ||
                                  restrictedAccess(item.repository.metadata)
                                }
                                aria-busy={busyIds.has(busyId)}
                                aria-label={
                                  choiceDownloaded
                                    ? `${choice.quantization} for ${item.repo} is downloaded`
                                    : `Download ${choice.quantization} for ${item.repo}`
                                }
                              >
                                {choiceDownloaded ? (
                                  <CircleCheck aria-hidden="true" />
                                ) : (
                                  <Download aria-hidden="true" />
                                )}
                                {choiceDownloaded ? "Downloaded" : "Download"}
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                      {selectedBrowseVariant.item.omittedMatchingChoices === 0 ? null : (
                        <p className="field-help">
                          {selectedBrowseVariant.item.omittedMatchingChoices} additional matching
                          artifact
                          {selectedBrowseVariant.item.omittedMatchingChoices === 1
                            ? " was"
                            : "s were"}{" "}
                          omitted from this bounded result. Use manual acquisition to inspect the
                          full repository.
                        </p>
                      )}
                    </article>
                  )}
                </section>
              </div>
            )}
            {browseResult.unknown.length === 0 ? null : (
              <details className="browse-unknown-results">
                <summary>
                  {browseResult.unknown.length} result
                  {browseResult.unknown.length === 1 ? " could" : "s could"} not be inspected
                </summary>
                <div className="browse-unknown-list">
                  {browseResult.unknown.map((item) => (
                    <article
                      key={`${item.repo}@${item.commit ?? "unknown"}`}
                      className="browse-result-card unknown-result"
                      data-repo-id={item.repo}
                      data-enrichment-state="unknown"
                      aria-label={item.repo}
                    >
                      <div className="resolved-heading">
                        <div>
                          <h4>{item.repo}</h4>
                          <p>{item.reason}</p>
                        </div>
                        <span className="status-badge status-unknown">
                          <TriangleAlert aria-hidden="true" />
                          Not inspected
                        </span>
                      </div>
                      <p>
                        License: {item.metadata.license ?? "Not declared"} ·{" "}
                        {accessLabel(item.metadata)}
                      </p>
                      <a
                        href={`https://huggingface.co/${item.repo
                          .split("/")
                          .map(encodeURIComponent)
                          .join("/")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open on Hugging Face
                      </a>
                    </article>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

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
              pins public, ungated repositories to a commit before listing files.
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
                disabled={workerAvailable !== true || resolving}
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
              <dl className="browse-repo-facts">
                <div>
                  <dt>License</dt>
                  <dd>{resolved.metadata.license ?? "Not declared"}</dd>
                </div>
                <div>
                  <dt>Access</dt>
                  <dd>{accessLabel(resolved.metadata)}</dd>
                </div>
                <div>
                  <dt>Task</dt>
                  <dd>{resolved.metadata.pipelineTask ?? "Not declared"}</dd>
                </div>
              </dl>
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
                          onClick={() => startDownload(resolved, choice, true)}
                          disabled={
                            workerAvailable !== true ||
                            acquisitionBusy ||
                            restrictedAccess(resolved.metadata)
                          }
                          aria-busy={busyIds.has(
                            `download:${resolved.repo}:${resolved.commit}:${choice.id}`,
                          )}
                        >
                          <Download aria-hidden="true" />
                          Download model + MTP
                        </Button>
                      )}
                      <Button
                        onClick={() => startDownload(resolved, choice)}
                        disabled={
                          workerAvailable !== true ||
                          acquisitionBusy ||
                          restrictedAccess(resolved.metadata)
                        }
                        aria-busy={busyIds.has(
                          `download:${resolved.repo}:${resolved.commit}:${choice.id}`,
                        )}
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
                    .join("/")}/tree/${encodeURIComponent(resolved.commit)}`}
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
