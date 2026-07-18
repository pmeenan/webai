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
});
