import { Pool, type PoolClient } from "pg";

export type Entry = Record<string, any>;
export interface Repository {
  get(kind: string, id: string, lock?: boolean): Promise<Entry | null>;
  put(kind: string, id: string, data: Entry, expiresAt: number): Promise<void>;
  remove(kind: string, id: string): Promise<Entry | null>;
  list(kind: string, userId?: string): Promise<Entry[]>;
}
export interface OAuthStore extends Repository {
  initialize(): Promise<void>;
  transaction<T>(action: (repo: Repository) => Promise<T>): Promise<T>;
  prune(): Promise<void>;
  close(): Promise<void>;
}

class PgRepository implements Repository {
  constructor(protected db: Pool | PoolClient) {}
  async get(kind: string, id: string, lock = false) {
    const r = await this.db.query(
      `SELECT data FROM mcp_oauth.entries WHERE kind=$1 AND id=$2 AND expires_at > now()${lock ? " FOR UPDATE" : ""}`,
      [kind, id],
    );
    return r.rows[0]?.data ?? null;
  }
  async put(kind: string, id: string, data: Entry, expiresAt: number) {
    await this.db.query(
      "INSERT INTO mcp_oauth.entries(kind,id,data,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at",
      [kind, id, data, new Date(expiresAt)],
    );
  }
  async remove(kind: string, id: string) {
    const r = await this.db.query(
      "DELETE FROM mcp_oauth.entries WHERE kind=$1 AND id=$2 RETURNING data",
      [kind, id],
    );
    return r.rows[0]?.data ?? null;
  }
  async list(kind: string, userId?: string) {
    const r = await this.db.query(
      `SELECT data FROM mcp_oauth.entries WHERE kind=$1 AND expires_at > now()${userId === undefined ? "" : " AND data->>'userId'=$2"} ORDER BY id LIMIT 1001`,
      userId === undefined ? [kind] : [kind, userId],
    );
    return r.rows.map((row) => row.data);
  }
}

export class PgOAuthStore extends PgRepository implements OAuthStore {
  private pool: Pool;
  private closing?: Promise<void>;
  constructor(connectionString: string) {
    const pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    // Never print connection details or credential-bearing SQL parameters.
    pool.on("error", () =>
      console.error("OAuth database connection unavailable"),
    );
    super(pool);
    this.pool = pool;
  }
  async initialize() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS mcp_oauth;
      CREATE TABLE IF NOT EXISTS mcp_oauth.entries (
        kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
        expires_at timestamptz NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS mcp_oauth_entries_expiry ON mcp_oauth.entries(expires_at);
      CREATE INDEX IF NOT EXISTS mcp_oauth_entries_user ON mcp_oauth.entries(kind,(data->>'userId'));`);
  }
  async transaction<T>(action: (repo: Repository) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await action(new PgRepository(db));
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async prune() {
    await this.pool.query(
      "DELETE FROM mcp_oauth.entries WHERE (kind,id) IN (SELECT kind,id FROM mcp_oauth.entries WHERE expires_at <= now() LIMIT 1000)",
    );
  }
  async close() {
    await (this.closing ??= this.pool.end());
  }
}
