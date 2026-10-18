import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { clearLiveRun } from '../src/renderer/liveRuns';
import { ChatPane } from '../src/renderer/components/ChatPane';
import { setRemoteImageFetcher } from '../src/renderer/remoteImages';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon, and
// the sandbox cancels every non-file request, so the "web photos" here come
// from the fake bridge's fetchRemoteImage, drawn on a canvas: no third-party
// image is shown or published.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now() - 3_600_000;

export const PHOTOS = {
  hero: 'https://img.example.com/mounts/mh-853b-front.jpg',
  a: 'https://img.example.com/mounts/mh-853b-tilt.jpg',
  b: 'https://cdn.shop.example/p/mh-853w-white.png',
  c: 'https://cdn.shop.example/p/mh-853-installed.webp',
  untrusted: 'https://tracker.example.net/pixel.png?chat=wall-mount',
};
const FILLER = 14;

function makeSession() {
  const call = { id: 'c1', name: 'fetch_url', input: { url: 'https://shop.example/mh-853' } };
  const messages: any[] = [
    { id: 'u0', role: 'user', content: 'What does the HAMILeX MH-853 look like? Show me a few photos.', createdAt: at },
    { id: 'a0x', role: 'assistant', content: 'Searching for product photos.', createdAt: at + 1000, toolCalls: [call] },
    { id: 't0', role: 'tool', content: '', createdAt: at + 2000, toolResult: { toolCallId: 'c1', output: `MH-853B wall mount\n[image: front] (${PHOTOS.hero})\n<img src="${PHOTOS.a}">\n${PHOTOS.b}\n${PHOTOS.c}` } },
    { id: 'a0', role: 'assistant', createdAt: at + 5000, content: [
      'The MH-853 is a **tilting wall mount** for large flat-panel TVs. Here is the official product shot:',
      '',
      `![MH-853B, front](${PHOTOS.hero})`,
      '',
      'A few more angles:',
      '',
      `![Tilted forward 12°](${PHOTOS.a})`,
      `![White version, MH-853W](${PHOTOS.b})`,
      `![Installed with a 75" TV](${PHOTOS.c})`,
      '',
      `And one the model made up, which waits for you: ![tracking pixel](${PHOTOS.untrusted})`,
    ].join('\n') },
  ];
  // Enough later turns that the photo reply starts well off-screen: proof that
  // nothing is fetched until it is scrolled near.
  for (let i = 1; i <= FILLER; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: `Follow-up question ${i} about mounting height and studs?`, createdAt: at + i * 20_000 });
    messages.push({ id: `a${i}`, role: 'assistant', content: `Answer ${i}: mount it so the screen centre sits near eye level, and use at least two studs. The plate is 750 mm wide, so it spans two studs at 400 mm centres.`, createdAt: at + i * 20_000 + 5000 });
  }
  return { id: 'alpha', title: 'Remote photos fixture', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] };
}

/** A synthetic "photo": a lit wall, a black mount, a label. Distinct per URL. */
function drawPhoto(url: string): string {
  const seed = [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const w = 960, h = url.includes('installed') ? 720 : 600;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  const hue = seed % 360;
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${hue} 30% 88%)`); bg.addColorStop(1, `hsl(${(hue + 40) % 360} 25% 70%)`);
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const white = url.includes('white');
  g.save(); g.translate(w / 2, h / 2); g.rotate(url.includes('tilt') ? -0.12 : 0);
  g.fillStyle = white ? '#f4f4f2' : '#1b1b1d'; g.strokeStyle = white ? '#bdbdb8' : '#000';
  g.lineWidth = 4; g.fillRect(-300, -110, 600, 220); g.strokeRect(-300, -110, 600, 220);
  g.fillStyle = `hsl(${hue} 30% 80%)`;
  for (const x of [-220, -40, 140]) g.fillRect(x, -60, 90, 120);
  g.fillStyle = white ? '#e6e6e2' : '#2a2a2d';
  for (const x of [-170, 150]) g.fillRect(x, -170, 34, 340);
  if (url.includes('installed')) { g.fillStyle = '#0d0f14'; g.fillRect(-380, -230, 760, 430); g.fillStyle = '#3b6fd8'; g.fillRect(-360, -210, 720, 390); }
  g.restore();
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, h - 44, w, 44);
  g.fillStyle = '#fff'; g.font = '600 20px system-ui, sans-serif';
  g.fillText(`synthetic photo · ${new URL(url).hostname}${new URL(url).pathname}`, 16, h - 16);
  return cv.toDataURL('image/png');
}

const fetched: string[] = [];
let inFlight = 0, peak = 0;
const bridge: any = {
  getSession: async () => record, listModels: async () => models, listSessionSummaries: async () => [], listTerminals: async () => [],
  getUsageSummary: async () => ({ totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {}, daily: [] }),
  pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }), getUpdateInfo: async () => null,
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], getLimitsProblem: async () => null, getLimits: async () => null,
  nextAgentWatchAt: async () => null,
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
  // The host's image:fetch, faked: slow enough to see the skeleton, drawn locally.
  fetchRemoteImage: async (url: string) => {
    fetched.push(url); inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, (window as any).integration?.delay ?? 700));
    inFlight -= 1;
    const dataUrl = drawPhoto(url);
    return { dataUrl, mime: 'image/png', bytes: Math.round(dataUrl.length * 0.75), finalUrl: url };
  },
  openPath: async (p: string) => { (window as any).opened = p; },
};
let record: any = makeSession();
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = () => {
    clearLiveRun('alpha');
    // A fresh run per theme: no cached photos, an empty fetch log.
    setRemoteImageFetcher(null);
    fetched.length = 0; peak = 0;
    record = makeSession();
    localStorage.clear();
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false, paletteOpen: false } as any);
    putCachedSession(record);
    setEpoch((e) => e + 1);
  };
  Object.assign(window, { integration: { ...(window as any).integration, reset, fetched, photos: PHOTOS, stats: () => ({ fetched: [...fetched], peak }) } });
  React.useEffect(() => reset(), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
