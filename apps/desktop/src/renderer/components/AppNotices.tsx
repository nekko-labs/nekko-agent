import React from 'react';
import type { AppNotice } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { CloseIcon } from '../icons.js';

/**
 * One-time notices nekkod leaves in `settings.notices` (for example
 * `claude-sign-in-changed`, written by crates/nekkod/src/claude_plan.rs when it
 * retires a Claude plan sign-in). The oldest shows first; dismissing it, or
 * taking one of its actions, removes it from settings for good.
 */
export function AppNotices() {
  const notice = useStore((s) => s.settings?.notices?.[0]);
  if (!notice) return null;
  return <NoticeCard notice={notice} />;
}

/** What each known action id does. An unknown id just dismisses. */
function runAction(id: string) {
  const store = useStore.getState();
  if (id === 'connect-claude-agent') store.openAddProvider('claude-code');
  else if (id === 'add-api-key') store.openAddProvider('anthropic');
  else if (id === 'what-changed') store.setClaudePlanSheet(true);
}

async function dismiss(id: string) {
  const notices = useStore.getState().settings?.notices ?? [];
  await window.nekko.updateSettings({ notices: notices.filter((n) => n.id !== id) });
  await useStore.getState().refreshSettings(false);
}

export function NoticeCard({ notice }: { notice: AppNotice }) {
  const titleId = `notice-${notice.id}`;
  return (
    <section className="app-notice" role="status" aria-labelledby={titleId}>
      <div className="app-notice-head">
        <h2 id={titleId}>{notice.title}</h2>
        <button className="app-notice-close" onClick={() => void dismiss(notice.id)} aria-label="Dismiss">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      <p>{notice.body}</p>
      {notice.points?.length ? (
        <ul>
          {notice.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {notice.actions?.length ? (
        <div className="app-notice-actions">
          {notice.actions.map((a, i) => (
            <button
              key={a.id}
              className={`btn ${i === 0 ? 'btn-primary' : a.id === 'what-changed' ? 'btn-ghost' : 'btn-outline'}`}
              onClick={() => {
                // The plan sheet explains; the rest act on the change, which retires the notice.
                runAction(a.id);
                if (a.id !== 'what-changed') void dismiss(notice.id);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
