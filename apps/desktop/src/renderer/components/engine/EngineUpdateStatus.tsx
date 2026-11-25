import type { DownloadJob } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { DownloadProgress } from './DownloadProgress.js';
import { isActive, type DownloadGroup } from './downloadGroups.js';

type RuntimeTransfer = { active: boolean; group?: DownloadGroup; runtimeJobs: DownloadJob[] };

/** Engine transfers stay next to the runtime that owns them, including the final outcome. */
export function EngineUpdateStatus({ download, onChanged }: { download: RuntimeTransfer; onChanged: () => void }) {
  const pushToast = useStore(s => s.pushToast);
  const { active, group, runtimeJobs } = download;
  if (!active && !runtimeJobs.length) return null;
  const change = async (job: DownloadJob) => {
    try {
      if (isActive(job.state)) await window.nekko.engineCancelDownload(job.id);
      else await window.nekko.engineDismissDownload(job.id);
      onChanged();
    } catch (e) { pushToast('error', e instanceof Error ? e.message : 'Could not change the engine download.'); }
  };
  return <div className="mt-2 space-y-2" aria-label="Engine update status" data-engine-update-status>
    {active && !group && <DownloadProgress />}
    {runtimeJobs.map(job => <div key={job.id} className="text-xs text-ink-soft">
      <div className="flex flex-wrap items-center gap-x-2">
        <span>{job.label}</span>
        {!isActive(job.state) && <span role="status" className={job.state === 'failed' ? 'text-danger-text' : 'text-ink-faint'}>
          {job.state === 'done' ? 'Installed' : job.state === 'failed' ? 'Update failed' : 'Cancelled'}
        </span>}
        <button type="button" className="btn btn-ghost text-xs" onClick={() => void change(job)} aria-label={`${isActive(job.state) ? 'Cancel' : 'Dismiss'} ${job.label}`}>
          {isActive(job.state) ? 'Cancel' : 'Dismiss'}
        </button>
      </div>
      {isActive(job.state) && <DownloadProgress group={{ jobs: [job], receivedBytes: job.receivedBytes, totalBytes: job.totalBytes }} />}
      {job.state === 'failed' && job.message && <p className="text-danger-text">{job.message}</p>}
    </div>)}
  </div>;
}
