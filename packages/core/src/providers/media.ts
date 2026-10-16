import type { ChatMessage } from '@nekko-agent/shared';

/**
 * Video attachments on the wire.
 *
 * Only OpenAI-compatible servers have a content part for video (`video_url`,
 * the shape OpenRouter forwards to Gemini and vLLM reads natively). Every
 * other provider gets a short note in the text instead, so the model knows a
 * clip was attached that it was not shown, rather than silently losing it.
 */
export function videoParts(m: ChatMessage): Array<{ type: 'video_url'; video_url: { url: string } }> {
  return (m.videos ?? []).map((url) => ({ type: 'video_url', video_url: { url } }));
}

/** The user's text with a note standing in for videos the provider cannot carry. */
export function withVideoNote(m: ChatMessage): string {
  const n = m.videos?.length ?? 0;
  if (!n) return m.content;
  const note = `[${n} video attachment${n === 1 ? '' : 's'} omitted: this model does not accept video input. Tell the user if the videos matter to the task.]`;
  return m.content ? `${m.content}\n\n${note}` : note;
}

/**
 * A message as a model that cannot see is sent it: its pictures (a user's
 * attachments, a tool's screenshots) become one line saying they were left out.
 *
 * Without this, a picture attached once to a text-only model's chat is resent
 * with every later turn, and the server rejects each of them: the chat never
 * answers again. The stored transcript keeps the pictures; only the request
 * leaves without them, so switching to a model that can see brings them back.
 */
export function withoutImages(m: ChatMessage): ChatMessage {
  if (m.role === 'user' && m.images?.length) {
    const n = m.images.length;
    const note = `[${n} image attachment${n === 1 ? '' : 's'} omitted: this model does not accept image input. Tell the user if the images matter to the task.]`;
    const { images: _images, ...rest } = m;
    return { ...rest, content: m.content ? `${m.content}\n\n${note}` : note };
  }
  if (m.role === 'tool' && m.toolResult?.images?.length) {
    const n = m.toolResult.images.length;
    const { images: _images, ...result } = m.toolResult;
    const note = `[${n} screenshot${n === 1 ? '' : 's'} omitted: this model does not accept image input.]`;
    return { ...m, toolResult: { ...result, output: result.output ? `${result.output}\n\n${note}` : note } };
  }
  return m;
}

/** True when a user message carries any media the adapters have to lay out as parts. */
export function hasUserMedia(m: ChatMessage): boolean {
  return m.role === 'user' && (!!m.images?.length || !!m.videos?.length);
}
