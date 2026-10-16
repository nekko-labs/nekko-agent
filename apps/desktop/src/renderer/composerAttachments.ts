import { mediaKindOf, type ModelMediaSupport } from '@nekko-agent/shared';

/**
 * What the composer does with each file the user pastes, drops, or picks.
 *
 * Photos and videos the model can see ride along with the message as data
 * URLs. Anything else (a PDF, a markdown file, a spreadsheet, or a photo for a
 * model that cannot see) becomes a file attachment: on disk already when the
 * OS told us where it lives, otherwise imported into the app's data dir first.
 * Nothing is dropped silently; a file the model cannot read still shows up in
 * the attachment strip, labelled as such, so the user knows what was kept.
 */
export type AttachmentPlan =
  | { kind: 'image'; file: File }
  | { kind: 'video'; file: File }
  | { kind: 'path'; path: string; note?: string }
  | { kind: 'import'; file: File; note?: string };

/** Files the model reads as text; anything else is kept but flagged. */
const TEXTUAL = /\.(md|markdown|txt|csv|tsv|json|jsonc|ya?ml|toml|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|ps1|bat|sql|ini|cfg|conf|env|log|diff|patch|tex|rst|org|svg)$/i;

/** A short reason the model will not read a file's bytes, or null when it will. */
export function unreadableNote(name: string, type = ''): string | null {
  if (mediaKindOf(type || name)) return null;
  if (!name.includes('.') || TEXTUAL.test(name)) return null;
  if (/\.pdf$/i.test(name) || type === 'application/pdf') return 'PDF: the text is not extracted yet, so the model sees only the name';
  if (/\.(docx?|pptx?|xlsx?|odt|ods|odp|rtf|pages|numbers|key)$/i.test(name)) return 'Office document: the model sees only the name';
  if (/\.(zip|7z|rar|tar|gz|bz2|xz|dmg|iso|exe|msi|dll|so|dylib|bin|wasm|class|jar)$/i.test(name)) return 'Binary: the model sees only the name';
  if (/\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(name) || type.startsWith('audio/')) return 'Audio: not transcribed, the model sees only the name';
  return null;
}

/**
 * Decide, for one file, how it travels. `path` is where the OS says the file
 * lives ('' when it is a pasted blob with no home).
 */
export function planAttachment(file: File, path: string, support: ModelMediaSupport): AttachmentPlan {
  const kind = mediaKindOf(file.type || file.name);
  if (kind === 'image' && support.image !== 'no') return { kind: 'image', file };
  if (kind === 'video' && support.video !== 'no') return { kind: 'video', file };
  const note = kind === 'image'
    ? "Attached as a file: this model can't view photos"
    : kind === 'video'
      ? "Attached as a file: this model can't view videos"
      : unreadableNote(file.name, file.type) ?? undefined;
  return path ? { kind: 'path', path, note } : { kind: 'import', file, note };
}

/** The basename of a path, for a chip. */
export function attachmentName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * A pasted blob rarely has a name (`image.png`, or nothing at all), so give it
 * one that says where it came from and when, keeping any real extension.
 */
export function pastedFileName(file: File, now = new Date()): string {
  const given = file.name && file.name !== 'blob' && !/^(image|clipboard-image)\.?\w*$/i.test(file.name) ? file.name : '';
  if (given) return given;
  const ext = file.type.split('/')[1]?.replace(/^x-/, '').split(';')[0] || (file.name.includes('.') ? file.name.split('.').pop()! : 'bin');
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `pasted-${stamp}.${ext === 'plain' ? 'txt' : ext === 'jpeg' ? 'jpg' : ext}`;
}
