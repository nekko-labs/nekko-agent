import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_ENGINE_SETTINGS } from '@nekko-agent/shared';
import { EngineSection } from '../src/renderer/components/engine/EngineSection';

// The Model server card as a Windows machine with an NVIDIA card saw it after a
// broken CUDA install: installed, running, one model resident, and (with this
// change) told that the engine is missing its GPU libraries. Every host call is
// a stub; nothing here reaches a real engine, network or settings file.
const cuda = { id: 'win-x64-cuda', platform: 'win32', arch: 'x64', backend: 'cuda', assetPattern: 'bin-win-cuda', requires: 'An NVIDIA GPU with a current driver.', companionPattern: 'cudart-llama' };
const installs: any[] = [];
const status: any = {
  install: {
    binPath: 'C:\\Users\\you\\.nekko-agent\\engine\\win-x64-cuda\\llama-server.exe',
    source: 'managed',
    backend: 'cuda',
    version: 'b11224',
    installedAt: Date.now() - 86_400_000,
    problem: {
      message: 'The NVIDIA engine is missing its GPU libraries, so models are running on the processor and replies will be very slow or never arrive. Repair it to use your graphics card.',
      repairBuildId: 'win-x64-cuda',
    },
    available: [cuda],
    recommended: cuda,
  },
  diffusionInstall: { available: [] },
  mlxInstall: { available: [] },
  running: true,
  startedAt: Date.now() - 600_000,
  resident: [{ id: 'chat/unsloth_Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M', name: 'Qwen3-4B', port: 58976, loadedAt: Date.now() - 300_000, lastUsedAt: Date.now() - 1000 }],
  loading: [],
  log: [],
  port: 11500,
  settings: { ...DEFAULT_ENGINE_SETTINGS, port: 11500 },
};
const noop = async () => ({ ok: true, message: '' });
(window as any).nekko = new Proxy(
  {
    engineStatus: async () => status,
    engineModels: async () => [],
    engineDownloads: async () => [],
    engineCatalog: async () => [],
    onDownloadsUpdated: () => () => {},
    engineInstall: async (buildId?: string) => { installs.push(buildId); (window as any).__installs = installs; return { ok: true, message: 'Downloading llama.cpp b11224.', jobId: 'engine:llama:win-x64-cuda' }; },
    engineInstallPreview: async () => null,
    apiServerStatus: async () => null,
    engineFolders: async () => [],
  },
  { get: (target: any, key: string) => (key in target ? target[key] : noop) },
);

function Fixture() {
  return (
    <div className="fixture-shell">
      <main>
        <EngineSection onProvidersChanged={() => {}} onOpenModel={() => {}} />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
