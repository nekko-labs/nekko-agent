import { MiddleTruncate } from '../components/primitives/MiddleTruncate.js';

/** A Models page row's name: clicking it makes the model the default for new chats. */
export function ModelRowName({ name, isDefault, onSetDefault }: { name: string; isDefault: boolean; onSetDefault: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={isDefault}
      title={isDefault ? 'Default model' : 'Set as default'}
      className="flex min-w-0 items-center gap-2 rounded-sm text-left hover:text-accent"
      onClick={() => { if (!isDefault) onSetDefault(); }}
    >
      <MiddleTruncate text={name} tail={20} className="font-mono" />
      {isDefault && <span className="shrink-0 text-2xs text-accent">Default</span>}
    </button>
  );
}
