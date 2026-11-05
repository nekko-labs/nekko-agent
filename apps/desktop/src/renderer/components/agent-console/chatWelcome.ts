/** Startup is already a turn, even before a live reply or saved message exists. */
export function chatWelcomeState({ loaded, messages, streaming, hasLive, hasProvider, modelId, imageMode }: {
  /** A chat still being fetched has no messages yet, which is not the same as being empty. */
  loaded: boolean;
  messages: number;
  streaming: boolean;
  hasLive: boolean;
  hasProvider: boolean;
  modelId: string | null;
  imageMode: boolean;
}): { welcome: boolean; modelChoice: boolean } {
  const welcome = loaded && messages === 0 && !streaming && !hasLive;
  return { welcome, modelChoice: welcome && hasProvider && (imageMode || !modelId) };
}
