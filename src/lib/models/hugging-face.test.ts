import { describe, expect, it } from "vitest";
import {
  fetchWith429Backoff,
  groupGgufChoices,
  parseModelInfo,
  parseModelInput,
  resolverUrl,
  validateRangeResponse,
} from "./hugging-face";
import type { HuggingFaceFile } from "./types";

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

describe("Hugging Face metadata", () => {
  it("uses a finite jittered retry budget for HTTP 429", async () => {
    let requests = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const response = await fetchWith429Backoff(
      async () => {
        requests += 1;
        return new Response(null, { status: requests < 3 ? 429 : 200 });
      },
      "https://huggingface.co/api/models/owner/model",
      {},
      {
        random: () => 0.5,
        sleep: async () => undefined,
        onRetry: (retry) => retries.push(retry),
      },
    );
    expect(response.status).toBe(200);
    expect(requests).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 250 },
      { attempt: 2, delayMs: 500 },
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

  it("treats a one-of-one shard as a single artifact", () => {
    const choices = groupGgufChoices([lfsFile("model-Q4_K_M-00001-of-00001.gguf", 20)]);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ quantization: "Q4_K_M", totalSize: 20 });
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
