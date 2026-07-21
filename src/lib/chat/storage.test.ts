import { afterEach, describe, expect, test } from "vitest";
import {
  deleteConversation,
  exportConversationJson,
  exportConversationMarkdown,
  getConversation,
  importConversationText,
  listConversations,
  maximumChatImportBytes,
  maximumReplayTurns,
  parseConversation,
  putConversation,
} from "./storage";
import { chatSchemaVersion, type ChatConversationRecord } from "./types";
import { openModelDatabase } from "../models/storage";

const createdIds: string[] = [];

function fixture(id = `chat-${crypto.randomUUID()}`): ChatConversationRecord {
  const timestamp = "2026-07-19T12:00:00.000Z";
  return {
    schemaVersion: chatSchemaVersion,
    id,
    title: "Import <script> fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    runtimeId: "wllama",
    adapterVersion: "webai-1",
    engineVersion: "wllama fixture",
    modelId: "model-1",
    modelName: "Fixture",
    modelTarget: {
      kind: "artifact-set",
      modelId: "model-1",
      displayName: "Fixture",
      files: [{ displayName: "fixture.gguf", size: 4, sha256: "a".repeat(64) }],
      source: { kind: "local-import", sha256: ["a".repeat(64)] },
    },
    systemPrompt: "Treat ``` fences and </script> as ordinary text.",
    generation: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      repeatPenalty: 1.1,
      seed: 42,
      thinking: false,
    },
    wllamaSession: { threads: 2, gpuMode: "partial", gpuLayers: 4, contextSize: 8_192 },
    messages: [
      { id: "user-1", runtimeId: "wllama", role: "user", content: "Hello\n```\nworld" },
      {
        id: "assistant-1",
        runtimeId: "wllama",
        role: "assistant",
        content: "<img src=x onerror=alert(1)>",
        request: { temperature: 0.7, seed: 42 },
        controlOutcomes: [
          {
            control: "seed",
            requested: 42,
            effective: 42,
            status: "honored",
            explanation: "Forwarded by the pinned adapter.",
          },
        ],
        tokenization: {
          method: "wllama-sampled-logprobs",
          tokens: [{ id: 7, text: "hello" }],
          omittedTokens: 0,
        },
        metrics: {
          loadTimeMs: 1,
          totalTimeMs: 2,
          promptTokens: 3,
          completionTokens: 1,
          cachedPromptTokens: 2,
          evaluatedPromptTokens: 1,
          contextUsage: 4,
          contextWindow: 8_192,
        },
        execution: {
          runtimeId: "wllama",
          adapterVersion: "webai-1",
          engineVersion: "wllama fixture",
          modelTarget: {
            kind: "artifact-set",
            modelId: "model-1",
            displayName: "Fixture",
            files: [{ displayName: "fixture.gguf", size: 4, sha256: "a".repeat(64) }],
            source: { kind: "local-import", sha256: ["a".repeat(64)] },
          },
          systemPrompt: "Treat ``` fences and </script> as ordinary text.",
          wllamaSession: { threads: 2, gpuMode: "partial", gpuLayers: 4, contextSize: 8_192 },
        },
      },
    ],
  };
}

function replayFixture(): ChatConversationRecord {
  const source = fixture("chat-source");
  const user = source.messages[0];
  const assistant = source.messages[1];
  if (user === undefined || assistant === undefined)
    throw new Error("Fixture messages are missing.");
  return {
    ...source,
    id: "chat-replay",
    title: "Fixture replay",
    messages: [
      { ...user, id: "replayed-user", replaySourceTurnId: "source-turn-1" },
      { ...assistant, id: "replayed-assistant", replaySourceTurnId: "source-turn-1" },
    ],
    replaySeed: {
      sourceConversationId: source.id,
      sourceTitle: source.title,
      capturedAt: source.updatedAt,
      systemPrompt: source.systemPrompt,
      turns: [{ id: "source-turn-1", user, assistant }],
    },
  };
}

afterEach(async () => {
  await Promise.all(createdIds.splice(0).map(async (id) => await deleteConversation(id)));
});

