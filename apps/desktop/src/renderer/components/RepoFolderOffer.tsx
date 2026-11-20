import React, { useState } from 'react';
import { FolderIcon } from '../icons.js';
import { answerRepoFolderOffer } from '../sessionFolders.js';
import { useStore } from '../store.js';

/**
 * Asked once, in the chat a folder was just added to, while no repositories
 * folder is chosen: the folder already holding several of the user's
 * repositories becomes where new ones are cloned
 * (spec/context/chat-environment-folders-and-repositories.md). Either answer
 * ends the offer for good; Settings can still change the folder.
 */
export function RepoFolderOffer({ suggested }: { suggested: string }) {
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const answer = async (dir: string | null) => {
    setBusy(true);
    try {
      await answerRepoFolderOffer(dir);
      if (dir) pushToast('success', `New repositories will be cloned to ${dir}.`);
    } catch (e) {
      setBusy(false);
      pushToast('error', `Couldn't save the repositories folder: ${(e as Error).message}`);
    }
  };
  return (
    // Narrow: the buttons drop below the text instead of squeezing it.
    <section className="fade-in mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" role="region"
      aria-label="Repositories folder" data-repo-folder-offer>
      <div className="flex min-w-[16rem] flex-1 items-center gap-3">
        <FolderIcon className="h-4 w-4 shrink-0 text-ink-soft" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Keep your repositories here?</p>
          <p className="truncate text-xs text-ink-faint" title={`${suggested} already holds several. Repositories you add later are cloned there.`}>
            <span className="font-mono">{suggested}</span> already holds several. Repositories you add later are cloned there.
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" className="btn btn-primary text-xs" disabled={busy} data-testid="repo-folder-use"
          onClick={() => void answer(suggested)}>Use this folder</button>
        <button type="button" className="btn btn-ghost text-xs" disabled={busy} data-testid="repo-folder-later"
          onClick={() => void answer(null)}>No thanks</button>
      </div>
    </section>
  );
}
