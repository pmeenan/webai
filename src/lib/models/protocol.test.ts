import { describe, expect, it } from "vitest";
import { modelWorkerProtocolVersion, parseModelWorkerEvent } from "./protocol";
import { maximumBrowseCandidates, maximumBrowsePages } from "./types";
import { shouldBroadcastWorkerEvent } from "./worker-client";

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
    const lateProgress = {
      protocolVersion: modelWorkerProtocolVersion,
      type: "model/browse-progress",
      requestId: "browse-old",
      inspectedCandidates: 8,
      inspectedPages: 1,
    } as const;
    expect(shouldBroadcastWorkerEvent(lateProgress, undefined)).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateProgress, "browse-new")).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateProgress, "browse-old")).toBe(true);
    const lateLineage = {
      protocolVersion: modelWorkerProtocolVersion,
      type: "model/lineage-progress",
      requestId: "lineage-old",
      inspectedNodes: 2,
    } as const;
    expect(shouldBroadcastWorkerEvent(lateLineage, undefined)).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateLineage, undefined, "lineage-new")).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateLineage, undefined, "lineage-old")).toBe(true);
    const lateBrowseRetry = {
      protocolVersion: modelWorkerProtocolVersion,
      type: "model/retry",
      requestId: "browse-old",
      phase: "browse",
      attempt: 1,
      delayMs: 500,
      message: "Retrying browse.",
    } as const;
    expect(shouldBroadcastWorkerEvent(lateBrowseRetry, undefined)).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateBrowseRetry, "browse-new")).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateBrowseRetry, "browse-old")).toBe(true);
    const lateLineageRetry = {
      ...lateBrowseRetry,
      requestId: "lineage-old",
      phase: "lineage",
    } as const;
    expect(shouldBroadcastWorkerEvent(lateLineageRetry, undefined, "lineage-new")).toBe(false);
    expect(shouldBroadcastWorkerEvent(lateLineageRetry, undefined, "lineage-old")).toBe(true);
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/browse-progress",
        requestId: "browse-maximum",
        inspectedCandidates: maximumBrowseCandidates,
        inspectedPages: maximumBrowsePages,
      }),
    ).toBeDefined();
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/browse-progress",
        requestId: "browse-too-many-pages",
        inspectedCandidates: maximumBrowseCandidates,
        inspectedPages: maximumBrowsePages + 1,
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/browse-progress",
        requestId: "browse-too-many-candidates",
        inspectedCandidates: maximumBrowseCandidates + 1,
        inspectedPages: maximumBrowsePages,
      }),
    ).toBeUndefined();
  });

  it("accepts exactly the raised 1,024-candidate result boundary", () => {
    const unknown = Array.from({ length: maximumBrowseCandidates }, (_, index) => ({
      repo: `owner/model-${index}`,
      commit: (index + 1).toString(16).padStart(40, "0"),
      metadata: { gating: "open" },
      reason: "No matching artifact.",
    }));
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/browse-result",
        result: {
          matches: [],
          needsVerification: [],
          unknown,
          inspectedCandidates: maximumBrowseCandidates,
          excludedCandidates: 0,
          inspectedPages: maximumBrowsePages,
          cacheHits: 0,
          catalog: { persistent: true, entries: 0, bytes: 0 },
          truncated: true,
        },
      }),
    ).toBeDefined();
  });

  it("accepts only a truncated stopped-discovery snapshot", () => {
    const stopped = {
      matches: [],
      needsVerification: [],
      unknown: [],
      inspectedCandidates: 0,
      excludedCandidates: 0,
      inspectedPages: 0,
      cacheHits: 0,
      catalog: { persistent: true, entries: 0, bytes: 0 },
      truncated: true,
      truncationReason: "stopped",
    };
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/browse-result",
        result: stopped,
      }),
    ).toBeDefined();
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/browse-result",
        result: { ...stopped, truncated: false },
      }),
    ).toBeUndefined();
  });

  it("rejects a browse result above the aggregate record-byte budget", () => {
    const tags = Array.from(
      { length: 256 },
      (_, index) => `${index.toString().padStart(3, "0")}-${"x".repeat(156)}`,
    );
    const unknown = Array.from({ length: 800 }, (_, index) => ({
      repo: `owner/large-${index}`,
      commit: (index + 1).toString(16).padStart(40, "0"),
      metadata: { gating: "open", tags },
      reason: "x".repeat(1_024),
    }));
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/browse-result",
        result: {
          matches: [],
          needsVerification: [],
          unknown,
          inspectedCandidates: unknown.length,
          excludedCandidates: 0,
          inspectedPages: 100,
          cacheHits: 0,
          catalog: { persistent: true, entries: 0, bytes: 0 },
          truncated: true,
          truncationReason: "result-budget",
        },
      }),
    ).toBeUndefined();
  });

  it("accepts a bounded lineage graph and rejects duplicate or oversized nodes", () => {
    const lineage = {
      rootRepo: "owner/model",
      nodes: [
        {
          repo: "owner/model",
          commit: "a".repeat(40),
          parents: [{ repo: "base/model", relation: "finetune" }],
          status: "resolved",
        },
        {
          repo: "base/model",
          commit: "b".repeat(40),
          parents: [],
          status: "resolved",
        },
      ],
      cacheHits: 1,
      truncated: false,
    };
    expect(
      parseModelWorkerEvent({ ...envelope, type: "model/lineage-result", lineage }),
    ).toBeDefined();
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/lineage-result",
        lineage: { ...lineage, nodes: [lineage.nodes[0], lineage.nodes[0]] },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...envelope,
        type: "model/lineage-result",
        lineage: {
          ...lineage,
          nodes: Array.from({ length: 33 }, (_, index) => ({
            repo: `owner/model-${index}`,
            parents: [],
            status: "resolved",
          })),
        },
      }),
    ).toBeUndefined();
  });

  it("requires browse choices to equal their validated canonical repository choices", () => {
    const choice = {
      id: "fixture-Q4_K_M.gguf",
      label: "fixture-Q4_K_M.gguf",
      quantization: "Q4_K_M",
      totalSize: 10,
      files: [
        {
          path: "fixture-Q4_K_M.gguf",
          size: 10,
          integrity: { kind: "lfs-sha256", digest: "a".repeat(64) },
        },
      ],
    };
    const event = {
      ...envelope,
      type: "model/browse-result",
      result: {
        matches: [
          {
            repo: "owner/model",
            commit: "b".repeat(40),
            omittedMatchingChoices: 0,
            repository: {
              repo: "owner/model",
              requestedRevision: "b".repeat(40),
              commit: "b".repeat(40),
              metadata: { gating: "open", visibility: "private" },
              choices: [choice],
            },
            matchingChoices: [choice],
          },
        ],
        needsVerification: [],
        unknown: [],
        inspectedCandidates: 1,
        excludedCandidates: 0,
        inspectedPages: 1,
        cacheHits: 0,
        catalog: { persistent: true, entries: 1, bytes: 100 },
        truncated: false,
      },
    };
    const baseMatch = event.result.matches[0]!;
    expect(parseModelWorkerEvent(event)).toBeDefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [
            {
              ...baseMatch,
              repository: {
                ...baseMatch.repository,
                metadata: { gating: "open", visibility: "secret" },
              },
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/browse-progress",
        requestId: "browse-1",
        inspectedCandidates: 8,
        inspectedPages: 1,
      }),
    ).toBeDefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [{ ...event.result.matches[0], repo: "owner/different-model" }],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [{ ...event.result.matches[0], commit: "c".repeat(40) }],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [
            {
              ...event.result.matches[0],
              matchingChoices: [{ ...choice, label: "x".repeat(3_000) }],
            },
          ],
        },
      }),
    ).toBeUndefined();
    const differentChoice = {
      ...choice,
      id: "fixture-Q8_0.gguf",
      label: "fixture-Q8_0.gguf",
      quantization: "Q8_0",
      files: [{ ...choice.files[0], path: "fixture-Q8_0.gguf" }],
    };
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [{ ...event.result.matches[0], matchingChoices: [differentChoice] }],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [
            {
              ...baseMatch,
              repository: { ...baseMatch.repository, choices: [] },
              matchingChoices: [],
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: Array.from({ length: maximumBrowseCandidates + 1 }, (_, index) => {
            const commit = (index + 1).toString(16).padStart(40, "0");
            return {
              ...baseMatch,
              repo: `owner/model-${index}`,
              commit,
              repository: {
                ...baseMatch.repository,
                repo: `owner/model-${index}`,
                requestedRevision: commit,
                commit,
              },
            };
          }),
          inspectedCandidates: maximumBrowseCandidates + 1,
        },
      }),
    ).toBeUndefined();
    const files = Array.from({ length: 256 }, (_, index) => ({
      ...choice.files[0],
      path: `part-${index}.gguf`,
    }));
    const oversizedChoice = {
      ...choice,
      totalSize: 2_560,
      files,
      optionalMtp: {
        ...choice.files[0],
        path: "mtp-model.gguf",
      },
    };
    expect(
      parseModelWorkerEvent({
        ...event,
        result: {
          ...event.result,
          matches: [
            {
              ...baseMatch,
              repository: {
                ...baseMatch.repository,
                choices: [oversizedChoice],
              },
              matchingChoices: [oversizedChoice],
            },
          ],
        },
      }),
    ).toBeUndefined();
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
