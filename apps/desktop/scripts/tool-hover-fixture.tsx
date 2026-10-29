import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles.css';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup.js';
createRoot(document.getElementById('root')!).render(<div style={{padding:32,maxWidth:900}}><ActivityGroup streaming items={[{kind:'tool',call:{id:'read',name:'read_file',input:{path:'/workspace/nekko-agent/apps/desktop/src/renderer/components/agent-console/ActivityGroup.tsx',start_line:1,end_line:220}}}]} /></div>);
