/**
 * The topics an agent's message can name (spec/chat/thinking-and-replies.md):
 * a line of its own, as a heading or a bold label, that says what follows. The
 * system prompt asks for these labels, and the chat draws them as headers.
 */
export type Topic = 'question' | 'next' | 'command' | 'decision' | 'summary';

// shortcut: English labels only, add translations once the prompt asks for them.
const TOPICS: Array<[Topic, RegExp]> = [
  ['question', /^(open )?questions?( for you)?$|^decisions? needed$/],
  ['next', /^next steps?$|^what'?s next$|^action (needed|required)$|^your turn$/],
  ['command', /^run this$|^commands?( to run)?$/],
  ['decision', /^decisions?( made)?$|^assumptions?$/],
  ['summary', /^summary$|^tl;?dr$|^changes$|^what changed$|^verified$|^not verified( \/ blocked)?$|^blocked$/],
];

function topicOf(label: string): Topic | undefined {
  const name = label.trim().toLowerCase();
  return TOPICS.find(([, pattern]) => pattern.test(name))?.[0];
}

/** A line that names a topic, and any words after the label (`**Next step**: merge it`). */
export function topicLine(line: string): { topic: Topic; label: string; rest: string } | null {
  const text = line.trim();
  const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(text);
  if (heading) {
    const label = heading[1].replace(/\*\*/g, '').replace(/:$/, '');
    const topic = topicOf(label);
    return topic ? { topic, label, rest: '' } : null;
  }
  const bold = /^\*\*([^*]+?)(:?)\*\*(:?)\s*(.*)$/.exec(text);
  // `**Changes** to the plan` is emphasis in a sentence, not a label.
  if (!bold || (bold[4] && !bold[2] && !bold[3])) return null;
  const topic = topicOf(bold[1]);
  return topic ? { topic, label: bold[1].trim(), rest: bold[4] } : null;
}

/** The text without its code fences, which can hold anything, by paragraph. */
function paragraphs(text: string): string[][] {
  const prose = text.split(/```/).filter((_, i) => i % 2 === 0).join('\n\n');
  return prose.split(/\n\s*\n/).map((p) => p.split('\n').filter((l) => l.trim())).filter((p) => p.length);
}

function endsInQuestion(lines: string[] | undefined): boolean {
  return /[?？][*_`)"'”’]*$/.test(lines?.at(-1)?.trim() ?? '');
}

/**
 * True when a message written mid-turn is addressed to the reader: it names a
 * topic, or it stops on a question and is waiting for them.
 */
export function speaksToUser(text: string): boolean {
  const blocks = paragraphs(text);
  return endsInQuestion(blocks.at(-1)) || blocks.some((p) => p.some(topicLine));
}

/** True when a message closes on a question that no label already announces. */
export function endsOnUnlabelledQuestion(text: string): boolean {
  const blocks = paragraphs(text);
  if (!endsInQuestion(blocks.at(-1)) || blocks.at(-1)?.some(topicLine)) return false;
  return !blocks.flat().some((l) => {
    const topic = topicLine(l)?.topic;
    return topic === 'question' || topic === 'next';
  });
}
