import { describe, expect, it } from "vitest";
import { modelWorkerProtocolVersion, parseModelWorkerEvent } from "./protocol";

const envelope = { protocolVersion: modelWorkerProtocolVersion, requestId: "request-1" };

describe("model worker event validation", () => {
  it.each([
    { ...envelope, type: "model/job", job: {} },
    { ...envelope, type: "model/inventory", inventory: { models: [], jobs: [], storage: {} } },
    { ...envelope, type: "model/resolved", repository: { repo: "owner/model" } },
    { ...envelope, type: "model/error", failure: { message: "missing discriminants" } },
  ])("rejects malformed nested payloads %#", (event) => {
    expect(parseModelWorkerEvent(event)).toBeUndefined();
  });

  it("accepts a bounded progress event", () => {
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/progress",
        jobId: "job-1",
        phase: "verifying",
        completedBytes: 4,
        totalBytes: 10,
        currentFile: "fixture.gguf",
      }),
    ).toBeDefined();
  });

  it("requires a recognized stage for split progress only", () => {
    const splitProgress = {
      ...envelope,
      type: "model/progress",
      jobId: "model-1",
      phase: "splitting",
      splitStage: "planning",
      completedBytes: 0,
      totalBytes: 10,
      currentFile: "fixture.gguf",
    };
    expect(parseModelWorkerEvent(splitProgress)).toBeDefined();
    const withoutStage: Record<string, unknown> = { ...splitProgress };
    delete withoutStage.splitStage;
    expect(parseModelWorkerEvent(withoutStage)).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...splitProgress,
        phase: "verifying",
      }),
    ).toBeUndefined();
  });

  it("accepts exactly one metadata result or warning for each installed file", () => {
    const file = {
      blobId: `sha256:${"a".repeat(64)}`,
      displayName: "fixture.gguf",
      size: 10,
      sha256: "a".repeat(64),
      opfsPath: `blobs/${"a".repeat(64)}`,
      inspectionError: {
        code: "gguf-invalid",
        phase: "inspect",
        message: "Inspector does not recognize this metadata yet.",
        retryable: false,
      },
    };
    const event = {
      ...envelope,
      type: "model/inventory",
      inventory: {
        models: [
          {
            id: "model-1",
            displayName: "Fixture",
            createdAt: "2026-07-18T00:00:00.000Z",
            totalSize: 10,
            state: "installed",
            source: {
              kind: "local-import",
              filenames: ["fixture.gguf"],
              lastModified: [1],
              sha256: ["a".repeat(64)],
            },
            files: [file],
          },
        ],
        jobs: [],
        storage: { modelBytes: 10, partialBytes: 0 },
      },
    };
    expect(parseModelWorkerEvent(event)).toBeDefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        inventory: {
          ...event.inventory,
          models: [
            {
              ...event.inventory.models[0],
              runtimeIssues: [
                {
                  runtimeId: "wllama",
                  reasonCode: "minimum-shard-size",
                  message: "Measured minimum shard exceeds the runtime limit.",
                  measuredAt: "2026-07-18T00:00:00.000Z",
                  limitBytes: 2_000_000_000,
                  requiredShardBytes: 1,
                  splitterVersion: "fixture-splitter",
                },
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        inventory: {
          ...event.inventory,
          models: [
            {
              ...event.inventory.models[0],
              files: [
                {
                  ...file,
                  inspection: {
                    format: "gguf",
                    version: 3,
                    tensorCount: 0,
                    metadataCount: 0,
                    entries: [],
                    omittedEntries: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("validates bounded special-token inventory fields across the worker boundary", () => {
    const inspection = {
      format: "gguf",
      version: 3,
      tensorCount: 0,
      metadataCount: 2,
      specialTokenInventoryInspected: true,
      specialTokens: [
        {
          id: 101,
          text: "<channel|>",
          textTruncated: false,
          type: 4,
          typeName: "user-defined",
        },
      ],
      specialTokenCount: 1,
      specialTokensTruncated: false,
      entries: [],
      omittedEntries: 0,
    };
    const event = {
      ...envelope,
      type: "model/inventory",
      inventory: {
        models: [
          {
            schemaVersion: 1,
            id: "model-1",
            displayName: "Fixture",
            createdAt: "2026-07-18T00:00:00.000Z",
            totalSize: 10,
            state: "installed",
            source: {
              kind: "local-import",
              filenames: ["fixture.gguf"],
              lastModified: [1],
              sha256: ["a".repeat(64)],
            },
            files: [
              {
                blobId: `sha256:${"a".repeat(64)}`,
                displayName: "fixture.gguf",
                size: 10,
                sha256: "a".repeat(64),
                opfsPath: `blobs/${"a".repeat(64)}`,
                inspection,
              },
            ],
          },
        ],
        jobs: [],
        storage: {
          modelBytes: 10,
          partialBytes: 0,
          originUsage: 10,
          originQuota: 100,
          persisted: false,
        },
      },
    };
    expect(parseModelWorkerEvent(event)).toBeDefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        inventory: {
          ...event.inventory,
          models: [
            {
              ...event.inventory.models[0],
              files: [
                {
                  ...event.inventory.models[0]?.files[0],
                  inspection: { ...inspection, specialTokenCount: 0 },
                },
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        inventory: {
          ...event.inventory,
          models: [
            {
              ...event.inventory.models[0],
              files: [
                {
                  ...event.inventory.models[0]?.files[0],
                  inspection: {
                    ...inspection,
                    specialTokens: [{ ...inspection.specialTokens[0], type: 99 }],
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });
});
