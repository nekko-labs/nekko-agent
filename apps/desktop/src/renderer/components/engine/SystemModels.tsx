import { VoiceSettings } from '../VoiceSettings.js';
import { ChevronIcon } from '../../icons.js';

/** The OS or Nekko Voice runs these, independently of the local model server. Folded until asked for. */
export function SystemModels() {
  return <details data-models-section="system" className="group min-w-0 rounded-xl border border-line px-4 py-3">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold [&::-webkit-details-marker]:hidden">
      <ChevronIcon className="h-3.5 w-3.5 text-ink-faint transition-transform duration-150 group-open:rotate-90" aria-hidden="true" />
      System models
    </summary>
    <VoiceSettings compact showHeading={false} />
  </details>;
}
