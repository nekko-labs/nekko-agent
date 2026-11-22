import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { authenticate } from './auth.js';
import type { Features } from './features.js';
import { fields, isSetup } from './hypergate-format.js';

export function registerHypergate(app: FastifyInstance, db: Db, features: Features) {
  app.route({ method: ['GET','PUT'], url: '/v1/hypergate/setup', handler: async (req, reply) => {
    reply.header('cache-control','no-store');
    const user = await authenticate(db, req);
    if (!user) return reply.code(401).send({error:'unauthenticated'});
    // A verified company mailbox qualifies without an individual rollout flag. Also honor
    // the explicit staff roster for employees who use an approved alternate address.
    const {rows: staff} = await db.query<{email:string}>('select lower(email) as email from users where id=$1 and email_verified=true',[user.userId]);
    const email=staff[0]?.email;
    if (!email || !(features.staff.has(email) || /^[^@\s]+@nekkolabs\.com$/.test(email))) return reply.code(403).send({error:'coming-soon'});
    const columns = 'revision, updated_at as "updatedAt", setup';
    if (req.method === 'GET') {
      const { rows } = await db.query('select '+columns+' from hypergate_setups where user_id=$1',[user.userId]);
      return rows[0] ?? {revision:0, updatedAt:null, setup:null};
    }
    const b = req.body;
    if (!fields(b,['baseRevision','setup']) || typeof b.baseRevision !== 'number' || !Number.isSafeInteger(b.baseRevision) || b.baseRevision < 0 || b.baseRevision >= 2147483647 || !isSetup(b.setup)) return reply.code(400).send({error:'invalid-setup'});
    const { rows } = b.baseRevision === 0
      ? await db.query('insert into hypergate_setups(user_id,revision,setup) values($1,1,$2::jsonb) on conflict do nothing returning '+columns,[user.userId,JSON.stringify(b.setup)])
      : await db.query('update hypergate_setups set revision=revision+1,setup=$2::jsonb,updated_at=now() where user_id=$1 and revision=$3 returning '+columns,[user.userId,JSON.stringify(b.setup),b.baseRevision]);
    return rows[0] ?? reply.code(409).send({error:'revision-changed'});
  }});
}
