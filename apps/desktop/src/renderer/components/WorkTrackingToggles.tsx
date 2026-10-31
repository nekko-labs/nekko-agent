import React from 'react';
import type { AppSettings } from '@nekko-agent/shared';

type ProjectManagement = NonNullable<AppSettings['projectManagement']>;
type PullRequests = NonNullable<AppSettings['pullRequests']>;

/**
 * One work tracking choice. `defaultOn` choices are on unless false. The
 * others are tri-state: unset shows a dash and means the agent asks the first
 * time, so a box nobody has touched never reads as a silent "no".
 */
function Toggle({ label, hint, value, defaultOn, onChange }: { label: string; hint: string; value?: boolean; defaultOn?: boolean; onChange: (v: boolean) => void }) {
  const ask = !defaultOn && value === undefined;
  return (
    <label className="mt-3 flex items-center justify-between gap-3 text-sm">
      <span>
        {label}
        <span className="mt-0.5 block text-2xs text-ink-faint">{ask ? `${hint} Not set yet: Nekko asks the first time.` : hint}</span>
      </span>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0"
        aria-label={label}
        ref={(el) => { if (el) el.indeterminate = ask; }}
        checked={defaultOn ? value !== false : value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function ProjectManagementToggles({ value = {}, onChange }: { value?: ProjectManagement; onChange: (v: ProjectManagement) => void }) {
  const set = (patch: ProjectManagement) => onChange({ ...value, ...patch });
  return (
    <>
      <Toggle defaultOn label="File an issue for each change" hint="Before opening a PR, the agent finds or files an issue for the feature or change (GitHub Issues, or the tracker the project uses)." value={value.createIssue} onChange={(v) => set({ createIssue: v })} />
      <Toggle label="Include my prompt in issues" hint="Quotes what you asked for, so the ticket says why." value={value.includePrompt} onChange={(v) => set({ includePrompt: v })} />
      <Toggle label="Include my screenshots in issues" hint="Relevant images you sent in the chat." value={value.includeScreenshots} onChange={(v) => set({ includeScreenshots: v })} />
      <Toggle label="Include other chat context in issues" hint="Attachments, pasted logs and a short summary of the conversation." value={value.includeContext} onChange={(v) => set({ includeContext: v })} />
    </>
  );
}

export function PullRequestToggles({ value = {}, onChange }: { value?: PullRequests; onChange: (v: PullRequests) => void }) {
  const set = (patch: PullRequests) => onChange({ ...value, ...patch });
  return (
    <>
      <Toggle defaultOn label="Link each PR to its issue" hint="Adds a closing link such as Closes #123 to the description." value={value.linkIssue} onChange={(v) => set({ linkIssue: v })} />
      <Toggle label="Include my prompt in PR descriptions" hint="Quotes what you asked for." value={value.includePrompt} onChange={(v) => set({ includePrompt: v })} />
      <Toggle label="Include my screenshots in PR descriptions" hint="Relevant images you sent, kept apart from the agent's own verification evidence." value={value.includeScreenshots} onChange={(v) => set({ includeScreenshots: v })} />
    </>
  );
}
