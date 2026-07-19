import { inspectGgufBlob } from "./gguf";
import { ggufSplitMaxShardBytes, ggufSplitThresholdBytes } from "./gguf-split-profile";
import { createSha256 } from "./hashing";
import { DurableFileWriter, deleteStoredPath, getStoredFile, promotePartialFile } from "./storage";
import type { GgufInspection, ModelFailure, ModelFileRecord } from "./types";
import { ModelOperationError } from "./types";

export {
  ggufSplitMaxShardBytes,
  ggufSplitThresholdBytes,
  ggufSplitToolVersion,
} from "./gguf-split-profile";

const plannerScriptUrl = "/runtime/gguf-split/webai-gguf-plan.7a95d993.js";
const plannerWasmUrl = "/runtime/gguf-split/webai-gguf-plan.990095fa.wasm";
const maximumHeaderBytes = 16 * 1024 * 1024;
const copyChunkBytes = 8 * 1024 * 1024;

interface EmscriptenFileSystem {
  writeFile(path: string, bytes: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

interface PlannerModule {
  readonly FS: EmscriptenFileSystem;
  callMain(arguments_: readonly string[]): number;
}

type PlannerFactory = (configuration: {
  readonly locateFile: (path: string) => string;
  readonly print: () => void;
  readonly printErr: () => void;
}) => Promise<PlannerModule>;

interface SplitTensor {
  readonly inputOffset: number;
  readonly length: number;
  readonly split: number;
  readonly outputOffset: number;
}

interface SplitShard {
  readonly header: Uint8Array;
  readonly size: number;
  readonly firstTensor: number;
  readonly tensorCount: number;
}

interface SplitPlan {
  readonly shards: readonly SplitShard[];
  readonly tensors: readonly SplitTensor[];
}

export interface GgufSplitResult {
  readonly files: readonly ModelFileRecord[];
  readonly sourceSha256: string;
}

export type GgufSplitStage = "planning" | "hashing" | "copying" | "finalizing";

function splitFailure(message: string, retryable = false): ModelOperationError {
  return new ModelOperationError({
    code: "gguf-invalid",
    phase: "split",
    message,
    retryable,
  });
}

export class WllamaShardLimitError extends ModelOperationError {
  readonly requiredShardBytes: number;

  constructor(requiredShardBytes: number) {
    super({
      code: "unsupported",
      phase: "split",
      message: `This GGUF cannot be prepared for wllama because its smallest valid layout requires a ${requiredShardBytes.toLocaleString()}-byte shard, at or above wllama's 2,000,000,000-byte file limit.`,
      retryable: false,
    });
    this.name = "WllamaShardLimitError";
    this.requiredShardBytes = requiredShardBytes;
  }
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw splitFailure(`The GGUF split planner returned an invalid ${label}.`);
  }
  return number;
}

class BinaryPlanReader {
  readonly #view: DataView;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  ensure(length: number): void {
    if (length < 0 || this.offset + length > this.#view.byteLength) {
      throw splitFailure("The GGUF split planner returned a truncated plan.");
    }
  }

