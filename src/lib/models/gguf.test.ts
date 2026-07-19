import { describe, expect, it } from "vitest";
import { inspectGgufBlob, parseGgufHeader } from "./gguf";

class FixtureWriter {
  readonly bytes: number[] = [];

  raw(...values: number[]): void {
    this.bytes.push(...values);
  }
  repeat(value: number, count: number): void {
    for (let index = 0; index < count; index += 1) this.bytes.push(value);
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

  it("promotes the architecture context length for runtime configuration", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(2n);
    writer.entry("general.architecture", 8, () => writer.string("gemma4"));
    writer.entry("gemma4.context_length", 4, () => writer.u32(131_072));
    expect(parseGgufHeader(writer.result())).toMatchObject({
      architecture: "gemma4",
      contextLength: 131_072,
    });
  });

  it("retains a bounded model-declared inventory of diagnostic tokenizer items", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(2n);
    writer.entry("tokenizer.ggml.token_type", 9, () => {
      writer.u32(4);
      writer.u64(4n);
      for (const type of [1, 4, 3, 5]) writer.u32(type);
    });
    writer.entry("tokenizer.ggml.tokens", 9, () => {
      writer.u32(8);
      writer.u64(4n);
      for (const token of ["ordinary", "<mystery|>", "<control>", "<unused49>"]) {
        writer.string(token);
      }
    });

    expect(parseGgufHeader(writer.result())).toMatchObject({
      specialTokenCount: 3,
      specialTokensTruncated: false,
      specialTokens: [
        { id: 1, text: "<mystery|>", type: 4, typeName: "user-defined" },
        { id: 2, text: "<control>", type: 3, typeName: "control" },
        { id: 3, text: "<unused49>", type: 5, typeName: "unused" },
      ],
    });
  });

  it("reports special-token inventory truncation without retaining an unbounded list", () => {
    const writer = new FixtureWriter();
    const count = 1030;
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(2n);
    writer.entry("tokenizer.ggml.tokens", 9, () => {
      writer.u32(8);
      writer.u64(BigInt(count));
      for (let index = 0; index < count; index += 1) writer.string(`<special-${index}>`);
    });
    writer.entry("tokenizer.ggml.token_type", 9, () => {
      writer.u32(4);
      writer.u64(BigInt(count));
      for (let index = 0; index < count; index += 1) writer.u32(4);
    });

    const inspection = parseGgufHeader(writer.result());
    expect(inspection.specialTokenCount).toBe(count);
    expect(inspection.specialTokens).toHaveLength(1024);
    expect(inspection.specialTokensTruncated).toBe(true);
  });

  it("keeps primary metadata when the optional special-token inventory is malformed", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(3n);
    writer.entry("general.name", 8, () => writer.string("Metadata survives"));
    writer.entry("tokenizer.ggml.tokens", 9, () => {
      writer.u32(8);
      writer.u64(40n);
      for (let index = 0; index < 40; index += 1) {
        if (index === 35) {
          writer.u64(1n);
          writer.raw(0xff);
        } else {
          writer.string(`token-${index}`);
        }
      }
    });
    writer.entry("tokenizer.ggml.token_type", 9, () => {
      writer.u32(4);
      writer.u64(40n);
      for (let index = 0; index < 40; index += 1) writer.u32(index === 35 ? 4 : 1);
    });

    expect(parseGgufHeader(writer.result())).toMatchObject({
      name: "Metadata survives",
      specialTokenInventoryInspected: true,
    });
    expect(parseGgufHeader(writer.result()).specialTokens).toBeUndefined();
  });

  it("does not promote implausibly large untrusted context declarations", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(1n);
    writer.entry("hostile.context_length", 10, () => writer.u64(10_000_000n));
    expect(parseGgufHeader(writer.result()).contextLength).toBeUndefined();
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

  it("accepts a hyphenated llama.cpp assistant architecture namespace", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(49n);
    writer.u64(2n);
    writer.entry("general.architecture", 8, () => writer.string("gemma4-assistant"));
    writer.entry("gemma4-assistant.block_count", 4, () => writer.u32(2));

    expect(parseGgufHeader(writer.result())).toMatchObject({
      architecture: "gemma4-assistant",
      metadataCount: 2,
    });
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

  it("accepts the measured Gemma 4 tokenizer array cardinalities", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(541n);
    writer.u64(4n);
    for (const [key, count] of [
      ["tokenizer.ggml.tokens", 262_144],
      ["tokenizer.ggml.scores", 262_144],
      ["tokenizer.ggml.token_type", 262_144],
      ["tokenizer.ggml.merges", 514_906],
    ] as const) {
      writer.entry(key, 9, () => {
        writer.u32(0);
        writer.u64(BigInt(count));
        writer.repeat(0, count);
      });
    }

    expect(parseGgufHeader(writer.result())).toMatchObject({
      version: 3,
      tensorCount: 541,
      metadataCount: 4,
    });
  });

  it("skips non-displayed string-array values and continues inspecting metadata", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(2n);
    writer.entry("tokenizer.ggml.tokens", 9, () => {
      writer.u32(8);
      writer.u64(40n);
      for (let index = 0; index < 40; index += 1) writer.string(`token-${index}`);
    });
    writer.entry("general.name", 8, () => writer.string("Metadata after tokenizer array"));

    const inspection = parseGgufHeader(writer.result());
    expect(inspection.name).toBe("Metadata after tokenizer array");
    expect(inspection.entries[0]?.value).toContain("… 8 more");
  });

  it("still rejects a single array beyond the measured inspection ceiling", () => {
    const writer = new FixtureWriter();
    writer.raw(0x47, 0x47, 0x55, 0x46);
    writer.u32(3);
    writer.u64(0n);
    writer.u64(1n);
    writer.entry("tokenizer.ggml.tokens", 9, () => {
      writer.u32(0);
      writer.u64(1_000_001n);
    });

    expect(() => parseGgufHeader(writer.result())).toThrow(/maximum 1000000/u);
  });
});