describe("chat conversation persistence and interchange", () => {
  test("round-trips a bounded conversation through JSON and collision-safe Markdown", () => {
    const original = fixture();
    const json = importConversationText(exportConversationJson(original));
    const markdown = importConversationText(exportConversationMarkdown(original));
    const crlfMarkdown = importConversationText(
      exportConversationMarkdown(original).replaceAll("\n", "\r\n"),
    );

    for (const imported of [json, markdown, crlfMarkdown]) {
      expect(imported.id).not.toBe(original.id);
      expect(imported.title).toBe("Import <script> fixture (imported)");
      expect(imported.messages.map((message) => message.content)).toEqual(
        original.messages.map((message) => message.content),
      );
      expect(new Set(imported.messages.map((message) => message.id)).size).toBe(2);
      expect(imported.messages[1]).toMatchObject({
        tokenization: { tokens: [{ id: 7, text: "hello" }] },
        controlOutcomes: [{ control: "seed", effective: 42 }],
        execution: { systemPrompt: "Treat ``` fences and </script> as ordinary text." },
      });
    }
  });

  test("round-trips a portable replay seed and remaps its imported associations", () => {
    const original = replayFixture();
    const imported = importConversationText(exportConversationJson(original));
    const importedTurn = imported.replaySeed?.turns[0];

    expect(importedTurn).toBeDefined();
    expect(importedTurn?.id).not.toBe("source-turn-1");
    expect(importedTurn?.user.id).not.toBe(original.replaySeed?.turns[0]?.user.id);
    expect(importedTurn?.assistant?.id).not.toBe(original.replaySeed?.turns[0]?.assistant?.id);
    expect(imported.messages.map((message) => message.replaySourceTurnId)).toEqual([
      importedTurn?.id,
      importedTurn?.id,
    ]);
    expect(imported.replaySeed).toMatchObject({
      sourceConversationId: "chat-source",
      sourceTitle: "Import <script> fixture",
      systemPrompt: "Treat ``` fences and </script> as ordinary text.",
      turns: [
        {
          user: { content: "Hello\n```\nworld" },
          assistant: { content: "<img src=x onerror=alert(1)>" },
        },
      ],
    });
  });

  test("rejects malformed replay seeds and dangling active associations", () => {
    const record = replayFixture();
    expect(() =>
      parseConversation({
        ...record,
        replaySeed: {
          ...record.replaySeed,
          turns: [record.replaySeed?.turns[0], record.replaySeed?.turns[0]],
        },
      }),
    ).toThrow("turn IDs must be unique");
    expect(() =>
      parseConversation({
        ...record,
        messages: [{ ...record.messages[0], replaySourceTurnId: "missing-turn" }],
      }),
    ).toThrow("missing source turn");
    expect(() =>
      parseConversation({
        ...record,
        messages: [record.messages[0]],
      }),
    ).toThrow("followed by its associated response");
    expect(() =>
      parseConversation({
        ...record,
        messages: [record.messages[0], { ...record.messages[1], replaySourceTurnId: undefined }],
      }),
    ).toThrow("followed by its associated response");
    expect(
      parseConversation({
        ...record,
        messages: [{ ...record.messages[0], content: "Adapted prompt" }, record.messages[1]],
      }).messages[0]?.content,
    ).toBe("Adapted prompt");
    expect(() =>
      parseConversation({
        ...record,
        replaySeed: {
          ...record.replaySeed,
          turns: [
            {
              id: "source-turn-1",
              user: record.replaySeed?.turns[0]?.assistant,
            },
          ],
        },
      }),
    ).toThrow("invalid message roles");
    expect(() =>
      parseConversation({
        ...record,
        messages: [],
        replaySeed: {
          ...record.replaySeed,
          turns: Array.from({ length: maximumReplayTurns + 1 }, (_, index) => ({
            id: `turn-${index}`,
            user: {
              id: `user-${index}`,
              runtimeId: "wllama",
              role: "user",
              content: "Prompt",
            },
          })),
        },
      }),
    ).toThrow("invalid or too large");
  });

  test("rejects future schemas, malformed settings, duplicate IDs, and oversized files", () => {
    expect(() => parseConversation({ ...fixture(), schemaVersion: 2 })).toThrow(
      "unsupported WebAI chat schema",
    );
    expect(() =>
      parseConversation({ ...fixture(), generation: { temperature: Number.POSITIVE_INFINITY } }),
    ).toThrow("finite non-negative");
    const record = fixture();
    expect(() =>
      parseConversation({ ...record, messages: [record.messages[0], record.messages[0]] }),
    ).toThrow("must be unique");
    expect(() => importConversationText("x".repeat(maximumChatImportBytes + 1))).toThrow(
      "8 MiB import limit",
    );
    expect(() =>
      parseConversation({
        ...fixture(),
        wllamaSession: {
          threads: Number.MAX_SAFE_INTEGER,
          gpuMode: "off",
          gpuLayers: 0,
          contextSize: 2_048,
        },
      }),
    ).toThrow("session configuration is invalid");
  });

  test("accepts one local source hash for a split runtime artifact set", () => {
    const record = fixture();
    expect(() =>
      parseConversation({
        ...record,
        modelTarget: {
          ...record.modelTarget,
          files: [
            { displayName: "fixture-00001-of-00002.gguf", size: 2, sha256: "b".repeat(64) },
            { displayName: "fixture-00002-of-00002.gguf", size: 2, sha256: "c".repeat(64) },
          ],
        },
      }),
    ).not.toThrow();
  });

  test("stores, lists, reads, and deletes chats in the additive database store", async () => {
    const record = fixture();
    createdIds.push(record.id);
    await putConversation(record);
    await expect(getConversation(record.id)).resolves.toEqual(record);
    await expect(listConversations()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ id: record.id, messageCount: 2 })],
      skippedRecords: 0,
    });
    await deleteConversation(record.id);
    createdIds.splice(createdIds.indexOf(record.id), 1);
    await expect(getConversation(record.id)).resolves.toBeUndefined();
  });

  test("skips and reports a malformed record without hiding valid history", async () => {
    const record = fixture();
    const malformedId = `chat-malformed-${crypto.randomUUID()}`;
    createdIds.push(record.id, malformedId);
    await putConversation(record);
    const database = await openModelDatabase();
    const transaction = database.transaction("chats", "readwrite");
    transaction.objectStore("chats").put({ id: malformedId, schemaVersion: 99 });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });

    await expect(listConversations()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ id: record.id })],
      skippedRecords: 1,
    });
  });
});
