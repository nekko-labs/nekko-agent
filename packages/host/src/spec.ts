import { assertHostExecution } from './indirect-execution-guard.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHostProvider as createProvider, hostProviderConfig, promptCachingForHost } from './prompt-caching.js';
import type { SpecDocDef, SpecDocRole, SpecDocStatus } from '@nekko-agent/shared';
import { getMethodology, getSessionWorkspaceIds, toggleTaskLine } from '@nekko-agent/shared';
import { getSettings } from './store.js';
import { getSession, saveSession } from './sessions.js';
import { resolveSubscriptionProvider } from './oauth.js';

/** The methodology a session uses (its own override, else the global default). */
function methodologyForSession(sessionId: string) {
  assertHostExecution(sessionId, 'Host spec access');
  const session = getSession(sessionId);
  return getMethodology(session?.specMethodology ?? getSettings().specMethodology);
}

/** Absolute path of a workspace file for a session, or null if no workspace. */
function workspacePath(sessionId: string, filename: string, workspaceId?: string): string | null {
  assertHostExecution(sessionId, 'Host spec access');
  const session = getSession(sessionId);
  const targetId = workspaceId && session && getSessionWorkspaceIds(session).includes(workspaceId)
    ? workspaceId
    : session?.workspaceId;
  if (!targetId) return null;
  const folder = getSettings().workspaces.find((w) => w.id === targetId);
  return folder ? join(folder.path, filename) : null;
}

/**
 * Absolute path of the *primary* spec for a chat's workspace (the first doc of
 * its methodology, usually `spec.md`/`requirements.md`). Kept for the Context
 * Inspector's "open spec" link and back-compat.
 */
export function specPathForSession(sessionId: string): string | null {
  const first = methodologyForSession(sessionId).docs[0];
  return workspacePath(sessionId, first.filename);
}

/** Live status of every artifact in the session's methodology, for the UI. */
export function readSpecDocs(
  sessionId: string,
  workspaceId?: string,
): { methodologyId: string; docs: SpecDocStatus[] } {
  const m = methodologyForSession(sessionId);
  const docs: SpecDocStatus[] = m.docs.map((d) => {
    const path = workspacePath(sessionId, d.filename, workspaceId) ?? d.filename;
    const exists = !!workspacePath(sessionId, d.filename, workspaceId) && existsSync(path);
    let content = '';
    if (exists) {
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        /* unreadable, treat as empty */
      }
    }
    return { ...d, path, exists, content };
  });
  return { methodologyId: m.id, docs };
}

/** Set the spec methodology for a session. */
export function setSpecMethodology(sessionId: string, methodologyId: string): void {
  assertHostExecution(sessionId, 'Host spec access');
  const session = getSession(sessionId);
  if (!session) return;
  session.specMethodology = getMethodology(methodologyId).id;
  saveSession(session);
}

const ROLE_GUIDANCE: Record<SpecDocRole, string> = {
  spec: `Write a clear, well-structured spec, the source of truth for WHAT we're building and WHY.
Use sections like: Overview, Goals, Users, Requirements (or user stories with acceptance criteria), and Open Questions.
Keep it about the product, not the implementation.`,
  plan: `Write a technical plan, HOW we'll build what the spec describes.
Use sections like: Architecture, Stack & Key Decisions, Data Model, Conventions, and Risks.
Ground it in the spec (provided below). Do not restate the spec; reference it.`,
  tasks: `Write an implementation task list as a markdown checklist.
Break the work into small, independently reviewable, testable items, each on its own line as "- [ ] <task>".
Group related items under \`##\` headings. Order them so dependencies come first. Be concrete and concise.
Derive the tasks from the spec (and plan, if present) provided below.`,
};

/**
 * Synthesize (or update) one artifact of the session's methodology from the
 * conversation, chaining in the earlier artifacts that already exist on disk.
 * Uses the session's own provider/model. One-shot, no tools.
 */
