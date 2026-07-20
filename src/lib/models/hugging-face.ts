import { type HuggingFaceCatalog, maximumCatalogSnapshotBytes } from "./catalog";
import type {
  HuggingFaceArtifactChoice,
  HuggingFaceBrowseFilters,
  HuggingFaceBrowseItem,
  HuggingFaceBrowseResult,
  HuggingFaceBrowseUnknown,
  HuggingFaceBaseModel,
  HuggingFaceCapability,
  HuggingFaceFile,
  HuggingFaceGating,
  HuggingFaceLineage,
  HuggingFaceLineageNode,
  IntegrityIdentity,
  ResolvedHuggingFaceRepository,
} from "./types";
import {
  maximumArtifactChoiceFiles,
  maximumBrowsePages,
  maximumBrowseResultBytes,
  maximumQuantizationLength,
  ModelOperationError,
} from "./types";

const hfOrigin = "https://huggingface.co";
const maxMetadataBytes = maximumCatalogSnapshotBytes;
const maxFiles = 50_000;
const maxArtifactBytes = 16 * 1024 ** 4;
const maxPathLength = 1_024;
const sha256Pattern = /^[a-fA-F0-9]{64}$/;
const sha1Pattern = /^[a-fA-F0-9]{40}$/;
const commitPattern = /^[a-fA-F0-9]{40}$/;
const repoPartPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const default429Retries = 3;
const browsePageSize = 8;
const maxTags = 256;
const maxLinkLength = 16 * 1024;
const maxLineageNodes = 32;
const maxLineageSnapshotBytes = 256 * 1024;
const lineageCacheFreshnessMs = 24 * 60 * 60 * 1_000;
const quantizationBitLevels = new Set([1, 2, 3, 4, 5, 6, 8, 16, 32]);
const capabilityValues = new Set<HuggingFaceCapability>([
  "thinking",
  "text-generation",
  "tool-calling",
  "image-generation",
  "image-input",
  "text-to-speech",
  "speech-recognition",
]);
const primaryCapabilityValues = new Set<HuggingFaceCapability>([
  "text-generation",
  "image-generation",
  "text-to-speech",
  "speech-recognition",
]);

export interface RateLimitRetry {
  readonly attempt: number;
  readonly delayMs: number;
}

interface BackoffOptions {
  readonly signal?: AbortSignal;
  readonly onRetry?: (retry: RateLimitRetry) => void;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly retries?: number;
  readonly runAttempt?: (request: () => Promise<Response>) => Promise<Response>;
}

