import { VoiceSettings } from '../VoiceSettings.js';

/** The OS or Nekko Voice runs these, independently of the local model server. */
export function SystemModels() {
  return <section data-models-section="system" aria-labelledby="system-models-title" className="min-w-0 rounded-xl border border-line px-4 py-3">
    <h3 id="system-models-title" className="text-base font-semibold">System models</h3>
    <VoiceSettings compact showHeading={false} />
  </section>;
}
