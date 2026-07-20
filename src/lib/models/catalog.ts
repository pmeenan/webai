import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

const catalogPath = "/webai/v1/hugging-face-catalog.sqlite3";
const catalogLockName = "webai-hugging-face-catalog-v1";
const maximumCatalogRows = 512;
const maximumCatalogBytes = 64 * 1024 * 1024;
const catalogSchemaVersion = "2";
export const maximumCatalogSnapshotBytes = 8 * 1024 * 1024;

export interface HuggingFaceCatalogEntry {
  readonly repo: string;
  readonly commit: string;
  readonly fetchedAt: string;
  readonly rawJson: string;
}

export interface HuggingFaceCatalogStatus {
  readonly persistent: boolean;
  readonly entries: number;
  readonly bytes: number;
  readonly reason?: string;
}

export interface HuggingFaceCatalog {
  readonly persistent: boolean;
  get(repo: string, commit: string): Promise<HuggingFaceCatalogEntry | undefined>;
  getLineage?(repo: string): Promise<HuggingFaceCatalogEntry | undefined>;
  putLineage?(entry: HuggingFaceCatalogEntry): Promise<void>;
  put(entry: HuggingFaceCatalogEntry): Promise<void>;
  status(): Promise<HuggingFaceCatalogStatus>;
}

export class MemoryCatalog implements HuggingFaceCatalog {
  readonly persistent = false;
  readonly #entries = new Map<string, HuggingFaceCatalogEntry>();
  readonly #lineage = new Map<string, HuggingFaceCatalogEntry>();
  readonly #lru = new Map<string, { readonly kind: "model" | "lineage"; readonly key: string }>();

  constructor(private readonly reason = "Persistent browser catalog storage is unavailable.") {}

  async get(repo: string, commit: string): Promise<HuggingFaceCatalogEntry | undefined> {
    const key = repo;
    const entry = this.#entries.get(key);
    if (entry?.commit !== commit) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#touch("model", key);
    return entry;
  }

  async put(entry: HuggingFaceCatalogEntry): Promise<void> {
    if (new TextEncoder().encode(entry.rawJson).byteLength > maximumCatalogSnapshotBytes) return;
    const key = entry.repo;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#touch("model", key);
    while (this.#entries.size > 8) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
      this.#lru.delete(`model:${oldest}`);
    }
    this.#prune();
  }

  async getLineage(repo: string): Promise<HuggingFaceCatalogEntry | undefined> {
    const entry = this.#lineage.get(repo);
    if (entry === undefined) return undefined;
    this.#lineage.delete(repo);
    this.#lineage.set(repo, entry);
    this.#touch("lineage", repo);
    return entry;
  }

  async putLineage(entry: HuggingFaceCatalogEntry): Promise<void> {
    if (new TextEncoder().encode(entry.rawJson).byteLength > maximumCatalogSnapshotBytes) return;
    this.#lineage.delete(entry.repo);
    this.#lineage.set(entry.repo, entry);
    this.#touch("lineage", entry.repo);
    while (this.#lineage.size > 32) {
      const oldest = this.#lineage.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#lineage.delete(oldest);
      this.#lru.delete(`lineage:${oldest}`);
    }
    this.#prune();
  }

  #touch(kind: "model" | "lineage", key: string): void {
    const identity = `${kind}:${key}`;
    this.#lru.delete(identity);
    this.#lru.set(identity, { kind, key });
  }

  #prune(): void {
    let bytes = this.#bytes();
    while (
      this.#entries.size + this.#lineage.size > maximumCatalogRows ||
      bytes > maximumCatalogBytes
    ) {
      const oldestIdentity = this.#lru.keys().next().value as string | undefined;
      if (oldestIdentity === undefined) break;
      const oldest = this.#lru.get(oldestIdentity);
      this.#lru.delete(oldestIdentity);
      if (oldest === undefined) continue;
      const entry =
        oldest.kind === "model" ? this.#entries.get(oldest.key) : this.#lineage.get(oldest.key);
      if (oldest.kind === "model") this.#entries.delete(oldest.key);
      else this.#lineage.delete(oldest.key);
      if (entry !== undefined) bytes -= new TextEncoder().encode(entry.rawJson).byteLength;
    }
  }

  #bytes(): number {
    let bytes = 0;
    for (const entry of [...this.#entries.values(), ...this.#lineage.values()])
      bytes += new TextEncoder().encode(entry.rawJson).byteLength;
    return bytes;
  }

  async status(): Promise<HuggingFaceCatalogStatus> {
    return {
      persistent: false,
      entries: this.#entries.size + this.#lineage.size,
      bytes: this.#bytes(),
      reason: this.reason,
    };
  }
}

