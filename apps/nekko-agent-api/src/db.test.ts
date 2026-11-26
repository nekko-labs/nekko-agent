import { describe, expect, it, vi } from "vitest";
import { type ClientLike, dbOnPool, type PoolLike, STATEMENT_TIMEOUT_MS } from "./db.js";

function fakePool(failRollback = false) {
  const statements: string[] = [];
  const released: unknown[] = [];
  let onError: ((e: Error) => void) | undefined;
  const client: ClientLike = {
    async query(text) {
      statements.push(text);
      if (failRollback && text === "rollback") throw new Error("connection terminated");
      return { rows: [] };
    },
    release: (err) => { released.push(err); },
  };
  const pool: PoolLike = {
    query: async () => ({ rows: [] }),
    connect: async () => client,
    end: async () => {},
    on: (_event, listener) => { onError = listener; },
  };
  return { pool, statements, released, emitError: (e: Error) => onError?.(e) };
}

describe("the pg pool", () => {
  it("listens for idle connection errors instead of letting them crash the process", () => {
    const { pool, emitError } = fakePool();
    const log = vi.fn();
    dbOnPool(pool, log);
    expect(() => emitError(new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
  });

  it("sets a statement timeout inside each transaction and returns a healthy connection", async () => {
    const { pool, statements, released } = fakePool();
    await dbOnPool(pool).transaction(async (tx) => { await tx.query("select 1"); });
    expect(statements).toEqual(["begin", `set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`, "select 1", "commit"]);
    expect(released).toEqual([undefined]);
  });

  it("destroys a connection whose rollback failed instead of handing it back to the pool", async () => {
    const { pool, released } = fakePool(true);
    await expect(dbOnPool(pool).transaction(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it("returns the connection normally when the rollback works", async () => {
    const { pool, released } = fakePool();
    await expect(dbOnPool(pool).transaction(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(released).toEqual([undefined]);
  });
});
