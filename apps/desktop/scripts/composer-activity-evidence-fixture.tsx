import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';
import { saveDraft } from '../src/renderer/composerDrafts';
import { applyEvent } from '../src/renderer/liveRuns';
import { ToolCard } from '../src/renderer/components/agent-console/ToolCard';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup';
import { PlanRail } from '../src/renderer/components/PlanRail';
import * as Cue from '../src/renderer/components/agent-console/SubagentCue';
import '../src/renderer/styles.css';
const provider = { id:'fixture',kind:'openai',enabled:true,label:'Fixture provider',auth:'subscription',tokenKey:'fixture' };
const models = [{id:'fixture-model',providerId:'fixture',name:'Fixture model',contextWindow:128000}];
const records:any[] = ['left','right'].map(id=>({id,title:'Synthetic '+id,createdAt:1,updatedAt:1,providerId:'fixture',modelId:'fixture-model',mode:'agent',chatType:'multimodal',messages:[{id:id+'-a',role:'assistant',content:'Synthetic reply for isolated layout verification.',createdAt:1}],attachments:[],queue:[]}));
const bridge:any = {listSessionSummaries:async()=>records.map(summarizeSession),listTerminals:async()=>[],getSession:async(id:string)=>records.find(s=>s.id===id),listModels:async()=>models,pendingInput:async()=>({}),runningSessions:async()=>[],listTasks:async()=>[],listShells:async()=>[],listChanges:async()=>[],listFiles:async()=>[],previewContext:async()=>({items:[],totalTokens:0,budget:128000}),getGitStatus:async()=>({repo:false}),listTools:async()=>[],getMcpStatus:async()=>[],listSkills:async()=>[],updateSettings:async(p:any)=>({...useStore.getState().settings,...p})};
Object.assign(window,{nekko:new Proxy(bridge,{get(t,k:string){if(k in t)return t[k];if(k.startsWith('on'))return()=>()=>{};return()=>Promise.resolve(null);}})});
localStorage.clear();
useStore.setState({view:'command',providers:[provider],models,activeProviderId:'fixture',sessions:records.map(summarizeSession),terminals:[],workspaces:[],activeWorkspaceId:null,activeSessionId:null,settings:{providers:[provider],workspaceFolders:[],workspaces:[],theme:'dark',experimental:{},agent:{},ui:{},commandWall:{...DEFAULT_WALL_STATE,root:{id:'split',dir:'row',children:[{id:'pane-left',kind:'chat',refId:'left'},{id:'pane-right',kind:'chat',refId:'right'}],sizes:[.5,.5]},hero:'right',autoAdd:false,watermark:Date.now(),dock:{...DEFAULT_WALL_STATE.dock,show:false},agentPanel:{show:false,orientation:'vertical'}}},activeSkillBySession:{},prsBySession:{},installedSkillDefs:[],contextPanelOpen:false,planRailOpen:false} as any);
records.forEach(putCachedSession);
// Observe the parent calls before creating children, as a real spawn lifecycle does.
// Historical timestamps cannot be associated with a newly observed live call.
const statuses = ['working','question','approval','completed','error','stopped'];
statuses.forEach(status=>applyEvent({type:'tool_call',sessionId:'parent',call:{id:'call-'+status,name:'spawn_agent',input:{title:'Fixture '+status,task:'Inspect the actual fixture.'}}} as any));
const children = statuses.map(status=>({id:'child-'+status,title:'Fixture '+status,parentSessionId:'parent',createdAt:Date.now(),updatedAt:Date.now()}));
const call=(status:string)=>({id:'call-'+status,name:'spawn_agent',input:{title:'Fixture '+status,task:('Inspect the actual fixture.\n'+'Large task detail '.repeat(20)+'\n').repeat(80)}});
function Gallery(){
 const Parent=(Cue as any).SubagentParentContext?.Provider || ((p:any)=>p.children);
 return <Parent value={children}><div data-gallery style={{display:'flex',height:'100vh',padding:16,gap:16,background:'var(--paper)',color:'var(--ink)'}}><div style={{flex:1,minWidth:0,overflow:'auto'}}>{children.map(c=><section key={c.id} data-status={c.id.slice(6)} style={{marginBottom:14}}><h3>{c.title}</h3><div data-tool><ToolCard call={call(c.id.slice(6)) as any}/></div><div data-activity><ActivityGroup streaming items={[{kind:'tool',call:call(c.id.slice(6)),result:{toolCallId:call(c.id.slice(6)).id,output:('Large complete result paragraph.\n\n').repeat(120)}}] as any}/></div></section>)}</div><div style={{width:260,flexShrink:0}}><PlanRail sessionId="parent" session={{id:'parent',agentPlan:[{id:'one',title:'Inspect live statuses',status:'active'}]} as any} streaming onChangePlan={()=>{}}/></div></div></Parent>;
}
function Fixture(){
 const [epoch,setEpoch]=useState(0);const [gallery,setGallery]=useState(false);const [page,setPage]=useState('command');
 const reset=(opts:any={})=>{
 records[1].queue=opts.extras?[{text:'Review queued fixture',images:[],skill:{name:'fixture-review'}}]:[];
 saveDraft('right',{text:opts.text||'',images:opts.extras?['data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#519"/><text x="10" y="35" fill="white">Fixture</text></svg>')]:[]});
 const st=useStore.getState();useStore.setState({sessions:opts.gallery?children:records.map(summarizeSession),activeSkillBySession:opts.extras?{right:{name:'fixture-review',description:'Synthetic skill',template:'Review fixture',variables:[],tags:[],kind:'prompt'}}:{},settings:{...st.settings,commandWall:{...st.settings.commandWall,composer:{...st.settings.commandWall.composer,height:opts.manual?330:null}}}} as any);
 records.forEach(r=>putCachedSession({...r}));setGallery(!!opts.gallery);setEpoch(e=>e+1);
 };
 Object.assign(window,{integration:{reset,page:setPage,state:()=>useStore.getState(),seedImage:()=>useStore.setState({composerSeed:{sessionId:'right',text:'',images:['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=']}} as any),event:(e:any)=>applyEvent(e)}});
 return <main key={epoch} style={{height:'100vh',width:'100vw',display:'flex',flexDirection:'column'}}>{gallery?<Gallery/>:page==='command'?<div style={{flex:1,minHeight:0,display:'flex',flexDirection:'column'}}><CommandCenterView/></div>:<div>Other page</div>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
