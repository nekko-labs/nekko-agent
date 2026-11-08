import React, { useEffect, useId, useState } from 'react';
import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { claudeConnectionDetail, claudeConnectionLabel } from './claudeConnections.js';

function Identity({ provider }: { provider: ProviderConfig }) {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  useEffect(() => {
    if (provider.kind !== 'claude-code') return;
    let live = true;
    void window.nekko.getClaudeCodeStatus(provider.id)
      .then(next => { if (live) setStatus(next); })
      .catch(() => { if (live) setStatus({ installed: false, message: 'Identity check unavailable' }); });
    return () => { live = false; };
  }, [provider.id, provider.kind]);
  return <p className="mt-2 break-words text-xs text-ink-soft" role="status">{claudeConnectionDetail(provider, status)}</p>;
}

export function ClaudeConnectionPicker({ providers, selected, currentId, onSelect }: {
  providers: ProviderConfig[];
  selected: string;
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  const provider = providers.find(p => p.id === selected);
  return <div className="mb-2 min-w-0 rounded-lg border border-line p-3" data-claude-connection>
    <label htmlFor={id} className="mb-1 block text-xs font-semibold text-ink">Claude connection</label>
    <select id={id} className="input w-full min-w-0 text-xs" value={selected} onChange={e => onSelect(e.target.value)} aria-describedby={`${id}-help`}>
      {providers.map(p => <option key={p.id} value={p.id}>{claudeConnectionLabel(p)}{p.id === currentId ? ' (this chat)' : ''}</option>)}
      <option value="all">All providers</option>
    </select>
    {provider && <Identity key={`${provider.id}:${provider.claudeCode?.account ?? ''}`} provider={provider} />}
    <p id={`${id}-help`} className="mt-2 text-2xs text-ink-faint">Choose a model below to use this connection. No account changes until you pick a model.</p>
    {(!provider || provider.kind === 'claude-code') && <p className="mt-1 text-2xs text-ink-faint">Changing subscription profiles starts a new Claude Code conversation. History stays here; start a new chat to keep work separate.</p>}
  </div>;
}
