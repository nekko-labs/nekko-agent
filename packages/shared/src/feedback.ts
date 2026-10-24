/**
 * "Send feedback" (#1004, spec/platform/send-feedback.md): the three routes
 * the sheet offers on every app. The Swift (apps/ios) and Kotlin
 * (apps/android) copies of the agent prompt match `agentPrompt` word for word.
 */

/** The issue forms (bug report, feature request). */
export const FEEDBACK_ISSUES_URL = 'https://github.com/nekko-labs/nekko-agent/issues/new/choose';

/** Nekko Cloud's limit for a quick note, in characters. */
export const FEEDBACK_MAX_CHARS = 4000;

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