class SqliteCatalog implements HuggingFaceCatalog {
  readonly persistent = true;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly database: Database) {}

  async #run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#operationTail;
    let release: () => void = () => undefined;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await withCatalogLock(operation);
    } finally {
      release();
    }
  }

  async get(repo: string, commit: string): Promise<HuggingFaceCatalogEntry | undefined> {
    return await this.#run(async () => {
      const statement = this.database.prepare(
        `SELECT fetched_at, raw_bytes, raw_json
           FROM model_snapshots
          WHERE repo = ? AND commit_sha = ? AND raw_bytes <= ?`,
      );
      try {
        statement.bind([repo, commit, maximumCatalogSnapshotBytes]);
        if (!statement.step()) return undefined;
        const row = statement.get([]);
        const fetchedAt = row[0];
        const rawBytes = row[1];
        const rawJson = row[2];
        if (
          typeof fetchedAt !== "string" ||
          !Number.isSafeInteger(rawBytes) ||
          typeof rawJson !== "string" ||
          new TextEncoder().encode(rawJson).byteLength !== rawBytes
        )
          return undefined;
        this.database
          .prepare(
            `UPDATE model_snapshots
                SET accessed_at = ?
              WHERE repo = ?`,
          )
          .bind([Date.now(), repo])
          .stepFinalize();
        return { repo, commit, fetchedAt, rawJson };
      } finally {
        statement.finalize();
      }
    });
  }

  async put(entry: HuggingFaceCatalogEntry): Promise<void> {
    const rawBytes = new TextEncoder().encode(entry.rawJson).byteLength;
    if (rawBytes > maximumCatalogSnapshotBytes) return;
    await this.#run(async () => {
      const now = Date.now();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const statement = this.database.prepare(
          `INSERT INTO model_snapshots
            (repo, commit_sha, fetched_at, accessed_at, raw_bytes, raw_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo) DO UPDATE SET
             commit_sha = excluded.commit_sha,
             fetched_at = excluded.fetched_at,
             accessed_at = excluded.accessed_at,
             raw_bytes = excluded.raw_bytes,
             raw_json = excluded.raw_json`,
        );
        try {
          statement
            .bind([entry.repo, entry.commit, entry.fetchedAt, now, rawBytes, entry.rawJson])
            .step();
        } finally {
          statement.finalize();
        }
        pruneCatalog(this.database);
        this.database.exec("COMMIT");
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original storage failure; this catalog is disposable.
        }
        throw error;
      }
    });
  }

  async getLineage(repo: string): Promise<HuggingFaceCatalogEntry | undefined> {
    return await this.#run(async () => {
      const statement = this.database.prepare(
        `SELECT commit_sha, fetched_at, raw_bytes, raw_json
           FROM lineage_snapshots
          WHERE repo = ? AND raw_bytes <= ?`,
      );
      try {
        statement.bind([repo, maximumCatalogSnapshotBytes]);
        if (!statement.step()) return undefined;
        const row = statement.get([]);
        const commit = row[0];
        const fetchedAt = row[1];
        const rawBytes = row[2];
        const rawJson = row[3];
        if (
          typeof commit !== "string" ||
          typeof fetchedAt !== "string" ||
          !Number.isSafeInteger(rawBytes) ||
          typeof rawJson !== "string" ||
          new TextEncoder().encode(rawJson).byteLength !== rawBytes
        )
          return undefined;
        this.database
          .prepare("UPDATE lineage_snapshots SET accessed_at = ? WHERE repo = ?")
          .bind([Date.now(), repo])
          .stepFinalize();
        return { repo, commit, fetchedAt, rawJson };
      } finally {
        statement.finalize();
      }
    });
  }

  async putLineage(entry: HuggingFaceCatalogEntry): Promise<void> {
    const rawBytes = new TextEncoder().encode(entry.rawJson).byteLength;
    if (rawBytes > maximumCatalogSnapshotBytes) return;
    await this.#run(async () => {
      const now = Date.now();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const statement = this.database.prepare(
          `INSERT INTO lineage_snapshots
            (repo, commit_sha, fetched_at, accessed_at, raw_bytes, raw_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo) DO UPDATE SET
             commit_sha = excluded.commit_sha,
             fetched_at = excluded.fetched_at,
             accessed_at = excluded.accessed_at,
             raw_bytes = excluded.raw_bytes,
             raw_json = excluded.raw_json`,
        );
        try {
          statement
            .bind([entry.repo, entry.commit, entry.fetchedAt, now, rawBytes, entry.rawJson])
            .step();
        } finally {
          statement.finalize();
        }
        pruneCatalog(this.database);
        this.database.exec("COMMIT");
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original storage failure; this catalog is disposable.
        }
        throw error;
      }
    });
  }

  async status(): Promise<HuggingFaceCatalogStatus> {
    return await this.#run(async () => {
      const statement = this.database.prepare(
        `SELECT COUNT(*), COALESCE(SUM(raw_bytes), 0)
           FROM (
             SELECT raw_bytes FROM model_snapshots
             UNION ALL
             SELECT raw_bytes FROM lineage_snapshots
           )`,
      );
      try {
        if (!statement.step()) return { persistent: true, entries: 0, bytes: 0 };
        const row = statement.get([]);
        const entries = typeof row[0] === "number" ? row[0] : 0;
        const bytes = typeof row[1] === "number" ? row[1] : 0;
        return {
          persistent: true,
          entries: Math.min(entries, maximumCatalogRows),
          bytes: Math.min(bytes, maximumCatalogBytes),
          ...(entries > maximumCatalogRows || bytes > maximumCatalogBytes
            ? { reason: "The local catalog exceeded its storage budget and will be pruned." }
            : {}),
        };
      } finally {
        statement.finalize();
      }
    });
  }
}

