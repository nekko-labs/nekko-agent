import React, { useEffect, useState } from 'react';
import type { MemoryEntry, MemoryScope } from '@nekko-agent/shared';
import { PlusIcon, TrashIcon } from '../icons.js';
import { hasAppChrome } from '../chrome.js';
import { useStore } from '../store.js';

export function MemoryView() {
  const [scope, setScope] = useState<MemoryScope>('global');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);

  const load = async () => setEntries(await window.nekko.listMemory(scope));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope]);

  // A chat's memory card opens the note it saved, which is always global.
  const memoryFocus = useStore((s) => s.memoryFocus);
  useEffect(() => {
    if (!memoryFocus) return;
    useStore.setState({ memoryFocus: null });
    setScope('global');
    window.nekko.listMemory('global').then((all) => {
      setEntries(all);
      const want = memoryFocus.trim().toLowerCase();
      const note = all.find((m) => m.title.trim().toLowerCase() === want);
      if (note) setEditing(note);
    });
  }, [memoryFocus]);

  const blank = (): MemoryEntry => ({
    id: `m_${Date.now().toString(36)}`,
    scope,
    title: '',
    body: '',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const save = async () => {
    if (!editing) return;
    await window.nekko.saveMemory(editing);
    setEditing(null);
    load();
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-72 flex-col border-r border-line">
        <div className="flex items-center justify-between p-4">
          {!hasAppChrome && <h1 className="view-title">Memory</h1>}
          <button className="btn btn-primary ml-auto px-2.5 py-1.5" onClick={() => setEditing(blank())}><PlusIcon /></button>
        </div>
        <div className="px-3">
          <div className="flex rounded-xl p-1" style={{ background: 'var(--surface-2)' }}>
            {(['global', 'workspace'] as MemoryScope[]).map((s) => (
              <button key={s} onClick={() => setScope(s)} className={`flex-1 rounded-lg py-1.5 text-xs font-medium ${scope === s ? 'bg-surface' : 'text-ink-faint'}`}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {entries.length === 0 && <p className="px-2 text-xs text-ink-faint">No memories. These are injected into context automatically.</p>}
          {entries.map((m) => (
            <div key={m.id} className="card cursor-pointer p-3" onClick={() => setEditing(m)}>
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium">{m.title || '(untitled)'}</span>
                <button className="text-ink-faint" onClick={async (e) => { e.stopPropagation(); await window.nekko.deleteMemory(m.id); load(); }}>
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-0.5 line-clamp-2 text-2xs text-ink-faint">{m.body}</p>
            </div>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col p-6">
        {editing ? (
          <div className="mx-auto w-full max-w-2xl space-y-3">
            <input className="input text-xl font-semibold" placeholder="Title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            <input className="input" placeholder="tags, comma separated" value={editing.tags.join(', ')} onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
            <textarea className="input min-h-[300px] resize-none" placeholder="What should Nekko Agent remember?" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl text-2xl" style={{ background: 'var(--accent-soft)' }}>🧠</div>
            <div>
              <h2 className="text-xl font-semibold">Nekko Agent's long-term memory</h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-faint">
                Notes saved here are injected into every chat's context. Select one on the left, or write a new one.
              </p>
            </div>
            <button className="btn btn-primary" onClick={() => setEditing(blank())}><PlusIcon className="h-4 w-4" /> New memory</button>
          </div>
        )}
      </section>
    </div>
  );
}
