/**
 * "Send feedback" (#1004, spec/platform/send-feedback.md): the three routes
 * the sheet offers on every app. The Swift (apps/ios) and Kotlin
 * (apps/android) copies of the agent prompt match `agentPrompt` word for word.
 */

/** The issue forms (bug report, feature request). */
export const FEEDBACK_ISSUES_URL = 'https://github.com/nekko-labs/nekko-agent/issues/new/choose';

/** How to join in, linked from the foot of the sheet. */
export const FEEDBACK_CONTRIBUTING_URL = 'https://github.com/nekko-labs/nekko-agent/blob/main/CONTRIBUTING.md';

/** Nekko Cloud's limit for a quick note, in characters. */
export const FEEDBACK_MAX_CHARS = 4000;

/** The sheet's limit for the one-line summary, in characters. */
export const FEEDBACK_SUMMARY_MAX_CHARS = 120;

export type FeedbackKind = 'good' | 'improve';

const KIND_LABELS: Record<FeedbackKind, string> = { good: 'Good', improve: 'Needs improvement' };

/**
 * The quick note as Nekko Cloud stores it. The wire has one `message`, so the
 * choice, summary and description travel inside it and share its limit.
 */
export interface FeedbackContact { name?: string; email?: string }

/** Contact details are opt-in note content, never a signup or inferred from settings. */
export function feedbackContactProblem(contact: FeedbackContact): string | null {
  const name = contact.name?.trim() ?? '';
  const email = contact.email?.trim() ?? '';
  if ([...name].length > 200 || /[\r\n]/.test(name)) return 'Keep your name to one line, up to 200 characters.';
  if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return 'Enter a valid email address or leave it blank.';
  return null;
}

export function feedbackNote(kind: FeedbackKind, summary: string, description: string, contact: FeedbackContact = {}): string {
  const lines = [`${KIND_LABELS[kind]}: ${summary.trim()}\n\n${description.trim()}`.trim()];
  if (contact.name?.trim()) lines.push(`Name (optional): ${contact.name.trim()}`);
  if (contact.email?.trim()) lines.push(`Email (optional, feedback replies only): ${contact.email.trim()}`);
  return lines.join('\n\n');
}

/** Screenshots a note can carry, and the most each one can weigh. */
export const FEEDBACK_SCREENSHOT_MAX_COUNT = 3;
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/** One screenshot on its way to `feedback:send`, as base64. */
export interface FeedbackScreenshot {
  name: string;
  type: 'image/png' | 'image/jpeg';
  data: string;
}

/** What a file's first bytes say it is: the extension alone proves nothing. */
export function feedbackScreenshotType(head: Uint8Array): FeedbackScreenshot['type'] | null {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte)) return 'image/png';
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'image/jpeg' : null;
}

/** Why a file can't be attached, in the sheet's words, or null when it can. */
export function feedbackScreenshotProblem(name: string, size: number, head: Uint8Array): string | null {
  if (!/\.(png|jpe?g)$/i.test(name) || !feedbackScreenshotType(head)) return `${name} isn't a PNG or JPG file.`;
  return size > FEEDBACK_SCREENSHOT_MAX_BYTES ? `${name} is over the 5 MB limit.` : null;
}

/** Characters the note will use, counted as the server counts them: 0 until something is typed. */
export function feedbackNoteLength(kind: FeedbackKind, summary: string, description: string, contact: FeedbackContact = {}): number {
  return summary.trim() || description.trim() || contact.name?.trim() || contact.email?.trim() ? [...feedbackNote(kind, summary, description, contact)].length : 0;
}

/**
 * The app facts a person may share: nothing that identifies them or the
 * machine. `feedback:info` answers it; the quick note carries it only when
 * "Include app info" is on.
 */
export interface FeedbackAppInfo {
  app: 'desktop' | 'web' | 'ios' | 'android';
  version: string;
  os: string;
  osVersion?: string;
  arch?: string;
}

/** `App: Nekko Agent 1.4.0 (desktop, macOS 15.1, arm64)`. */
export function appInfoLine(info: FeedbackAppInfo): string {
  const os = [info.os, info.osVersion].filter(Boolean).join(' ');
  return `App: Nekko Agent ${info.version} (${[info.app, os, info.arch].filter(Boolean).join(', ')})`;
}

/** What "Copy for an agent" puts on the clipboard. */
export function agentPrompt(info: FeedbackAppInfo | null): string {
  const lines = [
    'I want to send feedback about Nekko Agent to the team that makes it (Nekko Labs). Please help me file it as a GitHub issue on https://github.com/nekko-labs/nekko-agent.',
    '',
    "1. Ask me what happened and what I expected (for a bug, the steps to reproduce it), or what I'd like it to do (for an idea).",
    '2. Search the existing issues first, and if one already covers it, show me so I can add to it instead.',
    '3. Draft a short title and description and show them to me. File the issue only after I approve, for example with `gh issue create --repo nekko-labs/nekko-agent`, or give me the text to paste into https://github.com/nekko-labs/nekko-agent/issues/new/choose.',
    '4. Leave out anything personal: names, email addresses, file paths, keys and tokens, and chat contents.',
  ];
  if (info) lines.push('', appInfoLine(info));
  return lines.join('\n');
}
