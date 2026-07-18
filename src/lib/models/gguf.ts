import type { GgufInspection, GgufMetadataEntry } from "./types";
import { ModelOperationError } from "./types";

const maxHeaderBytes = 16 * 1024 * 1024;
const maxMetadataEntries = 10_000;
const maxDisplayedEntries = 128;
const maxStringBytes = 1024 * 1024;
const maxArrayItems = 100_000;
const maxTotalArrayItems = 250_000;
const maxDisplayedArrayItems = 32;
const maxArrayDepth = 4;
const maxDisplayCharacters = 512;

const valueTypeNames = [
  "uint8",
  "int8",
  "uint16",
  "int16",
  "uint32",
  "int32",
  "float32",
  "bool",
  "string",
  "array",
  "uint64",
  "int64",
  "float64",
] as const;

const fileTypes = new Map<number, string>([
  [0, "F32"],
  [1, "F16"],
  [2, "Q4_0"],
  [3, "Q4_1"],
  [7, "Q8_0"],
  [8, "Q5_0"],
  [9, "Q5_1"],
  [10, "Q2_K"],
  [11, "Q3_K_S"],
  [12, "Q3_K_M"],
  [13, "Q3_K_L"],
  [14, "Q4_K_S"],
  [15, "Q4_K_M"],
  [16, "Q5_K_S"],
  [17, "Q5_K_M"],
  [18, "Q6_K"],
  [19, "IQ2_XXS"],
  [20, "IQ2_XS"],
  [21, "IQ3_XXS"],
  [22, "IQ1_S"],
  [23, "IQ4_NL"],
  [24, "IQ3_S"],
  [25, "IQ2_S"],
  [26, "IQ4_XS"],
  [27, "I8"],
  [28, "I16"],
  [29, "I32"],
  [30, "I64"],
  [31, "F64"],
  [32, "IQ1_M"],
  [36, "BF16"],
  [37, "TQ1_0"],
  [38, "TQ2_0"],
]);

export class GgufParseError extends ModelOperationError {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super({ code: "gguf-invalid", phase: "inspect", message, retryable: false });
    this.name = "GgufParseError";
    this.offset = offset;
  }
}

class Reader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  ensure(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.#bytes.byteLength
    ) {
      throw new GgufParseError(
        "The GGUF header is truncated or exceeds the inspection limit.",
        this.offset,
      );
    }
  }

  bytes(length: number): Uint8Array {
    this.ensure(length);
    const value = this.#bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  uint8(): number {
    this.ensure(1);
    const value = this.#view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  int8(): number {
    this.ensure(1);
    const value = this.#view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  uint16(): number {
    this.ensure(2);
    const value = this.#view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  int16(): number {
    this.ensure(2);
    const value = this.#view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  uint32(): number {
    this.ensure(4);
    const value = this.#view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  int32(): number {
    this.ensure(4);
    const value = this.#view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  float32(): number {
    this.ensure(4);
    const value = this.#view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  uint64(): bigint {
    this.ensure(8);
    const value = this.#view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  int64(): bigint {
    this.ensure(8);
    const value = this.#view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  float64(): number {
    this.ensure(8);
    const value = this.#view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
}

function safeCount(value: bigint | number, maximum: number, label: string, offset: number): number {
  const count = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new GgufParseError(
      `The GGUF ${label} is outside the supported inspection bounds.`,
      offset,
    );
  }
  return count;
}

function hasInvalidStringControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      return true;
    }
  }
  return false;
}

function readString(reader: Reader, label: string): string {
  const length = safeCount(reader.uint64(), maxStringBytes, `${label} length`, reader.offset);
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(reader.bytes(length));
  } catch {
    throw new GgufParseError(`The GGUF ${label} is not valid UTF-8.`, reader.offset);
  }
  if (hasInvalidStringControl(value)) {
    throw new GgufParseError(`The GGUF ${label} contains control characters.`, reader.offset);
  }
  return value;
}

interface ParsedValue {
  readonly type: string;
  readonly raw: unknown;
  readonly display: string;
}

interface ParseBudget {
  remainingArrayItems: number;
}

