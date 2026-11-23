import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { issueToken } from './auth.js';
import { migrate } from './migrate.js';
import { buildServer } from './server.js';
import { pgliteDb } from './test-db.js';

it('isolates free employee accounts, rejects secret fields, and never overwrites a stale revision',async()=>{
 const db=pgliteDb(new PGlite());await migrate(db,undefined,{lock:false});
 const app=buildServer({db,allowedOrigins:['https://nekkoagent.com'],staffEmails:['a@unit.test','b@unit.test','unverified@unit.test']});
 const url='/v1/hypergate/setup';
 const person=async(email:string,verified=true)=>{const {rows}=await db.query<{id:string}>('insert into users(email,email_verified) values($1,$2) returning id',[email,verified]);return issueToken(db,rows[0].id);};
 const call=(token:string,method:'GET'|'PUT',payload?:object)=>app.inject({method,url,headers:{authorization:'Bearer '+token},payload});
 const setup={version:1,startMinimized:false,closeAction:'ask',servers:[{catalogId:'github',enabled:true}]};
 try {
  const a=await person('a@unit.test'),b=await person('b@unit.test');
  expect((await call(await person('new-starter@nekkolabs.com'),'GET')).statusCode).toBe(200);
  for(const [token,status] of [[await person('fake@nekkolabs.com',false),403],[await person('outsider@nekkolabs.com.unit.test'),403],['',401],[await person('unverified@unit.test',false),403],[await person('other@unit.test'),403]] as const){
   expect((await call(token,'GET')).statusCode).toBe(status);expect((await call(token,'PUT',{baseRevision:0,setup})).statusCode).toBe(status);
  }
  for(const bad of [{...setup,keys:{}},{...setup,servers:[{...setup.servers[0],args:['secret']}]},{...setup,servers:[{catalogId:'token',enabled:true}]},{...setup,servers:[...setup.servers,...setup.servers]}])expect((await call(a,'PUT',{baseRevision:0,setup:bad})).statusCode).toBe(400);
  const save=(baseRevision:number)=>call(a,'PUT',{baseRevision,setup});
  expect((await save(5)).statusCode).toBe(409);expect((await save(0)).json().revision).toBe(1);expect((await save(0)).statusCode).toBe(409);
  expect((await Promise.all([save(1),save(1)])).map(x=>x.statusCode).sort()).toEqual([200,409]);
  expect((await call(b,'GET')).json()).toEqual({revision:0,updatedAt:null,setup:null});
  const result=await call(a,'GET');expect(result.json().setup).toEqual(setup);expect(result.headers['cache-control']).toBe('no-store');
  await db.query('update users set email_verified=false where email=$1',['a@unit.test']);expect((await call(a,'GET')).statusCode).toBe(403);
 }finally{await app.close();await db.close();}
});

it('rate limits both Hypergate setup methods before authentication', async () => {
  const db = pgliteDb(new PGlite());
  const app = buildServer({ db, allowedOrigins: [], syncRateLimit: { max: 1, windowMs: 60_000 } });
  try {
    for (const [method, remoteAddress] of [['GET', '192.0.2.1'], ['PUT', '192.0.2.2']] as const) {
      const request = { method, url: '/v1/hypergate/setup', remoteAddress };
      expect((await app.inject(request)).statusCode).toBe(401);
      expect((await app.inject(request)).statusCode).toBe(429);
    }
  } finally {
    await app.close();
    await db.close();
  }
});
