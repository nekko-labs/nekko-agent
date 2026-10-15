// Stay below Anthropic's stricter 2000px ceiling for requests with >20 images.
// Normalize wire copies, including old evidence, so retry never replays an
// oversized original. Originals in saved history remain available at full size.
const MAX_EDGE = 1568;

export async function normalizeAnthropicImages(messages: any[]): Promise<any[]> {
  const copies = new Map<string, Promise<any>>();
  const normalize = (block: any): Promise<any> => {
    if (block.type !== 'image' || block.source?.type !== 'base64') return Promise.resolve(block);
    const key = `${block.source.media_type}:${block.source.data}`;
    let pending = copies.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const { Jimp } = await import('jimp');
          const image = await Jimp.read(Buffer.from(block.source.data, 'base64'));
          const edge = Math.max(image.width, image.height);
          if (edge <= MAX_EDGE) return block;
          image.resize({
            w: Math.max(1, Math.round(image.width * MAX_EDGE / edge)),
            h: Math.max(1, Math.round(image.height * MAX_EDGE / edge)),
          });
          const data = (await image.getBuffer('image/png')).toString('base64');
          return { ...block, source: { type: 'base64', media_type: 'image/png', data } };
        } catch {
          // Leave unsupported/corrupt inputs to the provider's validation. Never
          // silently drop user evidence or relabel bytes we could not decode.
          return block;
        }
      })();
      copies.set(key, pending);
    }
    return pending;
  };
  const out = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { out.push(message); continue; }
    const content = [];
    // Bound peak decode memory rather than decoding the whole history at once.
    for (const block of message.content) content.push(await normalize(block));
    out.push({ ...message, content });
  }
  return out;
}
