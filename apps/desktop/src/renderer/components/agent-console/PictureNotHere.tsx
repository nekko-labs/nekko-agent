import type React from 'react';
import { PhotoIcon } from '../../icons.js';

/**
 * A picture in a chat synced from another computer that isn't on this one
 * (#3298). Pictures travel through Nekko Cloud apart from the chat's text, so
 * one can arrive a moment after its chat (`nekko-blob:<name>`, the chat store's
 * reference, still unresolved); a chat synced before pictures synced holds a
 * note in its place instead, and that picture never comes.
 */
export type MissingPicture = 'coming' | 'left';

/** The note a chat synced before pictures synced holds where each one was (`records::IMAGE_NOTE`). */
const LEFT_OUT = '[picture not synced]';

/** Whether this picture source is one that isn't here, and why; null for a picture that can be drawn. */
export function missingPicture(src: string): MissingPicture | null {
  if (src.startsWith('nekko-blob:')) return 'coming';
  if (src === LEFT_OUT) return 'left';
  return null;
}

const WORDS: Record<MissingPicture, { label: string; detail: string }> = {
  coming: { label: 'Picture on its way', detail: 'This picture is still syncing from the computer this chat belongs to.' },
  left: { label: 'Picture not synced', detail: 'This chat synced before pictures did. The picture is on the computer this chat belongs to.' },
};

/** Where a picture would be: the same size and corners, a quiet glyph and a word, never a broken image. */
export function PictureNotHere({ why, className = '', style }: { why: MissingPicture; className?: string; style?: React.CSSProperties }) {
  const { label, detail } = WORDS[why];
  return (
    <div role="img" aria-label={`${label}. ${detail}`} title={detail} data-picture-missing={why}
      className={`flex flex-col items-center justify-center gap-1 overflow-hidden p-2 text-center text-2xs text-ink-faint ${className}`}
      // A faint tint of the ink: visible on the message bubble and on the page alike.
      style={{ background: 'color-mix(in srgb, var(--ink) 7%, transparent)', ...style }}>
      <PhotoIcon className="h-4 w-4 shrink-0" />
      <span className="leading-tight">{label}</span>
    </div>
  );
}
