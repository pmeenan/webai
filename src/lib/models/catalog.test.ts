import { describe, expect, it } from "vitest";
import {
  catalogSchemaNeedsReset,
  MemoryCatalog,
  maximumCatalogSnapshotBytes,
  selectCatalogPruneVictims,
} from "./catalog";
import { modelWorkerProtocolVersion, parseModelWorkerEvent } from "./protocol";

describe("Hugging Face memory catalog fallback", () => {
  it("reuses only the current catalog schema and resets missing or future versions", () => {
    expect(catalogSchemaNeedsReset("2")).toBe(false);
    expect(catalogSchemaNeedsReset(undefined)).toBe(true);
    expect(catalogSchemaNeedsReset("1")).toBe(true);
  });

  it("prunes the shared SQLite row and byte budget in least-recently-used order", () => {
    const rowBound = Array.from({ length: 513 }, (_, index) => ({
      kind: index % 2 === 0 ? ("model" as const) : ("lineage" as const),
      repo: `owner/model-${index}`,
      rawBytes: 1,
      accessedAt: index,
    }));
    expect(selectCatalogPruneVictims(rowBound).map(({ repo }) => repo)).toEqual(["owner/model-0"]);

    const byteBound = Array.from({ length: 9 }, (_, index) => ({
      kind: index % 2 === 0 ? ("model" as const) : ("lineage" as const),
      repo: `owner/large-${index}`,
      rawBytes: maximumCatalogSnapshotBytes,
      accessedAt: index,
    }));
    expect(selectCatalogPruneVictims(byteBound).map(({ repo }) => repo)).toEqual(["owner/large-0"]);
  });
  it("enforces one shared byte-aware LRU across detail and lineage snapshots", async () => {
    const catalog = new MemoryCatalog("test fallback");
    const rawJson = "x".repeat(maximumCatalogSnapshotBytes);
    for (let index = 0; index < 8; index += 1)
      await catalog.put({
        repo: `owner/model-${index}`,
        commit: (index + 1).toString(16).padStart(40, "0"),
        fetchedAt: new Date(0).toISOString(),
        rawJson,
      });
    await catalog.putLineage?.({
      repo: "base/model-0",
      commit: "20".padStart(40, "0"),
      fetchedAt: new Date(0).toISOString(),
      rawJson,
    });
    for (let index = 1; index < 8; index += 1)
      expect(
        await catalog.get(`owner/model-${index}`, (index + 1).toString(16).padStart(40, "0")),
      ).toBeDefined();
    await catalog.putLineage?.({
      repo: "base/model-1",
      commit: "21".padStart(40, "0"),
      fetchedAt: new Date(0).toISOString(),
      rawJson,
    });

    const status = await catalog.status();
    expect(status.entries).toBe(8);
    expect(status.bytes).toBe(64 * 1024 * 1024);
    expect(await catalog.get("owner/model-0", "1".padStart(40, "0"))).toBeUndefined();
    expect(await catalog.get("owner/model-1", "2".padStart(40, "0"))).toBeDefined();
    expect(await catalog.getLineage?.("base/model-0")).toBeUndefined();
    expect(await catalog.getLineage?.("base/model-1")).toBeDefined();
    expect(
      parseModelWorkerEvent({
        protocolVersion: modelWorkerProtocolVersion,
        type: "model/browse-result",
        requestId: "memory-status",
        result: {
          matches: [],
          needsVerification: [],
          unknown: [],
          inspectedCandidates: 0,
          excludedCandidates: 0,
          inspectedPages: 0,
          cacheHits: 0,
          catalog: status,
          truncated: false,
        },
      }),
    ).toBeDefined();
  });
});
