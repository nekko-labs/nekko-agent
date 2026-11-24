export function el(tag, text, parent) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  parent?.append(node);
  return node;
}
export function feedback(parent, text) {
  if (!parent.isConnected) return;
  parent.querySelector(':scope > .feedback')?.remove();
  const p = el('p', text, parent); p.className = 'feedback'; p.setAttribute('role','alert');
}
export function action(parent, title, run) {
  const b = el('button', title, parent); b.type='button';
  b.onclick = async () => { b.disabled=true; try { await run(); } catch(e) { feedback(parent,e.message); } finally { b.disabled=false; } };
  return b;
}
export function form(parent,title,fields,run) {
  const f=el('form',null,parent), inputs={};
  for(const [name,label,type,choices] of fields){
    const wrap=el('label',label,f), i=el(choices?'select':'input',null,wrap);
    if(choices) for(const v of choices) el('option',v,i).value=v;
    else {i.type=type||'text'; i.maxLength=type==='email'?254:100;}
    i.name=name; i.required=true; inputs[name]=i;
  }
  const b=el('button',title,f); b.type='submit';
  f.onsubmit=async e=>{e.preventDefault(); if(b.disabled)return; b.disabled=true; try {await run(Object.fromEntries(Object.entries(inputs).map(([k,i])=>[k,i.value.trim()])));}catch(err){feedback(f,err.message);}finally{b.disabled=false;}};
  return f;
}
export function row(parent,title,sub){const r=el('div',null,parent);r.className='row';const d=el('div',null,r);el('strong',title,d);if(sub)el('small',sub,d);return r;}
export function disclosure(parent,title){const d=el('details',null,parent);el('summary',title,d);return d;}