function retryAfterDelayMs(header: string | null, now: () => number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.min(30_000, seconds * 1_000) : 30_000;
  }
  if (!/[A-Za-z]/u.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(30_000, Math.max(0, Math.round(date - now())));
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timeout);
      reject(new DOMException("paused", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function fetchWith429Backoff(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  options: BackoffOptions = {},
): Promise<Response> {
  const retries = options.retries ?? default429Retries;
  for (let attempt = 0; ; attempt += 1) {
    const request = async () => await fetcher(input, init);
    const response =
      options.runAttempt === undefined ? await request() : await options.runAttempt(request);
    if (response.status !== 429 || attempt >= retries) return response;
    const ceiling = Math.min(8_000, 500 * 2 ** attempt);
    const random = Math.max(0, Math.min(1, (options.random ?? Math.random)()));
    const retryAfter = retryAfterDelayMs(
      response.headers.get("Retry-After"),
      options.now ?? Date.now,
    );
    const delayMs = retryAfter ?? Math.round(ceiling * random);
    await response.body?.cancel().catch(() => undefined);
    options.signal?.throwIfAborted();
    options.onRetry?.({ attempt: attempt + 1, delayMs });
    await (options.sleep ?? abortableSleep)(delayMs, options.signal);
  }
}

interface ParsedModelInput {
  readonly repo: string;
  readonly revision: string;
  readonly selectedPath?: string;
}

function metadataFailure(message: string): ModelOperationError {
  return new ModelOperationError({
    code: "metadata-invalid",
    phase: "resolve",
    message,
    retryable: false,
  });
}

class NoGgufChoicesError extends ModelOperationError {}
class RestrictedRepositoryError extends ModelOperationError {}

function inputFailure(message: string): ModelOperationError {
  return new ModelOperationError({
    code: "input-invalid",
    phase: "resolve",
    message,
    retryable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validRepo(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => repoPartPattern.test(part));
}

function validRevision(revision: string): boolean {
  return (
    revision.length > 0 &&
    revision.length <= 200 &&
    !revision.startsWith("/") &&
    !revision.endsWith("/") &&
    !revision.includes("..") &&
    !hasControlCharacter(revision) &&
    !/[\\?#]/u.test(revision)
  );
}

export function isSafeRepoPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > maxPathLength ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  ) {
    return false;
  }
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function parseModelInput(rawInput: string): ParsedModelInput {
  const input = rawInput.trim();
  if (input.length === 0 || input.length > 2_048) {
    throw inputFailure("Enter a Hugging Face model ID or URL.");
  }

  if (!input.includes("://")) {
    const at = input.lastIndexOf("@");
    const repo = at > 0 ? input.slice(0, at) : input;
    const revision = at > 0 ? input.slice(at + 1) : "main";
    if (!validRepo(repo) || !validRevision(revision)) {
      throw inputFailure("Use owner/model, optionally followed by @revision.");
    }
    return { repo, revision };
  }

  if (/(?:^|\/)(?:\.{2}|%2e%2e|%2e\.|\.%2e)(?:\/|$)/iu.test(input)) {
    throw inputFailure("The Hugging Face URL contains an unsafe path segment.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw inputFailure("The Hugging Face URL is not valid.");
  }
  if (
    url.origin !== hfOrigin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== ""
  ) {
    throw inputFailure("Only plain https://huggingface.co model URLs are accepted.");
  }
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw inputFailure("The Hugging Face URL contains invalid escaping.");
      }
    });
  if (parts.length < 2) throw inputFailure("The URL must identify a model repository.");
  const repo = `${parts[0]}/${parts[1]}`;
  if (!validRepo(repo)) throw inputFailure("The URL contains an invalid model ID.");
  if (parts.length === 2) return { repo, revision: "main" };
  const operation = parts[2];
  if (operation !== "tree" && operation !== "blob" && operation !== "resolve") {
    throw inputFailure("Use a model repository, tree, blob, or resolve URL.");
  }
  const revision = parts[3] ?? "";
  if (!validRevision(revision)) throw inputFailure("The URL contains an invalid revision.");
  const selectedPath = parts.slice(4).join("/");
  if (selectedPath !== "" && !isSafeRepoPath(selectedPath)) {
    throw inputFailure("The URL contains an unsafe repository path.");
  }
  return { repo, revision, ...(selectedPath === "" ? {} : { selectedPath }) };
}

function encodeRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function encodeRevision(revision: string): string {
  return revision.split("/").map(encodeURIComponent).join("/");
}

export function resolverUrl(repo: string, commit: string, path: string): string {
  if (!validRepo(repo) || !commitPattern.test(commit) || !isSafeRepoPath(path)) {
    throw inputFailure("The stored Hugging Face source identity is invalid.");
  }
  return `${hfOrigin}/${encodeRepo(repo)}/resolve/${commit.toLowerCase()}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function readBoundedJson(
  response: Response,
  maximumBytes = maxMetadataBytes,
): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw metadataFailure("Hugging Face returned an oversized metadata response.");
    }
  }
  if (response.body === null) throw metadataFailure("Hugging Face returned no metadata body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw metadataFailure("Hugging Face returned an oversized metadata response.");
    }
    chunks.push(result.value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw metadataFailure("Hugging Face returned malformed metadata.");
  }
  return parsed;
}

function parseIntegrity(sibling: Record<string, unknown>, size: number): IntegrityIdentity {
  const lfs = sibling.lfs;
  if (isRecord(lfs)) {
    const lfsSize = lfs.size;
    const digest = typeof lfs.sha256 === "string" ? lfs.sha256 : lfs.oid;
    if (lfsSize !== size || typeof digest !== "string" || !sha256Pattern.test(digest)) {
      throw metadataFailure("A Hugging Face LFS file has inconsistent size or integrity metadata.");
    }
    return { kind: "lfs-sha256", digest: digest.toLowerCase() };
  }
  const blobId = sibling.blobId;
  if (typeof blobId !== "string" || !sha1Pattern.test(blobId)) {
    throw metadataFailure("A Hugging Face file has no usable integrity identity.");
  }
  return { kind: "git-blob-sha1", digest: blobId.toLowerCase() };
}

function parseFiles(value: unknown): HuggingFaceFile[] {
  if (!Array.isArray(value) || value.length > maxFiles) {
    throw metadataFailure("The repository file listing is missing or too large.");
  }
  const files: HuggingFaceFile[] = [];
  const paths = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !boundedString(item.rfilename, maxPathLength)) continue;
    const path = item.rfilename;
    if (!path.toLowerCase().endsWith(".gguf")) continue;
    if (!isSafeRepoPath(path) || paths.has(path)) {
      throw metadataFailure("The GGUF file listing contains a duplicate or unsafe path.");
    }
    paths.add(path);
    if (
      !Number.isSafeInteger(item.size) ||
      (item.size as number) < 0 ||
      (item.size as number) > maxArtifactBytes
    ) {
      throw metadataFailure(`The file metadata for ${path} has an invalid size.`);
    }
    const size = item.size as number;
    files.push({ path, size, integrity: parseIntegrity(item, size) });
  }
  return files;
}

const shardPattern = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/iu;
const auxiliaryGgufMarkers = ["mmproj", "imatrix", "mtp-", "eagle3-", "dflash-"] as const;

function quantizationFromName(name: string): string {
  const stem = name.slice(name.lastIndexOf("/") + 1).replace(/\.gguf$/iu, "");
  const shardless = stem.replace(/-\d{5}-of-\d{5}$/u, "");
  const match = shardless.match(/(?:^|[-._])((?:IQ|TQ|Q|F|BF|MXFP)\d+(?:_[A-Z0-9]+)*)$/iu);
  const quantization = match?.[1]?.toUpperCase();
  return quantization !== undefined && quantization.length <= maximumQuantizationLength
    ? quantization
    : "GGUF";
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function isPrimaryGguf(path: string): boolean {
  const filename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return !auxiliaryGgufMarkers.some((marker) => filename.includes(marker));
}

function quantizationBits(path: string): number {
  const match = quantizationFromName(path).match(/\d+/u);
  return match === null ? 0 : Number(match[0]);
}

function findOptionalMtp(
  files: readonly HuggingFaceFile[],
  primaryPath: string,
): HuggingFaceFile | undefined {
  const directory = directoryOf(primaryPath);
  const primaryBits = quantizationBits(primaryPath);
  return files
    .filter(
      (file) =>
        file.integrity.kind === "lfs-sha256" &&
        directoryOf(file.path) === directory &&
        file.path.toLowerCase().endsWith(".gguf") &&
        file.path
          .slice(file.path.lastIndexOf("/") + 1)
          .toLowerCase()
          .includes("mtp-"),
    )
    .sort(
      (left, right) =>
        Math.abs(quantizationBits(left.path) - primaryBits) -
          Math.abs(quantizationBits(right.path) - primaryBits) ||
        left.path.localeCompare(right.path),
    )[0];
}

export function groupGgufChoices(files: readonly HuggingFaceFile[]): HuggingFaceArtifactChoice[] {
  const gguf = files.filter(
    (file) => file.path.toLowerCase().endsWith(".gguf") && isPrimaryGguf(file.path),
  );
  const groups = new Map<string, { expected: number; files: HuggingFaceFile[] }>();
  const singles: HuggingFaceFile[] = [];
  for (const file of gguf) {
    if (file.integrity.kind !== "lfs-sha256") {
      throw metadataFailure(`The GGUF weight ${file.path} does not have an LFS SHA-256 identity.`);
    }
    const match = file.path.match(shardPattern);
    if (match === null) {
      singles.push(file);
      continue;
    }
    const index = Number(match[2]);
    const expected = Number(match[3]);
    if (expected === 1 && index === 1) {
      singles.push(file);
      continue;
    }
    if (expected < 2 || index < 1 || index > expected) {
      throw metadataFailure(`The shard name ${file.path} is inconsistent.`);
    }
    if (expected > maximumArtifactChoiceFiles) {
      throw metadataFailure(
        `The shard set ${match[1]} has ${expected} files; at most ${maximumArtifactChoiceFiles} files can be downloaded as one artifact.`,
      );
    }
    const key = `${match[1]}|${expected}`;
    const group = groups.get(key) ?? { expected, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }

  const choices: HuggingFaceArtifactChoice[] = singles.map((file) => ({
    id: file.path,
    label: file.path,
    quantization: quantizationFromName(file.path),
    totalSize: file.size,
    files: [file],
  }));
  for (const [key, group] of groups) {
    group.files.sort((left, right) => left.path.localeCompare(right.path));
    if (group.files.length !== group.expected) {
      throw metadataFailure(`The shard set ${key.split("|")[0]} is incomplete.`);
    }
    const indexes = new Set(group.files.map((file) => Number(file.path.match(shardPattern)?.[2])));
    if (indexes.size !== group.expected) {
      throw metadataFailure(`The shard set ${key.split("|")[0]} contains duplicate indexes.`);
    }
    const totalSize = group.files.reduce((total, file) => {
      const next = total + file.size;
      if (!Number.isSafeInteger(next) || next > maxArtifactBytes) {
        throw metadataFailure("The GGUF shard set is too large to represent safely.");
      }
      return next;
    }, 0);
    choices.push({
      id: key,
      label: `${key.split("|")[0]}.gguf (${group.expected} shards)`,
      quantization: quantizationFromName(group.files[0]?.path ?? ""),
      totalSize,
      files: group.files,
    });
  }
  return choices
    .map((choice) => {
      const optionalMtp = findOptionalMtp(files, choice.files[0]?.path ?? "");
      return optionalMtp === undefined ||
        choice.files.length >= maximumArtifactChoiceFiles ||
        choice.totalSize + optionalMtp.size > maxArtifactBytes
        ? choice
        : { ...choice, optionalMtp };
    })
    .sort(
      (left, right) => left.totalSize - right.totalSize || left.label.localeCompare(right.label),
    );
}

export function parseModelInfo(
  value: unknown,
  request: ParsedModelInput,
): ResolvedHuggingFaceRepository {
  if (!isRecord(value) || typeof value.sha !== "string" || !commitPattern.test(value.sha)) {
    throw metadataFailure("Hugging Face did not return an immutable repository commit.");
  }
  if (
    commitPattern.test(request.revision) &&
    value.sha.toLowerCase() !== request.revision.toLowerCase()
  ) {
    throw metadataFailure("Hugging Face returned a different commit than the pinned revision.");
  }
  const files = parseFiles(value.siblings);
  const choices = groupGgufChoices(files);
  if (choices.length === 0) {
    throw new NoGgufChoicesError({
      code: "metadata-invalid",
      phase: "resolve",
      message: "This revision does not contain an integrity-identified GGUF file.",
      retryable: false,
    });
  }
  return {
    repo: request.repo,
    requestedRevision: request.revision,
    commit: value.sha.toLowerCase(),
    choices,
    metadata: parseRepositoryMetadata(value),
    ...(request.selectedPath === undefined ? {} : { selectedPath: request.selectedPath }),
  };
}

function parseGating(value: unknown): HuggingFaceGating {
  if (value === false) return "open";
  if (value === true) return "gated";
  if (value === "auto") return "automatic";
  if (value === "manual") return "manual";
  return "unknown";
}

function parseRepositoryMetadata(
  value: Record<string, unknown>,
): ResolvedHuggingFaceRepository["metadata"] {
  const tags =
    Array.isArray(value.tags) &&
    value.tags.length <= maxTags &&
    value.tags.every((tag) => typeof tag === "string" && boundedString(tag, 160))
      ? value.tags
      : [];
  const licenseTags = tags.filter(
    (tag): tag is string =>
      typeof tag === "string" && tag.startsWith("license:") && boundedString(tag, 160),
  );
  const taggedLicense =
    licenseTags.length === 1 ? licenseTags[0]?.slice("license:".length) : undefined;
  const cardData = isRecord(value.cardData) ? value.cardData : undefined;
  const customLicenseName =
    cardData !== undefined && boundedString(cardData.license_name, 160)
      ? cardData.license_name
      : undefined;
  const license =
    taggedLicense === "other" && customLicenseName !== undefined
      ? customLicenseName
      : taggedLicense;
  const pipelineTask = boundedString(value.pipeline_tag, 160) ? value.pipeline_tag : undefined;
  const author = boundedString(value.author, 160) ? value.author : undefined;
  const library = boundedString(value.library_name, 160) ? value.library_name : undefined;
  const gguf = isRecord(value.gguf) ? value.gguf : undefined;
  const config = isRecord(value.config) ? value.config : undefined;
  const architecture =
    gguf !== undefined && boundedString(gguf.architecture, 160)
      ? gguf.architecture
      : config !== undefined && boundedString(config.model_type, 160)
        ? config.model_type
        : undefined;
  const contextLength =
    gguf !== undefined &&
    Number.isSafeInteger(gguf.context_length) &&
    (gguf.context_length as number) >= 256 &&
    (gguf.context_length as number) <= 1024 * 1024
      ? (gguf.context_length as number)
      : undefined;
  const baseModels = parseBaseModels(value.baseModels, cardData, tags);
  const normalizedTags = new Set(tags.map((tag) => tag.toLowerCase()));
  const normalizedTask = pipelineTask?.toLowerCase();
  const declaredCapabilities = [...capabilityValues].filter((capability) =>
    capabilityDeclared(capability, normalizedTask, normalizedTags),
  );
  return {
    gating: parseGating(value.gated),
    ...(value.private === true
      ? { visibility: "private" as const }
      : value.private === false
        ? { visibility: "public" as const }
        : {}),
    ...(license === undefined || license.length === 0 ? {} : { license }),
    ...(pipelineTask === undefined ? {} : { pipelineTask }),
    ...(author === undefined ? {} : { author }),
    ...(library === undefined ? {} : { library }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(architecture === undefined ? {} : { architecture }),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(baseModels.length === 0 ? {} : { baseModels }),
    ...(declaredCapabilities.length === 0 ? {} : { declaredCapabilities }),
  };
}

function parseBaseModels(
  value: unknown,
  cardData: Record<string, unknown> | undefined,
  tags: readonly string[],
): NonNullable<ResolvedHuggingFaceRepository["metadata"]["baseModels"]> {
  type BaseModel = {
    repo: string;
    relation?: "adapter" | "finetune" | "merge" | "quantized" | "unknown";
  };
  const structured: BaseModel[] = [];
  const card: BaseModel[] = [];
  const tagged: BaseModel[] = [];
  const add = (target: BaseModel[], repo: unknown, relation?: unknown) => {
    if (
      target.length >= 16 ||
      typeof repo !== "string" ||
      !validRepo(repo) ||
      target.some((model) => model.repo === repo)
    )
      return;
    const normalizedRelation =
      relation === "adapter" ||
      relation === "finetune" ||
      relation === "merge" ||
      relation === "quantized"
        ? relation
        : undefined;
    target.push({
      repo,
      ...(normalizedRelation === undefined ? {} : { relation: normalizedRelation }),
    });
  };
  if (isRecord(value) && Array.isArray(value.models) && value.models.length <= 16) {
    for (const model of value.models)
      if (isRecord(model)) add(structured, model.id, value.relation);
  }
  if (cardData !== undefined) {
    const cardBase = cardData.base_model;
    if (Array.isArray(cardBase) && cardBase.length <= 16) {
      for (const repo of cardBase) add(card, repo, cardData.base_model_relation);
    } else {
      add(card, cardBase, cardData.base_model_relation);
    }
  }
  for (const tag of tags) {
    const relationMatch = tag.match(/^base_model:(adapter|finetune|merge|quantized):(.+)$/u);
    if (relationMatch !== null) add(tagged, relationMatch[2], relationMatch[1]);
  }
  for (const tag of tags) {
    const baseMatch = tag.match(/^base_model:(?!adapter:|finetune:|merge:|quantized:)(.+)$/u);
    if (baseMatch !== null) add(tagged, baseMatch[1]);
  }
  const sources = [structured, card, tagged].filter((source) => source.length > 0);
  const identities = new Set(
    sources.map((source) =>
      source
        .map((model) => model.repo)
        .sort()
        .join("\n"),
    ),
  );
  if (identities.size > 1) return [];
  for (const repo of sources[0]?.map((model) => model.repo) ?? []) {
    const relations = new Set(
      sources
        .map((source) => source.find((model) => model.repo === repo)?.relation)
        .filter((relation) => relation !== undefined),
    );
    if (relations.size > 1) return [];
  }
  return structured.length > 0 ? structured : card.length > 0 ? card : tagged;
}

function capabilityDeclared(
  capability: HuggingFaceCapability,
  task: string | undefined,
  tags: ReadonlySet<string>,
): boolean {
  const has = (...values: readonly string[]) => values.some((value) => tags.has(value));
  switch (capability) {
    case "thinking":
      return has("reasoning", "thinking");
    case "text-generation":
      return (
        task === "text-generation" ||
        task === "text2text-generation" ||
        task === "image-text-to-text" ||
        task === "any-to-any" ||
        has("text-generation", "text2text-generation", "conversational")
      );
    case "tool-calling":
      return has("tool-use", "tool-calling", "function-calling");
    case "image-generation":
      return (
        task === "text-to-image" ||
        task === "image-to-image" ||
        task === "unconditional-image-generation" ||
        has("text-to-image", "image-to-image", "unconditional-image-generation")
      );
    case "image-input":
      return (
        task === "image-text-to-text" ||
        task === "visual-question-answering" ||
        task === "document-question-answering" ||
        task === "any-to-any" ||
        has("image-text-to-text", "visual-question-answering", "vision")
      );
    case "text-to-speech":
      return task === "text-to-speech" || has("text-to-speech");
    case "speech-recognition":
      return task === "automatic-speech-recognition" || has("automatic-speech-recognition");
  }
}

function primaryCapabilityForTask(task: string | undefined): HuggingFaceCapability | undefined {
  if (task === undefined || task === "any-to-any") return undefined;
  if (
    task === "text-generation" ||
    task === "text2text-generation" ||
    task === "image-text-to-text"
  )
    return "text-generation";
  if (
    task === "text-to-image" ||
    task === "image-to-image" ||
    task === "unconditional-image-generation"
  )
    return "image-generation";
  if (task === "text-to-speech") return "text-to-speech";
  if (task === "automatic-speech-recognition") return "speech-recognition";
  return undefined;
}

async function fetchResolvedHuggingFaceModel(
  input: string,
  fetcher: typeof fetch = fetch,
  onRetry?: (retry: RateLimitRetry) => void,
  signal?: AbortSignal,
): Promise<{
  readonly repository: ResolvedHuggingFaceRepository;
  readonly rawJson: string;
  readonly cacheable: boolean;
}> {
  const request = parseModelInput(input);
  const url = new URL(
    `/api/models/${encodeRepo(request.repo)}/revision/${encodeRevision(request.revision)}`,
    hfOrigin,
  );
  url.searchParams.set("blobs", "true");
  for (const field of [
    "author",
    "baseModels",
    "cardData",
    "childrenModelCount",
    "config",
    "createdAt",
    "downloads",
    "gated",
    "gguf",
    "lastModified",
    "library_name",
    "likes",
    "model-index",
    "pipeline_tag",
    "private",
    "safetensors",
    "sha",
    "siblings",
    "spaces",
    "tags",
    "transformersInfo",
    "usedStorage",
  ])
    url.searchParams.append("expand", field);
  let response: Response;
  try {
    response = await fetchWith429Backoff(
      fetcher,
      url.href,
      {
        headers: { Accept: "application/json" },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
      {
        ...(onRetry === undefined ? {} : { onRetry }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ModelOperationError({
      code: "network",
      phase: "resolve",
      message: "Hugging Face could not be reached. Check the connection and retry.",
      retryable: true,
    });
  }
  if (!response.ok) {
    const accessDenied = response.status === 401 || response.status === 403;
    throw new ModelOperationError({
      code: accessDenied || response.status === 404 ? "input-invalid" : "network",
      phase: "resolve",
      message: accessDenied
        ? "This repository is not publicly accessible. WebAI supports only public, ungated Hugging Face models."
        : response.status === 404
          ? "That public model or revision was not found."
          : `Hugging Face returned HTTP ${response.status}. Retry the request.`,
      retryable: !accessDenied && response.status !== 404,
    });
  }
  const value = await readBoundedJson(response);
  const cacheable =
    isRecord(value) && value.private === false && parseGating(value.gated) === "open";
  const repository = parseModelInfo(value, request);
  if (repository.metadata.visibility !== "public" || repository.metadata.gating !== "open")
    throw new RestrictedRepositoryError({
      code: "unsupported",
      phase: "resolve",
      message: "WebAI supports only public, ungated Hugging Face models.",
      retryable: false,
    });
  return {
    repository,
    rawJson: JSON.stringify(value),
    cacheable,
  };
}

export async function resolveHuggingFaceModel(
  input: string,
  fetcher: typeof fetch = fetch,
  onRetry?: (retry: RateLimitRetry) => void,
  signal?: AbortSignal,
): Promise<ResolvedHuggingFaceRepository> {
  return (await fetchResolvedHuggingFaceModel(input, fetcher, onRetry, signal)).repository;
}

interface LineageSnapshot {
  readonly node: HuggingFaceLineageNode;
  readonly cacheHit: boolean;
}

function parseLineageSnapshot(value: unknown, repo: string): HuggingFaceLineageNode {
  if (!isRecord(value) || typeof value.sha !== "string" || !commitPattern.test(value.sha))
    throw metadataFailure("Hugging Face did not return an immutable lineage snapshot.");
  return {
    repo,
    commit: value.sha.toLowerCase(),
    parents: parseRepositoryMetadata(value).baseModels ?? [],
    status: "resolved",
  };
}

function freshCatalogEntry(fetchedAt: string): boolean {
  const timestamp = Date.parse(fetchedAt);
  const age = Date.now() - timestamp;
  return Number.isFinite(timestamp) && age >= -5 * 60_000 && age <= lineageCacheFreshnessMs;
}

async function fetchLineageSnapshot(
  repo: string,
  options: {
    readonly fetcher: typeof fetch;
    readonly signal?: AbortSignal;
    readonly onRetry?: (retry: RateLimitRetry) => void;
    readonly catalog?: HuggingFaceCatalog;
  },
): Promise<LineageSnapshot> {
  let cached: Awaited<ReturnType<NonNullable<HuggingFaceCatalog["getLineage"]>>>;
  try {
    cached = await options.catalog?.getLineage?.(repo);
  } catch {
    cached = undefined;
  }
  if (cached !== undefined && freshCatalogEntry(cached.fetchedAt)) {
    try {
      if (new TextEncoder().encode(cached.rawJson).byteLength > maxLineageSnapshotBytes)
        throw metadataFailure("The cached lineage response is oversized.");
      const value: unknown = JSON.parse(cached.rawJson);
      if (
        !isRecord(value) ||
        value.private !== false ||
        parseGating(value.gated) !== "open" ||
        value.sha !== cached.commit
      )
        throw metadataFailure("The cached lineage response is not explicitly public and open.");
      return { node: parseLineageSnapshot(value, repo), cacheHit: true };
    } catch {
      // Cached remote input is always reparsed. Invalid and obsolete rows fall through.
    }
  }

  const request = async (): Promise<Response> => {
    const url = new URL(`/api/models/${encodeRepo(repo)}`, hfOrigin);
    for (const field of ["baseModels", "cardData", "gated", "private", "sha", "tags"])
      url.searchParams.append("expand", field);
    return await fetchWith429Backoff(
      options.fetcher,
      url.href,
      {
        headers: { Accept: "application/json" },
        redirect: "error",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
      },
    );
  };

  let response: Response;
  try {
    response = await request();
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
      throw error;
    return {
      node: { repo, parents: [], status: "unavailable" },
      cacheHit: false,
    };
  }
  if (!response.ok) {
    const status =
      response.status === 401 || response.status === 403 ? "access-required" : "unavailable";
    await response.body?.cancel().catch(() => undefined);
    return { node: { repo, parents: [], status }, cacheHit: false };
  }
  try {
    const value = await readBoundedJson(response, maxLineageSnapshotBytes);
    if (!isRecord(value) || value.private !== false || parseGating(value.gated) !== "open")
      return {
        node: { repo, parents: [], status: "access-required" },
        cacheHit: false,
      };
    const node = parseLineageSnapshot(value, repo);
    try {
      await options.catalog?.putLineage?.({
        repo,
        commit: node.commit ?? "",
        fetchedAt: new Date().toISOString(),
        rawJson: JSON.stringify(value),
      });
    } catch {
      // The disposable catalog is an optimization; lineage remains usable without it.
    }
    return { node, cacheHit: false };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
      throw error;
    return { node: { repo, parents: [], status: "unavailable" }, cacheHit: false };
  }
}

export async function fetchHuggingFaceLineage(
  root: {
    readonly repo: string;
    readonly commit: string;
    readonly parents: readonly HuggingFaceBaseModel[];
  },
  options: {
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly onRetry?: (retry: RateLimitRetry) => void;
    readonly onProgress?: (inspectedNodes: number) => void;
    readonly catalog?: HuggingFaceCatalog;
  } = {},
): Promise<HuggingFaceLineage> {
  const parsedRoot = parseModelInput(`${root.repo}@${root.commit}`);
  if (!commitPattern.test(parsedRoot.revision) || root.parents.length > 16)
    throw inputFailure("The lineage root is invalid.");
  for (const parent of root.parents)
    if (!validRepo(parent.repo)) throw inputFailure("The lineage root has an invalid parent.");

  const nodes = new Map<string, HuggingFaceLineageNode>();
  nodes.set(root.repo, {
    repo: root.repo,
    commit: root.commit.toLowerCase(),
    parents: root.parents,
    status: "resolved",
  });
  const queued = new Set([root.repo]);
  const queue: string[] = [];
  let truncated = false;
  let cacheHits = 0;
  const schedule = (repo: string) => {
    if (queued.has(repo)) return;
    if (queued.size >= maxLineageNodes) {
      truncated = true;
      return;
    }
    queued.add(repo);
    queue.push(repo);
  };
  for (const parent of root.parents) schedule(parent.repo);

  while (queue.length > 0) {
    options.signal?.throwIfAborted();
    const batch = queue.splice(0, 2);
    const snapshots = await Promise.all(
      batch.map(
        async (repo) =>
          await fetchLineageSnapshot(repo, {
            fetcher: options.fetcher ?? fetch,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
            ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
          }),
      ),
    );
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      const repo = batch[index];
      if (snapshot === undefined || repo === undefined) continue;
      if (snapshot.cacheHit) cacheHits += 1;
      nodes.set(repo, snapshot.node);
      if (snapshot.node.status === "resolved")
        for (const parent of snapshot.node.parents) schedule(parent.repo);
    }
    options.onProgress?.(nodes.size);
  }
  options.signal?.throwIfAborted();
  return { rootRepo: root.repo, nodes: [...nodes.values()], cacheHits, truncated };
}

interface BrowseCandidate {
  readonly repo: string;
  readonly commit?: string;
  readonly downloads?: number;
  readonly likes?: number;
  readonly lastModified?: string;
  readonly metadata: ResolvedHuggingFaceRepository["metadata"];
}

function optionalCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function parseBrowseCandidates(value: unknown): BrowseCandidate[] {
  if (!Array.isArray(value) || value.length > browsePageSize) {
    throw metadataFailure("Hugging Face returned an invalid model search page.");
  }
  const candidates: BrowseCandidate[] = [];
  const repos = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !boundedString(item.id, 200) || !validRepo(item.id)) {
      throw metadataFailure("Hugging Face returned an invalid model search candidate.");
    }
    if (repos.has(item.id)) throw metadataFailure("Hugging Face returned a duplicate candidate.");
    repos.add(item.id);
    const commit =
      typeof item.sha === "string" && commitPattern.test(item.sha)
        ? item.sha.toLowerCase()
        : undefined;
    const lastModified = boundedString(item.lastModified, 64) ? item.lastModified : undefined;
    const downloads = optionalCount(item.downloads);
    const likes = optionalCount(item.likes);
    candidates.push({
      repo: item.id,
      ...(commit === undefined ? {} : { commit }),
      ...(downloads === undefined ? {} : { downloads }),
      ...(likes === undefined ? {} : { likes }),
      ...(lastModified === undefined ? {} : { lastModified }),
      metadata: parseRepositoryMetadata(item),
    });
  }
  return candidates;
}

export function parseHuggingFaceNextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  if (header.length === 0 || header.length > maxLinkLength) {
    throw metadataFailure("Hugging Face returned an invalid pagination link.");
  }
  let target: string | undefined;
  for (const match of header.matchAll(/<([^>]+)>((?:\s*;[^,]*)?)(?:,|$)/gu)) {
    const relations = match[2]?.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/iu);
    const relationList = (relations?.[1] ?? relations?.[2])?.trim().split(/\s+/u) ?? [];
    if (relationList.some((relation) => relation.toLowerCase() === "next")) {
      target = match[1];
      break;
    }
  }
  if (target === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw metadataFailure("Hugging Face returned a malformed pagination link.");
  }
  if (
    url.origin !== hfOrigin ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname !== "/api/models"
  ) {
    throw metadataFailure("Hugging Face returned an unsafe pagination link.");
  }
  return url.href;
}

function validateBrowseFilters(filters: HuggingFaceBrowseFilters): void {
  if (
    !isRecord(filters) ||
    filters.format !== "gguf" ||
    typeof filters.query !== "string" ||
    filters.query.length > 200
  ) {
    throw inputFailure("The model search filters are invalid.");
  }
  if (
    filters.capabilities !== undefined &&
    (!Array.isArray(filters.capabilities) ||
      filters.capabilities.length > capabilityValues.size ||
      new Set(filters.capabilities).size !== filters.capabilities.length ||
      !filters.capabilities.every((value) => capabilityValues.has(value)))
  ) {
    throw inputFailure("The capability filters are invalid.");
  }
  if (
    filters.quantizationBits !== undefined &&
    (!Array.isArray(filters.quantizationBits) ||
      filters.quantizationBits.length > quantizationBitLevels.size + 1 ||
      new Set(filters.quantizationBits).size !== filters.quantizationBits.length ||
      !filters.quantizationBits.every(
        (value) =>
          value === "other" || (typeof value === "number" && quantizationBitLevels.has(value)),
      ))
  ) {
    throw inputFailure("The quantization filter is invalid.");
  }
  if (
    filters.otherQuantization !== undefined &&
    (typeof filters.otherQuantization !== "string" || filters.otherQuantization.length > 128)
  )
    throw inputFailure("The custom quantization filter is invalid.");
  if (
    filters.minimumContextTokens !== undefined &&
    (!Number.isSafeInteger(filters.minimumContextTokens) ||
      filters.minimumContextTokens < 256 ||
      filters.minimumContextTokens > 1024 * 1024)
  )
    throw inputFailure("The minimum context filter is invalid.");
  if (
    filters.maximumBytes !== undefined &&
    (!Number.isSafeInteger(filters.maximumBytes) ||
      filters.maximumBytes <= 0 ||
      filters.maximumBytes > maxArtifactBytes)
  ) {
    throw inputFailure("The maximum artifact size is invalid.");
  }
}

function initialBrowseUrl(filters: HuggingFaceBrowseFilters): string {
  const url = new URL("/api/models", hfOrigin);
  const query = filters.query.trim();
  if (query !== "") url.searchParams.set("search", query);
  url.searchParams.set("filter", filters.format);
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("direction", "-1");
  url.searchParams.set("limit", browsePageSize.toString());
  for (const field of [
    "downloads",
    "baseModels",
    "config",
    "gated",
    "gguf",
    "lastModified",
    "likes",
    "pipeline_tag",
    "private",
    "sha",
    "tags",
  ])
    url.searchParams.append("expand", field);
  return url.href;
}

function choiceMatches(
  choice: HuggingFaceArtifactChoice,
  filters: HuggingFaceBrowseFilters,
): boolean {
  const selected = filters.quantizationBits;
  const bits = quantizationBitLevel(choice.quantization);
  const other = filters.otherQuantization?.trim().toUpperCase();
  const quantizationMatches =
    selected === undefined ||
    selected.length === 0 ||
    (bits !== undefined && selected.includes(bits)) ||
    (selected.includes("other") &&
      (other === undefined || other === ""
        ? bits === undefined
        : choice.quantization.toUpperCase().includes(other)));
  return (
    quantizationMatches &&
    (filters.maximumBytes === undefined || choice.totalSize <= filters.maximumBytes)
  );
}

export function quantizationBitLevel(
  quantization: string,
): 1 | 2 | 3 | 4 | 5 | 6 | 8 | 16 | 32 | undefined {
  const match = quantization.toUpperCase().match(/^(?:IQ|TQ|Q|F|BF|MXFP)(\d+)(?:_|$)/u);
  if (match?.[1] === undefined) return undefined;
  const bits = Number(match[1]);
  return quantizationBitLevels.has(bits)
    ? (bits as 1 | 2 | 3 | 4 | 5 | 6 | 8 | 16 | 32)
    : undefined;
}

function repositoryFilterState(
  metadata: ResolvedHuggingFaceRepository["metadata"],
  filters: HuggingFaceBrowseFilters,
): "match" | "needs-verification" | "excluded" {
  if (metadata.visibility !== "public" || metadata.gating !== "open") return "excluded";
  if (
    filters.minimumContextTokens !== undefined &&
    metadata.contextLength !== undefined &&
    metadata.contextLength < filters.minimumContextTokens
  )
    return "excluded";
  const selectedCapabilities = filters.capabilities ?? [];
  const declared = new Set(metadata.declaredCapabilities ?? []);
  const declaredPrimary = primaryCapabilityForTask(metadata.pipelineTask?.toLowerCase());
  if (
    declaredPrimary !== undefined &&
    selectedCapabilities.some(
      (capability) => primaryCapabilityValues.has(capability) && capability !== declaredPrimary,
    )
  )
    return "excluded";
  if (
    (filters.minimumContextTokens !== undefined && metadata.contextLength === undefined) ||
    selectedCapabilities.some((capability) => !declared.has(capability))
  )
    return "needs-verification";
  return "match";
}

async function fetchBrowsePage(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  onRetry: ((retry: RateLimitRetry) => void) | undefined,
): Promise<{ candidates: BrowseCandidate[]; next?: string }> {
  let response: Response;
  try {
    response = await fetchWith429Backoff(
      fetcher,
      url,
      {
        headers: { Accept: "application/json" },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(onRetry === undefined ? {} : { onRetry }),
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ModelOperationError({
      code: "network",
      phase: "resolve",
      message: "Hugging Face model search could not be reached. Check the connection and retry.",
      retryable: true,
    });
  }
  if (!response.ok) {
    const accessDenied = response.status === 401 || response.status === 403;
    throw new ModelOperationError({
      code: accessDenied ? "input-invalid" : "network",
      phase: "resolve",
      message: accessDenied
        ? "Hugging Face denied anonymous model search access. WebAI supports only public models."
        : `Hugging Face model search returned HTTP ${response.status}. Retry the request.`,
      retryable: !accessDenied,
    });
  }
  const candidates = parseBrowseCandidates(await readBoundedJson(response));
  const next = parseHuggingFaceNextLink(response.headers.get("Link"));
  return { candidates, ...(next === undefined ? {} : { next }) };
}

const maxEnrichmentCacheEntries = 8;
const enrichmentCache = new Map<string, ResolvedHuggingFaceRepository>();

function cachedEnrichment(key: string): ResolvedHuggingFaceRepository | undefined {
  const cached = enrichmentCache.get(key);
  if (cached === undefined) return undefined;
  enrichmentCache.delete(key);
  enrichmentCache.set(key, cached);
  return cached;
}

function cacheEnrichment(key: string, repository: ResolvedHuggingFaceRepository): void {
  enrichmentCache.set(key, repository);
  while (enrichmentCache.size > maxEnrichmentCacheEntries) {
    const oldest = enrichmentCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    enrichmentCache.delete(oldest);
  }
}

function mergeCandidateMetadata(
  repository: ResolvedHuggingFaceRepository,
  candidate: BrowseCandidate,
): ResolvedHuggingFaceRepository {
  const visibility = repository.metadata.visibility ?? candidate.metadata.visibility;
  return {
    ...repository,
    metadata: {
      ...candidate.metadata,
      ...repository.metadata,
      gating:
        repository.metadata.gating === "unknown"
          ? candidate.metadata.gating
          : repository.metadata.gating,
      ...(visibility === undefined ? {} : { visibility }),
    },
  };
}

interface EnrichedCandidate {
  readonly repository: ResolvedHuggingFaceRepository;
  readonly cacheHit: boolean;
}

async function enrichCandidateOnce(
  candidate: BrowseCandidate,
  fetcher: typeof fetch,
  onRetry: ((retry: RateLimitRetry) => void) | undefined,
  signal: AbortSignal | undefined,
  catalog: HuggingFaceCatalog | undefined,
): Promise<EnrichedCandidate> {
  if (candidate.commit === undefined)
    throw metadataFailure("The candidate has no immutable commit.");
  const key = `${candidate.repo}@${candidate.commit}`;
  let catalogEntry: Awaited<ReturnType<HuggingFaceCatalog["get"]>>;
  try {
    catalogEntry = await catalog?.get(candidate.repo, candidate.commit);
  } catch {
    catalogEntry = undefined;
  }
  if (catalogEntry !== undefined) {
    try {
      if (new TextEncoder().encode(catalogEntry.rawJson).byteLength > maxMetadataBytes)
        throw metadataFailure("The cached metadata response is oversized.");
      const cachedValue: unknown = JSON.parse(catalogEntry.rawJson);
      if (
        !isRecord(cachedValue) ||
        cachedValue.private !== false ||
        parseGating(cachedValue.gated) !== "open"
      )
        throw metadataFailure("The cached response is not explicitly public and open.");
      const repository = parseModelInfo(cachedValue, {
        repo: candidate.repo,
        revision: candidate.commit,
      });
      return {
        repository: mergeCandidateMetadata(repository, candidate),
        cacheHit: true,
      };
    } catch {
      // A disposable cache record is always reparsed through the current untrusted-input
      // boundary. Corrupt or obsolete rows simply fall through to a fresh request.
    }
  }
  const cached = cachedEnrichment(key);
  if (cached !== undefined)
    return {
      repository: mergeCandidateMetadata(cached, candidate),
      cacheHit: true,
    };
  const fetched = await fetchResolvedHuggingFaceModel(
    `${candidate.repo}@${candidate.commit}`,
    fetcher,
    onRetry,
    signal,
  );
  const repository = fetched.repository;
  const merged = mergeCandidateMetadata(repository, candidate);
  const cacheable = fetched.cacheable && merged.metadata.gating === "open";
  const totalFiles = repository.choices.reduce(
    (total, choice) => total + choice.files.length + (choice.optionalMtp === undefined ? 0 : 1),
    0,
  );
  if (cacheable && repository.choices.length <= 256 && totalFiles <= 512)
    cacheEnrichment(key, repository);
  try {
    if (cacheable)
      await catalog?.put({
        repo: candidate.repo,
        commit: candidate.commit,
        fetchedAt: new Date().toISOString(),
        rawJson: fetched.rawJson,
      });
  } catch {
    // Discovery remains a network-backed path when the disposable local catalog is unavailable.
  }
  return { repository: merged, cacheHit: false };
}

async function enrichCandidate(
  candidate: BrowseCandidate,
  fetcher: typeof fetch,
  onRetry: ((retry: RateLimitRetry) => void) | undefined,
  signal: AbortSignal | undefined,
  catalog: HuggingFaceCatalog | undefined,
): Promise<EnrichedCandidate> {
  return await enrichCandidateOnce(candidate, fetcher, onRetry, signal, catalog);
}

export async function browseHuggingFaceModels(
  filters: HuggingFaceBrowseFilters,
  options: {
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly onRetry?: (retry: RateLimitRetry) => void;
    readonly onProgress?: (progress: {
      readonly inspectedCandidates: number;
      readonly inspectedPages: number;
    }) => void;
    readonly catalog?: HuggingFaceCatalog;
  } = {},
): Promise<HuggingFaceBrowseResult> {
  validateBrowseFilters(filters);
  const fetcher = options.fetcher ?? fetch;
  let url: string | undefined = initialBrowseUrl(filters);
  const matches: HuggingFaceBrowseItem[] = [];
  const needsVerification: HuggingFaceBrowseItem[] = [];
  const unknown: HuggingFaceBrowseUnknown[] = [];
  const seenCandidates = new Set<string>();
  let inspectedCandidates = 0;
  let excludedCandidates = 0;
  let inspectedPages = 0;
  let cacheHits = 0;
  let retainedResultBytes = 0;
  let resultBudgetReached = false;
  let stopped = false;
  let currentPageFetched = false;
  const retainResultRecord = (value: HuggingFaceBrowseItem | HuggingFaceBrowseUnknown): boolean => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (retainedResultBytes + bytes > maximumBrowseResultBytes) return false;
    retainedResultBytes += bytes;
    return true;
  };
  try {
    for (; inspectedPages < maximumBrowsePages; inspectedPages += 1) {
      currentPageFetched = false;
      options.signal?.throwIfAborted();
      const page = await fetchBrowsePage(url, fetcher, options.signal, options.onRetry);
      currentPageFetched = true;
      const uniqueCandidates = page.candidates.filter((candidate) => {
        if (seenCandidates.has(candidate.repo)) return false;
        seenCandidates.add(candidate.repo);
        return true;
      });
      for (let offset = 0; offset < uniqueCandidates.length; offset += 2) {
        const batch = uniqueCandidates.slice(offset, offset + 2);
        const enriched = await Promise.all(
          batch.map(async (candidate) => {
            if (
              candidate.metadata.visibility === "private" ||
              candidate.metadata.gating === "automatic" ||
              candidate.metadata.gating === "manual" ||
              candidate.metadata.gating === "gated"
            )
              return { candidate, excluded: true } as const;
            try {
              return {
                candidate,
                enriched: await enrichCandidate(
                  candidate,
                  fetcher,
                  options.onRetry,
                  options.signal,
                  options.catalog,
                ),
              } as const;
            } catch (error) {
              if (
                options.signal?.aborted ||
                (error instanceof DOMException && error.name === "AbortError")
              )
                throw error;
              if (error instanceof NoGgufChoicesError || error instanceof RestrictedRepositoryError)
                return { candidate, excluded: true } as const;
              return { candidate } as const;
            }
          }),
        );
        for (const result of enriched) {
          inspectedCandidates += 1;
          if ("excluded" in result) {
            excludedCandidates += 1;
            continue;
          }
          if (!("enriched" in result)) {
            const item: HuggingFaceBrowseUnknown = {
              repo: result.candidate.repo,
              ...(result.candidate.commit === undefined ? {} : { commit: result.candidate.commit }),
              metadata: result.candidate.metadata,
              reason:
                result.candidate.metadata.visibility !== "private" &&
                result.candidate.metadata.gating === "open"
                  ? "Pinned file metadata could not be inspected. Retry or use manual acquisition."
                  : "Public, ungated file access could not be verified. WebAI does not support restricted repositories.",
            };
            if (!retainResultRecord(item)) {
              inspectedCandidates -= 1;
              resultBudgetReached = true;
              break;
            }
            unknown.push(item);
            continue;
          }
          if (result.enriched.cacheHit) cacheHits += 1;
          const resolvedRepository = result.enriched.repository;
          const allMatchingChoices = resolvedRepository.choices.filter((choice) =>
            choiceMatches(choice, filters),
          );
          if (allMatchingChoices.length === 0) {
            excludedCandidates += 1;
            continue;
          }
          const matchingChoices: HuggingFaceArtifactChoice[] = [];
          let matchingFiles = 0;
          for (const choice of allMatchingChoices) {
            const referencedFiles =
              choice.files.length + (choice.optionalMtp === undefined ? 0 : 1);
            if (
              matchingChoices.length >= 64 ||
              matchingFiles + referencedFiles > maximumArtifactChoiceFiles
            )
              break;
            matchingChoices.push(choice);
            matchingFiles += referencedFiles;
          }
          if (matchingChoices.length === 0) {
            const item: HuggingFaceBrowseUnknown = {
              repo: result.candidate.repo,
              commit: resolvedRepository.commit,
              metadata: resolvedRepository.metadata,
              reason:
                "Matching artifacts exceed the bounded browser listing. Use manual acquisition for this repository.",
            };
            if (!retainResultRecord(item)) {
              inspectedCandidates -= 1;
              if (result.enriched.cacheHit) cacheHits -= 1;
              resultBudgetReached = true;
              break;
            }
            unknown.push(item);
            continue;
          }
          const repository = { ...resolvedRepository, choices: matchingChoices };
          const item: HuggingFaceBrowseItem = {
            repo: result.candidate.repo,
            commit: resolvedRepository.commit,
            ...(result.candidate.downloads === undefined
              ? {}
              : { downloads: result.candidate.downloads }),
            ...(result.candidate.likes === undefined ? {} : { likes: result.candidate.likes }),
            ...(result.candidate.lastModified === undefined
              ? {}
              : { lastModified: result.candidate.lastModified }),
            repository,
            matchingChoices,
            omittedMatchingChoices: allMatchingChoices.length - matchingChoices.length,
          };
          const filterState = repositoryFilterState(repository.metadata, filters);
          if (filterState === "excluded") {
            excludedCandidates += 1;
          } else {
            if (!retainResultRecord(item)) {
              inspectedCandidates -= 1;
              if (result.enriched.cacheHit) cacheHits -= 1;
              resultBudgetReached = true;
              break;
            }
            if (filterState === "needs-verification") needsVerification.push(item);
            else matches.push(item);
          }
        }
        if (resultBudgetReached) break;
        options.onProgress?.({ inspectedCandidates, inspectedPages: inspectedPages + 1 });
      }
      if (uniqueCandidates.length === 0)
        options.onProgress?.({ inspectedCandidates, inspectedPages: inspectedPages + 1 });
      if (resultBudgetReached) {
        options.onProgress?.({ inspectedCandidates, inspectedPages: inspectedPages + 1 });
        inspectedPages += 1;
        break;
      }
      if (page.next === undefined) {
        url = undefined;
        inspectedPages += 1;
        break;
      }
      url = page.next;
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error;
    stopped = true;
    if (currentPageFetched) inspectedPages += 1;
  }
  let catalog = { persistent: false, entries: 0, bytes: 0 };
  try {
    catalog = (await options.catalog?.status()) ?? catalog;
  } catch {
    // Catalog health is advisory and must not turn valid discovery results into failures.
  }
  return {
    matches,
    needsVerification,
    unknown,
    inspectedCandidates,
    excludedCandidates,
    inspectedPages,
    cacheHits,
    catalog,
    truncated: stopped || url !== undefined || resultBudgetReached,
    ...(stopped
      ? { truncationReason: "stopped" as const }
      : resultBudgetReached
        ? { truncationReason: "result-budget" as const }
        : {}),
  };
}

export interface ValidatedContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly length: number;
}

export function validateRangeResponse(
  response: Response,
  expectedStart: number,
  expectedTotal: number,
): ValidatedContentRange {
  if (response.status !== 206) {
    throw new ModelOperationError({
      code: "range-invalid",
      phase: "download",
      message: `The download returned HTTP ${response.status}; an exact partial response was required.`,
      retryable: true,
    });
  }
  const header = response.headers.get("Content-Range");
  const match = header?.match(/^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/u);
  if (match === undefined || match === null) {
    throw new ModelOperationError({
      code: "range-invalid",
      phase: "download",
      message: "The download returned a missing or malformed Content-Range header.",
      retryable: true,
    });
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== expectedStart ||
    total !== expectedTotal ||
    start > end ||
    end >= total
  ) {
    throw new ModelOperationError({
      code: "range-invalid",
      phase: "download",
      message: "The download range did not match the durable prefix and pinned file size.",
      retryable: true,
    });
  }
  const length = end - start + 1;
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) !== length) {
    throw new ModelOperationError({
      code: "range-invalid",
      phase: "download",
      message: "The download Content-Length did not match its declared byte range.",
      retryable: true,
    });
  }
  return { start, end, total, length };
}
