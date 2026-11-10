/**
 * The agent asking before it acts.
 *
 * An agent that guesses at an ambiguous request spends ten minutes building the
 * wrong thing, and the user only finds out at the end. One question up front is
 * cheaper than that, so the agent gets a tool for it: it stops, asks, and waits
 * for a real answer instead of picking for you and mentioning it in the wrap-up.
 *
 * Deliberately multiple-choice. A free-text prompt is a second conversation and
 * people skip it; a short list of concrete options is a click, and writing the
 * options forces the agent to have actually thought about the alternatives.
 * Every question still takes a typed answer, because the right option is
 * sometimes not on the list.
 */

/**
 * Something the app does when the user answers with an option (#2404), before
 * the agent reads the answer: let them pick a folder, add a folder the agent
 * found, or add a repository from a connected git provider. Each one widens
 * the chat's environment; the answer tells the agent what was added.
 */
export type AskAction =
  | { kind: 'pickFolder' }
  | { kind: 'addFolder'; path: string }
  | { kind: 'connectRepo' };

/** One answer a question offers. */
export interface AskOption {
  label: string;
  /** What picking this means, in one line. */
  description?: string;
  action?: AskAction;
}

/** An option's action as the model wrote it, or undefined when unusable. */
export function normalizeAskAction(value: unknown): AskAction | undefined {
  const a = (value ?? {}) as Record<string, unknown>;
  const kind = typeof a.kind === 'string' ? a.kind.trim() : '';
  if (kind === 'pickFolder' || kind === 'connectRepo') return { kind };
  if (kind === 'addFolder') {
    const path = typeof a.path === 'string' ? a.path.trim() : '';
    if (path && path.length <= 4096) return { kind, path };
  }
  return undefined;
}

/** One question in a request. */
export interface AskQuestion {
  id: string;
  /** Two or three words for the chip above the question, e.g. "Auth method". */
  header: string;
  question: string;
  options: AskOption[];
  /** The options are not mutually exclusive. */
  multiSelect?: boolean;
}

/** Everything the agent wants to know before it carries on. */
export interface AskRequest {
  /** The `ask_user` tool call this answers, so the reply resolves that call. */
  callId: string;
  questions: AskQuestion[];
  /** When the agent asked, for "waiting 4m" on a board card. */
  askedAt: number;
}

/** What the user picked for one question. */
export interface AskAnswer {
  questionId: string;
  /** Chosen option labels. Empty when the answer is only free text. */
  labels: string[];
  /** Anything typed instead of, or alongside, the options. */
  note?: string;
}

/** Bounds. More than this is an interrogation, not a clarification. */
export const ASK_MAX_QUESTIONS = 4;
export const ASK_MAX_OPTIONS = 5;

/** The label every question carries for an answer that isn't on the list. */
export const ASK_OTHER_LABEL = 'Something else';

/**
 * Read a tool call's arguments into a request, or return null with the reason.
 *
 * Models get this shape wrong in predictable ways — a bare string instead of an
 * object, options as plain strings, a missing header — so the ones that are
 * recoverable are recovered and the rest come back as a message the model can
 * act on rather than a silent failure.
 */
export function parseAskRequest(
  callId: string,
  input: unknown,
  now = Date.now(),
): { request: AskRequest } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const list = Array.isArray(raw.questions) ? raw.questions : null;
  if (!list || list.length === 0) {
    return { error: 'ask_user needs a non-empty `questions` array. Each entry needs `header`, `question`, and 2 or more `options`.' };
  }

  const questions: AskQuestion[] = [];
  for (const [i, entry] of list.slice(0, ASK_MAX_QUESTIONS).entries()) {
    const q = (entry ?? {}) as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) return { error: `Question ${i + 1} has no \`question\` text.` };

    const options = normalizeOptions(q.options);
    if (options.length < 2) {
      return { error: `Question ${i + 1} ("${question.slice(0, 40)}") needs at least 2 \`options\`. Ask a question worth a choice, or just do the work.` };
    }

    questions.push({
      id: `q${i + 1}`,
      header: (typeof q.header === 'string' && q.header.trim()) || question.slice(0, 24),
      question,
      options: options.slice(0, ASK_MAX_OPTIONS),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }

  return { request: { callId, questions, askedAt: now } };
}

/** Options as written, as plain strings, or as objects missing a label. */
function normalizeOptions(value: unknown): AskOption[] {
  if (!Array.isArray(value)) return [];
  const out: AskOption[] = [];
  for (const o of value) {
    if (typeof o === 'string') {
      if (o.trim()) out.push({ label: o.trim() });
      continue;
    }
    const obj = (o ?? {}) as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    if (!label) continue;
    const description = typeof obj.description === 'string' ? obj.description.trim() : '';
    const action = normalizeAskAction(obj.action);
    out.push({ label, ...(description ? { description } : {}), ...(action ? { action } : {}) });
  }
  return out;
}

/**
 * The answers as the model reads them back.
 *
 * Every question is echoed with its answer, including ones left blank: a model
 * told only what was answered cannot tell "they chose nothing" from "I never
 * asked", and it needs to know which of its questions is still open.
 */
export function formatAskAnswers(request: AskRequest, answers: AskAnswer[]): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const lines = request.questions.map((q) => {
    const a = byId.get(q.id);
    const picked = a?.labels.filter(Boolean) ?? [];
    const note = a?.note?.trim();
    const answer = [picked.join(', '), note].filter(Boolean).join(' — ');
    return `Q: ${q.question}\nA: ${answer || '(not answered)'}`;
  });
  return `The user answered:\n\n${lines.join('\n\n')}\n\nWork to these answers. Do not ask again about anything settled here.`;
}

/** The tool result when nobody answered (the run was stopped, or the chat moved on). */
export const ASK_CANCELLED =
  'The user did not answer. Do not ask again: pick the most reasonable option, say which one you picked and why, and carry on.';

/** The answer when nobody was around within the unattended limit (Settings → Agent loop). */
export const ASK_UNATTENDED =
  'Nobody answered within the unattended time limit. Do not ask again: choose the most reasonable, least destructive option yourself, state the assumption plainly in your reply, and carry on.';

/** One-line summary of what is being asked, for a board card or a sidebar row. */
export function summarizeAsk(request: AskRequest): string {
  const [first] = request.questions;
  if (!first) return 'Waiting on you';
  const more = request.questions.length - 1;
  return more > 0 ? `${first.question} (+${more} more)` : first.question;
}

/** Whether every question has something recorded against it. */
export function isAskComplete(request: AskRequest, answers: AskAnswer[]): boolean {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  return request.questions.every((q) => {
    const a = byId.get(q.id);
    return !!a && (a.labels.length > 0 || !!a.note?.trim());
  });
}
