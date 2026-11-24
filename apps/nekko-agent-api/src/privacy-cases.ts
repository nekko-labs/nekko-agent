import type { FastifyInstance } from "fastify";
import { authenticate } from "./auth.js";
import type { Db } from "./db.js";

/** Review metadata only. Closing a case cannot run account deletion or generate an export. */
export function registerPrivacyCases(app: FastifyInstance, db: Db, reviewers: string[]): void {
  const staff = async (id: string) => (await db.query("select 1 from users where id=$1 and email_verified and auth_subject::text = any($2::text[])", [id, reviewers])).rows.length > 0;
  const history = ", (select json_agg(json_build_object('state',e.state,'at',e.created_at) order by e.id) from privacy_case_events e where e.case_id=c.id) as history";
  app.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/v1/privacy/cases", async (req, reply) => {
    const user = await authenticate(db, req);
    if (!user) return reply.code(401).send();
    return { cases: (await db.query("select c.id,c.kind,c.state,c.created_at" + history + " from privacy_cases c where user_id=$1 order by created_at desc,id desc limit 100", [user.userId])).rows, reviewer: await staff(user.userId) };
  });
  app.post("/v1/privacy/cases", async (req, reply) => {
    const user = await authenticate(db, req);
    if (!user) return reply.code(401).send();
    const kind = (req.body as {kind?: unknown} | null)?.kind;
    if (kind !== "export" && kind !== "erasure") return reply.code(400).send({ error: "invalid-kind" });
    const id = await db.transaction(async tx => {
      const { rows } = await tx.query<{id:string}>("insert into privacy_cases(user_id,kind) values($1,$2) on conflict do nothing returning id", [user.userId,kind]);
      if (!rows[0]) return null;
      await tx.query("insert into privacy_case_events(case_id,actor,state) values($1,$2,'received')", [rows[0].id,user.userId]);
      return rows[0].id;
    });
    return id ? reply.code(201).send({id}) : reply.code(409).send({error:"already-open"});
  });
  app.get("/v1/staff/privacy/cases", async (req, reply) => {
    const user = await authenticate(db, req);
    if (!user) return reply.code(401).send();
    if (!(await staff(user.userId))) return reply.code(404).send();
    return { cases: (await db.query("select c.id,c.kind,c.state,c.created_at,u.email" + history + " from privacy_cases c join users u on u.id=c.user_id where state <> 'closed' order by c.created_at,c.id limit 100")).rows };
  });
  app.patch("/v1/staff/privacy/cases/:id", async (req, reply) => {
    const user = await authenticate(db, req);
    if (!user) return reply.code(401).send();
    if (!(await staff(user.userId))) return reply.code(404).send();
    const state = (req.body as {state?: unknown} | null)?.state;
    if (state !== "reviewing" && state !== "closed") return reply.code(400).send();
    const { id } = req.params as {id:string};
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return reply.code(400).send();
    const changed = await db.transaction(async tx => {
      const r = await tx.query("update privacy_cases set state=$1 where id=$2 and state=$3 returning id", [state,id,state === "reviewing" ? "received" : "reviewing"]);
      if (!r.rows.length) return false;
      await tx.query("insert into privacy_case_events(case_id,actor,state) values($1,$2,$3)", [id,user.userId,state]);
      return true;
    });
    return changed ? reply.code(204).send() : reply.code(409).send({error:"case-changed"});
  });
}
