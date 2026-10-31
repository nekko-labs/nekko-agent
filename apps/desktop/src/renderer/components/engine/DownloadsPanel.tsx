import type { DownloadJob } from '@nekko-agent/shared';
import { CloseIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { eta, fileRole, groupDownloads, isActive, type DownloadGroup } from './downloadGroups.js';

/**
 * What is coming down the wire.
 *
 * A model download is minutes to hours, so this has to answer "is it still
 * going" at a glance and "how much longer" on a second look. Cancel is always
 * available, because a 20 GB file started by mistake should not be something you
 * have to wait out.
 *
 * One model is one row even when it arrives as several files (split weights, a
 * vision projector, tokenizer files): the files are listed beneath it, each named
 * for what it is and why it is needed.
 */

const STATE_LABEL: Record<DownloadJob['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  verifying: 'Checking the file',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function stateColor(state: DownloadJob['state']): string {
  return state === 'failed' ? 'var(--danger)' : state === 'done' ? 'var(--success)' : 'var(--ink-faint)';
}

function progressLine(p: { receivedBytes: number; totalBytes?: number; bytesPerSecond?: number }): string {
  return [
    `${formatBytes(p.receivedBytes)}${p.totalBytes ? ` of ${formatBytes(p.totalBytes)}` : ''}`,
    p.bytesPerSecond ? `${formatBytes(p.bytesPerSecond)}/s` : null,
    eta(p),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function DownloadsPanel({ jobs, onChanged }: { jobs: DownloadJob[]; onChanged: () => void }) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-3.5 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
        Nothing downloading. Anything you start from <strong>Find models</strong> shows its progress here.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {groupDownloads(jobs).map((group) => (
        <DownloadGroupRow key={group.id} group={group} onChanged={onChanged} />
      ))}
    </div>
  );
}

function DownloadGroupRow({ group, onChanged }: { group: DownloadGroup; onChanged: () => void }) {
  const active = isActive(group.state);
  const pct = group.totalBytes && group.totalBytes > 0 ? Math.min(100, (group.receivedBytes / group.totalBytes) * 100) : null;
  const multi = group.jobs.length > 1;
  const files = group.jobs.length;

  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-2)' }} data-download-group={group.id}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs">{group.label}</span>
        {multi && <span className="shrink-0 text-2xs text-ink-faint">{files} files</span>}
        <span className="shrink-0 text-2xs" style={{ color: stateColor(group.state) }}>
          {STATE_LABEL[group.state]}
        </span>
        <button
          className="btn btn-ghost shrink-0 px-1.5 py-1"
          title={active ? (multi ? 'Cancel this download (every file)' : 'Cancel this download') : 'Remove from the list'}
          aria-label={active ? 'Cancel download' : 'Remove from the list'}
          onClick={async () => {
            for (const job of group.jobs) {
              if (isActive(job.state)) await window.nekko.engineCancelDownload(job.id);
              else await window.nekko.engineDismissDownload(job.id);
            }
            onChanged();
          }}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {active && <ProgressBar pct={pct} />}

      <p className="mt-1 text-2xs text-ink-faint">{group.message ?? progressLine(group)}</p>

      {multi && (
        <ul className="mt-2 space-y-1 border-t pt-2" style={{ borderColor: 'color-mix(in srgb, var(--ink-faint) 15%, transparent)' }}>
          {group.jobs.map((job) => (
            <FileRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({ job }: { job: DownloadJob }) {
  const file = job.file ?? job.label;
  const name = file.split('/').pop() ?? file;
  const role = fileRole(file, job.role);
  const active = isActive(job.state);
  const pct = job.totalBytes && job.totalBytes > 0 ? Math.min(100, (job.receivedBytes / job.totalBytes) * 100) : null;
  return (
    <li className="pl-2.5" style={{ borderLeft: '2px solid color-mix(in srgb, var(--ink-faint) 20%, transparent)' }} data-download-file={name}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-xs">{role.title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint" title={file}>
          {name}
        </span>
        <span className="shrink-0 text-2xs text-ink-faint">
          {job.state === 'done' ? formatBytes(job.totalBytes ?? job.receivedBytes) : progressLine({ ...job, bytesPerSecond: undefined })}
        </span>
        <span className="shrink-0 text-2xs" style={{ color: stateColor(job.state) }}>
          {job.state === 'downloading' && pct !== null ? `${Math.round(pct)}%` : STATE_LABEL[job.state]}
        </span>
      </div>
      <p className="text-2xs text-ink-faint">{job.state === 'failed' && job.message ? job.message : role.purpose}</p>
      {active && <ProgressBar pct={pct} thin />}
    </li>
  );
}

function ProgressBar({ pct, thin }: { pct: number | null; thin?: boolean }) {
  return (
    <div
      className={`${thin ? 'mt-1 h-1' : 'mt-1.5 h-1.5'} w-full overflow-hidden rounded-full`}
      style={{ background: 'color-mix(in srgb, var(--ink-faint) 15%, transparent)' }}
    >
      <div
        className="h-full rounded-full transition-[width]"
        style={{
          // An unknown total still shows motion rather than an empty
          // bar, which otherwise reads as "stuck".
          width: pct === null ? '35%' : `${pct}%`,
          background: 'var(--accent)',
          opacity: pct === null ? 0.5 : 1,
        }}
      />
    </div>
  );
}
