import {
  type GgufInspection,
  type GgufMetadataEntry,
  type GgufSpecialToken,
  ModelOperationError,
  maximumDeclaredContextTokens,
} from "./types";

const maxHeaderBytes = 16 * 1024 * 1024;
const maxMetadataEntries = 10_000;
const maxDisplayedEntries = 128;
const maxStringBytes = 1024 * 1024;
const maxMetadataKeyBytes = 1024;
const maxArrayItems = 1_000_000;
const maxTotalArrayItems = 2_000_000;
const maxDisplayedArrayItems = 32;
const maxTotalDisplayedArrayItems = 1024;
const maxArrayDepth = 4;
const maxDisplayCharacters = 512;
const maxStoredSpecialTokens = 1024;
const maxSpecialTokenDisplayCharacters = 256;

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

  skip(length: number): void {
    this.ensure(length);
    this.offset += length;
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
      `The GGUF ${label} (${value.toString()}) is outside the supported inspection bounds (maximum ${maximum}).`,
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

function readString(reader: Reader, label: string, maximum = maxStringBytes): string {
  const length = safeCount(reader.uint64(), maximum, `${label} length`, reader.offset);
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

function readUncheckedString(reader: Reader, label: string, maximum = maxStringBytes): string {
  const length = safeCount(reader.uint64(), maximum, `${label} length`, reader.offset);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(reader.bytes(length));
  } catch {
    throw new GgufParseError(`The GGUF ${label} is not valid UTF-8.`, reader.offset);
  }
}

interface ParsedValue {
  readonly type: string;
  readonly raw: unknown;
  readonly display: string;
}

interface ParseBudget {
  remainingArrayItems: number;
  remainingDisplayedArrayItems: number;
}

function skipString(reader: Reader, label: string): void {
  const length = safeCount(reader.uint64(), maxStringBytes, `${label} length`, reader.offset);
  reader.skip(length);
}

function readArrayHeader(
  reader: Reader,
  budget: ParseBudget,
  arrayDepth: number,
): { elementType: number; count: number } {
  if (arrayDepth >= maxArrayDepth) {
    throw new GgufParseError(
      "The GGUF metadata array nesting exceeds the inspection limit.",
      reader.offset,
    );
  }
  const elementType = reader.uint32();
  if (valueTypeNames[elementType] === undefined) {
    throw new GgufParseError("The GGUF metadata array has an invalid element type.", reader.offset);
  }
  const count = safeCount(reader.uint64(), maxArrayItems, "array item count", reader.offset);
  if (count > budget.remainingArrayItems) {
    throw new GgufParseError(
      `The GGUF metadata arrays exceed the total inspection limit of ${maxTotalArrayItems} items.`,
      reader.offset,
    );
  }
  budget.remainingArrayItems -= count;
  return { elementType, count };
}

function skipTypedValues(
  reader: Reader,
  type: number,
  count: number,
  budget: ParseBudget,
  arrayDepth: number,
): void {
  const fixedWidths = [1, 1, 2, 2, 4, 4, 4, undefined, undefined, undefined, 8, 8, 8];
  const width = fixedWidths[type];
  if (width !== undefined) {
    reader.skip(count * width);
    return;
  }
  if (type === 7) {
    for (let index = 0; index < count; index += 1) {
      const boolean = reader.uint8();
      if (boolean !== 0 && boolean !== 1) {
        throw new GgufParseError("The GGUF metadata contains an invalid boolean.", reader.offset);
      }
    }
    return;
  }
  if (type === 8) {
    for (let index = 0; index < count; index += 1) {
      skipString(reader, "metadata string");
    }
    return;
  }
  if (type === 9) {
    for (let index = 0; index < count; index += 1) {
      const nested = readArrayHeader(reader, budget, arrayDepth);
      skipTypedValues(reader, nested.elementType, nested.count, budget, arrayDepth + 1);
    }
    return;
  }
  throw new GgufParseError("The GGUF metadata value type is unsupported.", reader.offset);
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

interface ArrayLocation {
  readonly offset: number;
}

function tokenTypeName(type: number): string {
  switch (type) {
    case 0:
      return "undefined";
    case 2:
      return "unknown";
    case 3:
      return "control";
    case 4:
      return "user-defined";
    case 5:
      return "unused";
    case 6:
      return "byte";
    default:
      return `type ${type}`;
  }
}

function readIntegerValue(reader: Reader, type: number): number | undefined {
  switch (type) {
    case 0:
      return reader.uint8();
    case 1:
      return reader.int8();
    case 2:
      return reader.uint16();
    case 3:
      return reader.int16();
    case 4:
      return reader.uint32();
    case 5:
      return reader.int32();
    case 10: {
      const value = reader.uint64();
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
    }
    case 11: {
      const value = reader.int64();
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : undefined;
    }
    default:
      return undefined;
  }
}

function boundedTokenDisplay(value: string): { text: string; truncated: boolean } {
  let text = "";
  let characters = 0;
  for (const character of value) {
    if (characters >= maxSpecialTokenDisplayCharacters)
      return { text: `${text}…`, truncated: true };
    const code = character.codePointAt(0) ?? 0;
    text += code < 32 || code === 127 ? `\\u{${code.toString(16).padStart(4, "0")}}` : character;
    characters += 1;
  }
  return { text, truncated: false };
}

function inspectSpecialTokens(
  bytes: Uint8Array,
  tokensLocation: ArrayLocation | undefined,
  typesLocation: ArrayLocation | undefined,
):
  | {
      readonly tokens: readonly GgufSpecialToken[];
      readonly count: number;
      readonly truncated: boolean;
    }
  | undefined {
  if (tokensLocation === undefined || typesLocation === undefined) return undefined;
  const budget: ParseBudget = {
    remainingArrayItems: maxTotalArrayItems,
    remainingDisplayedArrayItems: 0,
  };
  const typesReader = new Reader(bytes);
  typesReader.skip(typesLocation.offset);
  const typesHeader = readArrayHeader(typesReader, budget, 0);
  if (![0, 1, 2, 3, 4, 5, 10, 11].includes(typesHeader.elementType)) return undefined;
  const retainedTypes = new Map<number, number>();
  let specialTokenCount = 0;
  for (let id = 0; id < typesHeader.count; id += 1) {
    const type = readIntegerValue(typesReader, typesHeader.elementType);
    if (type === undefined) return undefined;
    if ([2, 3, 4, 5].includes(type)) {
      specialTokenCount += 1;
      if (retainedTypes.size < maxStoredSpecialTokens) retainedTypes.set(id, type);
    }
  }

  const tokensReader = new Reader(bytes);
  tokensReader.skip(tokensLocation.offset);
  const tokensHeader = readArrayHeader(tokensReader, budget, 0);
  if (tokensHeader.elementType !== 8 || tokensHeader.count !== typesHeader.count) return undefined;
  const tokens: GgufSpecialToken[] = [];
  for (let id = 0; id < tokensHeader.count; id += 1) {
    const type = retainedTypes.get(id);
    if (type === undefined) {
      skipString(tokensReader, "tokenizer token");
      continue;
    }
    const display = boundedTokenDisplay(readUncheckedString(tokensReader, "tokenizer token"));
    tokens.push({
      id,
      text: display.text,
      textTruncated: display.truncated,
      type,
      typeName: tokenTypeName(type),
    });
  }
  return {
    tokens,
    count: specialTokenCount,
    truncated: specialTokenCount > tokens.length,
  };
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
      const { elementType, count } = readArrayHeader(reader, budget, arrayDepth);
      const displayedCount = Math.min(
        count,
        maxDisplayedArrayItems,
        budget.remainingDisplayedArrayItems,
      );
      budget.remainingDisplayedArrayItems -= displayedCount;
      const displayed: string[] = [];
      for (let index = 0; index < displayedCount; index += 1) {
        const item = readTypedValue(reader, elementType, budget, arrayDepth + 1);
        displayed.push(item.display);
      }
      skipTypedValues(reader, elementType, count - displayedCount, budget, arrayDepth + 1);
      const suffix = count > displayedCount ? `, … ${count - displayedCount} more` : "";
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
  let contextLength: number | undefined;
  let name: string | undefined;
  let quantization: string | undefined;
  let tokenizerTokensLocation: ArrayLocation | undefined;
  let tokenizerTypesLocation: ArrayLocation | undefined;
  const keys = new Set<string>();
  const budget: ParseBudget = {
    remainingArrayItems: maxTotalArrayItems,
    remainingDisplayedArrayItems: maxTotalDisplayedArrayItems,
  };

  for (let index = 0; index < metadataCount; index += 1) {
    const key = readString(reader, "metadata key", maxMetadataKeyBytes);
    if (key.length === 0 || keys.has(key)) {
      throw new GgufParseError(
        `The GGUF metadata contains ${key.length === 0 ? "an empty" : "a duplicate"} key.`,
        reader.offset,
      );
    }
    keys.add(key);
    const valueType = reader.uint32();
    const valueOffset = reader.offset;
    const value = readTypedValue(reader, valueType, budget);
    if (valueType === 9 && key === "tokenizer.ggml.tokens") {
      tokenizerTokensLocation = { offset: valueOffset };
    }
    if (valueType === 9 && key === "tokenizer.ggml.token_type") {
      tokenizerTypesLocation = { offset: valueOffset };
    }
    if (key === "general.architecture" && typeof value.raw === "string") architecture = value.raw;
    if (key.endsWith(".context_length")) {
      const candidate = typeof value.raw === "bigint" ? Number(value.raw) : value.raw;
      if (
        typeof candidate === "number" &&
        Number.isSafeInteger(candidate) &&
        candidate >= 256 &&
        candidate <= maximumDeclaredContextTokens
      ) {
        contextLength = candidate;
      }
    }
    if (key === "general.name" && typeof value.raw === "string") name = value.raw;
    if (key === "general.file_type" && typeof value.raw === "number") {
      quantization = fileTypes.get(value.raw) ?? `type ${value.raw}`;
    }
    if (entries.length < maxDisplayedEntries) {
      entries.push({ key, type: value.type, value: value.display });
    }
  }

  let specialTokens: ReturnType<typeof inspectSpecialTokens>;
  try {
    specialTokens = inspectSpecialTokens(bytes, tokenizerTokensLocation, tokenizerTypesLocation);
  } catch {
    // The primary metadata pass already bounded and skipped these arrays. A malformed
    // diagnostic token must not discard otherwise useful GGUF metadata.
    specialTokens = undefined;
  }

  return {
    format: "gguf",
    version,
    tensorCount,
    metadataCount,
    ...(architecture === undefined ? {} : { architecture }),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(name === undefined ? {} : { name }),
    ...(quantization === undefined ? {} : { quantization }),
    specialTokenInventoryInspected: true,
    ...(specialTokens === undefined
      ? {}
      : {
          specialTokens: specialTokens.tokens,
          specialTokenCount: specialTokens.count,
          specialTokensTruncated: specialTokens.truncated,
        }),
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