  bytes(length: number): Uint8Array {
    this.ensure(length);
    const result = new Uint8Array(this.#view.buffer, this.#view.byteOffset + this.offset, length);
    this.offset += length;
    return result;
  }

  u32(): number {
    this.ensure(4);
    const value = this.#view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(label: string): number {
    this.ensure(8);
    const value = safeNumber(this.#view.getBigUint64(this.offset, true), label);
    this.offset += 8;
    return value;
  }

  get done(): boolean {
    return this.offset === this.#view.byteLength;
  }
}

function parsePlan(
  bytes: Uint8Array,
  headers: readonly Uint8Array[],
  sourceSize: number,
): SplitPlan {
  const reader = new BinaryPlanReader(bytes);
  const magic = new TextDecoder().decode(reader.bytes(8));
  if (magic !== "WAISPLIT" || reader.u32() !== 1) {
    throw splitFailure("The GGUF split planner returned an unsupported plan format.");
  }
  const shardCount = reader.u32();
  const tensorCount = reader.u64("tensor count");
  if (shardCount < 1 || shardCount > 256 || headers.length !== shardCount) {
    throw splitFailure("The GGUF split planner returned an invalid shard count.");
  }
  if (tensorCount < 1 || tensorCount > 1_000_000) {
    throw splitFailure("The GGUF split planner returned an invalid tensor count.");
  }

  const shards: SplitShard[] = [];
  let coveredTensors = 0;
  let largestShardBytes = 0;
  for (let split = 0; split < shardCount; split += 1) {
    const headerSize = reader.u64("header size");
    const size = reader.u64("shard size");
    const firstTensor = reader.u32();
    const count = reader.u32();
    if (
      headerSize !== headers[split]?.byteLength ||
      size < headerSize ||
      firstTensor !== coveredTensors ||
      count < 1 ||
      firstTensor + count > tensorCount
    ) {
      throw splitFailure("The GGUF split planner returned inconsistent shard bounds.");
    }
    largestShardBytes = Math.max(largestShardBytes, size);
    coveredTensors += count;
    const header = headers[split];
    if (header === undefined) throw splitFailure("The GGUF split planner omitted a header.");
    shards.push({ header, size, firstTensor, tensorCount: count });
  }
  if (coveredTensors !== tensorCount) {
    throw splitFailure("The GGUF split plan does not cover every tensor exactly once.");
  }

  const tensors: SplitTensor[] = [];
  const nextOutputOffsets = shards.map((shard) => shard.header.byteLength);
  for (let index = 0; index < tensorCount; index += 1) {
    const inputOffset = reader.u64("tensor input offset");
    const length = reader.u64("tensor length");
    const split = reader.u32();
    const reserved = reader.u32();
    const outputOffset = reader.u64("tensor output offset");
    const shard = shards[split];
    if (
      reserved !== 0 ||
      shard === undefined ||
      length < 1 ||
      inputOffset + length > sourceSize ||
      outputOffset !== nextOutputOffsets[split] ||
      outputOffset + length > shard.size ||
      index < shard.firstTensor ||
      index >= shard.firstTensor + shard.tensorCount
    ) {
      throw splitFailure("The GGUF split planner returned an invalid tensor range.");
    }
    nextOutputOffsets[split] = Math.ceil((outputOffset + length) / 32) * 32;
    tensors.push({ inputOffset, length, split, outputOffset });
  }
  if (!reader.done || nextOutputOffsets.some((offset, split) => offset !== shards[split]?.size)) {
    throw splitFailure("The GGUF split plan has inconsistent output lengths.");
  }
  if (largestShardBytes >= ggufSplitThresholdBytes) {
    throw new WllamaShardLimitError(largestShardBytes);
  }
  if (shards.length < 2) {
    throw splitFailure(
      "This GGUF cannot be divided at the requested target because its tensors are indivisible.",
    );
  }
  return { shards, tensors };
}

async function createSplitPlan(source: Blob, maxShardBytes: number): Promise<SplitPlan> {
  const prefix = new Uint8Array(
    await source.slice(0, Math.min(source.size, maximumHeaderBytes)).arrayBuffer(),
  );
  let imported: unknown;
  try {
    const script = new URL(plannerScriptUrl, globalThis.location.origin).href;
    imported = await import(/* @vite-ignore */ script);
  } catch {
    throw splitFailure("The bundled GGUF split planner could not be loaded in this browser.", true);
  }
  if (
    typeof imported !== "object" ||
    imported === null ||
    !("default" in imported) ||
    typeof imported.default !== "function"
  ) {
    throw splitFailure("The bundled GGUF split planner module is invalid.");
  }
  const factory = imported.default as PlannerFactory;
  let module: PlannerModule;
  try {
    module = await factory({
      locateFile: () => plannerWasmUrl,
      print: () => undefined,
      printErr: () => undefined,
    });
    module.FS.writeFile("/input.gguf", prefix);
    const status = module.callMain([
      "/input.gguf",
      "/header-",
      "/plan.bin",
      maxShardBytes.toString(),
    ]);
    if (status !== 0) throw new Error(`planner status ${status}`);
  } catch {
    throw splitFailure(
      "This GGUF header could not be split safely. It may be malformed or exceed the 16 MiB planner-header limit.",
    );
  }
  const planBytes = module.FS.readFile("/plan.bin");
  const preliminary = new BinaryPlanReader(planBytes);
  preliminary.bytes(8);
  preliminary.u32();
  const shardCount = preliminary.u32();
  if (shardCount < 1 || shardCount > 256) throw splitFailure("Invalid GGUF shard count.");
  const headers = Array.from({ length: shardCount }, (_, index) =>
    module.FS.readFile(`/header-${index}.gguf`).slice(),
  );
  return parsePlan(planBytes, headers, source.size);
}

function splitDisplayNames(sourceName: string, count: number): string[] {
  const base = sourceName.replace(/\.gguf$/iu, "");
  const total = count.toString().padStart(5, "0");
  return Array.from(
    { length: count },
    (_, index) => `${base}-${(index + 1).toString().padStart(5, "0")}-of-${total}.gguf`,
  );
}

async function inspectBestEffort(
  file: Blob,
): Promise<{ inspection?: GgufInspection; inspectionError?: ModelFailure }> {
  try {
    return { inspection: await inspectGgufBlob(file) };
  } catch (error) {
    return {
      inspectionError:
        error instanceof ModelOperationError
          ? error.failure
          : {
              code: "gguf-invalid",
              phase: "inspect",
              message: "This WebAI version could not inspect the derived GGUF shard.",
              retryable: true,
            },
    };
  }
}

export async function splitGgufFile(
  source: File,
  sourceName: string,
  stagingPrefix: string,
  signal: AbortSignal,
  onProgress?: (completedBytes: number, totalBytes: number, stage: GgufSplitStage) => void,
  maxShardBytes = ggufSplitMaxShardBytes,
): Promise<GgufSplitResult> {
  if (!Number.isSafeInteger(maxShardBytes) || maxShardBytes < 32 || maxShardBytes > 2_000_000_000) {
    throw splitFailure("The requested GGUF shard size is invalid.");
  }
  onProgress?.(0, source.size, "planning");
  const plan = await createSplitPlan(source, maxShardBytes);
  signal.throwIfAborted();
  const copyWorkBytes = plan.tensors.reduce((total, tensor) => total + tensor.length, 0);
  const totalWorkBytes = source.size + copyWorkBytes;
  if (!Number.isSafeInteger(totalWorkBytes)) {
    throw splitFailure("This GGUF is too large for safe split progress accounting.");
  }
  const displayNames = splitDisplayNames(sourceName, plan.shards.length);
  const paths = plan.shards.map((_, index) => `${stagingPrefix}/${index}.part`);
  const writers: DurableFileWriter[] = [];
  const hashes = plan.shards.map(() => createSha256());
  const sourceHash = createSha256();
  let completed = 0;
  let hashed = 0;
  let nextHashProgress = copyChunkBytes;
  let nextCopyProgress = copyChunkBytes;
  try {
    for (let split = 0; split < plan.shards.length; split += 1) {
      const shard = plan.shards[split];
      const writer = await DurableFileWriter.open(paths[split] as string);
      writers.push(writer);
      await writer.write(0, shard?.header ?? new Uint8Array());
      hashes[split]?.update(shard?.header ?? new Uint8Array());
    }
    onProgress?.(0, totalWorkBytes, "hashing");
    const sourceReader = source.stream().getReader();
    while (true) {
      signal.throwIfAborted();
      const result = await sourceReader.read();
      if (result.done) break;
      sourceHash.update(result.value);
      hashed += result.value.byteLength;
      if (hashed >= nextHashProgress || hashed === source.size) {
        onProgress?.(hashed, totalWorkBytes, "hashing");
        nextHashProgress = hashed + copyChunkBytes;
      }
    }

    onProgress?.(source.size, totalWorkBytes, "copying");
    for (const tensor of plan.tensors) {
      let tensorOffset = 0;
      while (tensorOffset < tensor.length) {
        signal.throwIfAborted();
        const length = Math.min(copyChunkBytes, tensor.length - tensorOffset);
        const bytes = new Uint8Array(
          await source
            .slice(tensor.inputOffset + tensorOffset, tensor.inputOffset + tensorOffset + length)
            .arrayBuffer(),
        );
        if (bytes.byteLength !== length) throw splitFailure("A GGUF tensor read was truncated.");
        await writers[tensor.split]?.write(tensor.outputOffset + tensorOffset, bytes);
        hashes[tensor.split]?.update(bytes);
        tensorOffset += length;
        completed += length;
        if (completed >= nextCopyProgress) {
          onProgress?.(source.size + completed, totalWorkBytes, "copying");
          nextCopyProgress = completed + copyChunkBytes;
        }
      }
      const paddedEnd = Math.ceil((tensor.outputOffset + tensor.length) / 32) * 32;
      const paddingLength = paddedEnd - tensor.outputOffset - tensor.length;
      if (paddingLength > 0) {
        const padding = new Uint8Array(paddingLength);
        await writers[tensor.split]?.write(tensor.outputOffset + tensor.length, padding);
        hashes[tensor.split]?.update(padding);
      }
    }
  } catch (error) {
    for (const writer of writers) writer.close();
    await Promise.all(
      paths.map(async (path) => await deleteStoredPath(path).catch(() => undefined)),
    );
    throw error;
  }
  for (const writer of writers) writer.close();

  onProgress?.(totalWorkBytes, totalWorkBytes, "finalizing");
  const files: ModelFileRecord[] = [];
  for (let split = 0; split < plan.shards.length; split += 1) {
    signal.throwIfAborted();
    const shard = plan.shards[split];
    const sha256 = hashes[split]?.digestHex();
    const path = paths[split];
    if (shard === undefined || sha256 === undefined || path === undefined) {
      throw splitFailure("The GGUF split output is incomplete.");
    }
    const opfsPath = await promotePartialFile(path, sha256, shard.size);
    const stored = await getStoredFile(opfsPath);
    if (stored === undefined || stored.size !== shard.size) {
      throw splitFailure("A promoted GGUF shard is missing.", true);
    }
    files.push({
      blobId: `sha256:${sha256}`,
      displayName: displayNames[split] as string,
      size: shard.size,
      sha256,
      opfsPath,
      ...(await inspectBestEffort(stored)),
    });
  }
  onProgress?.(totalWorkBytes, totalWorkBytes, "finalizing");
  return { files, sourceSha256: sourceHash.digestHex() };
}
