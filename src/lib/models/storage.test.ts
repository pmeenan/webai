import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteModel,
  discardAcquisitionJob,
  DurableFileWriter,
  getStoredFile,
  installModel,
  promotePartialFile,
  putJob,
  reconcileModelInventory,
  requestStoragePersistence,
} from "./storage";
import type { DownloadJobRecord, InstalledModelRecord } from "./types";
import { modelSchemaVersion } from "./types";

function modelFixture(id: string, sha256: string): InstalledModelRecord {
  return {
    schemaVersion: modelSchemaVersion,
    id,
    displayName: "Storage fixture",
    createdAt: new Date().toISOString(),
    totalSize: 4,
    state: "installed",
    source: {
      kind: "local-import",
      filenames: ["fixture.gguf"],
      lastModified: [0],
      sha256: [sha256],
    },
    files: [
      {
        blobId: `sha256:${sha256}`,
        displayName: "fixture.gguf",
        size: 4,
        sha256,
        opfsPath: `blobs/${sha256}`,
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
  };
}

function downloadJobFixture(id: string): DownloadJobRecord {
  const now = new Date().toISOString();
  const source = {
    path: "fixture.gguf",
    size: 4,
    integrity: { kind: "lfs-sha256" as const, digest: "a".repeat(64) },
  };
  return {
    schemaVersion: modelSchemaVersion,
    id,
    displayName: "Download fixture",
    createdAt: now,
    updatedAt: now,
    state: "paused",
    source: {
      kind: "hugging-face",
      repo: "owner/model",
      requestedRevision: "main",
      commit: "b".repeat(40),
      files: [source],
    },
    files: [
      {
        source,
        partialPath: `partials/${id}/0.part`,
        durableBytes: 4,
        phase: "downloading",
      },
    ],
  };
}

async function writeFixture(path: string): Promise<void> {
  await writeBytes(path, Uint8Array.from([1, 2, 3, 4]));
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  const writer = await DurableFileWriter.open(path);
  await writer.write(0, bytes);
  writer.close();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model storage crash recovery", () => {
  it("keeps deletion recoverable when physical cleanup is interrupted", async () => {
    const id = `delete-${crypto.randomUUID()}`;
    const sha256 = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const model = modelFixture(id, sha256);
    await writeFixture(model.files[0]?.opfsPath ?? "");
    await installModel(model);

    const original = FileSystemDirectoryHandle.prototype.removeEntry;
    let interrupted = false;
    vi.spyOn(FileSystemDirectoryHandle.prototype, "removeEntry").mockImplementation(async function (
      this: FileSystemDirectoryHandle,
      name,
      options,
    ) {
      if (!interrupted && name === sha256) {
        interrupted = true;
        throw new DOMException("injected interruption", "UnknownError");
      }
      return await original.call(this, name, options);
    });
    await deleteModel(id);
    expect(await getStoredFile(`blobs/${sha256}`)).toBeDefined();

    vi.restoreAllMocks();
    const inventory = await reconcileModelInventory();
    expect(inventory.models.some((entry) => entry.id === id)).toBe(false);
    expect(await getStoredFile(`blobs/${sha256}`)).toBeUndefined();
  });

  it("makes repeated install idempotent instead of inflating blob references", async () => {
    const id = `install-${crypto.randomUUID()}`;
    const sha256 = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const model = modelFixture(id, sha256);
    await writeFixture(model.files[0]?.opfsPath ?? "");
    await installModel(model);
    await installModel(model);
    await deleteModel(id);
    expect(await getStoredFile(`blobs/${sha256}`)).toBeUndefined();
  });

  it("does not resurrect a model deleted during reconciliation", async () => {
    const id = `reconcile-${crypto.randomUUID()}`;
    const sha256 = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const model = modelFixture(id, sha256);
    await writeBytes(model.files[0]?.opfsPath ?? "", Uint8Array.from([1, 2, 3]));
    await installModel(model);

    const original = FileSystemFileHandle.prototype.getFile;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(FileSystemFileHandle.prototype, "getFile").mockImplementation(async function (
      this: FileSystemFileHandle,
    ) {
      const file = await original.call(this);
      if (this.name === sha256) {
        reached();
        await held;
      }
      return file;
    });

    const reconciliation = reconcileModelInventory();
    await started;
    await deleteModel(id);
    release();
    const inventory = await reconciliation;
    expect(inventory.models.some((entry) => entry.id === id)).toBe(false);
    vi.restoreAllMocks();
    expect((await reconcileModelInventory()).models.some((entry) => entry.id === id)).toBe(false);
  });

  it("does not resurrect a job discarded during reconciliation", async () => {
    const job = downloadJobFixture(`job-reconcile-${crypto.randomUUID()}`);
    await writeBytes(job.files[0]?.partialPath ?? "", Uint8Array.from([1, 2, 3]));
    await putJob(job);

    const original = FileSystemFileHandle.prototype.getFile;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(FileSystemFileHandle.prototype, "getFile").mockImplementation(async function (
      this: FileSystemFileHandle,
    ) {
      const file = await original.call(this);
      if (this.name === "0.part") {
        reached();
        await held;
      }
      return file;
    });

    const reconciliation = reconcileModelInventory();
    await started;
    await discardAcquisitionJob(job);
    release();
    const inventory = await reconciliation;
    expect(inventory.jobs.some((entry) => entry.id === job.id)).toBe(false);
    vi.restoreAllMocks();
    expect((await reconcileModelInventory()).jobs.some((entry) => entry.id === job.id)).toBe(false);
  });

  it("removes content-addressed blobs that have no manifest or resumable job", async () => {
    const sha256 = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    await writeFixture(`blobs/${sha256}`);
    expect(await getStoredFile(`blobs/${sha256}`)).toBeDefined();
    await reconcileModelInventory();
    expect(await getStoredFile(`blobs/${sha256}`)).toBeUndefined();
  });

  it("replaces a corrupt existing blob with the verified partial", async () => {
    const sha256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
    const finalPath = `blobs/${sha256}`;
    const partialPath = `partials/repair-${crypto.randomUUID()}/0.part`;
    await writeBytes(finalPath, Uint8Array.from([4, 3, 2, 1]));
    await writeFixture(partialPath);
    await promotePartialFile(partialPath, sha256, 4);
    const repaired = await getStoredFile(finalPath);
    if (repaired === undefined) throw new Error("repaired blob missing");
    expect([...new Uint8Array(await repaired.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    await reconcileModelInventory();
  });

  it("degrades one oversized partial without hiding the rest of inventory", async () => {
    const id = `oversized-${crypto.randomUUID()}`;
    const job = downloadJobFixture(id);
    await writeBytes(job.files[0]?.partialPath ?? "", Uint8Array.from([1, 2, 3, 4, 5]));
    await putJob(job);
    const inventory = await reconcileModelInventory();
    const failed = inventory.jobs.find((entry) => entry.id === id);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toMatchObject({ retryable: false });
    await discardAcquisitionJob(failed ?? job);
  });

  it("times out a browser persistence request that never settles", async () => {
    vi.useFakeTimers();
    const original = navigator.storage.persist;
    Object.defineProperty(navigator.storage, "persist", {
      configurable: true,
      value: async () => await new Promise<boolean>(() => undefined),
    });
    const pending = requestStoragePersistence();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).rejects.toThrow(/timed out/u);
    Object.defineProperty(navigator.storage, "persist", { configurable: true, value: original });
  });
});
