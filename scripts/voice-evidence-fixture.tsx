import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { VoiceSettings } from '../apps/desktop/src/renderer/components/VoiceSettings';
import '../apps/desktop/src/renderer/styles.css';
// Apple ready and no engine chosen yet: the state a Mac is in on the first click.
const status: any = { installed: true, installing: false, progress: 0, running: false, supported: false, engine: 'apple', apple: { supported: true, installed: true, installing: false, locale: 'en-US' }, whisper: { installed: false, installing: false, progress: 0 } };
const bridge: any = { voiceStatus: async () => status, updateSettings: async (p: any) => ({ ...useStore.getState().settings, voice: { ...useStore.getState().settings?.voice, ...p.voice } }) };
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; return () => Promise.resolve(null); } }) });
useStore.setState({ settings: { providers: [], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, voice: {} } } as any);
function Fixture() { const [epoch] = useState(0); return <main data-evidence-route="voice" className="bg-paper" style={{ minHeight: '100vh', padding: 24 }} key={epoch}><div className="card w-[520px] p-5"><h4 className="text-[14px] font-semibold">System models</h4><div className="mt-2"><VoiceSettings compact /></div></div></main>; }
createRoot(document.getElementById('root')!).render(<Fixture />);
