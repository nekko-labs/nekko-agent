import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EngineLoadDrawer } from '../src/renderer/components/engine/EngineLoadDrawer';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';
import data from './model-tuning-fixture.json';

// Synthetic records only: no host, daemon or engine. Recommendations, the old
// drawer's auto-fit and plan answers are the real Rust planner's, dumped by
// `crates/nekko-engine/tests/placement.rs::dump_fixture`. `runtimePlace` is a
// fixture-only copy of `placement::place` so clicks move the meter; the sandbox
// checks it against the dumped answer for the recommended request.
const GB = 1024 ** 3;
const MB = 1024 ** 2;
type Scenario = keyof typeof data;
const MODELS: Record<string, any> = {
  moe8: { id: 'flash-next', name: 'Qwen Flash-Next Coder', parameterSize: '80B-A3B', quantization: 'IQ3_XXS', architecture: 'qwen4exp' },
  dense24: { id: 'qwen3-14b', name: 'Qwen3 14B', parameterSize: '14B', quantization: 'Q4_K_M', architecture: 'qwen3' },
  dense8: { id: 'qwen3-14b', name: 'Qwen3 14B', parameterSize: '14B', quantization: 'Q4_K_M', architecture: 'qwen3' },
};
let scenario: Scenario = 'moe8';

function place(req: any) {
  const d = data[scenario] as any;
  const f = d.facts, hw = d.hardware;
  const dev = hw.devices[0];
  const unified = hw.unified && !!dev;
  const runOn = dev ? req.runOn : 'cpu';
  const L = f.layers, W = f.weightsBytes, w = f.weightLayout;
  const ctxTotal = req.contextTokens * req.sessions;
  const per = { f16: 2, q8_0: 1, q4_0: 0.5 }[req.kvCacheDtype as 'f16'] ?? 2;
  const kv = f.kvPerToken * ctxTotal * per;
  const overhead = 256 * MB + L * (f.headDim ?? 128) * 4 * Math.min(ctxTotal, 8192);
  const table = W * w.tableShare, body = W - table;
  const expert = (W * w.expertShare) / L, ffn = (W * w.ffnShare) / L;
  const rest = Math.max(0, body / L - expert - ffn);
  const vram = { weightsBytes: 0, kvCacheBytes: 0, overheadBytes: 0, pinnedBytes: 0 };
  const ram = { weightsBytes: 0, kvCacheBytes: 0, overheadBytes: 0, pinnedBytes: 0 };
  let diskTables = 0, overflow = 0;
  if (table > 0 && req.mmap && req.tablesOnDisk) diskTables = table; else ram.weightsBytes += table;
  if (unified || runOn === 'gpu') Object.assign(vram, { weightsBytes: body, kvCacheBytes: kv, overheadBytes: overhead });
  else if (runOn === 'cpu') { ram.weightsBytes += body; ram.kvCacheBytes = kv; ram.overheadBytes = overhead; }
  else {
    const g = Math.min(req.gpuLayers, L);
    const onGpu = (n: number) => Math.min(g, Math.max(0, L - n));
    const gw = g * rest + onGpu(w.expertShare > 0 ? req.cpuMoeLayers : 0) * expert + onGpu(req.cpuFfnLayers) * ffn;
    const gkv = req.kvOnGpu ? (kv * g) / L : 0;
    Object.assign(vram, { weightsBytes: gw + req.moeCacheBytes, kvCacheBytes: gkv, overheadBytes: overhead });
    ram.weightsBytes += body - gw; ram.kvCacheBytes = kv - gkv;
    if (body - gw > 0) ram.overheadBytes = 512 * MB;
  }
  if (req.pin && !unified) { ram.pinnedBytes = vram.weightsBytes - Math.min(req.moeCacheBytes, vram.weightsBytes) + diskTables; diskTables = 0; }
  const sum = (s: any) => s.weightsBytes + s.kvCacheBytes + s.overheadBytes + s.pinnedBytes;
  const vAvail = dev ? dev.freeBytes : 0, rAvail = Math.max(0, hw.ramFreeBytes - 2 * GB);
  let verdict = 'fits', reason: string | undefined, shortBy = 0;
  if (sum(vram) > vAvail) { verdict = 'wont-load'; reason = 'vram'; shortBy = sum(vram) - vAvail; }
  else if (sum(ram) > rAvail) {
    const over = sum(ram) - rAvail, pageable = req.mmap && !req.pin ? ram.weightsBytes : 0;
    if (over <= pageable) { verdict = 'disk'; overflow = over; } else { verdict = 'wont-load'; reason = 'ram'; shortBy = over - pageable; }
  } else if ((vAvail - sum(vram) < 768 * MB && sum(vram) > 0) || rAvail - sum(ram) < GB) verdict = 'tight';
  return {
    verdict, reason, shortByBytes: shortBy, unified, deviceName: dev?.name ?? null,
    vram: { totalBytes: dev?.totalBytes ?? 0, otherBytes: dev ? dev.totalBytes - dev.freeBytes : 0, availBytes: vAvail, model: vram },
    ram: { totalBytes: hw.ramTotalBytes, otherBytes: hw.ramTotalBytes - hw.ramFreeBytes, availBytes: rAvail, model: ram },
    disk: { tableBytes: diskTables, overflowBytes: overflow },
    spareVramBytes: Math.max(0, vAvail - sum(vram) - 768 * MB),
  };
}

