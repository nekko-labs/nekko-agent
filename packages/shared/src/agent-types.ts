/**
 * Agent "type" classification. In a busy Agent board a team needs to tell at
 * a glance what each running agent *is*, a code-review bot, a production
 * monitor, a research agent, a build agent, so this derives a type from the
 * signals we already have: the skill in play, the task kind/condition, the
 * prompt text, and the model. Pure + deterministic so it's unit-testable and
 * runs anywhere (renderer or host).
 */

import type { Session } from './chat.js';
import type { SessionSummary } from './session-summary.js';
import type { AutomationTask, TaskKind } from './tasks.js';

export type AgentRole = 'reviewer' | 'monitor' | 'researcher' | 'builder' | 'automation' | 'assistant' | 'artist';

export interface AgentType {
  role: AgentRole;
  /** Human label shown as a badge, e.g. "Code review bot", "Production monitor". */
  label: string;
  icon: string;
  color: string;
}

/** Signals classification reads. All optional; more signal → sharper type. */
export interface AgentSignals {
  taskKind?: TaskKind;
  /** background "until" condition (monitors often live here). */
  taskCondition?: string;
  /** A detected skill name (e.g. 'review', 'research'), if any. */
  skill?: string;
  /** Free text to keyword-match: task prompt or the chat's first user turn. */
  prompt?: string;
  modelId?: string;
}

const REVIEW_SKILLS = new Set(['review', 'security-review', 'simplify', 'review-council', 'a11y-audit', 'dep-audit']);
const RESEARCH_SKILLS = new Set(['research', 'plan', 'explain', 'brainstorm', 'spec-sync']);
const BUILD_SKILLS = new Set(['fix', 'test', 'commit', 'pr', 'systematic-debug', 'changelog', 'i18n-sweep']);

const MONITOR_RE = /\b(monitor|watch(ing|es)?|poll(ing)?|uptime|health\s?check|heartbeat|alert|on-call|oncall|surveil|keep an eye|deploy(ment)?s?\b.*\b(status|health))\b/i;
const PROD_RE = /\b(production|prod\b|live site|deploy|incident|outage|pager|sev\d)\b/i;
const REVIEW_RE = /\b(review|audit|vulnerab|lint|code smell|refactor safety|pr feedback)\b/i;
const RESEARCH_RE = /\b(research|investigate|explain|summari[sz]e|analy[sz]e|compare|explore|plan\b|design doc)\b/i;
const BUILD_RE = /\b(implement|build|fix|refactor|migrat|scaffold|add (a|the|support)|write (code|tests|the)|ship|feature)\b/i;

/** Detect a skill name from text: a leading `/name` token or "skill: name". */
export function detectSkill(text?: string): string | undefined {
  if (!text) return undefined;
  const slash = text.match(/^\s*\/([a-z][a-z0-9-]*)/i);
  if (slash) return slash[1].toLowerCase();
  const named = text.match(/\bskill:\s*([a-z][a-z0-9-]*)/i);
  return named ? named[1].toLowerCase() : undefined;
}

export function classifyAgent(sig: AgentSignals): AgentType {
  const skill = sig.skill?.toLowerCase();
  const text = `${sig.taskCondition ?? ''} ${sig.prompt ?? ''}`;
  const recurring = sig.taskKind === 'recurring' || sig.taskKind === 'background';

  // Monitors first, but only for standing (recurring/background) work that
  // reads as watching something. A one-off "check this" chat isn't a monitor.
  if (recurring && MONITOR_RE.test(text)) {
    const prod = PROD_RE.test(text);
    return {
      role: 'monitor',
      label: prod ? 'Production monitor' : 'Monitor bot',
      icon: prod ? '🚨' : '📡',
      color: '#e0574a',
    };
  }

  if ((skill && REVIEW_SKILLS.has(skill)) || REVIEW_RE.test(text)) {
    return { role: 'reviewer', label: 'Code review bot', icon: '🔍', color: '#5b9dd9' };
  }
  if ((skill && RESEARCH_SKILLS.has(skill)) || RESEARCH_RE.test(text)) {
    return { role: 'researcher', label: 'Research agent', icon: '📚', color: '#a78bfa' };
  }
  if ((skill && BUILD_SKILLS.has(skill)) || BUILD_RE.test(text)) {
    return { role: 'builder', label: 'Build agent', icon: '🛠️', color: '#4ec98a' };
  }
  if (sig.taskKind) {
    return { role: 'automation', label: 'Automation', icon: '⚙️', color: '#e0a44a' };
  }
  return { role: 'assistant', label: 'Assistant', icon: '💬', color: '#8a8f98' };
}

/** Extract classification signals from a chat session (+ its driving task, if any). */
export function agentSignals(session: Session | SessionSummary, task?: AutomationTask): AgentSignals {
  const firstUser = 'messages' in session
    ? session.messages.find((m) => m.role === 'user')?.content
    : session.firstUserText;
  const prompt = task?.prompt ?? firstUser ?? session.title;
  return {
    taskKind: task?.kind,
    taskCondition: task?.condition,
    skill: detectSkill(task?.prompt) ?? detectSkill(firstUser),
    prompt,
    modelId: session.modelId,
  };
}

/** Classify a chat session directly (convenience). */
export function classifySession(session: Session | SessionSummary, task?: AutomationTask): AgentType {
  // An image chat's prompts describe pictures, not work; reading them for
  // "build" or "review" would misfile a request for a castle as a build agent.
  if (session.chatType === 'image') return { role: 'artist', label: 'Image generation', icon: '🎨', color: '#e879a6' };
  return classifyAgent(agentSignals(session, task));
}
