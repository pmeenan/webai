import { describe, expect, it, vi } from "vitest";
import { type HuggingFaceCatalog, maximumCatalogSnapshotBytes } from "./catalog";
import {
  browseHuggingFaceModels,
  fetchHuggingFaceLineage,
  fetchWith429Backoff,
  groupGgufChoices,
  parseHuggingFaceNextLink,
  parseModelInfo,
  parseModelInput,
  quantizationBitLevel,
  resolveHuggingFaceModel,
  resolverUrl,
  validateRangeResponse,
} from "./hugging-face";
import { modelWorkerProtocolVersion, parseModelWorkerEvent } from "./protocol";
import {
  maximumArtifactChoiceFiles,
  maximumBrowseCandidates,
  maximumBrowsePages,
  maximumBrowseResultBytes,
  type HuggingFaceFile,
} from "./types";

const sha256 = "a".repeat(64);
const commit = "b".repeat(40);

function lfsFile(path: string, size = 10): HuggingFaceFile {
  return { path, size, integrity: { kind: "lfs-sha256", digest: sha256 } };
}

describe("Hugging Face model input", () => {
  it("accepts IDs, revisions, and file URLs without retaining mutable resolver URLs", () => {
    expect(parseModelInput("owner/model")).toEqual({ repo: "owner/model", revision: "main" });
    expect(parseModelInput("owner/model@refs/pr/4")).toEqual({
      repo: "owner/model",
      revision: "refs/pr/4",
    });
    expect(parseModelInput("https://huggingface.co/owner/model/blob/main/sub/model.gguf")).toEqual({
      repo: "owner/model",
      revision: "main",
      selectedPath: "sub/model.gguf",
    });
    expect(resolverUrl("owner/model", commit, "sub/model.gguf")).toBe(
      `https://huggingface.co/owner/model/resolve/${commit}/sub/model.gguf`,
    );
  });

  it.each([
    "",
    "one-segment",
    "owner/../model",
    "http://huggingface.co/owner/model",
    "https://evil.example/owner/model",
    "https://user:secret@huggingface.co/owner/model",
    "https://huggingface.co/owner/model/discussions/1",
    "https://huggingface.co/owner/model/blob/main/../secret.gguf",
  ])("rejects unsafe input %s", (input) => {
    expect(() => parseModelInput(input)).toThrow();
  });
});