const loads: any[] = [];
const bridge: any = {
  runtimeAutoFit: async () => (data[scenario] as any).autoFit,
  runtimePlan: async () => (data[scenario] as any).planFit,
  runtimePlace: async (_p: string, _m: string, req: any) => place(req),
  runtimeRecommend: async (_p: string, _m: string, opts: any = {}) => {
    const d = data[scenario] as any;
    if (opts.goal === 'context') return d.context;
    if (opts.goal === 'fill') {
      // The lightest split that keeps the asked-for context, as `Goal::Fill` searches.
      const moe = d.facts.weightLayout.expertShare > 0;
      const base = { ...opts.request, runOn: 'hybrid', gpuLayers: d.facts.layers, cpuMoeLayers: 0, cpuFfnLayers: 0 };
      for (let n = 0; n <= d.facts.layers; n++) {
        const r = { ...base, [moe ? 'cpuMoeLayers' : 'cpuFfnLayers']: n };
        const p = place(r);
        if (p.verdict === 'fits' || p.verdict === 'tight' || p.verdict === 'disk') return { request: r, plan: p, why: [] };
      }
      return null;
    }
    return d.speed;
  },
  runtimeLoad: async (_p: string, _m: string, params: any) => { loads.push(params); return { ok: true, message: 'Loaded.' }; },
  engineSaveModelPreset: async () => {},
  engineModels: async () => [],
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = (opts: { scenario?: Scenario; preset?: any } = {}) => {
    scenario = opts.scenario ?? 'moe8';
    loads.length = 0;
    useStore.setState({ toasts: [] } as any);
    (window as any).__preset = opts.preset;
    setEpoch((e) => e + 1);
  };
  Object.assign(window, { integration: { reset, loads: () => loads, place, data } });
  const d = data[scenario] as any;
  const model = {
    ...MODELS[scenario],
    path: '/fixture/model.gguf', file: '/fixture/model.gguf', format: 'gguf', modality: 'chat', readable: true, addedAt: 0,
    sizeBytes: d.facts.weightsBytes, layers: d.facts.layers, maxContext: d.facts.maxContext, kvHeads: 8,
    weightLayout: d.facts.weightLayout, loaded: false, preset: (window as any).__preset,
  };
  return (
    <div className="bg-paper" style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }} className="rounded-xl" key={epoch}>
        <EngineLoadDrawer providerId="nekko-engine" model={model} onDone={() => {}} onClose={() => {}} onToggleAutoload={() => {}} />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
