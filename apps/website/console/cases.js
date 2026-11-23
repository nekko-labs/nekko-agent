import {api} from './session.js';
import {el,row,action,disclosure} from './ui.js';
const names={export:'Data export',erasure:'Data erasure'}, labels={received:'Received',reviewing:'In review',closed:'Closed'};
export async function cases(root, staff, refresh){
 const path=staff?'/v1/staff/privacy/cases':'/v1/privacy/cases';
 let data;try{data=await api(path);}catch(e){if(staff||e.status!==404)throw e;el('p','Online intake is not enabled. Contact the privacy team to request access, export or erasure.',root);el('a','Email the privacy team',root).href='mailto:hello@nekkoagent.com';return;}
 el('p',staff?'Oldest open cases first, up to 100. Verify identity and scope before fulfilling through the privacy process.':'Request a copy of your account data or ask for it to be erased. Neither action happens until the request is reviewed.',root);
 if(!staff){const a=el('a','Privacy policy',root);a.href='/privacy';for(const [kind,name] of Object.entries(names)){
  if(data.cases.some(c=>c.kind===kind&&c.state!=='closed'))continue;
  const d=disclosure(root,'Request '+name.toLowerCase());el('p',kind==='export'?'This request covers your Cloud account, not readable copies of encrypted device data.':'This opens an erasure case. It does not immediately delete your account, machines or subscription.',d);
  action(d,'Submit '+kind+' request',async()=>{await api(path,'POST',{kind});await refresh();});
 }}
 el('h2',staff?'Review queue':'Request history',root);if(!data.cases.length)el('p',staff?'There are no open requests.':'No requests yet.',root);
 for(const c of data.cases){const d=disclosure(root,names[c.kind]+' · '+labels[c.state]+(staff?' · '+c.email:''));row(d,'Reference',c.id);
  for(const e of c.history)row(d,labels[e.state],new Date(e.at).toLocaleString());
  if(staff){const state=c.state==='received'?'reviewing':'closed';if(state==='closed')el('p','Close only after the requester has received the outcome. Closing records the review; it does not perform the request.',d);
   action(d,state==='closed'?'Record closure':'Start review',async()=>{await api(path+'/'+c.id,'PATCH',{state});await refresh();});}
 }
}
