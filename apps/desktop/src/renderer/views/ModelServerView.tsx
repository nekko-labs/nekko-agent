import { ResourceQueueSection } from '../components/server/ResourceQueueSection.js';
import { useCallback, useEffect, useState } from 'react';
import type { EngineMemory, LocalModel } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { EngineSection } from '../components/engine/EngineSection.js';
import { ModelDetail } from '../components/engine/ModelDetail.js';
import { hasAppChrome } from '../chrome.js';

/**
 * This machine as a model server.
 *
 * Two halves of one answer, which used to sit at opposite ends of the Models
 * page under two other things. The first is what runs the models: the engine, the
 * models it can load, where those models come from on disk, and the address it
 * serves them on. The second is what runs *this app*: the local API, the command
 * line, and the MCP entry other agents use it through.
 *
 * They belong together because they are the same question asked twice — what on
 * this computer can other software talk to — and because the page that answers
 * it is not the page where you connect an Anthropic key. That one is Model
 * Providers now.
 *
 * Opening a model from the catalog takes the whole view rather than unfolding a
 * drawer: a model card, a download-count, a ladder of builds and a license is a
 * page's worth of reading, and it should not have to happen inside a list.
 */

export function ModelServerView() {
  const queueEnabled = useStore((s) => s.settings?.experimental?.resourceQueue === true);
  const refreshProviders = useStore((s) => s.refreshProviders);
  // The catalog model being read, if any. Held here rather than in the engine
  // section so the page it opens can use the whole view.
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [memory, setMemory] = useState<EngineMemory | undefined>(undefined);

  const refreshModels = useCallback(async () => {
    setModels(await window.nekko.engineModels().catch(() => []));
    setMemory((await window.nekko.engineStatus().catch(() => null))?.memory);
  }, []);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  if (openModelId) {
    return (
      <div className="h-full overflow-y-auto">
        <ModelDetail
          modelId={openModelId}
          memory={memory}
          // A repo's files land under a folder named after it, so this is how the
          // page knows which of its builds you already hold.
          installed={models.filter((m) => m.id.includes(openModelId.replace('/', '_')) || m.sourceRepo === openModelId)}
          onBack={() => {
            setOpenModelId(null);
            refreshModels();
          }}
          onQueued={() => setOpenModelId(null)}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
        {!hasAppChrome && <h1 className="view-title">Nekko Server</h1>}
        <p className="mt-1 text-[13px] text-ink-faint">
          Run models on this machine, and let anything else on it drive Nekko Agent.
        </p>

        <div className="mt-7">
          <EngineSection
            onProvidersChanged={refreshProviders}
            onOpenModel={(id) => {
              void refreshModels();
              setOpenModelId(id);
            }}
          />
        </div>

        {queueEnabled && <ResourceQueueSection />}

        <p className="mt-8 text-center text-[12px] text-ink-faint">
          Cloud keys and other machines' servers live in Model Providers.
        </p>
      </div>
    </div>
  );
}
