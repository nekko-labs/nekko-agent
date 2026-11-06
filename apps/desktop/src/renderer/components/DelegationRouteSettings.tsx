import React, { useEffect, useRef, useState } from 'react';
import { isChatModel, DEFAULT_ORCHESTRATION } from '@nekko-agent/shared';
import type { AppSettings, ModelInfo } from '@nekko-agent/shared';

export function DelegationRouteSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> }) {
  const cur = settings.orchestration ?? DEFAULT_ORCHESTRATION;
  const route = cur.delegationRoute;
  const [providerId, setProviderId] = useState(route?.providerId ?? '');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = async (id: string) => {
    const token = ++generation.current;
    setModels([]);
    if (!id) { setStatus(''); setBusy(false); return; }
    setBusy(true);
    setStatus('Checking available chat models…');
    try {
      const found = (await window.nekko.listModels(id)).filter((m) => m.providerId === id && isChatModel(m));
      if (token !== generation.current) return;
      setModels(found);
      setStatus(found.length ? 'Select an exact model. Saved routes are checked again before delegation.' : 'No chat models available. Install or load a model in Models, then refresh.');
    } catch {
      if (token === generation.current) setStatus('Could not list models. Check service availability and credentials in Models, then refresh.');
    } finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => { void refresh(providerId); return () => { generation.current++; }; }, [providerId]);
  return <div className="mt-4 border-t border-line pt-4">
    <h3 className="text-sm font-medium">Delegation route</h3>
    <p className="mt-1 text-2xs text-ink-faint">Inherit the parent by default, or explicitly choose a worker. Unavailable routes never fall back. An external cloud route sends delegated task content to that provider.</p>
    <select className="input mt-3 w-full" aria-label="Delegation provider" value={providerId} onChange={(e) => { setProviderId(e.target.value); if (!e.target.value) void update({ orchestration: { ...cur, delegationRoute: undefined } }); }}>
      <option value="">Inherit parent provider and model</option>
      {route && !settings.providers.some((p) => p.enabled && p.id === route.providerId) && <option value={route.providerId}>Saved provider (unavailable)</option>}
      {settings.providers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select>
    {providerId && <>
      <div className="mt-2 flex gap-2">
        <select className="input min-w-0 flex-1" aria-label="Delegation model" disabled={busy} value={route?.providerId === providerId ? route.modelId : ''} onChange={(e) => { if (e.target.value) void update({ orchestration: { ...cur, delegationRoute: { providerId, modelId: e.target.value } } }); }}>
          <option value="">Choose a model to save this route</option>
          {route?.providerId === providerId && !models.some((m) => m.id === route.modelId) && <option value={route.modelId}>{route.modelId} (not verified)</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.id}</option>)}
        </select>
        <button className="btn" disabled={busy} onClick={() => void refresh(providerId)}>Refresh</button>
      </div>
      <p role="status" className="mt-2 text-2xs text-ink-faint">{status}</p>
    </>}
  </div>;
}
