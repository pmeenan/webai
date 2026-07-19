import { describe, expect, it } from "vitest";
import { ggufSplitToolVersion } from "../models/gguf-split-profile";
import { type InstalledModelRecord, modelSchemaVersion } from "../models/types";
import {
  maximumWllamaFileBytes,
  wllamaModelCompatibility,
  wllamaModelContextLength,
} from "./wllama-compatibility";

function fixture(size: number, displayName = "fixture.gguf"): InstalledModelRecord {
  const sha256 = "a".repeat(64);
  return {
    schemaVersion: modelSchemaVersion,
    id: "model-1",
    displayName: "Fixture",
    createdAt: "2026-07-18T00:00:00.000Z",
    totalSize: size,
    state: "installed",
    source: {
      kind: "local-import",
      filenames: [displayName],
      lastModified: [1],
      sha256: [sha256],
    },
    files: [
      {
        blobId: `sha256:${sha256}`,
        displayName,
        size,
        sha256,
        opfsPath: `blobs/${sha256}`,
      },
    ],
  };
}

describe("wllama model preparation policy", () => {
  it("keeps a sub-limit monolith ready without requiring a split", () => {
    expect(wllamaModelCompatibility(fixture(maximumWllamaFileBytes - 1))).toEqual({
      status: "ready",
    });
  });

  it("requires runtime-driven preparation for an oversized monolith", () => {
    expect(wllamaModelCompatibility(fixture(maximumWllamaFileBytes)).status).toBe("needs-split");
  });

  it("uses the primary GGUF trained context and ignores companion metadata", () => {
    const model = fixture(1024);
    const primary = model.files[0];
    if (primary === undefined) throw new Error("fixture primary file is missing");
    const withContext: InstalledModelRecord = {
      ...model,
      files: [
        {
          ...primary,
          inspection: {
            format: "gguf",
            version: 3,
            tensorCount: 1,
            metadataCount: 1,
            architecture: "gemma4",
            contextLength: 131_072,
            entries: [],
            omittedEntries: 0,
          },
        },
        {
          ...primary,
          blobId: `sha256:${"b".repeat(64)}`,
          sha256: "b".repeat(64),
          displayName: "mtp-fixture.gguf",
          inspection: {
            format: "gguf",
            version: 3,
            tensorCount: 1,
            metadataCount: 1,
            architecture: "gemma4-assistant",
            contextLength: 4096,
            entries: [],
            omittedEntries: 0,
          },
        },
      ],
    };
    expect(wllamaModelContextLength(withContext)).toBe(131_072);
  });

  it("recovers trained context from existing bounded metadata entries", () => {
    const model = fixture(1024);
    const primary = model.files[0];
    if (primary === undefined) throw new Error("fixture primary file is missing");
    expect(
      wllamaModelContextLength({
        ...model,
        files: [
          {
            ...primary,
            inspection: {
              format: "gguf",
              version: 3,
              tensorCount: 1,
              metadataCount: 1,
              entries: [{ key: "gemma4.context_length", type: "uint32", value: "131072" }],
              omittedEntries: 0,
            },
          },
        ],
      }),
    ).toBe(131_072);
  });

  it("does not retry a measured minimum-shard incompatibility", () => {
    const model: InstalledModelRecord = {
      ...fixture(maximumWllamaFileBytes),
      runtimeIssues: [
        {
          runtimeId: "wllama",
          reasonCode: "minimum-shard-size",
          message: "Measured minimum shard exceeds the wllama limit.",
          measuredAt: "2026-07-18T00:00:00.000Z",
          limitBytes: maximumWllamaFileBytes,
          requiredShardBytes: maximumWllamaFileBytes + 1,
          splitterVersion: ggufSplitToolVersion,
        },
      ],
    };
    expect(wllamaModelCompatibility(model)).toEqual({
      status: "incompatible",
      reasonCode: "minimum-shard-size",
      explanation: "Measured minimum shard exceeds the wllama limit.",
    });
  });

  it.each([
    { splitterVersion: "older-splitter", limitBytes: maximumWllamaFileBytes },
    { splitterVersion: ggufSplitToolVersion, limitBytes: maximumWllamaFileBytes - 1 },
  ])("retries preparation when measured evidence is stale", (evidence) => {
    const model: InstalledModelRecord = {
      ...fixture(maximumWllamaFileBytes),
      runtimeIssues: [
        {
          runtimeId: "wllama",
          reasonCode: "minimum-shard-size",
          message: "Stale measured incompatibility.",
          measuredAt: "2026-07-18T00:00:00.000Z",
          ...evidence,
          requiredShardBytes: maximumWllamaFileBytes + 1,
        },
      ],
    };
    expect(wllamaModelCompatibility(model).status).toBe("needs-split");
  });

  it("rejects an already-sharded set containing an oversized file", () => {
    expect(
      wllamaModelCompatibility(fixture(maximumWllamaFileBytes, "fixture-00001-of-00002.gguf"))
        .status,
    ).toBe("incompatible");
  });
});