export async function buildSpecDoc(
  sessionId: string,
  docId?: string,
  workspaceId?: string,
): Promise<{ ok: boolean; path?: string; docId?: string; message?: string }> {
  assertHostExecution(sessionId, 'Host spec access');
  const session = getSession(sessionId);
  if (!session) return { ok: false, message: 'Session not found.' };
  const targetId = workspaceId && getSessionWorkspaceIds(session).includes(workspaceId)
    ? workspaceId
    : session.workspaceId;
  if (!targetId) return { ok: false, message: 'Add a project folder to this chat first.' };
  const folder = getSettings().workspaces.find((w) => w.id === targetId);
  if (!folder) return { ok: false, message: 'Workspace not found.' };

  const provider = getSettings().providers.find((p) => p.id === session.providerId);
  if (!provider || !session.modelId) return { ok: false, message: 'Pick a provider and model, then chat first.' };

  const m = methodologyForSession(sessionId);
  const doc: SpecDocDef | undefined = docId ? m.docs.find((d) => d.id === docId) : m.docs[0];
  if (!doc) return { ok: false, message: 'Unknown spec document.' };

  const transcript = session.messages
    .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
    .map((msg) => `## ${msg.role === 'user' ? 'User' : 'Assistant'}\n${msg.content}`)
    .join('\n\n')
    .slice(0, 60000);
  if (!transcript.trim()) return { ok: false, message: 'Nothing to build a spec from yet.' };

  // Chain in the artifacts that come before this one in the methodology.
  const priorDocs = m.docs
    .slice(0, m.docs.indexOf(doc))
    .map((d) => {
      const p = join(folder.path, d.filename);
      if (!existsSync(p)) return null;
      try {
        return `### ${d.label} (${d.filename})\n\n${readFileSync(p, 'utf8').slice(0, 20000)}`;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => !!x);

  const system = `You maintain a project's ${doc.filename}, part of a spec-driven development workflow ("${m.label}"), synthesized from an ongoing working conversation between a user and an AI assistant.
${ROLE_GUIDANCE[doc.role]}
If an existing ${doc.filename} is provided, UPDATE it to reflect the latest conversation, keep still-valid content, revise what changed, add what's new.
Be concise and concrete. Output ONLY the markdown for ${doc.filename}, with no preamble or code fences.`;

  const path = join(folder.path, doc.filename);
  const existing = existsSync(path) ? readFileSync(path, 'utf8').slice(0, 40000) : '';
  const prompt =
    (priorDocs.length ? `Earlier artifacts in this workflow:\n\n${priorDocs.join('\n\n---\n\n')}\n\n===\n\n` : '') +
    (existing ? `Existing ${doc.filename}:\n\n${existing}\n\n---\n\n` : '') +
    `Conversation so far:\n\n${transcript}\n\n---\n\nWrite the updated ${doc.filename}.`;

  let out = '';
  try {
    const resolved = await resolveSubscriptionProvider(provider);
    for await (const chunk of createProvider(resolved).chat({
      model: session.modelId,
      system,
      messages: [{ id: 'spec', role: 'user', content: prompt, createdAt: Date.now() }],
      temperature: 0.3,
    })) {
      if (chunk.type === 'text') out += chunk.delta;
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  out = out.replace(/^```(?:markdown|md)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  if (!out) return { ok: false, message: 'The model returned an empty document.' };
  assertHostExecution(sessionId, 'Host spec write');
  writeFileSync(path, out + '\n', 'utf8');
  return { ok: true, path, docId: doc.id };
}

/**
 * Build (or update) the primary spec doc. Kept for the Context Inspector's
 * Build-from-chat button and the post-turn `specLinked` refresh.
 */
export function buildSpec(sessionId: string): Promise<{ ok: boolean; path?: string; message?: string }> {
  return buildSpecDoc(sessionId);
}

/**
 * Toggle a checklist item in the session's tasks artifact (the doc with role
 * `tasks`), rewriting the file. Returns the refreshed tasks-doc status.
 */
export function toggleSpecTask(
  sessionId: string,
  lineIndex: number,
  workspaceId?: string,
): { ok: boolean; message?: string } {
  const m = methodologyForSession(sessionId);
  const tasksDoc = m.docs.find((d) => d.role === 'tasks');
  if (!tasksDoc) return { ok: false, message: 'This methodology has no tasks document.' };
  const path = workspacePath(sessionId, tasksDoc.filename, workspaceId);
  if (!path || !existsSync(path)) return { ok: false, message: 'Build the tasks document first.' };
  try {
    const next = toggleTaskLine(readFileSync(path, 'utf8'), lineIndex);
    writeFileSync(path, next, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * A saved provider, signed in (a subscription token refreshed) and ready for
 * the engine daemon's Rust providers: what it asks for (`provider:resolved`)
 * when it builds a spec doc, since sign-ins still live here.
 */
export async function resolvedProvider(providerId: string): Promise<{ provider: import('@nekko-agent/shared').ProviderConfig; promptCaching: boolean }> {
  const provider = getSettings().providers.find((p) => p.id === providerId);
  if (!provider) throw new Error('Pick a provider and model, then chat first.');
  return { provider: hostProviderConfig(await resolveSubscriptionProvider(provider)), promptCaching: promptCachingForHost() };
}
