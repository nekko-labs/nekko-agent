import {api, signIn, signOut} from './session.js';
import {el, action, row, feedback} from './ui.js';
import {organizations} from './organizations.js';
import {hypergate} from './hypergate.js';
import {cases} from './cases.js';
const main=document.querySelector('main'),nav=document.querySelector('nav');let account,reviewer=false;
const titles={account:'Account and billing',orgs:'Organizations',operations:'Nekko Agent',hypergate:'Hypergate',privacy:'Privacy requests',staff:'Staff case review'};
function login(){nav.hidden=true;nav.replaceChildren();main.replaceChildren();account=null;reviewer=false;signIn(main,async a=>{account=a;await show('account');});}
function menu(key){
 nav.hidden=false;nav.replaceChildren();
 function group(label,keys){
  const group=el('div',null,nav);group.className='nav-group';group.setAttribute('role','group');group.setAttribute('aria-label',label);
  el('span',label,group).className='eyebrow';
  for(const k of keys){const b=action(group,titles[k],()=>show(k));if(k===key)b.setAttribute('aria-current','page');}
 }
 group('Products',['operations','hypergate']);
 group('Workspace',['account','orgs','privacy',...(reviewer?['staff']:[])]);
 action(nav,'Sign out',async()=>{await signOut();login();});
}
async function show(key,id){if(!account||key==='staff'&&!reviewer)return;const root=document.createElement('section');main.replaceChildren(root);menu(key);el('p',key==='staff'?'Nekko staff · Compliance':account.email,root).className='eyebrow';el('h1',titles[key],root);
 const active=()=>root.isConnected;const refresh=()=>active()&&show(key,id);
 try{if(key==='orgs')await organizations(root,account,newId=>active()&&show(key,newId),id);
 else if(key==='privacy'||key==='staff')await cases(root,key==='staff',refresh);
 else if(key==='hypergate')await hypergate(root,refresh);
 else if(key==='account'){
  const {account:a}=await api('/v1/auth/me');if(!active())return;account=a;row(root,'Signed in as',a.email);row(root,'Current plan',a.plan.toUpperCase());
  if(a.features.billing)action(root,a.plan==='free'?'Upgrade to Pro':'Manage billing',async()=>{const upgrade=a.plan==='free';const {url}=await api('/v1/billing/'+(upgrade?'checkout':'portal'),'POST',upgrade?{plan:'pro'}:undefined);const dest=new URL(url);if(dest.protocol!=='https:'||!['checkout.stripe.com','billing.stripe.com'].includes(dest.hostname))throw new Error('Billing destination is unavailable.');if(active())location.assign(dest.href);});
  el('h2','Workspace',root);action(row(root,'Organizations','Members, invitations and audit history'),'View organizations',()=>show('orgs'));action(row(root,'Privacy requests','Request an export or erasure and follow its review.'),'View requests',()=>show('privacy'));
  try {const data=await api('/v1/privacy/cases');if(active()){reviewer=data.reviewer;menu(key);}}catch(e){if(e.status!==404)throw e;}
 }else{
  el('p','Fleet and operations for Nekko Agent.',root);
  el('h2','Hosted machines',root);try{const m=await api('/v1/machines');row(root,'Machine hours',m.hoursUsed+' used · '+m.hoursIncluded+' included');if(!m.machines.length)el('p','No hosted machines on this account.',root);for(const v of m.machines)row(root,v.name,v.region+' · '+v.state);}catch(e){if(e.status!==404)throw e;el('p','Hosted machine reporting is not enabled.',root);}
  for(const [name,desc,doc] of [['Shared fleet','Open Organization → Computers on an unlocked device to see online status and available models.','connections'],['Pairing','Review and revoke paired devices on the computer that granted access. An org invitation does not pair a device.','remote'],['CI runners','Inspect runners, queued jobs and run results in CI Runner on the host. No Cloud runner feed is connected.','ci-runners'],['Automations','Review schedules and run history in Automations on the host. No Cloud automation feed is connected.','automations']]){el('h2',name,root);el('p',desc,root);el('a',name+' guide',root).href='/docs/'+doc;}
 }
 }catch(e){if(active()){feedback(root,e.message);action(root,'Refresh',refresh);}}
}
login();
