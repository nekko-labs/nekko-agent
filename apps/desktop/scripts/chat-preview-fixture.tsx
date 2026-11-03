import React from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/renderer/components/Markdown';
import '../src/renderer/styles.css';
(window as any).nekko = { openPath: () => {}, onAgentEvent: () => () => {} };
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<div style={{height:'100vh', background:'var(--paper)', color:'var(--ink)', padding:'80px 40px', boxSizing:'border-box'}}><div style={{maxWidth:720, margin:'auto'}}><h2>Choose a live spinner</h2><Markdown text={'Here are a few live options to compare:\n\n- [Lucide Loader Circle](https://lucide.dev/icons/loader-circle)\n- [CSS Loaders: spinners](https://css-loaders.com/spinner/)\n- [UI Ball LDRS](https://uiball.com/ldrs/)'} /></div></div>);
