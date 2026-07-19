import { afterEach, describe, expect, it } from "vitest";
import { splitGgufFile } from "./gguf-split";
import { createSha256 } from "./hashing";
import { deleteStoredPath, getStoredFile } from "./storage";

class FixtureWriter {
  readonly bytes: number[] = [];

  raw(...values: number[]): void {
    this.bytes.push(...values);
  }

  u32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.raw(...bytes);
  }

  u64(value: bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    this.raw(...bytes);
  }

  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.u64(BigInt(encoded.byteLength));
    this.raw(...encoded);
  }

  align(alignment: number): void {
    while (this.bytes.length % alignment !== 0) this.raw(0);
  }

  result(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function twoTensorGguf(): Uint8Array {
  const writer = new FixtureWriter();
  writer.raw(0x47, 0x47, 0x55, 0x46);
  writer.u32(3);
  writer.u64(2n);
  writer.u64(1n);
  writer.string("general.architecture");
  writer.u32(8);
  writer.string("llama");
  for (const [name, offset] of [
    ["tensor.a", 0n],
    ["tensor.b", 64n],
  ] as const) {
    writer.string(name);
    writer.u32(1);
    writer.u64(16n);
    writer.u32(0);
    writer.u64(offset);
  }
  writer.align(32);
  for (let index = 0; index < 64; index += 1) writer.raw(index);
  for (let index = 0; index < 64; index += 1) writer.raw(255 - index);
  return writer.result();
}

function largeTwoTensorGguf(): File {
  const tensorBytes = 8 * 1024 * 1024 + 512 * 1024;
  const writer = new FixtureWriter();
  writer.raw(0x47, 0x47, 0x55, 0x46);
  writer.u32(3);
  writer.u64(2n);
  writer.u64(1n);
  writer.string("general.architecture");
  writer.u32(8);
  writer.string("llama");
  for (const [name, offset] of [
    ["tensor.a", 0n],
    ["tensor.b", BigInt(tensorBytes)],
  ] as const) {
    writer.string(name);
    writer.u32(1);
    writer.u64(BigInt(tensorBytes / 4));
    writer.u32(0);
    writer.u64(offset);
  }
  writer.align(32);
  return new File(
    [
      writer.result().buffer as ArrayBuffer,
      new Uint8Array(tensorBytes).buffer as ArrayBuffer,
      new Uint8Array(tensorBytes).buffer as ArrayBuffer,
    ],
    "large-fixture.gguf",
  );
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(async (path) => await deleteStoredPath(path)));
});

describe("pinned llama.cpp GGUF splitter", () => {
  it("plans in wasm and copies tensor bytes into compatible OPFS shards", async () => {
    const bytes = twoTensorGguf();
    const file = new File([bytes.buffer as ArrayBuffer], "fixture.gguf");
    const prefix = `partials/split-test-${crypto.randomUUID()}`;
    const stages: string[] = [];
    const result = await splitGgufFile(
      file,
      file.name,
      prefix,
      new AbortController().signal,
      (_completedBytes, _totalBytes, stage) => stages.push(stage),
      64,
    );
    cleanupPaths.push(...result.files.map((output) => output.opfsPath));

    const sourceHash = createSha256();
    sourceHash.update(bytes);
    expect(result.sourceSha256).toBe(sourceHash.digestHex());
    expect(result.files.map((output) => output.displayName)).toEqual([
      "fixture-00001-of-00002.gguf",
      "fixture-00002-of-00002.gguf",
    ]);
    expect(result.files.every((output) => output.size < 16 * 1024 * 1024)).toBe(true);
    for (const output of result.files) {
      const stored = await getStoredFile(output.opfsPath);
      expect(stored?.size).toBe(output.size);
      expect(output.inspection?.format).toBe("gguf");
    }
    expect(result.files[0]?.inspection?.architecture).toBe("llama");
    expect(stages[0]).toBe("planning");
    expect(stages).toContain("hashing");
    expect(stages.filter((stage) => stage === "copying")).toHaveLength(1);
    expect(stages.at(-1)).toBe("finalizing");
  });

  it("rejects attacker-controlled shard sizing before loading wasm", async () => {
    const bytes = twoTensorGguf();
    const file = new File([bytes.buffer as ArrayBuffer], "fixture.gguf");
    await expect(
      splitGgufFile(
        file,
        file.name,
        `partials/split-test-${crypto.randomUUID()}`,
        new AbortController().signal,
        undefined,
        0,
      ),
    ).rejects.toThrow(/shard size/u);
  });

  it("plans tensors beyond the bounded wasm header prefix", async () => {
    const file = largeTwoTensorGguf();
    expect(file.size).toBeGreaterThan(16 * 1024 * 1024);
    const result = await splitGgufFile(
      file,
      file.name,
      `partials/split-test-${crypto.randomUUID()}`,
      new AbortController().signal,
      undefined,
      9 * 1024 * 1024,
    );
    cleanupPaths.push(...result.files.map((output) => output.opfsPath));
    expect(result.files).toHaveLength(2);
    expect(result.files.every((output) => output.size < 9 * 1024 * 1024)).toBe(true);
  });
});