function displayScalar(value: unknown): string {
  if (typeof value === "string") {
    return value.length <= maxDisplayCharacters
      ? value
      : `${value.slice(0, maxDisplayCharacters)}…`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

function readTypedValue(
  reader: Reader,
  type: number,
  budget: ParseBudget,
  arrayDepth = 0,
): ParsedValue {
  const typeName = valueTypeNames[type];
  if (typeName === undefined) {
    throw new GgufParseError(`The GGUF metadata uses unknown value type ${type}.`, reader.offset);
  }
  let raw: unknown;
  switch (type) {
    case 0:
      raw = reader.uint8();
      break;
    case 1:
      raw = reader.int8();
      break;
    case 2:
      raw = reader.uint16();
      break;
    case 3:
      raw = reader.int16();
      break;
    case 4:
      raw = reader.uint32();
      break;
    case 5:
      raw = reader.int32();
      break;
    case 6:
      raw = reader.float32();
      break;
    case 7: {
      const boolean = reader.uint8();
      if (boolean !== 0 && boolean !== 1) {
        throw new GgufParseError("The GGUF metadata contains an invalid boolean.", reader.offset);
      }
      raw = boolean === 1;
      break;
    }
    case 8:
      raw = readString(reader, "metadata string");
      break;
    case 9: {
      if (arrayDepth >= maxArrayDepth) {
        throw new GgufParseError(
          "The GGUF metadata array nesting exceeds the inspection limit.",
          reader.offset,
        );
      }
      const elementType = reader.uint32();
      if (valueTypeNames[elementType] === undefined) {
        throw new GgufParseError(
          "The GGUF metadata array has an invalid element type.",
          reader.offset,
        );
      }
      const count = safeCount(reader.uint64(), maxArrayItems, "array item count", reader.offset);
      if (count > budget.remainingArrayItems) {
        throw new GgufParseError(
          "The GGUF metadata arrays exceed the total inspection item limit.",
          reader.offset,
        );
      }
      budget.remainingArrayItems -= count;
      const displayed: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = readTypedValue(reader, elementType, budget, arrayDepth + 1);
        if (index < maxDisplayedArrayItems) displayed.push(item.display);
      }
      const suffix =
        count > maxDisplayedArrayItems ? `, … ${count - maxDisplayedArrayItems} more` : "";
      return {
        type: `array<${valueTypeNames[elementType]}>`,
        raw: undefined,
        display: `[${displayed.join(", ")}${suffix}]`,
      };
    }
    case 10:
      raw = reader.uint64();
      break;
    case 11:
      raw = reader.int64();
      break;
    case 12:
      raw = reader.float64();
      break;
    default:
      throw new GgufParseError("The GGUF metadata value type is unsupported.", reader.offset);
  }
  return { type: typeName, raw, display: displayScalar(raw) };
}

export function parseGgufHeader(bytes: Uint8Array): GgufInspection {
  if (bytes.byteLength > maxHeaderBytes) {
    throw new GgufParseError("The GGUF header exceeds the 16 MiB inspection limit.", 0);
  }
  const reader = new Reader(bytes);
  const magic = reader.bytes(4);
  if (magic[0] !== 0x47 || magic[1] !== 0x47 || magic[2] !== 0x55 || magic[3] !== 0x46) {
    throw new GgufParseError("The file does not start with the GGUF magic bytes.", 0);
  }
  const version = reader.uint32();
  if (version < 2 || version > 3) {
    throw new GgufParseError(`GGUF version ${version} is not supported.`, 4);
  }
  const tensorCount = safeCount(
    reader.uint64(),
    Number.MAX_SAFE_INTEGER,
    "tensor count",
    reader.offset,
  );
  const metadataCount = safeCount(
    reader.uint64(),
    maxMetadataEntries,
    "metadata count",
    reader.offset,
  );
  const entries: GgufMetadataEntry[] = [];
  let architecture: string | undefined;
  let name: string | undefined;
  let quantization: string | undefined;
  const keys = new Set<string>();
  const budget: ParseBudget = { remainingArrayItems: maxTotalArrayItems };

  for (let index = 0; index < metadataCount; index += 1) {
    const key = readString(reader, "metadata key");
    if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u.test(key) || keys.has(key)) {
      throw new GgufParseError(
        "The GGUF metadata contains an invalid or duplicate key.",
        reader.offset,
      );
    }
    keys.add(key);
    const value = readTypedValue(reader, reader.uint32(), budget);
    if (key === "general.architecture" && typeof value.raw === "string") architecture = value.raw;
    if (key === "general.name" && typeof value.raw === "string") name = value.raw;
    if (key === "general.file_type" && typeof value.raw === "number") {
      quantization = fileTypes.get(value.raw) ?? `type ${value.raw}`;
    }
    if (entries.length < maxDisplayedEntries) {
      entries.push({ key, type: value.type, value: value.display });
    }
  }

  return {
    format: "gguf",
    version,
    tensorCount,
    metadataCount,
    ...(architecture === undefined ? {} : { architecture }),
    ...(name === undefined ? {} : { name }),
    ...(quantization === undefined ? {} : { quantization }),
    entries,
    omittedEntries: Math.max(0, metadataCount - entries.length),
  };
}

export async function inspectGgufBlob(blob: Blob): Promise<GgufInspection> {
  // A model can be many GiB; only its bounded prefix is needed for metadata.
  const length = Math.min(blob.size, maxHeaderBytes);
  const bytes = new Uint8Array(await blob.slice(0, length).arrayBuffer());
  return parseGgufHeader(bytes);
}
