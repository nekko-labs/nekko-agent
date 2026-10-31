import { useEffect, useState } from 'react';
import type { ProviderConfig } from '@nekko-agent/shared';
import { CheckIcon, CopyIcon, PencilIcon } from '../../icons.js';

/**
 * The server's address, ready to copy and easy to change.
 *
 * Copying an address is one of the two things people do most on this page (the
 * other is turning the server on), and until now it meant selecting text by hand.
 * Editing re-detects on save, so a corrected port shows its result immediately
 * rather than leaving the card stale.
 */

export function AddressField({
  provider,
  onSaved,
}: {
  provider: ProviderConfig;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(provider.baseUrl);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(provider.baseUrl);
  }, [provider.baseUrl]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(provider.baseUrl);
      setCopied(true);
    } catch {
      /* a denied clipboard is not worth an error toast */
    }
  };

  const save = async () => {
    const next = value.trim();
    if (!next || next === provider.baseUrl) {
      setEditing(false);
      setValue(provider.baseUrl);
      return;
    }
    setSaving(true);
    await window.nekko.saveProvider({ ...provider, baseUrl: next }).catch(() => {});
    setSaving(false);
    setEditing(false);
    onSaved();
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          className="input flex-1 py-1 font-mono text-2xs"
          value={value}
          autoFocus
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setValue(provider.baseUrl);
              setEditing(false);
            }
          }}
        />
        <button className="btn btn-outline px-2 py-1 text-2xs" onClick={save} disabled={saving}>
          {saving ? 'Saving' : 'Save'}
        </button>
        <button
          className="btn btn-ghost px-2 py-1 text-2xs"
          onClick={() => {
            setValue(provider.baseUrl);
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <code className="flex-1 truncate font-mono text-2xs text-ink-faint">{provider.baseUrl}</code>
      <button
        className="btn btn-ghost px-2 py-1"
        onClick={copy}
        title={copied ? 'Copied' : 'Copy this address'}
        aria-label="Copy address"
      >
        {copied ? (
          <span style={{ color: 'var(--success)' }}>
            <CheckIcon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        className="btn btn-ghost px-2 py-1"
        onClick={() => setEditing(true)}
        title="Change this address"
        aria-label="Edit address"
      >
        <PencilIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