describe("Hugging Face reported lineage", () => {
  it("recursively follows immediate parent metadata, preserves branches, and stops cycles", async () => {
    const commits = new Map([
      ["base/left", "1".repeat(40)],
      ["base/right", "2".repeat(40)],
      ["base/shared", "3".repeat(40)],
    ]);
    const parents = new Map([
      ["base/left", ["base/shared"]],
      ["base/right", ["base/shared"]],
      ["base/shared", ["owner/root"]],
    ]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const repo = decodeURIComponent(url.pathname.slice("/api/models/".length));
      const baseModels = parents.get(repo) ?? [];
      return Response.json({
        sha: commits.get(repo),
        private: false,
        gated: false,
        baseModels: {
          relation: "finetune",
          models: baseModels.map((id) => ({ id })),
        },
      });
    });

    const lineage = await fetchHuggingFaceLineage(
      {
        repo: "owner/root",
        commit,
        parents: [
          { repo: "base/left", relation: "merge" },
          { repo: "base/right", relation: "merge" },
        ],
      },
      { fetcher: fetcher as typeof fetch },
    );

    expect(lineage.nodes.map((node) => node.repo)).toEqual([
      "owner/root",
      "base/left",
      "base/right",
      "base/shared",
    ]);
    expect(lineage.nodes.find((node) => node.repo === "base/shared")?.parents).toEqual([
      { repo: "owner/root", relation: "finetune" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(lineage.truncated).toBe(false);
  });

  it("reuses a fresh public lineage snapshot without a network request", async () => {
    const parentCommit = "4".repeat(40);
    const rawJson = JSON.stringify({
      sha: parentCommit,
      private: false,
      gated: false,
      baseModels: { relation: "quantized", models: [] },
    });
    const catalog: HuggingFaceCatalog = {
      persistent: true,
      get: async () => undefined,
      getLineage: async () => ({
        repo: "base/cached",
        commit: parentCommit,
        fetchedAt: new Date().toISOString(),
        rawJson,
      }),
      put: async () => undefined,
      status: async () => ({ persistent: true, entries: 1, bytes: rawJson.length }),
    };
    const fetcher = vi.fn();

    const lineage = await fetchHuggingFaceLineage(
      {
        repo: "owner/root",
        commit,
        parents: [{ repo: "base/cached", relation: "quantized" }],
      },
      { fetcher: fetcher as typeof fetch, catalog },
    );

    expect(lineage.cacheHits).toBe(1);
    expect(lineage.nodes[1]).toMatchObject({
      repo: "base/cached",
      commit: parentCommit,
      status: "resolved",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not traverse a restricted parent returned by the public endpoint", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        sha: "4".repeat(40),
        private: false,
        gated: "manual",
        baseModels: {
          relation: "finetune",
          models: [{ id: "restricted/grandparent" }],
        },
      }),
    );

    const lineage = await fetchHuggingFaceLineage(
      {
        repo: "owner/root",
        commit,
        parents: [{ repo: "restricted/parent", relation: "quantized" }],
      },
      { fetcher: fetcher as typeof fetch },
    );

    expect(lineage.nodes[1]).toEqual({
      repo: "restricted/parent",
      parents: [],
      status: "access-required",
    });
    expect(lineage.nodes.some((node) => node.repo === "restricted/grandparent")).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an oversized but valid lineage snapshot before parsing it", async () => {
    const parentCommit = "5".repeat(40);
    const rawJson = JSON.stringify({
      sha: parentCommit,
      private: false,
      gated: false,
      baseModels: { relation: "quantized", models: [] },
      padding: "x".repeat(300 * 1024),
    });
    const catalog: HuggingFaceCatalog = {
      persistent: true,
      get: async () => undefined,
      getLineage: async () => ({
        repo: "base/oversized",
        commit: parentCommit,
        fetchedAt: new Date().toISOString(),
        rawJson,
      }),
      put: async () => undefined,
      status: async () => ({ persistent: true, entries: 1, bytes: rawJson.length }),
    };
    const fetcher = vi.fn(async () =>
      Response.json({
        sha: parentCommit,
        private: false,
        gated: false,
        baseModels: { relation: "quantized", models: [] },
      }),
    );

    const lineage = await fetchHuggingFaceLineage(
      {
        repo: "owner/root",
        commit,
        parents: [{ repo: "base/oversized", relation: "quantized" }],
      },
      { fetcher: fetcher as typeof fetch, catalog },
    );

    expect(lineage.cacheHits).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("propagates cancellation while reading lineage metadata", async () => {
    const controller = new AbortController();
    let responseStarted = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          responseStarted = true;
          stream.enqueue(new TextEncoder().encode("{"));
          init?.signal?.addEventListener(
            "abort",
            () => stream.error(new DOMException("stopped", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const pending = fetchHuggingFaceLineage(
      {
        repo: "owner/root",
        commit,
        parents: [{ repo: "base/slow", relation: "quantized" }],
      },
      { fetcher: fetcher as typeof fetch, signal: controller.signal },
    );
    await vi.waitFor(() => expect(responseStarted).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("walks ancestry beyond eight levels and stops only at the node budget", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const repo = decodeURIComponent(url.pathname.slice("/api/models/".length));
      const index = Number(repo.split("-").at(-1));
      return Response.json({
        sha: (index + 1).toString(16).padStart(40, "0"),
        private: false,
        gated: false,
        baseModels: {
          relation: "finetune",
          models: [{ id: `base/model-${index + 1}` }],
        },
      });
    });

    const lineage = await fetchHuggingFaceLineage(
      {
        repo: "owner/root",
        commit,
        parents: [{ repo: "base/model-0", relation: "finetune" }],
      },
      { fetcher: fetcher as typeof fetch },
    );

    expect(lineage.nodes.length).toBeLessThanOrEqual(32);
    expect(lineage.truncated).toBe(true);
    expect(lineage.nodes.at(-1)).toMatchObject({
      repo: "base/model-30",
      parents: [{ repo: "base/model-31", relation: "finetune" }],
      status: "resolved",
    });
    expect(fetcher).toHaveBeenCalledTimes(31);
  });
});

describe("discovery metadata normalization", () => {
  it.each([
    ["TQ1_0", 1],
    ["IQ2_XXS", 2],
    ["Q3_K_M", 3],
    ["MXFP4", 4],
    ["Q5_K_S", 5],
    ["Q6_K", 6],
    ["Q8_0", 8],
    ["F16", 16],
    ["BF16", 16],
    ["F32", 32],
    ["GGUF", undefined],
    ["Q4ish", undefined],
  ] as const)("maps %s to nominal %s-bit metadata", (label, bits) => {
    expect(quantizationBitLevel(label)).toBe(bits);
  });

  it("keeps declared context, capabilities, and immediate lineage with provenance", () => {
    const repository = parseModelInfo(
      {
        sha: commit,
        author: "publisher",
        library_name: "transformers",
        gated: false,
        pipeline_tag: "any-to-any",
        tags: ["gguf", "reasoning", "tool-calling", "image-text-to-text", "license:apache-2.0"],
        baseModels: {
          relation: "quantized",
          models: [{ id: "base/model" }],
        },
        gguf: { architecture: "gemma4", context_length: 131_072 },
        siblings: [
          {
            rfilename: "model-Q4_K_M.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      },
      { repo: "owner/model", revision: commit },
    );
    expect(repository.metadata).toMatchObject({
      author: "publisher",
      library: "transformers",
      architecture: "gemma4",
      contextLength: 131_072,
      baseModels: [{ repo: "base/model", relation: "quantized" }],
      declaredCapabilities: expect.arrayContaining([
        "thinking",
        "text-generation",
        "tool-calling",
        "image-input",
      ]),
    });
  });

  it("bounds tag lineage, rejects conflicting parent sources, and keeps generic multimodal evidence unknown", () => {
    const siblings = [
      {
        rfilename: "model-Q4_K_M.gguf",
        size: 10,
        lfs: { size: 10, sha256 },
      },
    ];
    const bounded = parseModelInfo(
      {
        sha: commit,
        gated: false,
        tags: Array.from({ length: 17 }, (_, index) => `base_model:base/model-${index}`),
        siblings,
      },
      { repo: "owner/model", revision: commit },
    );
    expect(bounded.metadata.baseModels).toHaveLength(16);

    const conflicting = parseModelInfo(
      {
        sha: commit,
        gated: false,
        pipeline_tag: "text-to-speech",
        tags: ["multimodal", "base_model:base/tagged"],
        baseModels: { relation: "quantized", models: [{ id: "base/structured" }] },
        cardData: { base_model: "base/card" },
        siblings,
      },
      { repo: "owner/model", revision: commit },
    );
    expect(conflicting.metadata.baseModels).toBeUndefined();
    expect(conflicting.metadata.declaredCapabilities).toEqual(["text-to-speech"]);

    const relationConflict = parseModelInfo(
      {
        sha: commit,
        gated: false,
        baseModels: { relation: "quantized", models: [{ id: "base/shared" }] },
        cardData: { base_model: "base/shared", base_model_relation: "finetune" },
        siblings,
      },
      { repo: "owner/model", revision: commit },
    );
    expect(relationConflict.metadata.baseModels).toBeUndefined();
  });
});

describe("Hugging Face metadata", () => {
  it("uses a finite jittered retry budget for HTTP 429", async () => {
    let requests = 0;
    let guardedAttempts = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const response = await fetchWith429Backoff(
      async () => {
        requests += 1;
        return new Response(null, { status: requests < 4 ? 429 : 200 });
      },
      "https://huggingface.co/api/models/owner/model",
      {},
      {
        random: () => 0.5,
        sleep: async () => undefined,
        onRetry: (retry) => retries.push(retry),
        runAttempt: async (request) => {
          guardedAttempts += 1;
          return await request();
        },
      },
    );
    expect(response.status).toBe(200);
    expect(requests).toBe(4);
    expect(guardedAttempts).toBe(4);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 250 },
      { attempt: 2, delayMs: 500 },
      { attempt: 3, delayMs: 1_000 },
    ]);

    requests = 0;
    const exhausted = await fetchWith429Backoff(
      async () => {
        requests += 1;
        return new Response(null, { status: 429 });
      },
      "https://huggingface.co/api/models/owner/model",
      {},
      { retries: 2, random: () => 0, sleep: async () => undefined },
    );
    expect(exhausted.status).toBe(429);
    expect(requests).toBe(3);
  });

  it("honors both Retry-After forms and caps their delay", async () => {
    const now = Date.parse("2026-07-19T12:00:00Z");
    for (const [header, expectedDelay] of [
      ["45", 30_000],
      ["Sun, 19 Jul 2026 12:00:45 GMT", 30_000],
      ["Sun, 19 Jul 2026 11:59:00 GMT", 0],
    ] as const) {
      const delays: number[] = [];
      let requests = 0;
      const response = await fetchWith429Backoff(
        async () => {
          requests += 1;
          return new Response(null, {
            status: requests === 1 ? 429 : 200,
            headers: { "Retry-After": header },
          });
        },
        "https://huggingface.co/api/models/owner/model",
        {},
        {
          now: () => now,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      );
      expect(response.status).toBe(200);
      expect(delays).toEqual([expectedDelay]);
    }
  });

  it("does not publish a stale retry after cancellation during response cleanup", async () => {
    const controller = new AbortController();
    let releaseCancel: (() => void) | undefined;
    const onRetry = vi.fn();
    const response = new Response(
      new ReadableStream({
        cancel: async () =>
          await new Promise<void>((resolve) => {
            releaseCancel = resolve;
          }),
      }),
      { status: 429 },
    );
    const pending = fetchWith429Backoff(
      async () => response,
      "https://huggingface.co/api/models",
      { signal: controller.signal },
      { signal: controller.signal, onRetry },
    );
    await vi.waitFor(() => expect(releaseCancel).toBeTypeOf("function"));
    controller.abort();
    releaseCancel?.();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "0.5", "-1"])(
    'falls back to jitter for malformed Retry-After value "%s"',
    async (header) => {
      const delays: number[] = [];
      let requests = 0;
      await fetchWith429Backoff(
        async () => {
          requests += 1;
          return new Response(null, {
            status: requests === 1 ? 429 : 200,
            headers: { "Retry-After": header },
          });
        },
        "https://huggingface.co/api/models/owner/model",
        {},
        {
          random: () => 0.5,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      );
      expect(delays).toEqual([250]);
    },
  );

  it("groups a complete shard set and keeps per-shard integrity", () => {
    const choices = groupGgufChoices([
      lfsFile("model-Q4_K_M-00002-of-00002.gguf", 20),
      lfsFile("model-Q8_0.gguf", 50),
      lfsFile("model-Q4_K_M-00001-of-00002.gguf", 10),
    ]);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({ quantization: "Q4_K_M", totalSize: 30 });
    expect(choices[0]?.files.map((file) => file.path)).toEqual([
      "model-Q4_K_M-00001-of-00002.gguf",
      "model-Q4_K_M-00002-of-00002.gguf",
    ]);
  });

  it.each(["TQ1_0", "TQ2_0", "MXFP4", "F16", "BF16", "F32"])(
    'recognizes current GGUF quantization hint "%s"',
    (quantization) => {
      expect(groupGgufChoices([lfsFile(`model-${quantization}.gguf`)])[0]?.quantization).toBe(
        quantization,
      );
    },
  );

  it("treats a one-of-one shard as a single artifact", () => {
    const choices = groupGgufChoices([lfsFile("model-Q4_K_M-00001-of-00001.gguf", 20)]);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ quantization: "Q4_K_M", totalSize: 20 });
  });

  it("keeps llama.cpp sidecars out of primary choices and pairs the closest same-directory MTP", () => {
    const choices = groupGgufChoices([
      lfsFile("model-Q4_K_XL.gguf", 100),
      lfsFile("mtp-model-Q8_0.gguf", 20),
      lfsFile("mtp-model-Q4_0.gguf", 10),
      lfsFile("MTP/mtp-model-Q4_0.gguf", 10),
      lfsFile("mmproj-F16.gguf", 30),
    ]);

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      label: "model-Q4_K_XL.gguf",
      optionalMtp: { path: "mtp-model-Q4_0.gguf", size: 10 },
    });
  });

  it("keeps discovered choices inside worker protocol file and quantization bounds", () => {
    const longHint = `Q4_${"A".repeat(200)}`;
    expect(groupGgufChoices([lfsFile(`model-${longHint}.gguf`)])[0]?.quantization).toBe("GGUF");

    const shard = (index: number, count: number) =>
      lfsFile(
        `model-Q4_0-${index.toString().padStart(5, "0")}-of-${count
          .toString()
          .padStart(5, "0")}.gguf`,
      );
    expect(() =>
      groupGgufChoices(
        Array.from({ length: maximumArtifactChoiceFiles + 1 }, (_, index) =>
          shard(index + 1, maximumArtifactChoiceFiles + 1),
        ),
      ),
    ).toThrow(/at most 256 files/u);

    const maximumChoice = groupGgufChoices([
      ...Array.from({ length: maximumArtifactChoiceFiles }, (_, index) =>
        shard(index + 1, maximumArtifactChoiceFiles),
      ),
      lfsFile("mtp-model-Q4_0.gguf"),
    ])[0];
    expect(maximumChoice?.files).toHaveLength(maximumArtifactChoiceFiles);
    expect(maximumChoice?.optionalMtp).toBeUndefined();
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/resolved",
        requestId: "bounded-choice",
        repository: {
          repo: "owner/model",
          requestedRevision: commit,
          commit,
          choices: [maximumChoice],
          metadata: { gating: "open" },
        },
      }),
    ).toBeDefined();

    const choiceWithMtp = groupGgufChoices([
      ...Array.from({ length: maximumArtifactChoiceFiles - 1 }, (_, index) =>
        shard(index + 1, maximumArtifactChoiceFiles - 1),
      ),
      lfsFile("mtp-model-Q4_0.gguf"),
    ])[0];
    expect(choiceWithMtp?.optionalMtp).toBeDefined();
    expect((choiceWithMtp?.files.length ?? 0) + 1).toBe(maximumArtifactChoiceFiles);
  });

  it("fails closed on incomplete shards and non-LFS GGUF weights", () => {
    expect(() => groupGgufChoices([lfsFile("model-Q4_0-00001-of-00002.gguf")])).toThrow(
      /incomplete/u,
    );
    expect(() =>
      groupGgufChoices([
        {
          path: "model-Q4_0.gguf",
          size: 10,
          integrity: { kind: "git-blob-sha1", digest: "c".repeat(40) },
        },
      ]),
    ).toThrow(/LFS SHA-256/u);
  });

  it("normalizes only the LFS payload hash from bounded model info", () => {
    const parsed = parseModelInfo(
      {
        sha: commit,
        siblings: [
          {
            rfilename: "model-Q4_0.gguf",
            size: 10,
            blobId: "c".repeat(40),
            lfs: { size: 10, sha256, pointerSize: 130 },
          },
        ],
      },
      { repo: "owner/model", revision: "main" },
    );
    expect(parsed.choices[0]?.files[0]?.integrity).toEqual({ kind: "lfs-sha256", digest: sha256 });
  });

  it("skips malformed non-GGUF companions without hiding valid weights", () => {
    const parsed = parseModelInfo(
      {
        sha: commit,
        siblings: [
          { rfilename: "README.md", size: "unknown" },
          { not_a_filename: true },
          {
            rfilename: "model-Q4_0.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      },
      { repo: "owner/model", revision: "main" },
    );
    expect(parsed.choices.map((choice) => choice.label)).toEqual(["model-Q4_0.gguf"]);
  });

  it("requires a commit-pinned request to resolve to that exact commit", () => {
    expect(() =>
      parseModelInfo(
        {
          sha: "c".repeat(40),
          siblings: [
            {
              rfilename: "model-Q4_0.gguf",
              size: 10,
              lfs: { size: 10, sha256 },
            },
          ],
        },
        { repo: "owner/model", revision: commit },
      ),
    ).toThrow(/different commit/u);
  });

  it("surfaces a bounded custom license name instead of the generic other tag", () => {
    const parsed = parseModelInfo(
      {
        sha: commit,
        tags: ["gguf", "license:other"],
        cardData: { license_name: "krea-2-community-license" },
        siblings: [
          {
            rfilename: "model-Q4_0.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      },
      { repo: "owner/model", revision: "main" },
    );
    expect(parsed.metadata.license).toBe("krea-2-community-license");
  });

  it.each([
    { sha: "mutable", siblings: [] },
    { sha: commit, siblings: [{ rfilename: "../bad.gguf", size: 10, lfs: { size: 10, sha256 } }] },
    { sha: commit, siblings: [{ rfilename: "model.gguf", size: 10, lfs: { size: 11, sha256 } }] },
    {
      sha: commit,
      siblings: [
        {
          rfilename: "model.gguf",
          size: Number.MAX_SAFE_INTEGER + 1,
          lfs: { size: Number.MAX_SAFE_INTEGER + 1, sha256 },
        },
      ],
    },
    {
      sha: commit,
      siblings: [
        { rfilename: "model.gguf", size: 10, lfs: { size: 10, sha256 } },
        { rfilename: "model.gguf", size: 10, lfs: { size: 10, sha256 } },
      ],
    },
  ])("rejects hostile model metadata %#", (value) => {
    expect(() => parseModelInfo(value, { repo: "owner/model", revision: "main" })).toThrow();
  });
});

describe("Hugging Face discovery", () => {
  it("reports anonymous search authorization failures as unsupported access", async () => {
    await expect(
      browseHuggingFaceModels(
        { query: "denied", format: "gguf" },
        { fetcher: (async () => new Response(null, { status: 403 })) as typeof fetch },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "input-invalid",
        retryable: false,
        message: expect.stringContaining("only public models"),
      },
    });
  });

  it("treats an oversized catalog snapshot as a cache miss before JSON parsing", async () => {
    const oversizedCommit = "9".repeat(40);
    const catalog: HuggingFaceCatalog = {
      persistent: true,
      get: async () => ({
        repo: "owner/oversized",
        commit: oversizedCommit,
        fetchedAt: new Date(0).toISOString(),
        rawJson: JSON.stringify({
          sha: oversizedCommit,
          private: false,
          gated: false,
          tags: ["gguf"],
          siblings: [],
          padding: "x".repeat(maximumCatalogSnapshotBytes + 1),
        }),
      }),
      put: async () => undefined,
      status: async () => ({ persistent: true, entries: 1, bytes: 1 }),
    };
    let revisionRequests = 0;
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/revision/")) {
        revisionRequests += 1;
        return Response.json({
          sha: oversizedCommit,
          private: false,
          gated: false,
          tags: ["gguf"],
          siblings: [
            {
              rfilename: "model-Q4_K_M.gguf",
              size: 10,
              lfs: { size: 10, sha256 },
            },
          ],
        });
      }
      return Response.json([
        { id: "owner/oversized", sha: oversizedCommit, gated: false, tags: ["gguf"] },
      ]);
    };

    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf" },
      { fetcher: fetcher as typeof fetch, catalog },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.cacheHits).toBe(0);
    expect(revisionRequests).toBe(1);
  });

  it("excludes known gated candidates without enrichment or cache access", async () => {
    const put = vi.fn();
    const get = vi.fn();
    const catalog: HuggingFaceCatalog = {
      persistent: true,
      get,
      put,
      status: async () => ({ persistent: true, entries: 0, bytes: 0 }),
    };
    let revisionRequests = 0;
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/revision/")) {
        revisionRequests += 1;
        throw new Error("A known gated candidate must not be enriched");
      }
      return Response.json([{ id: "owner/model", sha: commit, gated: "manual", tags: ["gguf"] }]);
    };

    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf", capabilities: [], quantizationBits: [] },
      { fetcher: fetcher as typeof fetch, catalog },
    );
    expect(result.matches).toHaveLength(0);
    expect(result.excludedCandidates).toBe(1);
    expect(revisionRequests).toBe(0);
    expect(result.cacheHits).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("ANDs declared capabilities, applies context thresholds, and preserves unknown evidence", async () => {
    const run = async (suffix: string, tags: string[], contextLength: number | undefined) => {
      const pinnedCommit = suffix.repeat(40);
      const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes("/revision/")) {
          return Response.json({
            sha: pinnedCommit,
            private: false,
            gated: false,
            pipeline_tag: "text-generation",
            tags: ["gguf", ...tags],
            ...(contextLength === undefined
              ? {}
              : { gguf: { architecture: "llama", context_length: contextLength } }),
            siblings: [
              {
                rfilename: "model-Q4_K_M.gguf",
                size: 10,
                lfs: { size: 10, sha256 },
              },
            ],
          });
        }
        return Response.json([
          { id: `owner/model-${suffix}`, sha: pinnedCommit, gated: false, tags: ["gguf"] },
        ]);
      };
      return await browseHuggingFaceModels(
        {
          query: "",
          format: "gguf",
          capabilities: ["thinking", "tool-calling"],
          quantizationBits: [4],
          minimumContextTokens: 32_768,
        },
        { fetcher: fetcher as typeof fetch },
      );
    };

    const confirmed = await run("a", ["reasoning", "tool-calling"], 32_768);
    expect(confirmed.matches).toHaveLength(1);
    expect(confirmed.needsVerification).toEqual([]);

    const missingCapability = await run("c", ["reasoning"], 32_768);
    expect(missingCapability.matches).toEqual([]);
    expect(missingCapability.needsVerification).toHaveLength(1);
    expect(missingCapability.excludedCandidates).toBe(0);

    const belowContext = await run("d", ["reasoning", "tool-calling"], 16_384);
    expect(belowContext.matches).toEqual([]);
    expect(belowContext.needsVerification).toEqual([]);
    expect(belowContext.excludedCandidates).toBe(1);
  });

  it("uses pipeline-task provenance for contradictory primary capability evidence", async () => {
    const run = async (
      suffix: string,
      pipelineTask: string | undefined,
      tags: readonly string[],
    ) => {
      const parakeetCommit = suffix.repeat(40);
      const fetcher = async (input: RequestInfo | URL): Promise<Response> =>
        String(input).includes("/revision/")
          ? Response.json({
              sha: parakeetCommit,
              private: false,
              gated: false,
              ...(pipelineTask === undefined ? {} : { pipeline_tag: pipelineTask }),
              tags: ["gguf", ...tags],
              gguf: { architecture: "parakeet", context_length: 65_536 },
              siblings: [
                {
                  rfilename: "parakeet-Q4_K_M.gguf",
                  size: 10,
                  lfs: { size: 10, sha256 },
                },
              ],
            })
          : Response.json([
              {
                id: `owner/parakeet-${suffix}`,
                sha: parakeetCommit,
                gated: false,
                ...(pipelineTask === undefined ? {} : { pipeline_tag: pipelineTask }),
                tags: ["gguf", ...tags],
              },
            ]);
      return await browseHuggingFaceModels(
        { query: "", format: "gguf", capabilities: ["text-generation"] },
        { fetcher: fetcher as typeof fetch },
      );
    };

    const maskedContradiction = await run("e", "automatic-speech-recognition", [
      "automatic-speech-recognition",
      "text-generation",
    ]);
    expect(maskedContradiction.matches).toEqual([]);
    expect(maskedContradiction.needsVerification).toEqual([]);
    expect(maskedContradiction.excludedCandidates).toBe(1);

    const tagOnly = await run("f", undefined, ["automatic-speech-recognition"]);
    expect(tagOnly.matches).toEqual([]);
    expect(tagOnly.needsVerification).toHaveLength(1);
    expect(tagOnly.excludedCandidates).toBe(0);
  });

  it("progressively enriches pinned candidates until a later page matches client filters", async () => {
    const firstCommit = "1".repeat(40);
    const secondCommit = "2".repeat(40);
    const requests: string[] = [];
    const next =
      "https://huggingface.co/api/models?filter=gguf&pipeline_tag=text-generation&limit=8&cursor=opaque%3D";
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/revision/")) {
        const matching = url.includes(secondCommit);
        return Response.json({
          sha: matching ? secondCommit : firstCommit,
          private: false,
          gated: false,
          pipeline_tag: "text-generation",
          tags: ["gguf", "license:apache-2.0"],
          siblings: [
            {
              rfilename: matching ? "later-Q4_K_M.gguf" : "first-Q8_0.gguf",
              size: matching ? 2 * 1024 ** 3 : 8 * 1024 ** 3,
              lfs: {
                size: matching ? 2 * 1024 ** 3 : 8 * 1024 ** 3,
                sha256,
              },
            },
          ],
        });
      }
      if (url === next) {
        return Response.json([
          {
            id: "owner/later-model",
            sha: secondCommit,
            gated: false,
            downloads: 20,
            tags: ["gguf", "license:apache-2.0"],
            pipeline_tag: "text-generation",
          },
        ]);
      }
      const parsed = new URL(url);
      expect(parsed.searchParams.get("search")).toBe("Qwen");
      expect(parsed.searchParams.get("filter")).toBe("gguf");
      expect(parsed.searchParams.get("pipeline_tag")).toBeNull();
      expect(parsed.searchParams.getAll("expand")).toContain("gated");
      return Response.json(
        [
          {
            id: "owner/first-model",
            sha: firstCommit,
            gated: false,
            tags: ["gguf", "license:mit"],
            pipeline_tag: "text-generation",
          },
        ],
        { headers: { Link: `<${next}>; rel="next"` } },
      );
    };

    const result = await browseHuggingFaceModels(
      {
        query: "Qwen",
        format: "gguf",
        capabilities: ["text-generation"],
        quantizationBits: [4],
        maximumBytes: 4 * 1024 ** 3,
      },
      { fetcher: fetcher as typeof fetch },
    );

    expect(result).toMatchObject({
      inspectedPages: 2,
      inspectedCandidates: 2,
      excludedCandidates: 1,
      matches: [
        {
          repo: "owner/later-model",
          repository: { metadata: { gating: "open", license: "apache-2.0" } },
          matchingChoices: [{ quantization: "Q4_K_M", totalSize: 2 * 1024 ** 3 }],
        },
      ],
    });
    expect(requests.some((url) => url.includes(`/revision/${secondCommit}`))).toBe(true);
  });

  it("excludes a gated listing without requesting restricted details", async () => {
    const gatedCommit = "3".repeat(40);
    const fetcher = async (input: RequestInfo | URL): Promise<Response> =>
      String(input).includes("/revision/")
        ? new Response(null, { status: 401 })
        : Response.json([
            {
              id: "owner/gated-model",
              sha: gatedCommit,
              gated: "manual",
              tags: ["gguf", "license:other"],
            },
          ]);
    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf", quantizationBits: [4] },
      { fetcher: fetcher as typeof fetch },
    );
    expect(result.matches).toEqual([]);
    expect(result.excludedCandidates).toBe(1);
    expect(result.unknown).toEqual([]);
  });

  it("counts a successfully inspected repository with no GGUF choices as excluded", async () => {
    const emptyCommit = "8".repeat(40);
    const fetcher = async (input: RequestInfo | URL): Promise<Response> =>
      String(input).includes("/revision/")
        ? Response.json({
            sha: emptyCommit,
            gated: false,
            tags: ["license:mit"],
            siblings: [{ rfilename: "README.md", size: 10 }],
          })
        : Response.json([
            {
              id: "owner/no-gguf",
              sha: emptyCommit,
              gated: false,
              tags: ["license:mit"],
            },
          ]);
    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf" },
      { fetcher: fetcher as typeof fetch },
    );
    expect(result).toMatchObject({
      matches: [],
      unknown: [],
      inspectedCandidates: 1,
      excludedCandidates: 1,
    });
  });

  it("deduplicates candidates across pages without dropping the fetched page tail", async () => {
    const next = "https://huggingface.co/api/models?cursor=second-page";
    const revisionRequests = new Map<string, number>();
    const candidate = (index: number) => ({
      id: `bounded/model-${index}`,
      sha: (index + 1).toString(16).repeat(40),
      gated: false,
      tags: ["gguf", "license:mit"],
    });
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/revision/")) {
        const match = url.match(/bounded\/model-(\d+)\/revision\/([a-f0-9]{40})/u);
        const index = Number(match?.[1]);
        const resolvedCommit = match?.[2] ?? "0".repeat(40);
        revisionRequests.set(`model-${index}`, (revisionRequests.get(`model-${index}`) ?? 0) + 1);
        return Response.json({
          sha: resolvedCommit,
          private: false,
          gated: false,
          tags: ["gguf", "license:mit"],
          siblings: [
            {
              rfilename: `model-${index}-Q4_0.gguf`,
              size: 10,
              lfs: { size: 10, sha256 },
            },
          ],
        });
      }
      if (url === next)
        return Response.json([
          { ...candidate(0), sha: "f".repeat(40) },
          ...Array.from({ length: 7 }, (_, index) => candidate(index + 7)),
        ]);
      return Response.json(
        Array.from({ length: 7 }, (_, index) => candidate(index)),
        {
          headers: { Link: `<${next}>; rel="next"` },
        },
      );
    };

    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf" },
      { fetcher: fetcher as typeof fetch },
    );
    expect(result.matches).toHaveLength(14);
    expect(new Set(result.matches.map((match) => match.repo)).size).toBe(14);
    expect(revisionRequests.get("model-0")).toBe(1);
  });

  it("returns already-collected candidates when discovery is stopped", async () => {
    const controller = new AbortController();
    const commits = ["2".repeat(40), "3".repeat(40), "4".repeat(40)] as const;
    let enrichmentStarted = false;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.includes("/revision/")) {
        return Response.json(
          commits.map((candidateCommit, index) => ({
            id: "owner/stopped-" + (index + 1),
            sha: candidateCommit,
            gated: false,
            tags: ["gguf"],
          })),
        );
      }
      if (url.includes(commits[2])) {
        enrichmentStarted = true;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("stopped", "AbortError")),
            { once: true },
          );
        });
      }
      const resolvedCommit = commits.find((candidateCommit) => url.includes(candidateCommit));
      return Response.json({
        sha: resolvedCommit,
        private: false,
        gated: false,
        tags: ["gguf"],
        gguf: { architecture: "llama", context_length: 65_536 },
        siblings: [
          {
            rfilename: "model-Q4_K_M.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      });
    };
    const pending = browseHuggingFaceModels(
      { query: "", format: "gguf" },
      { fetcher: fetcher as typeof fetch, signal: controller.signal },
    );
    await vi.waitFor(() => expect(enrichmentStarted).toBe(true));
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      matches: [
        { repo: "owner/stopped-1", commit: commits[0] },
        { repo: "owner/stopped-2", commit: commits[1] },
      ],
      inspectedCandidates: 2,
      inspectedPages: 1,
      truncated: true,
      truncationReason: "stopped",
    });
  });

  it("rejects a server page larger than the requested eight-candidate bound", async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      id: `owner/oversized-${index}`,
      sha: (index + 1).toString(16).repeat(40),
      gated: false,
      tags: ["gguf"],
    }));
    await expect(
      browseHuggingFaceModels(
        { query: "", format: "gguf" },
        { fetcher: (async () => Response.json(candidates)) as typeof fetch },
      ),
    ).rejects.toThrow(/invalid model search page/u);
  });

  it("bounds anonymous enrichment caching with least-recently-used eviction", async () => {
    let selected = 0;
    const revisionRequests = new Map<string, number>();
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (!url.includes("/revision/")) {
        const commit = (selected + 5).toString(16).repeat(40);
        return Response.json([
          { id: `owner/cache-${selected}`, sha: commit, gated: false, tags: ["gguf"] },
        ]);
      }
      const match = url.match(/owner\/cache-(\d+)\/revision\//u);
      const index = Number(match?.[1]);
      revisionRequests.set(`cache-${index}`, (revisionRequests.get(`cache-${index}`) ?? 0) + 1);
      const commit = (index + 5).toString(16).repeat(40);
      return Response.json({
        sha: commit,
        private: false,
        gated: false,
        tags: ["gguf", "license:mit"],
        siblings: [
          {
            rfilename: `cache-${index}-Q4_0.gguf`,
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      });
    };
    for (selected = 0; selected < 9; selected += 1) {
      await browseHuggingFaceModels(
        { query: `cache-${selected}`, format: "gguf" },
        { fetcher: fetcher as typeof fetch },
      );
    }
    selected = 0;
    await browseHuggingFaceModels(
      { query: "cache-0", format: "gguf" },
      { fetcher: fetcher as typeof fetch },
    );
    expect(revisionRequests.get("cache-0")).toBe(2);
  });

  it("reuses public enrichment cache when filters are refined", async () => {
    const cacheCommit = "e".repeat(40);
    let revisionRequests = 0;
    const revisionAuthorizations: Array<string | null> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes("/revision/"))
        return Response.json([
          { id: "owner/cache-hit", sha: cacheCommit, gated: false, tags: ["gguf"] },
        ]);
      revisionRequests += 1;
      revisionAuthorizations.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({
        sha: cacheCommit,
        private: false,
        gated: false,
        pipeline_tag: "text-generation",
        tags: ["gguf", "license:mit"],
        siblings: [
          {
            rfilename: "cache-hit-Q4_0.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      });
    };
    const first = await browseHuggingFaceModels(
      { query: "cache-hit", format: "gguf" },
      { fetcher: fetcher as typeof fetch },
    );
    const refined = await browseHuggingFaceModels(
      { query: "cache-hit", format: "gguf", capabilities: ["text-generation"] },
      { fetcher: fetcher as typeof fetch },
    );
    expect(revisionRequests).toBe(1);
    expect(revisionAuthorizations).toEqual([null]);
    expect(first.cacheHits).toBe(0);
    expect(refined.cacheHits).toBe(1);
  });

  it("excludes pinned gated detail despite a stale open search result", async () => {
    const gatedCommit = "8".repeat(40);
    let revisionRequests = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes("/revision/"))
        return Response.json([
          { id: "owner/stale-open", sha: gatedCommit, gated: false, tags: ["gguf"] },
        ]);
      revisionRequests += 1;
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      return Response.json({
        sha: gatedCommit,
        private: false,
        gated: "manual",
        tags: ["gguf"],
        siblings: [
          {
            rfilename: "stale-open-Q4_0.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      });
    };
    const filters = { query: "stale-open", format: "gguf" } as const;
    const first = await browseHuggingFaceModels(filters, {
      fetcher: fetcher as typeof fetch,
    });
    const second = await browseHuggingFaceModels(filters, {
      fetcher: fetcher as typeof fetch,
    });
    expect(revisionRequests).toBe(2);
    expect(first.cacheHits).toBe(0);
    expect(first.matches).toEqual([]);
    expect(first.excludedCandidates).toBe(1);
    expect(second.cacheHits).toBe(0);
    expect(second.matches).toEqual([]);
    expect(second.excludedCandidates).toBe(1);
  });

  it("bypasses a stale public cache after list access becomes restricted", async () => {
    const mutableCommit = "7".repeat(40);
    let access: "public" | "manual" | "private" = "public";
    let revisionRequests = 0;
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      if (!String(input).includes("/revision/"))
        return Response.json([
          {
            id: "owner/mutable-access",
            sha: mutableCommit,
            private: access === "private",
            gated: access === "manual" ? "manual" : false,
            tags: ["gguf"],
          },
        ]);
      revisionRequests += 1;
      if (access === "private") return new Response(null, { status: 404 });
      return Response.json({
        sha: mutableCommit,
        private: false,
        gated: access === "manual" ? "manual" : false,
        tags: ["gguf"],
        siblings: [
          {
            rfilename: "mutable-access-Q4_0.gguf",
            size: 10,
            lfs: { size: 10, sha256 },
          },
        ],
      });
    };
    const filters = { query: "mutable-access", format: "gguf" } as const;
    const initial = await browseHuggingFaceModels(filters, {
      fetcher: fetcher as typeof fetch,
    });
    expect(initial.matches[0]?.repository.metadata.gating).toBe("open");

    access = "manual";
    const gated = await browseHuggingFaceModels(filters, {
      fetcher: fetcher as typeof fetch,
    });
    expect(gated.cacheHits).toBe(0);
    expect(gated.matches).toEqual([]);
    expect(gated.excludedCandidates).toBe(1);

    access = "private";
    const privateResult = await browseHuggingFaceModels(filters, {
      fetcher: fetcher as typeof fetch,
    });
    expect(revisionRequests).toBe(1);
    expect(privateResult.cacheHits).toBe(0);
    expect(privateResult.matches).toEqual([]);
    expect(privateResult.excludedCandidates).toBe(1);
  });

  it("accepts only bounded same-origin opaque model cursors", () => {
    expect(
      parseHuggingFaceNextLink(
        '<https://huggingface.co/api/models?cursor=opaque%3D%3D>; rel="next"',
      ),
    ).toBe("https://huggingface.co/api/models?cursor=opaque%3D%3D");
    expect(
      parseHuggingFaceNextLink(
        '<https://huggingface.co/api/models?cursor=rel-list>; rel="prev next prefetch"',
      ),
    ).toBe("https://huggingface.co/api/models?cursor=rel-list");
    for (const link of [
      '<http://huggingface.co/api/models?cursor=x>; rel="next"',
      '<https://evil.example/api/models?cursor=x>; rel="next"',
      '<https://user:secret@huggingface.co/api/models?cursor=x>; rel="next"',
      '<https://huggingface.co/api/datasets?cursor=x>; rel="next"',
      '<https://huggingface.co/api/models?cursor=x#fragment>; rel="next"',
    ]) {
      expect(() => parseHuggingFaceNextLink(link)).toThrow();
    }
  });

  it("validates filters before requesting discovery results", async () => {
    await expect(
      browseHuggingFaceModels(
        { query: "", format: "gguf", quantizationBits: [42] } as unknown as Parameters<
          typeof browseHuggingFaceModels
        >[0],
        { fetcher: (async () => Response.json([])) as typeof fetch },
      ),
    ).rejects.toMatchObject({ failure: { code: "input-invalid" } });
  });

  it("automatically follows pages until the raised safety boundary", async () => {
    let searchPage = 0;
    const progress: { inspectedCandidates: number; inspectedPages: number }[] = [];
    const nextUrls = Array.from(
      { length: maximumBrowsePages },
      (_, index) => `https://huggingface.co/api/models?cursor=page-${index + 2}`,
    );
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/revision/")) {
        const commitMatch = url.match(/revision\/([a-f0-9]{40})/u);
        const pinnedCommit = commitMatch?.[1] ?? "0".repeat(40);
        return Response.json({
          sha: pinnedCommit,
          gated: false,
          tags: ["gguf"],
          siblings: [
            {
              rfilename: "model-Q8_0.gguf",
              size: 10,
              lfs: { size: 10, sha256 },
            },
          ],
        });
      }
      const index = searchPage;
      searchPage += 1;
      return Response.json(
        Array.from({ length: 8 }, (_, candidateIndex) => {
          const identity = index * 8 + candidateIndex + 1;
          return {
            id: `owner/page-${identity}`,
            sha: identity.toString(16).padStart(40, "0"),
            gated: false,
            tags: ["gguf"],
          };
        }),
        { headers: { Link: `<${nextUrls[index]}>; rel="next"` } },
      );
    };
    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf", quantizationBits: [4] },
      {
        fetcher: fetcher as typeof fetch,
        onProgress: (update) => progress.push(update),
      },
    );
    expect(result).toMatchObject({
      inspectedPages: maximumBrowsePages,
      inspectedCandidates: maximumBrowseCandidates,
      excludedCandidates: maximumBrowseCandidates,
      truncated: true,
    });
    expect(progress).toHaveLength(maximumBrowseCandidates / 2);
    expect(progress.at(-1)).toEqual({
      inspectedCandidates: maximumBrowseCandidates,
      inspectedPages: maximumBrowsePages,
    });
  });

  it("stops before retained browse records exceed the aggregate result budget", async () => {
    let searchPage = 0;
    const siblings = Array.from({ length: 64 }, (_, index) => ({
      rfilename: `${"x".repeat(900)}-${index}-Q4_0.gguf`,
      size: 10,
      lfs: { size: 10, sha256 },
    }));
    const catalog: HuggingFaceCatalog = {
      persistent: true,
      get: async (repo, cachedCommit) => ({
        repo,
        commit: cachedCommit,
        fetchedAt: new Date(0).toISOString(),
        rawJson: JSON.stringify({
          sha: cachedCommit,
          private: false,
          gated: false,
          tags: ["gguf"],
          siblings,
        }),
      }),
      put: async () => undefined,
      status: async () => ({ persistent: true, entries: 512, bytes: 32 * 1024 * 1024 }),
    };
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/revision/")) throw new Error("Expected catalog-backed enrichment");
      const page = searchPage;
      searchPage += 1;
      return Response.json(
        Array.from({ length: 8 }, (_, candidateIndex) => {
          const identity = page * 8 + candidateIndex + 1;
          return {
            id: `owner/large-${identity}`,
            sha: identity.toString(16).padStart(40, "0"),
            gated: false,
            tags: ["gguf"],
          };
        }),
        {
          headers: {
            Link: `<https://huggingface.co/api/models?cursor=large-${page + 2}>; rel="next"`,
          },
        },
      );
    };

    const result = await browseHuggingFaceModels(
      { query: "", format: "gguf" },
      { fetcher: fetcher as typeof fetch, catalog },
    );
    const retainedBytes = [
      ...result.matches,
      ...result.needsVerification,
      ...result.unknown,
    ].reduce((total, item) => total + new TextEncoder().encode(JSON.stringify(item)).byteLength, 0);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("result-budget");
    expect(result.inspectedCandidates).toBeLessThan(maximumBrowseCandidates);
    expect(result.cacheHits).toBe(result.inspectedCandidates);
    expect(retainedBytes).toBeLessThanOrEqual(maximumBrowseResultBytes);
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/browse-result",
        requestId: "budget-cache-hit",
        result,
      }),
    ).toBeDefined();
  });

  it("reports HTTP 403 as an unsupported restricted repository", async () => {
    await expect(
      resolveHuggingFaceModel(
        "owner/gated",
        (async () => new Response(null, { status: 403 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "input-invalid",
        retryable: false,
        message: expect.stringMatching(/only public, ungated/u),
      },
    });
  });

  it("requires pinned metadata to explicitly confirm public access", async () => {
    await expect(
      resolveHuggingFaceModel("owner/ambiguous", (async () =>
        Response.json({
          sha: commit,
          gated: false,
          siblings: [
            {
              rfilename: "model-Q4_0.gguf",
              size: 10,
              lfs: { size: 10, sha256 },
            },
          ],
        })) as typeof fetch),
    ).rejects.toMatchObject({
      failure: {
        code: "unsupported",
        retryable: false,
        message: expect.stringMatching(/only public, ungated/u),
      },
    });
  });
});

describe("range response validation", () => {
  it("accepts only the exact requested interval and pinned total", () => {
    const response = new Response(new Uint8Array(5), {
      status: 206,
      headers: { "Content-Range": "bytes 5-9/10", "Content-Length": "5" },
    });
    expect(validateRangeResponse(response, 5, 10)).toEqual({
      start: 5,
      end: 9,
      total: 10,
      length: 5,
    });
  });

  it.each([
    [200, "bytes 5-9/10", "5"],
    [206, null, "5"],
    [206, "bytes 4-9/10", "6"],
    [206, "bytes 5-9/11", "5"],
    [206, "bytes 5-10/10", "6"],
    [206, "bytes 9-5/10", "-3"],
    [206, "bytes 5-9/10", "4"],
    [416, "bytes */10", "0"],
  ])("rejects status/range mismatch %#", (status, range, length) => {
    const headers = new Headers({ "Content-Length": length as string });
    if (range !== null) headers.set("Content-Range", range as string);
    const response = new Response(null, { status: status as number, headers });
    expect(() => validateRangeResponse(response, 5, 10)).toThrow();
  });
});
