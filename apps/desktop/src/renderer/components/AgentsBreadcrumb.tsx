import { useStore } from '../store.js';
import { useT } from '../i18n.js';

/** A direct route home from Settings, not browser history. */
export function AgentsBreadcrumb() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const t = useT();
  if (view !== 'settings') return null;
  return <nav className="agents-breadcrumb" aria-label={t('nav.breadcrumb')} data-agents-breadcrumb>
    <button type="button" className="btn btn-ghost" data-back-to-agents onClick={() => setView('command')}>
      <span aria-hidden="true">←</span>{t('nav.command')}
    </button>
    <span aria-hidden="true" className="text-ink-faint">/</span>
    <span aria-current="page" className="min-w-0 truncate">{t('nav.settings')}</span>
  </nav>;
}
