/** A provider card shows a filter box past this many models, like the composer's model picker. */
export const MODEL_FILTER_THRESHOLD = 8;

/**
 * Why a provider card's model list is empty, or null when nothing failed.
 * A local server that failed its connection test reads as off: its list error
 * is a raw fetch failure, or nothing at all (Ollama swallows its own). A
 * failed connection test already shows the cause, so the list does not repeat it.
 */
export function modelListProblem(input: {
  error?: string;
  connFailed: boolean;
  local: boolean;
  label: string;
  baseUrl: string;
}): string | null {
  if (input.local && input.connFailed) return `${input.label} didn't answer at ${input.baseUrl}. Is it running?`;
  if (input.error && input.connFailed) return "Couldn't list models.";
  if (input.error) return `Couldn't list models: ${input.error}`;
  return null;
}
