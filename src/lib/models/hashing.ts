import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { IntegrityIdentity } from "./types";

export interface StreamingHasher {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

export function createSha256(): StreamingHasher {
  const hash = sha256.create();
  return {
    update: (chunk) => hash.update(chunk),
    digestHex: () => bytesToHex(hash.digest()),
  };
}

export function createIntegrityHasher(identity: IntegrityIdentity, size: number): StreamingHasher {
  if (identity.kind === "lfs-sha256") return createSha256();
  const hash = sha1.create();
  hash.update(new TextEncoder().encode(`blob ${size}\0`));
  return {
    update: (chunk) => hash.update(chunk),
    digestHex: () => bytesToHex(hash.digest()),
  };
}
