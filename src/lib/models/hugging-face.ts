import type {
  HuggingFaceArtifactChoice,
  HuggingFaceFile,
  IntegrityIdentity,
  ResolvedHuggingFaceRepository,
} from "./types";
import { ModelOperationError } from "./types";

const hfOrigin = "https://huggingface.co";
const maxMetadataBytes = 8 * 1024 * 1024;
const maxFiles = 50_000;
const maxArtifactBytes = 16 * 1024 ** 4;
const maxPathLength = 1_024;
const sha256Pattern = /^[a-fA-F0-9]{64}$/;
const sha1Pattern = /^[a-fA-F0-9]{40}$/;
const commitPattern = /^[a-fA-F0-9]{40}$/;
const repoPartPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const default429Retries = 3;

export interface RateLimitRetry {
  readonly attempt: number;
  readonly delayMs: number;
}

interface BackoffOptions {
  readonly signal?: AbortSignal;
  readonly onRetry?: (retry: RateLimitRetry) => void;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly retries?: number;
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
    const response = await fetcher(input, init);
    if (response.status !== 429 || attempt >= retries) return response;
    const ceiling = Math.min(8_000, 500 * 2 ** attempt);
    const random = Math.max(0, Math.min(1, (options.random ?? Math.random)()));
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    const delayMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(30_000, Math.round(retryAfterSeconds * 1_000))
        : Math.round(ceiling * random);
    await response.body?.cancel().catch(() => undefined);
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

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxMetadataBytes) {
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
    if (length > maxMetadataBytes) {
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
  const match = shardless.match(/(?:^|[-._])((?:IQ|Q|F|BF)\d(?:_[A-Z0-9]+)*)$/iu);
  return match?.[1]?.toUpperCase() ?? "GGUF";
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
      return optionalMtp === undefined || choice.totalSize + optionalMtp.size > maxArtifactBytes
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
  const files = parseFiles(value.siblings);
  const choices = groupGgufChoices(files);
  if (choices.length === 0) {
    throw metadataFailure("This revision does not contain an integrity-identified GGUF file.");
  }
  return {
    repo: request.repo,
    requestedRevision: request.revision,
    commit: value.sha.toLowerCase(),
    choices,
    ...(request.selectedPath === undefined ? {} : { selectedPath: request.selectedPath }),
  };
}

export async function resolveHuggingFaceModel(
  input: string,
  fetcher: typeof fetch = fetch,
  onRetry?: (retry: RateLimitRetry) => void,
): Promise<ResolvedHuggingFaceRepository> {
  const request = parseModelInput(input);
  const url = `${hfOrigin}/api/models/${encodeRepo(request.repo)}/revision/${encodeRevision(request.revision)}?blobs=true`;
  let response: Response;
  try {
    response = await fetchWith429Backoff(
      fetcher,
      url,
      { headers: { Accept: "application/json" }, redirect: "error" },
      onRetry === undefined ? {} : { onRetry },
    );
  } catch {
    throw new ModelOperationError({
      code: "network",
      phase: "resolve",
      message: "Hugging Face could not be reached. Check the connection and retry.",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new ModelOperationError({
      code: response.status === 401 || response.status === 404 ? "input-invalid" : "network",
      phase: "resolve",
      message:
        response.status === 401 || response.status === 404
          ? "That model or revision was not found, or it requires access."
          : `Hugging Face returned HTTP ${response.status}. Retry the request.`,
      retryable: response.status !== 401 && response.status !== 404,
    });
  }
  return parseModelInfo(await readBoundedJson(response), request);
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
