import React, { useId } from 'react';
import { CloseIcon } from '../icons.js';
import { Modal } from './primitives/index.js';

/** Only a packaged app has the file: `dist` and `release` generate it (scripts/third-party.mjs). */
export const hasNotices = () => globalThis.location?.protocol === 'file:';

/** An iframe, because a page loaded from file:// cannot fetch a neighbouring file. */
export function OpenSourceLicenses({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal title="Open-source licenses" labelledBy={titleId} onClose={onClose} overlayClassName="p-4" className="card flex h-[80vh] w-full max-w-3xl flex-col p-4">
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="font-semibold">Open-source licenses</h2>
        <button className="btn btn-ghost p-1" aria-label="Close" onClick={onClose}><CloseIcon className="h-4 w-4" /></button>
      </div>
      <iframe title="Third-party notices" src="./THIRD_PARTY_NOTICES.txt" className="mt-3 min-h-0 flex-1 rounded border border-line" />
    </Modal>
  );
}
