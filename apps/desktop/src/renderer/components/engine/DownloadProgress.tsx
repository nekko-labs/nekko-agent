import './downloadProgress.css';
import type { DownloadGroup } from './downloadGroups.js';

/** Native progress is indeterminate until the host knows every file's size. */
export function DownloadProgress({ group }: { group?: DownloadGroup }) {
  const percent = group?.totalBytes && Number.isFinite(group.receivedBytes)
    ? Math.max(0, Math.min(100, Math.round(group.receivedBytes / group.totalBytes * 100))) : undefined;
  const label = group?.jobs.some(j => j.state === 'verifying') && !group.jobs.some(j => j.state === 'downloading' || j.state === 'queued')
    ? 'Verifying…' : 'Downloading…';
  return <div className="mt-1 min-w-[120px] max-w-full text-2xs text-ink-faint" role="status">
    <span>{label}{percent !== undefined ? ` ${percent}%` : ''}</span>
    <progress className="engine-download-progress mt-1 block h-1.5 w-full" style={{ accentColor: 'var(--accent)' }} aria-label="Download progress" role="progressbar" max={100} value={percent} aria-valuenow={percent} />
  </div>;
}
