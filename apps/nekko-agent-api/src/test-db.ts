import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.js";

/** PGlite behind the same interface; param-less calls go through exec so a migration's many statements run. */
export function pgliteDb(pg: PGlite): Db {
  const db: Db = {
    async query(text, params) {
      if (params?.length) return (await pg.query(text, params)) as never;
      const results = await pg.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as never };
    },
    transaction: (fn) => pg.transaction((tx) => fn({ ...db, query: async (text, params) => {
      if (params?.length) return (await tx.query(text, params)) as never;
      const results = await tx.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as never };
    } })) as never,
    close: () => pg.close(),
  };
  return db;
}