async function withCatalogLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const locks = (navigator as Navigator & { readonly locks?: LockManager }).locks;
  if (locks === undefined) return await operation();
  return await locks.request(catalogLockName, { ifAvailable: true }, async (lock) => {
    if (lock === null) throw new Error("The local catalog is busy in another browser context.");
    return await operation();
  });
}

export function catalogSchemaNeedsReset(version: string | undefined): boolean {
  return version !== catalogSchemaVersion;
}

function readCatalogSchemaVersion(database: Database): string | undefined {
  const statement = database.prepare(
    "SELECT value FROM catalog_meta WHERE key = 'schema_version' LIMIT 1",
  );
  try {
    if (!statement.step()) return undefined;
    const value = statement.get([])[0];
    return typeof value === "string" ? value : undefined;
  } finally {
    statement.finalize();
  }
}

function initializeSchema(database: Database): void {
  database.exec([
    "PRAGMA busy_timeout = 5000;",
    `CREATE TABLE IF NOT EXISTS catalog_meta (
       key TEXT PRIMARY KEY NOT NULL,
       value TEXT NOT NULL
     ) STRICT;`,
  ]);
  if (catalogSchemaNeedsReset(readCatalogSchemaVersion(database))) {
    // This database contains only disposable, remotely derived metadata. Dropping an
    // unknown schema is safer than trying to interpret it with current statements.
    database.exec([
      "DROP TABLE IF EXISTS lineage_snapshots;",
      "DROP TABLE IF EXISTS model_snapshots;",
      "DROP TABLE IF EXISTS catalog_meta;",
    ]);
  }
  database.exec([
    `CREATE TABLE IF NOT EXISTS catalog_meta (
       key TEXT PRIMARY KEY NOT NULL,
       value TEXT NOT NULL
     ) STRICT;`,
    `INSERT INTO catalog_meta(key, value) VALUES ('schema_version', '${catalogSchemaVersion}')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    `CREATE TABLE IF NOT EXISTS model_snapshots (
       repo TEXT PRIMARY KEY NOT NULL,
       commit_sha TEXT NOT NULL,
       fetched_at TEXT NOT NULL,
       accessed_at INTEGER NOT NULL,
       raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
       raw_json TEXT NOT NULL
     ) STRICT;`,
    "CREATE INDEX IF NOT EXISTS model_snapshots_lru ON model_snapshots(accessed_at);",
    `CREATE TABLE IF NOT EXISTS lineage_snapshots (
       repo TEXT PRIMARY KEY NOT NULL,
       commit_sha TEXT NOT NULL,
       fetched_at TEXT NOT NULL,
       accessed_at INTEGER NOT NULL,
       raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
       raw_json TEXT NOT NULL
     ) STRICT;`,
    "CREATE INDEX IF NOT EXISTS lineage_snapshots_lru ON lineage_snapshots(accessed_at);",
  ]);
}

export interface CatalogPruneCandidate {
  readonly kind: "model" | "lineage";
  readonly repo: string;
  readonly rawBytes: number;
  readonly accessedAt: number;
}

export function selectCatalogPruneVictims(
  candidates: readonly CatalogPruneCandidate[],
): readonly CatalogPruneCandidate[] {
  let count = candidates.length;
  let bytes = candidates.reduce((total, candidate) => total + candidate.rawBytes, 0);
  const victims: CatalogPruneCandidate[] = [];
  for (const candidate of [...candidates].sort(
    (left, right) => left.accessedAt - right.accessedAt || left.repo.localeCompare(right.repo),
  )) {
    if (count <= maximumCatalogRows && bytes <= maximumCatalogBytes) break;
    victims.push(candidate);
    count -= 1;
    bytes -= candidate.rawBytes;
  }
  return victims;
}

function pruneCatalog(database: Database): void {
  const statement = database.prepare(`
    SELECT kind, repo, raw_bytes, accessed_at
      FROM (
        SELECT 'model' AS kind, repo, raw_bytes, accessed_at
          FROM model_snapshots
        UNION ALL
        SELECT 'lineage' AS kind, repo, raw_bytes, accessed_at
          FROM lineage_snapshots
      )`);
  const candidates: CatalogPruneCandidate[] = [];
  try {
    while (statement.step()) {
      const row = statement.get([]);
      if (
        (row[0] !== "model" && row[0] !== "lineage") ||
        typeof row[1] !== "string" ||
        typeof row[2] !== "number" ||
        typeof row[3] !== "number"
      )
        continue;
      candidates.push({
        kind: row[0],
        repo: row[1],
        rawBytes: row[2],
        accessedAt: row[3],
      });
    }
  } finally {
    statement.finalize();
  }
  for (const victim of selectCatalogPruneVictims(candidates)) {
    const remove = database.prepare(
      victim.kind === "model"
        ? "DELETE FROM model_snapshots WHERE repo = ?"
        : "DELETE FROM lineage_snapshots WHERE repo = ?",
    );
    try {
      remove.bind([victim.repo]).step();
    } finally {
      remove.finalize();
    }
  }
}

let catalogPromise: Promise<HuggingFaceCatalog> | undefined;

export function openHuggingFaceCatalog(): Promise<HuggingFaceCatalog> {
  if (catalogPromise !== undefined) return catalogPromise;
  catalogPromise = withCatalogLock(async () => {
    const sqliteGlobal = globalThis as typeof globalThis & {
      sqlite3ApiConfig?: { readonly warn?: (...values: readonly unknown[]) => void };
    };
    const previousConfig = sqliteGlobal.sqlite3ApiConfig;
    const warnings: string[] = [];
    try {
      sqliteGlobal.sqlite3ApiConfig = {
        ...previousConfig,
        warn: (...values: readonly unknown[]) => {
          const message = values
            .map((value) => (value instanceof Error ? value.message : String(value)))
            .join(" ")
            .slice(0, 384);
          if (message !== "") warnings.push(message);
        },
      };
      const module = await import("@sqlite.org/sqlite-wasm");
      const initialize = module.default as unknown as (options: {
        readonly print?: () => void;
        readonly printErr?: () => void;
      }) => Promise<Sqlite3Static>;
      const sqlite = await initialize({
        print: () => undefined,
        printErr: () => undefined,
      });
      if (previousConfig === undefined) delete sqliteGlobal.sqlite3ApiConfig;
      else sqliteGlobal.sqlite3ApiConfig = previousConfig;
      if (sqlite.oo1.OpfsDb === undefined)
        return new MemoryCatalog(
          warnings.at(-1) ??
            `SQLite's OPFS VFS is unavailable (isolated=${String(globalThis.crossOriginIsolated)}, shared-memory=${String(typeof SharedArrayBuffer !== "undefined")}, storage-directory=${String(typeof navigator.storage?.getDirectory === "function")}, file-handle=${String(typeof globalThis.FileSystemHandle !== "undefined")}).`,
        );
      const database = new sqlite.oo1.OpfsDb(catalogPath, "c");
      initializeSchema(database);
      pruneCatalog(database);
      return new SqliteCatalog(database);
    } catch (error) {
      if (previousConfig === undefined) delete sqliteGlobal.sqlite3ApiConfig;
      else sqliteGlobal.sqlite3ApiConfig = previousConfig;
      return new MemoryCatalog(
        error instanceof Error
          ? error.message.slice(0, 512)
          : "Unknown SQLite initialization error.",
      );
    }
  }).catch(
    (error) =>
      new MemoryCatalog(
        error instanceof Error ? error.message.slice(0, 512) : "The local catalog is busy.",
      ),
  );
  return catalogPromise;
}
