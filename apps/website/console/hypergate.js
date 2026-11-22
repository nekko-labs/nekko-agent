import {api} from './session.js';
import {action, el, feedback, row} from './ui.js';

export async function hypergate(root,refresh) {
  const path='/v1/hypergate/setup';
  let doc;
  try {doc=await api(path);} catch(err){
    if(err.status!==403) throw err;
    el('h2','Coming soon',root);
    el('p','Back up Hypergate setup and review changes on your computers. Cloud sync is currently available to verified Nekko Labs employees.',root);return;
  }
  el('p','Employee preview · Personal setup',root).className='eyebrow';
  el('h2','Settings',root);
  el('p','Save a portable setup for your computers. Each computer reviews and applies it in Hypergate. Saving here never starts or stops a server.',root);
  if(!doc.setup){el('h2','No setup published yet',root);el('p','Open Settings → Nekko Cloud in Hypergate and publish this computer’s setup to get started.',root);action(root,'Refresh',refresh);return;}
  const draft=structuredClone(doc.setup);
  const stamp=()=> 'Revision '+doc.revision+' · '+new Date(doc.updatedAt).toLocaleString();
  const summary=row(root,'Saved setup',stamp());
  function select(title, choices, current, update){const label=el('label',title,root),input=el('select',null,label);for(const [value,text] of choices){const o=el('option',text,input);o.value=value;}input.value=current;input.onchange=()=>update(input.value);}
  el('h2','Desktop behavior',root);
  select('On startup',[['true','Start minimized'],['false','Open manager window']],String(draft.startMinimized),v=>draft.startMinimized=v==='true');
  select('On window close',[['ask','Ask each time'],['tray','Stay in tray'],['quit','Quit Hypergate']],draft.closeAction,v=>draft.closeAction=v);
  el('h2','Catalog servers',root);
  if(!draft.servers.length)el('p','No portable catalog servers in this setup.',root);
  for(const s of draft.servers) select(s.catalogId,[['true','Enabled'],['false','Disabled']],String(s.enabled),v=>s.enabled=v==='true');
  el('p','Custom commands, endpoints, environment variables, keys and sign-ins stay on each computer.',root);
  let stale=false;
  action(root,'Save for local review',async()=>{
    if(stale)return;
    try{const saved=await api(path,'PUT',{baseRevision:doc.revision,setup:draft});doc=saved;summary.querySelector('small').textContent=stamp();feedback(root,'Saved revision '+doc.revision+'. No computer has been changed.');}
    catch(err){if(err.status!==409)throw err;stale=true;feedback(root,'Another edit was saved first. Your changes were not saved. Reload the latest setup before editing again.');action(root,'Reload latest setup',refresh);}
  });
}
