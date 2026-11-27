let words: Intl.Segmenter | undefined;

type SpellingWord = { word: string; start: number; end: number };

/** A caret is between characters, so a pixel hit can belong to either side. */
export function spellingWordsAt(text: string, offset: number): SpellingWord[] {
  const segments = (words ??= new Intl.Segmenter(undefined, { granularity: 'word' })).segment(text);
  const at = segments.containing(offset);
  const before = segments.containing(offset - 1);
  return (before === undefined || before.index === at?.index ? [at] : [at, before]).flatMap(segment => {
    if (!segment?.isWordLike || !/^\p{L}[\p{L}\p{M}'’]*$/u.test(segment.segment)) return [];
    return [{ word: segment.segment, start: segment.index, end: segment.index + segment.segment.length }];
  });
}

/** Locate the word without disturbing the selection that Markdown and Copy use. */
export function composerSpellingWord(editor: HTMLElement, event: MouseEvent): SpellingWord | undefined {
  const doc = editor.ownerDocument;
  const keyboard = event.button === 0 && !event.ctrlKey;
  const selection = keyboard ? doc.getSelection() : doc.caretRangeFromPoint(event.clientX, event.clientY);
  const node = selection && ('anchorNode' in selection ? selection.anchorNode : selection.startContainer);
  if (!node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return;
  if (node.parentElement?.closest('[data-privacy-kind], [spellcheck="false"]')) return;
  const offset = 'anchorOffset' in selection ? selection.anchorOffset : selection.startOffset;
  const range = doc.createRange();
  for (const candidate of spellingWordsAt(node.textContent ?? '', offset)) {
    if (!keyboard) {
      range.setStart(node, candidate.start);
      range.setEnd(node, candidate.end);
      // Hit-testing a caret can snap to text when the pointer is on blank space.
      if (![...range.getClientRects()].some(r => event.clientX >= r.left && event.clientX < r.right
        && event.clientY >= r.top && event.clientY < r.bottom)) continue;
    }
    range.selectNodeContents(editor);
    range.setEnd(node, 0);
    const prefix = range.toString().length;
    return { word: candidate.word, start: prefix + candidate.start, end: prefix + candidate.end };
  }
}
