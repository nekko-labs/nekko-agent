import pg from "pg";

/** The one database call the service needs; pg in production, PGlite in tests. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs `fn` on one connection inside a transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * A pool on Neon's pooled connection string. Neon scales to zero, so the first
 * query after an idle spell waits for the compute to wake (well under a second);
 * the timeouts leave room for that.
 */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const tx: Db = {
          query: (text, params) => client.query(text, params as unknown[]) as never,
          transaction: (inner) => inner(tx),
          close: async () => {},
        };
        const result = await fn(tx);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
