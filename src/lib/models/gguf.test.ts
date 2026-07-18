import { describe, expect, it } from "vitest";
import { inspectGgufBlob, parseGgufHeader } from "./gguf";

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
    const bytes = new TextEncoder().encode(value);
    this.u64(BigInt(bytes.byteLength));
    this.raw(...bytes);
  }
  entry(key: string, type: number, writeValue: () => void): void {
    this.string(key);
    this.u32(type);
    writeValue();
  }
  result(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function validFixture(): Uint8Array {
  const writer = new FixtureWriter();
  writer.raw(0x47, 0x47, 0x55, 0x46);
  writer.u32(3);
  writer.u64(12n);
  writer.u64(4n);
  writer.entry("general.architecture", 8, () => writer.string("llama"));
  writer.entry("general.name", 8, () => writer.string("Hostile fixture survivor"));
  writer.entry("general.file_type", 4, () => writer.u32(15));
  writer.entry("tokenizer.ggml.tokens", 9, () => {
    writer.u32(8);
    writer.u64(2n);
    writer.string("one");
    writer.string("two");
  });
  return writer.result();
}

describe("defensive GGUF metadata parsing", () => {
  it("extracts bounded inspector metadata", () => {
    expect(parseGgufHeader(validFixture())).toMatchObject({
      format: "gguf",
      version: 3,
      tensorCount: 12,
      metadataCount: 4,
      architecture: "llama",
      name: "Hostile fixture survivor",
      quantization: "Q4_K_M",
      omittedEntries: 0,
    });
  });

  it("inspects a large model from its bounded prefix", async () => {
    const padding = new Uint8Array(16 * 1024 * 1024);
    await expect(
      inspectGgufBlob(
        new Blob([validFixture().buffer as ArrayBuffer, padding.buffer as ArrayBuffer]),
      ),
    ).resolves.toMatchObject({
      architecture: "llama",
      name: "Hostile fixture survivor",
    });
  });

  it.each([
    new Uint8Array(),
    Uint8Array.from([0x42, 0x41, 0x44, 0x21, 3, 0, 0, 0]),
    validFixture().subarray(0, 20),
    (() => {
      const bytes = validFixture().slice();
      new DataView(bytes.buffer).setUint32(4, 99, true);
      return bytes;
    })(),
    (() => {
      const bytes = validFixture().slice();
      new DataView(bytes.buffer).setBigUint64(16, 10_001n, true);
      return bytes;
    })(),
  ])("fails with a report instead of reading beyond malformed fixture %#", (fixture) => {
    expect(() => parseGgufHeader(fixture)).toThrow();
  });

  it("rejects duplicate metadata keys", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(2n);
    writer.entry("general.name", 8, () => writer.string("one"));
    writer.entry("general.name", 8, () => writer.string("two"));
    expect(() => parseGgufHeader(writer.result())).toThrow(/duplicate/u);
  });

  it("bounds attacker-controlled strings before allocation", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(1n);
    writer.u64(BigInt(1024 * 1024 + 1));
    expect(() => parseGgufHeader(writer.result())).toThrow(/bounds/u);
  });
});
