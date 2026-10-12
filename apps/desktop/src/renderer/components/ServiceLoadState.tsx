import { hasAppChrome } from '../chrome.js';

export function ServiceLoadState({ label, error, retry }: { label: string; error: string | null; retry: () => Promise<void> }) {
  return <div className="mx-auto max-w-xl px-6 py-8" role={error ? 'alert' : 'status'}>
    <p className="text-[14px] font-medium">{error ? `Could not load ${label}` : `Loading ${label}…`}</p>
    {error && <>
      <p className="mt-2 break-words text-[13px] text-ink-soft">{error}</p>
      <p className="mt-2 text-[12px] text-ink-faint">{hasAppChrome ? 'If the service is stopped, start it from the tray menu, then try again.' : 'Check that the Nekko service is running, then try again.'}</p>
      <button className="btn btn-outline mt-4" onClick={() => void retry()}>Try again</button>
    </>}
  </div>;
}

