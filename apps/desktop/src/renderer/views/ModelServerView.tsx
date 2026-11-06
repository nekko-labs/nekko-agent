import { ResourceQueueSection } from '../components/server/ResourceQueueSection.js';
import { useCallback, useEffect, useState } from 'react';
import type { EngineMemory, LocalModel } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { EngineSection } from '../components/engine/EngineSection.js';
import { ModelDetail } from '../components/engine/ModelDetail.js';
import { hasAppChrome } from '../chrome.js';

/** Built-in engine surface, embedded in Models or used by standalone fixtures. */
export function ModelServerView({ embedded = false }: { embedded?: boolean }) {
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
      <div className={embedded ? "" : "h-full overflow-y-auto"}>
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
    <div className={embedded ? "" : "h-full overflow-y-auto"}>
      <div className={embedded ? "w-full" : "mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8"}>
        {!embedded && !hasAppChrome && <h1 className="view-title">Model Server</h1>}


        <div className={embedded ? "" : "mt-7"}>
          <EngineSection
            onProvidersChanged={refreshProviders}
            onOpenModel={(id) => {
              void refreshModels();
              setOpenModelId(id);
            }}
          />
        </div>

        {queueEnabled && <ResourceQueueSection />}


      </div>
    </div>
  );
}
