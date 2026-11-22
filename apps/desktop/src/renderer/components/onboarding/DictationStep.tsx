import { VoiceSettings } from '../VoiceSettings.js';

export function DictationStep() {
  return <div className="w-full">
    <h1 className="text-center text-2xl font-semibold tracking-tight">Set up local dictation</h1>
    <div className="mt-5"><VoiceSettings compact showHeading={false} /></div>
  </div>;
}
