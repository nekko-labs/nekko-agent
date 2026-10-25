import { useStore } from '../store.js';
import { hasAppChrome } from '../chrome.js';
import { ModelsView } from './ModelsView.js';
import { ModelServerView } from './ModelServerView.js';

/** Keep existing destinations working, with one rail entry and shared subnavigation. */
export function ModelsWorkspace() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const local = view === 'modelserver';
  return <div className="models-workspace">
    <nav className="models-subnav" aria-label="Models">
      {!hasAppChrome && <h1 className="view-title">Models</h1>}
      <button type="button" aria-current={local ? 'page' : undefined} onClick={() => setView('modelserver')}>
        <span aria-hidden="true">▣</span> Local model server
      </button>
      <button type="button" aria-current={!local ? 'page' : undefined} onClick={() => setView('models')}>
        <span aria-hidden="true">☁</span> Cloud providers
      </button>
    </nav>
    <div className="models-content" key={local ? 'local' : 'cloud'}>
      <h2 className="models-section-title">{local ? 'Local model server' : 'Cloud providers'}</h2>
      {local ? <>
        <ModelServerView embedded />
        <div className="models-local-connections">
          <h3 className="models-section-title">Connected servers</h3>
          <ModelsView localOnly />
        </div>
      </> : <ModelsView />}
    </div>
  </div>;
}
