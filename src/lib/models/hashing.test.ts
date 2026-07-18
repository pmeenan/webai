import { describe, expect, it } from "vitest";
import { createIntegrityHasher, createSha256 } from "./hashing";

const encoder = new TextEncoder();

describe("streaming model hashes", () => {
  it("matches the SHA-256 vector across chunk boundaries", () => {
    const hash = createSha256();
    hash.update(encoder.encode("a"));
    hash.update(encoder.encode("bc"));
    expect(hash.digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("uses Git blob framing for companion object IDs", () => {
    const bytes = encoder.encode("hello\n");
    const hash = createIntegrityHasher(
      { kind: "git-blob-sha1", digest: "unused" },
      bytes.byteLength,
    );
    hash.update(bytes.subarray(0, 2));
    hash.update(bytes.subarray(2));
    expect(hash.digestHex()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
