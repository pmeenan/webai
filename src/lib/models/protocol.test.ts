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
});
