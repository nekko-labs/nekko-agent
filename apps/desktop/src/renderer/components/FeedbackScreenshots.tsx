import React, { useEffect, useRef, useState } from 'react';
import {
  FEEDBACK_SCREENSHOT_MAX_COUNT, feedbackScreenshotProblem, feedbackScreenshotType, type FeedbackScreenshot,
} from '@nekko-agent/shared';
import { CloseIcon } from '../icons.js';

interface Shot {
  id: number;
  name: string;
  file: File;
  url: string;
}

const fileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

async function firstBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 8).arrayBuffer());
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // In slices: spreading a whole 5 MB file into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The screenshots on a note. Lives in the form, so paste and drop work anywhere on it. */
export function useFeedbackScreenshots() {
  const [shots, setShots] = useState<Shot[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const latest = useRef(shots);
  latest.current = shots;
  const nextId = useRef(0);

  useEffect(() => () => { for (const shot of latest.current) URL.revokeObjectURL(shot.url); }, []);

  const add = async (files: File[]) => {
    const kept = [...latest.current];
    const problems: string[] = [];
    for (const file of files) {
      // A pasted image arrives with a stock name.
      const name = file.name === 'image.png' ? 'Pasted image.png' : file.name;
      const problem = kept.length >= FEEDBACK_SCREENSHOT_MAX_COUNT
        ? `${name} wasn't added. You can add up to ${FEEDBACK_SCREENSHOT_MAX_COUNT} screenshots.`
        : feedbackScreenshotProblem(name, file.size, await firstBytes(file));
      if (problem) problems.push(problem);
      else kept.push({ id: nextId.current++, name, file, url: URL.createObjectURL(file) });
    }
    setShots(kept);
    setErrors(problems);
  };

  const remove = (id: number) => {
    const shot = latest.current.find(s => s.id === id);
    if (shot) URL.revokeObjectURL(shot.url);
    setShots(latest.current.filter(s => s.id !== id));
    setErrors([]);
  };

  const forUpload = (): Promise<FeedbackScreenshot[]> => Promise.all(latest.current.map(async shot => ({
    name: shot.name,
    type: feedbackScreenshotType(await firstBytes(shot.file))!,
    data: await toBase64(shot.file),
  })));

  return { shots, errors, add, remove, forUpload };
}

export function FeedbackScreenshots({ shots, errors, add, remove }: Pick<ReturnType<typeof useFeedbackScreenshots>, 'shots' | 'errors' | 'add' | 'remove'>) {
  const picker = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const problems = useRef<HTMLUListElement>(null);
  const removedAt = useRef<number | null>(null);
  const [over, setOver] = useState(false);
  const full = shots.length >= FEEDBACK_SCREENSHOT_MAX_COUNT;

  // The form scrolls, so a refused file must not fail out of sight.
  useEffect(() => { if (errors.length) problems.current?.scrollIntoView({ block: 'nearest' }); }, [errors]);

  // The focused button can vanish (a removed tile, or Add at the limit): land on its neighbour.
  useEffect(() => {
    const buttons = list.current?.querySelectorAll('button');
    if (removedAt.current !== null) {
      (buttons?.[Math.min(removedAt.current, buttons.length - 1)] ?? addButton.current)?.focus();
      removedAt.current = null;
    } else if (full && document.activeElement === document.body) {
      buttons?.[buttons.length - 1]?.focus();
    }
  }, [shots, full]);

  return (
    <div data-testid="feedback-screenshots">
      <span id="feedback-shots-label" className="mb-1 block text-xs font-medium text-ink-soft">
        Screenshots (optional) <span className="font-normal text-ink-faint">{shots.length} of {FEEDBACK_SCREENSHOT_MAX_COUNT}</span>
      </span>
      {shots.length > 0 && (
        <ul ref={list} className="mb-2 grid grid-cols-3 gap-2" aria-labelledby="feedback-shots-label">
          {shots.map((shot, index) => (
            <li key={shot.id} className="relative min-w-0 overflow-hidden rounded-xl border border-line">
              <img src={shot.url} alt={shot.name} className="block h-16 w-full bg-surface-2 object-cover object-top" />
              <div className="px-2 py-1 text-2xs">
                <span className="block truncate text-ink" title={shot.name}>{shot.name}</span>
                <span className="block text-ink-faint">{fileSize(shot.file.size)}</span>
              </div>
              <button
                type="button"
                className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-ink"
                aria-label={`Remove ${shot.name}`}
                onClick={() => { removedAt.current = index; remove(shot.id); }}
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-2 text-xs text-ink-faint">That's the limit of {FEEDBACK_SCREENSHOT_MAX_COUNT}. Remove one to add a different screenshot.</p>
      ) : (
        <button
          ref={addButton}
          type="button"
          className={`block w-full rounded-xl border border-dashed px-4 py-3 text-left text-xs text-ink-faint transition-colors ${over ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}
          aria-describedby="feedback-shots-privacy"
          onClick={() => picker.current?.click()}
          onDragOver={() => setOver(true)}
          onDragLeave={() => setOver(false)}
          onDrop={() => setOver(false)}
          data-testid="feedback-add-screenshots"
        >
          <span className="block font-medium text-ink">Add screenshots</span>
          Drop, paste or browse. PNG, JPG or JPEG, up to 5 MB each.
        </button>
      )}
      <input
        ref={picker}
        type="file"
        className="hidden"
        accept=".png,.jpg,.jpeg,image/png,image/jpeg"
        multiple
        tabIndex={-1}
        aria-hidden
        onChange={async e => { const input = e.target; await add([...(input.files ?? [])]); input.value = ''; }}
        data-testid="feedback-file"
      />
      <ul ref={problems} className="mt-2 scroll-mb-6 text-xs text-danger empty:hidden" role="alert">
        {errors.map(error => <li key={error}>{error}</li>)}
      </ul>
      <p id="feedback-shots-privacy" className="mt-1 text-2xs text-ink-faint">Screenshots can show names, chats or file paths. Check yours before you send.</p>
    </div>
  );
}
