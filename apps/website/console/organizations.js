import {api} from './session.js';
import {el,row,form,disclosure,action,feedback} from './ui.js';
export async function organizations(root, account, open, id){
 if(!id){
  const {orgs,invites}=await api('/v1/orgs');
  if(!orgs.length)el('p','You do not belong to any organizations yet.',root);
  for(const org of orgs)action(row(root,org.name,org.role+' · '+org.memberCount+' members'),'Manage',()=>open(org.id));
  if(account.plan!=='free')form(disclosure(root,'Create organization'),'Create',[['name','Organization name']],async({name})=>{const org=await api('/v1/orgs','POST',{name});await open(org.id);});
  for(const inv of invites)action(row(root,inv.orgName,'Invitation · '+inv.role),'Accept invitation',async()=>{await api('/v1/orgs/invites/'+inv.id+'/accept','POST');await open(inv.orgId);});
  return;
 }
 const path='/v1/orgs/'+encodeURIComponent(id), org=await api(path), admin=org.role!=='member';
 action(root,'All organizations',()=>open());el('h2',org.name,root);el('p','Viewing as '+org.role,root);el('h3','Members',root);
 for(const m of org.members){const r=row(root,m.email,m.role+(m.you?' · You':''));
  if((m.you||org.role==='owner'||(admin&&m.role==='member'))&&!(m.role==='owner'&&org.members.filter(x=>x.role==='owner').length===1)){
   const d=disclosure(r,m.you?'Leave':'Remove');el('p','Access ends immediately. An unlocked owner or admin should advance the organization key in Nekko Agent.',d);
   action(d,m.you?'Confirm leaving':'Confirm removal',async()=>{await api(path+'/members/'+m.userId,'DELETE');await open(m.you?undefined:id);});
  }
 }
 if(!admin)return;
 const invites=disclosure(root,'Invitations');for(const inv of org.invites)action(row(invites,inv.email,inv.role),'Revoke',async()=>{await api(path+'/invites/'+inv.id,'DELETE');await open(id);});
 el('p','Invitations appear in the recipient’s account. No email is sent.',invites);
 form(invites,'Invite',[['email','Email','email'],['role','Role',null,['member','admin']]],async v=>{await api(path+'/invites','POST',v);await open(id);});
 form(disclosure(root,'Rename organization'),'Save name',[['name','New name']],async v=>{await api(path,'PATCH',v);await open(id);});
 const log=disclosure(root,'Organization audit log');log.ontoggle=async()=>{if(!log.open)return;log.ontoggle=null;try{const {events}=await api(path+'/activity');if(!events.length)el('p','No recorded changes.',log);for(const e of events)row(log,e.action,(e.actor||'Deleted account')+' · '+new Date(e.at).toLocaleString());}catch(e){feedback(log,e.message);}};
 if(org.role==='owner')form(disclosure(root,'Delete organization'),'Permanently delete organization',[['name','Type '+org.name+' to confirm']],async v=>{if(v.name!==org.name)throw new Error('The organization name must match.');await api(path,'DELETE');await open();});
}
