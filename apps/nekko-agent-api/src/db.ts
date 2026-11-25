import pg from "pg";

/** The one database call the service needs; pg in production, PGlite in tests. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs `fn` on one connection inside a transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** How long one statement may run before the database gives up on it (in a transaction) or the caller stops waiting (outside one). */
export const STATEMENT_TIMEOUT_MS = 30_000;

/** The parts of a pg Pool the service uses, so a test can stand in for it. */
export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
}
export interface ClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /** Passing an error destroys the connection instead of returning it to the pool. */
  release(err?: Error | boolean): void;
}

/**
 * A pool on Neon's pooled connection string. Neon scales to zero, so the first
 * query after an idle spell waits for the compute to wake (well under a second);
 * the timeouts leave room for that.
 *
 * Neon's pooler (pgbouncer in transaction mode) refuses startup options such as
 * `statement_timeout`, so the server-side timeout is `SET LOCAL` inside each
 * transaction; a single statement outside a transaction is bounded by pg's own
 * client-side `query_timeout` (it stops waiting; the statement is not cancelled).
 */
export function createPgDb(connectionString: string): Db {
  return dbOnPool(new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: STATEMENT_TIMEOUT_MS + 5_000,
    // Neon drops idle connections quietly; keep-alive probes find the dead ones.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  }) as unknown as PoolLike);
}

export function dbOnPool(pool: PoolLike, log: (message: string, err: unknown) => void = (m, e) => console.error(m, e)): Db {
  // pg emits `error` on the pool when an idle client's connection drops (Neon
  // does this when its compute restarts). With no listener Node crashes the process.
  pool.on("error", (err) => log("database pool: idle connection error", err));
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async transaction(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("begin");
        await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const tx: Db = {
          query: (text, params) => client.query(text, params as unknown[]) as never,
          transaction: (inner) => inner(tx),
          close: async () => {},
        };
        const result = await fn(tx);
        await client.query("commit");
        return result;
      } catch (error) {
        // A failed rollback leaves the connection in an unknown state: destroy it rather than hand it to the next request.
        await client.query("rollback").catch((e: unknown) => { broken = e instanceof Error ? e : new Error(String(e)); });
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}
