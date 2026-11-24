import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe,it,expect } from 'vitest';
import { migrate } from './migrate.js';
import { pgliteDb } from './test-db.js';
import { buildServer } from './server.js';
import { issueToken } from './auth.js';

describe('Cloud console',()=>{
 it('isolates account requests, restricts review to a verified subject, and records transitions without executing them',async()=>{
  const db=pgliteDb(new PGlite());await migrate(db,undefined,{lock:false});
  const reviewer=randomUUID(), unverified=randomUUID();
  const app=buildServer({db,orgsEnabled:true,allowedOrigins:['https://nekkoagent.com'],privacyReviewers:[reviewer,unverified],staffEmails:['other@example.test']});
  async function person(email:string,sub=randomUUID(),verified=true){const {rows}=await db.query<{id:string}>("insert into users(email,auth_subject,email_verified,plan) values($1,$2,$3,'pro') returning id",[email,sub,verified]);return issueToken(db,rows[0].id);}
  const call=(token:string,method:'GET'|'POST'|'PATCH',url:string,payload?:object)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+token}});
  try{
   const a=await person('a@example.test'),b=await person('other@example.test'),s=await person('review@example.test',reviewer),u=await person('unverified@example.test',unverified,false);
   const own='/v1/privacy/cases',staff='/v1/staff/privacy/cases';
   expect((await call('', 'GET', own)).statusCode).toBe(401);
   expect((await call(a,'POST',own,{kind:'delete-now'})).statusCode).toBe(400);
   const created=await call(a,'POST',own,{kind:'erasure'});expect(created.statusCode).toBe(201);const id=created.json().id;
   expect((await call(a,'POST',own,{kind:'erasure'})).statusCode).toBe(409);
   expect((await call(a,'POST',own,{kind:'export'})).statusCode).toBe(201);
   expect((await call(b,'GET',own)).json()).toEqual({cases:[],reviewer:false});
   for(const token of [a,b,u]){expect((await call(token,'GET',staff)).statusCode).toBe(404);expect((await call(token,'PATCH',staff+'/'+id,{state:'reviewing'})).statusCode).toBe(404);}
   expect((await call(s,'GET',staff)).json().cases).toHaveLength(2);
   const patch=(state:string)=>call(s,'PATCH',staff+'/'+id,{state});
   expect((await patch('closed')).statusCode).toBe(409);expect((await patch('reviewing')).statusCode).toBe(204);expect((await patch('reviewing')).statusCode).toBe(409);expect((await patch('closed')).statusCode).toBe(204);
   const cases=(await call(a,'GET',own)).json().cases;expect(cases.find((x:{id:string})=>x.id===id).history.map((x:{state:string})=>x.state)).toEqual(['received','reviewing','closed']);
   expect((await call(a,'GET','/v1/auth/me')).statusCode).toBe(200);
   const org=(await call(a,'POST','/v1/orgs',{name:'Studio'})).json().id;
   await call(a,'PATCH','/v1/orgs/'+org,{name:'New studio'});const path='/v1/orgs/'+org+'/activity';
   expect((await call(b,'GET',path)).statusCode).toBe(404);
   expect((await call(a,'GET',path)).json().events.map((x:{action:string})=>x.action)).toEqual(['Organization renamed','Organization created']);
   for(const [origin,code] of [['https://nekkoagent.com',204],['https://other.example',403]] as const)expect((await app.inject({method:'OPTIONS',url:own,headers:{origin}})).statusCode).toBe(code);
  }finally{await app.close();await db.close();}
 });
});
