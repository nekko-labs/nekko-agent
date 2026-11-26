import {el, form, action} from './ui.js';
// Loopback uses a same-origin local development proxy; no query parameter can redirect credentials.
const local=['127.0.0.1','localhost'].includes(location.hostname);
const base=local?location.origin:'https://nekko-agent-api.fly.dev';
let token='';
export async function api(path,method='GET',body){
 const res=await fetch(base+path,{method,cache:'no-store',credentials:'omit',redirect:'error',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(!res.ok){const data=await res.json().catch(()=>({}));const messages={'account-not-available':'Nekko Cloud is invite-only for this account.','already-open':'You already have an open request of this type.','last-owner':'The last owner cannot leave.','invite-exists':'An invitation is already pending.','case-changed':'This case changed. Refresh before reviewing it.','no-billing-account':'This plan has no Stripe billing account.'};const err=new Error(messages[data.error]||data.message||({401:'Your session is no longer valid. Sign in again.',402:'This action requires Pro or Team.',403:'This action is not allowed for your account.',404:'This feature is unavailable.',503:'Cloud is temporarily unavailable.'}[res.status])||'The action was not completed. Refresh and try again.');err.status=res.status;throw err;}
 return res.status===204?null:res.json();
}
export function signIn(root,done){
 el('p','Personal workspace',root).className='eyebrow';el('h1','Sign in to Nekko Cloud',root);el('p','Use your account email to get a one-time code.',root);
 form(root,'Send code',[['email','Email address','email']],async({email})=>{
  const cfg=await api('/v1/auth/config');const host=new URL(cfg.supabaseUrl);
  if(local && ['127.0.0.1','localhost'].includes(host.hostname))host.host=location.host;
  else if(host.protocol!=='https:'||!host.hostname.endsWith('.supabase.co'))throw new Error('Sign-in provider is not configured.');
  const auth=async(route,body)=>{const r=await fetch(host.origin+'/auth/v1/'+route,{method:'POST',credentials:'omit',redirect:'error',headers:{apikey:cfg.supabaseAnonKey,'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(route==='otp'?'Could not send a code. Wait a moment and try again.':'Code expired or incorrect. Request a new code.');return r;};
  await auth('otp',{email,create_user:false});root.replaceChildren();el('h1','Check your email',root);el('p','Enter the code sent to '+email+'.',root);
  form(root,'Verify code',[['code','One-time code','text']],async({code})=>{const verified=await (await auth('verify',{email,token:code,type:'email'})).json();const session=await api('/v1/auth/session','POST',{accessToken:verified.access_token,label:'Cloud web console'});token=session.token;await done(session.account);});
  action(root,'Use another email',()=>{root.replaceChildren();signIn(root,done);});
 });
}
export async function signOut(){await api('/v1/auth/session','DELETE').catch(e=>{if(e.status!==401)throw e;});token='';}
